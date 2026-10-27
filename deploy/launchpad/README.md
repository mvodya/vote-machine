# Launchpad deployment

TLS terminates only on ssh proxy, all traffic to launchpad uses HTTP
The public origin stays https://vote.frogling.com for secure cookies and link generation
The proxy host is 10.0.0.61, launchpad is 10.0.0.63
Only the proxy can access the application listener on port 8091

## Installed layout

- /opt/votemachine/repo.git - push target, main branch only
- /opt/votemachine/bin/deploy.sh - installed deployment script
- /opt/votemachine/config/runtime.env - private server keys, mode 600
- /opt/votemachine/config/compose.yaml - installed launchpad override
- /opt/votemachine/config/nginx.conf - internal HTTP balancer
- /opt/votemachine/releases/COMMIT - immutable application source for each release
- /opt/votemachine/current - last successful release
- /opt/votemachine/deployed-revision - last successful full commit hash

The local remote is named launchpad, origin is not used
Push committed application changes with git push launchpad
Uncommitted files are not deployed
Only fast-forward main updates are accepted, branch deletion is blocked

The hook builds migration, API and web images in sequence before maintenance
It then stops application writers, applies migrations and waits for healthy services
Database and Garage volumes belong to the fixed votemachine Compose project
Keys and data are not copied from the development machine
The cleanup worker uses the same release image as web
Launchpad runs one web and one API by default, counts are set in runtime.env

## Compose commands

On launchpad, change to /opt/votemachine and use normal Compose commands
The private .env link reads config/runtime.env
COMPOSE_FILE selects current/compose.yaml, current/compose.production.yaml and config/compose.yaml
COMPOSE_PROJECT_NAME is votemachine, DEPLOY_REVISION follows the last successful release

```sh
ssh launchpad
cd /opt/votemachine
docker compose ps
docker compose top
docker compose logs -f --tail 100
docker compose down
docker compose up -d --no-build --wait
```

down removes project containers and network, stored data stays in Docker volumes
Use stop and start instead when containers should stay present
Do not add -v to down unless database and file deletion is intended

## Operator config

Installed operator files do not update on push, copy reviewed changes separately
This prevents application pushes from replacing server keys or proxy configuration
No TLS certificates are mounted on launchpad and port 443 is not published

## Failure and retry

A post-receive failure does not undo Git reception, read the deployment output
After fixing the cause, retry on launchpad

```sh
/opt/votemachine/bin/deploy.sh COMMIT
```

Build failures leave the old application running
Failures after maintenance begins leave writers stopped for operator inspection
Never run database down migrations automatically when returning to older code
Do not delete Docker volumes or server keys during a release
Old releases and build caches require periodic disk review
Backups must be configured separately using the operations runbook

## Proxy and DNS

proxy.conf is installed as /etc/nginx/sites-available/vote.frogling.com
The enabled site links to that file
It follows proxy_template and mon.frogling.com, with buffering disabled for SSE
Forwarded client addresses are replaced and private request URLs are not logged
The internal balancer trusts only the proxy host address

Create the DNS record for vote.frogling.com pointing to the public proxy address
The owner runs Certbot on proxy to enable HTTPS
Until then, secure room cookies need HTTPS and normal login over HTTP will not work
Certbot has not been run by the deployment script
