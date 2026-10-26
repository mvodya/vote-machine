# Horizontal deployment

Use `compose.yaml` with `compose.production.yaml` on one Docker host
Only Nginx publishes ports, PostgreSQL, API and web stay private
Multiple hosts need a separate deployment platform and shared PostgreSQL/S3

Set PUBLIC_ORIGIN to the exact HTTPS origin, including a non-default port
Set TLS_CERT_FILE and TLS_KEY_FILE to existing PEM files outside the repository
Use a certificate trusted by your clients, test certificates are only for isolated tests
Set real secrets with scripts/setup-local-env.mjs and keep a separate secure copy
Run migrations once before replacing application replicas

```sh
docker compose -f compose.yaml -f compose.production.yaml up --build --wait
```

Two web replicas and two API replicas are the defaults, there are no sticky cookies
All web replicas need the same release image so static files and handlers match
All API replicas use the same database, session keys, media worker key and gateway key
Garage is a single-host local storage service, configure external S3 for a separate storage platform

Only the fixed edge address is trusted for a forwarded client IP
Choose APP_SUBNET and EDGE_ADDRESS together if the default network conflicts with your host
Never expose a trusted web ingress port directly or trust arbitrary internet networks
Nginx replaces external forwarding headers, the web ingress resets them again before Next.js
TLS cookies remain Secure and private routes stay uncached

Each API opens DB_POOL_SIZE SQL connections plus one dedicated LISTEN connection
Keep `API_REPLICAS * (DB_POOL_SIZE + 1) + 20 <= POSTGRES_MAX_CONNECTIONS`
The extra twenty connections cover migrations, operator queries and headroom
The default budget is six application connections out of one hundred
Pool size is bounded from one to thirty-two and invalid values fail before startup
Adding replicas does not remove PostgreSQL or single-host limits

## Replica removal and release behavior

A private API POST /internal/drain with X-VM-Gateway marks readiness unavailable and closes SSE
Send it to the selected API address from a web container using its existing environment key
Wait at least six seconds before stopping that API, its SQL timeout is three seconds
Keep another healthy API in the pool before retiring one, then wait for Docker DNS refresh
The web SIGTERM handler stops new admission, ends SSE and gives commands ten seconds to finish
Compose allows twenty seconds before forcing either application container to exit
SSE reconnects with a snapshot, ambiguous answer replies use the same durable request identity
Do not replay a failed write with a new identity

Compose does not promise an automatic rolling release across versions
Build and test the release, back up data, run migrations and replace replicas in a controlled window
Do not mix incompatible web builds, use a maintenance window for a whole web release
An API drain is irreversible until that replica restarts
A code rollback must not trigger a database down migration
Certificate replacement requires recreating edge so file mounts use the renewed files

## Verification

Run `sh tests/test-horizontal.sh` against its own disposable project
It generates a short-lived trusted test certificate and starts two web and two API replicas
Checks cover actual traffic on every replica, Secure cookies, shared private images, streamed events,
concurrent deadline workers, pool counts, protected API drain, removal and exact answer retries
Working development data and TLS material are not used

The proxy disables response buffering and refreshes upstream DNS
See [Nginx proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) and
[dynamic upstream resolution](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
