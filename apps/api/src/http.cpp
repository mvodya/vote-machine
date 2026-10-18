#include "http.hpp"

#include "access.hpp"

namespace vote_machine {

// Send private JSON without caching
void Send(const Reply& reply, const Json::Value& body,
          drogon::HttpStatusCode status) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  response->addHeader("Cache-Control", "no-store");
  response->addHeader("Referrer-Policy", "no-referrer");
  reply(response);
}

// Send a short error without private details
void Error(const Reply& reply, drogon::HttpStatusCode status,
           const std::string& message) {
  Json::Value body;
  body["error"] = message;
  Send(reply, body, status);
}

// Read and hash the session key from the request
std::string Session(const drogon::HttpRequestPtr& request) {
  const auto& authorization = request->getHeader("Authorization");
  constexpr std::string_view kPrefix = "Bearer ";
  // Cookies are handled by the web server, not here
  if (!authorization.starts_with(kPrefix)) return "";
  const auto token = authorization.substr(kPrefix.size());
  return IsSecret(token) ? HashSecret(token) : "";
}

// Hide database and crypto errors from the client
void Unavailable(const Reply& reply) {
  Error(reply, drogon::k503ServiceUnavailable, "Service is unavailable");
}

}  // namespace vote_machine
