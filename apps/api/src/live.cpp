#include "live.hpp"

#include <drogon/drogon.h>
#include <drogon/orm/DbListener.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>

#include "access.hpp"
#include "http.hpp"

namespace vote_machine {
namespace {
using Clock = std::chrono::steady_clock;
// All mutable stream state stays on the main event loop
struct LiveClient {
  // Role-scoped identity and hashed session
  std::string identity;
  std::string session;
  // Room routing and opaque visible version
  std::string room;
  std::string version;
  // Access role fixed by the route
  bool admin = false;
  // Coalesce changes while a database read is pending
  bool dirty = false;
  bool checking = false;
  // Bound buffered events and connection age
  std::uint32_t writes = 0;
  Clock::time_point started = Clock::now();
  // Close this stream before removing the client
  drogon::ResponseStreamPtr stream;
};
class LiveHub : public std::enable_shared_from_this<LiveHub> {
 public:
  // Keep background work from owning database threads
  explicit LiveHub(const drogon::orm::DbClientPtr& database)
      : database_(database) {}

  // Drogon reconnects and repeats LISTEN after a database outage
  void Start(const std::string& connection) {
    listener_ = drogon::orm::DbListener::newPgListener(connection,
                                                       drogon::app().getLoop());
    const std::weak_ptr<LiveHub> weak = shared_from_this();
    listener_->listen("live_changes",
                      [weak](const std::string&, const std::string& room) {
                        if (auto hub = weak.lock()) {
                          for (auto& [key, client] : hub->clients_) {
                            (void)key;
                            if (client->room == room) client->dirty = true;
                          }
                        }
                      });
    timer_ = drogon::app().getLoop()->runEvery(1.0, [weak]() {
      if (auto hub = weak.lock()) hub->Tick();
    });
  }

  // Release streams and the listener before closing the shared database
  void Stop() {
    // Drain and final shutdown can request the same cleanup
    if (stopped_) return;
    stopped_ = true;
    drogon::app().getLoop()->invalidateTimer(timer_);
    listener_.reset();
    for (const auto& [key, client] : clients_) {
      (void)key;
      CloseClient(client);
    }
    clients_.clear();
  }

  // Authenticate before sending successful stream headers
  void Open(const drogon::HttpRequestPtr& request, const Reply& reply,
            const std::string& identity, bool admin) {
    const auto session = Session(request);
    if (!IsRoomId(identity) || session.empty()) {
      Error(reply, drogon::k401Unauthorized, "Access required");
      return;
    }
    const auto database = database_.lock();
    if (!database) {
      Unavailable(reply);
      return;
    }
    const std::weak_ptr<LiveHub> weak = shared_from_this();
    database->execSqlAsync(
        "SELECT vm_event_state($1::uuid,decode($2,'hex'),$3::boolean)::text AS "
        "state",
        [weak, reply, identity, session,
         admin](const drogon::orm::Result& result) {
          Json::Value state;
          Json::Reader reader;
          if (result.empty() ||
              !reader.parse(result[0]["state"].as<std::string>(), state)) {
            Unavailable(reply);
            return;
          }
          drogon::app().getLoop()->queueInLoop(
              [weak, reply, identity, session, admin, state]() {
                if (auto hub = weak.lock())
                  hub->Attach(reply, identity, session, admin, state);
              });
        },
        [reply](const drogon::orm::DrogonDbException&) { Unavailable(reply); },
        identity, session, admin);
  }

 private:
  // Close explicitly because a response callback may still hold the client
  static void CloseClient(const std::shared_ptr<LiveClient>& client) {
    if (client->stream) {
      client->stream->close();
      client->stream.reset();
    }
  }
  // Drop a stream even when a pending callback still refers to it
  void Remove(std::uint64_t key) {
    const auto item = clients_.find(key);
    if (item != clients_.end()) {
      CloseClient(item->second);
      clients_.erase(item);
    }
  }
  // Bound each stream to a small lease even if its reader stops consuming
  static bool Send(const std::shared_ptr<LiveClient>& client,
                   const std::string& event, const std::string& version = "") {
    ++client->writes;
    return client->stream && client->stream->send("event: " + event + "\nid: " +
                                                  version + "\ndata: {}\n\n");
  }

