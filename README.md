<p align="center">
  <img src="apps/web/public/brand/votebox-icon.svg" width="100" height="100" alt="Vote Machine">
</p>

<h1 align="center">Vote Machine</h1>

<p align="center">
  Voting and polls in persistent rooms, without registration<br>
  <a href="https://vote.frogling.com/">Open app</a> - <a href="#installation">Installation</a> - <a href="#development">Development</a>
</p>

## Features

- **No registration** - create rooms without an account and use dedicated links for administration and individual responses
- **Configurable questions** - Markdown, images, animations and video in questions and answer options
- **Real-time updates** - see results as responses arrive and apply question edits live
- **Privacy settings** - anonymous responses and the option to hide results even from the administrator until voting closes
- **Shared-device voting** - manual response entry and reusable voting links for multiple people using one device
- **Result exports** - CSV and XLSX workbooks with multiple sheets
- **Interface** - customizable room themes synced across admin and participant views, a responsive mobile layout, dark mode, sound alerts and accessibility support

Administrators share links with participants themselves. The admin link grants full access to the room

## Installation

Requires Git, Node.js 24 and Docker with Compose v2. Docker Desktop includes Compose

```sh
git clone https://github.com/mvodya/vote-machine.git
cd vote-machine
node scripts/setup-local-env.mjs
docker compose up --build --wait
```

Open [localhost:3000](http://localhost:3000/) and create a room. Dependencies and the application are built inside containers, and migrations run before the API starts

The setup script creates `.env` with local keys and Garage settings. Running it again preserves existing keys. See [.env.example](.env.example) for other settings

```sh
docker compose logs -f api web
docker compose stop
docker compose up -d --wait
```

The database and uploaded files persist in Docker volumes. `docker compose down` keeps them, while `docker compose down --volumes` deletes them

### Self-hosting

Use `compose.production.yaml` for a server with TLS at the included Nginx proxy. Set the public URL, certificate and private key paths on the Docker host, database password and replica counts in `.env`

```dotenv
PUBLIC_ORIGIN=https://vote.example.com
TLS_CERT_FILE=/etc/letsencrypt/live/vote.example.com/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/vote.example.com/privkey.pem
POSTGRES_PASSWORD=replace_with_a_random_password
WEB_REPLICAS=1
API_REPLICAS=1
```

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --build --wait
```

Obtain the certificate separately. Only Nginx publishes ports; the API, PostgreSQL and object storage stay on the internal network

Back up the database, uploaded files and `.env`. Keep `ADMIN_LINK_KEY` to recover admin and participant links

### External S3 storage

Garage is used by default. To use your own private S3-compatible bucket, set these values in `.env`

```dotenv
COMPOSE_PROFILES=
S3_ENDPOINT=https://s3.example.com
S3_REGION=your-region
S3_BUCKET=your-private-bucket
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_FORCE_PATH_STYLE=true
```

Set `S3_FORCE_PATH_STYLE=false` if your provider requires virtual-hosted bucket URLs. The application needs permission to read, write and delete objects in the bucket

## Development

### Dev Container in Zed

Generate `.env`, then open the project in its Dev Container. Dependencies install automatically; the image includes the C++ toolchain, Node.js and pnpm

Apply migrations

```sh
pnpm db:migrate
```

Start the API and web app in separate container terminals or through Zed tasks

```sh
pnpm dev:api
```

```sh
pnpm dev:web
```

| Service    | Default host address                     |
| ---------- | ---------------------------------------- |
| Web        | [localhost:3001](http://localhost:3001/) |
| API        | `http://localhost:8081`                  |
| PostgreSQL | `127.0.0.1:5432`                         |

Set `WORKSPACE_WEB_PORT`, `WORKSPACE_API_PORT` and `WORKSPACE_DB_PORT` in `.env` to change host ports. The PostgreSQL database and user are both `vote_machine`; the password is `POSTGRES_PASSWORD`

The web app supports hot reload. The API rebuilds and restarts automatically after source changes. Run `pnpm db:migrate` after adding migrations

### Project layout

| Directory  | Contents                                                        |
| ---------- | --------------------------------------------------------------- |
| `apps/web` | Next.js, TypeScript, Tailwind CSS, custom UI components         |
| `apps/api` | C++ / Drogon, HTTP API and SSE                                  |
| `db`       | PostgreSQL, SQL functions, triggers, node-pg-migrate migrations |
| `storage`  | Garage configuration                                            |
| `tests`    | API, migration, failure recovery and deployment checks          |
| `deploy`   | Nginx configuration and deployment scripts                      |

Data changes and real-time signals are committed in the same PostgreSQL transaction. The API receives signals through `LISTEN/NOTIFY` and forwards updates to browsers through SSE. Clients fetch a fresh snapshot after reconnecting

### Checks

Inside the Dev Container

```sh
pnpm check:web
pnpm format:cpp:check
pnpm lint:cpp
cd apps/api
ctest --preset dev
```

Run browser and full integration checks on the host. Requires Node.js 24, pnpm 11.25.0 and Docker

```sh
pnpm install --frozen-lockfile
pnpm --filter @vote-machine/web exec playwright install chromium firefox webkit
pnpm test:db
sh tests/test-stack.sh
```

These checks create isolated Compose projects and remove only their own test data. The full stack suite uses port 3100; set `TEST_WEB_PORT` to change it

Use `pnpm test:e2e` to run browser checks against an existing application instance. Set `TEST_BASE_URL` to its address; the default is `http://127.0.0.1:3000`