  // Every connection starts with a fresh snapshot request, including reconnects
  void Attach(const Reply& reply, const std::string& identity,
              const std::string& session, bool admin,
              const Json::Value& state) {
    if (state["status"].asInt() != 200) {
      Error(reply, drogon::k401Unauthorized, "Access required");
      return;
    }
    if (stopped_ || clients_.size() >= 512) {
      Unavailable(reply);
      return;
    }
    const auto client = std::make_shared<LiveClient>();
    client->identity = identity;
    client->session = session;
    client->admin = admin;
    client->room = state["roomId"].asString();
    client->version = state["version"].asString();
    const auto key = ++next_;
    clients_.emplace(key, client);
    const std::weak_ptr<LiveHub> weak = shared_from_this();
    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [weak, key, client](drogon::ResponseStreamPtr stream) {
          // A shared holder keeps the move-only stream safe across loop queues
          auto holder =
              std::make_shared<drogon::ResponseStreamPtr>(std::move(stream));
          drogon::app().getLoop()->queueInLoop([weak, key, client, holder]() {
            if (auto hub = weak.lock(); hub && hub->clients_.contains(key)) {
              client->stream = std::move(*holder);
              client->dirty = true;
              if (!Send(client, "ready", client->version)) hub->Remove(key);
            }
          });
        });
    response->setContentTypeString("text/event-stream");
    response->addHeader("Cache-Control", "private, no-store");
    response->addHeader("X-Accel-Buffering", "no");
    response->addHeader("Referrer-Policy", "no-referrer");
    reply(response);
  }

  // Coalesce writes and reconcile periodically because NOTIFY is not durable
  void Tick() {
    ++ticks_;
    for (auto item = clients_.begin(); item != clients_.end();) {
      const auto key = item->first;
      const auto client = item->second;
      if (Clock::now() - client->started >= std::chrono::seconds(180) ||
          client->writes >= 64 ||
          (ticks_ % 15 == 0 && client->stream &&
           !client->stream->send(": heartbeat\n\n"))) {
        CloseClient(client);
        item = clients_.erase(item);
        continue;
      }
      ++item;
      if (client->stream && !client->checking &&
          (client->dirty || ticks_ % 5 == 0))
        Check(key, client);
    }
  }

  // Only a changed authorized view creates a browser event
  void Check(std::uint64_t key, const std::shared_ptr<LiveClient>& client) {
    const auto database = database_.lock();
    if (!database) return;
    client->checking = true;
    client->dirty = false;
    const std::weak_ptr<LiveHub> weak = shared_from_this();
    database->execSqlAsync(
        "SELECT vm_event_state($1::uuid,decode($2,'hex'),$3::boolean)::text AS "
        "state",
        [weak, key, client](const drogon::orm::Result& result) {
          Json::Value state;
          Json::Reader reader;
          if (!result.empty())
            reader.parse(result[0]["state"].as<std::string>(), state);
          drogon::app().getLoop()->queueInLoop([weak, key, client, state]() {
            if (auto hub = weak.lock(); hub && hub->clients_.contains(key)) {
              client->checking = false;
              if (state["status"].asInt() != 200) {
                Send(client, "access");
                hub->Remove(key);
                return;
              }
              const auto version = state["version"].asString();
              if (version != client->version) {
                client->version = version;
                if (!Send(client, "change", version)) hub->Remove(key);
              }
            }
          });
        },
        [weak, key](const drogon::orm::DrogonDbException&) {
          drogon::app().getLoop()->queueInLoop([weak, key]() {
            if (auto hub = weak.lock()) hub->Remove(key);
          });
        },
        client->identity, client->session, client->admin);
  }

  // Shared resources and clients are changed only by the main loop
  std::weak_ptr<drogon::orm::DbClient> database_;
  drogon::orm::DbListenerPtr listener_;
  trantor::TimerId timer_ = trantor::InvalidTimerId;
  std::unordered_map<std::uint64_t, std::shared_ptr<LiveClient>> clients_;
  std::uint64_t next_ = 0;
  std::uint32_t ticks_ = 0;
  bool stopped_ = false;
};
}  // namespace
// Register role-specific endpoints with one shared PostgreSQL listener
std::function<void()> RegisterLiveHandlers(
    const drogon::orm::DbClientPtr& database, const std::string& connection) {
  auto hub = std::make_shared<LiveHub>(database);
  drogon::app().registerBeginningAdvice(
      [hub, connection]() { hub->Start(connection); });
  drogon::app().registerHandler(
      "/api/rooms/{1}/events",
      [hub](const drogon::HttpRequestPtr& request, Reply&& reply,
            const std::string& room) { hub->Open(request, reply, room, true); },
      {drogon::Get});
  drogon::app().registerHandler("/api/vote/{1}/events",
                                [hub](const drogon::HttpRequestPtr& request,
                                      Reply&& reply, const std::string& link) {
                                  hub->Open(request, reply, link, false);
                                },
                                {drogon::Get});
  return [hub]() { hub->Stop(); };
}
}  // namespace vote_machine
