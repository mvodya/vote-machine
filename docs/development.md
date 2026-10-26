# Development and quality

Stage 02 targets Zed with the existing Dev Container setup
VS Code settings and validation are deferred by user request

## Daily work in Zed

Open the repository in its Dev Container
After pulling changes to the toolchain, rebuild the Dev Container once
The new image adds clang-tidy, and Compose gives sanitizer builds a separate volume
Rebuilding the workspace does not require deleting PostgreSQL data

The Zed task picker provides web/API start commands and quality checks
Run these from separate terminals inside the container if preferred

```sh
pnpm dev:api
pnpm dev:web
```

Open http://localhost:3001
The API is exposed at http://localhost:8081
Change `WORKSPACE_WEB_PORT` and `WORKSPACE_API_PORT` in `.env` if needed
Do not start two copies of either server on the same internal port

Next.js reloads frontend changes
The API command checks file contents under `apps/api` every 500 ms
Polling also works when Docker bind mounts do not deliver file events
On a change it stops the old API, configures CMake, builds incrementally and starts the new binary
Added and removed source files are detected, including CMake changes
A failed build leaves the API stopped until the next edit
An API runtime failure is printed to the terminal and needs a source edit or command restart
Ctrl+C stops the watcher and its active child

## Media storage

Run `node scripts/setup-local-env.mjs` before starting or rebuilding the stack
It adds missing local keys to `.env` and keeps existing keys
Keep this file private and preserve `ADMIN_LINK_KEY` so saved room links remain readable

The `local-storage` Compose profile starts Garage with a private bucket and a persistent volume
Garage ports are not published on the host, files pass through the web app after access checks
The Dev Container also starts the cleanup worker, using the API inside the workspace
Run `pnpm dev:api` and `pnpm dev:web` as usual

For external S3, leave `COMPOSE_PROFILES=` empty and set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`
Set `S3_FORCE_PATH_STYLE=false` if the provider needs virtual-host bucket names
Use a private bucket and give the application read, write and delete access to its objects
The web app and cleanup worker must use the same storage settings

Uploads accept PNG, JPEG, WebP, GIF, JPEG XL, AVIF, MP4 and WebM
Limits are 10 MiB per file and 25 megapixels per frame, with no duration or frame-count limit
Static pictures become WebP, animated GIF/WebP keep frame timing and loops
Videos keep their codec, so playback support depends on the browser
Processing removes metadata and has operational timeouts to release stalled work

Used files have no expiry, unused files have a 24-hour grace period
An active editor renews the grace period for its uploaded files
PostgreSQL leases let cleanup workers share work and retry failed object deletion
Schema rollback removes asset metadata, it cannot restore deleted objects
Before protected data exists this remains a development workflow, later backups must cover both PostgreSQL and object storage

The first C++ build is slower, later builds reuse the named build volume
clangd uses `build/api/compile_commands.json` after the first configure
No editor-specific language-server or formatter overrides are required

## Git across macOS and Linux

When host tools and the Dev Container share a checkout, different inode and owner values can trigger repeated Git index refreshes
If this happens, set these options once in the affected clone

```sh
git config --local core.checkStat minimal
git config --local core.trustctime false
```

These settings avoid refreshes caused only by platform-specific file metadata
Content checks stay enabled, including same-size edits
The options apply only to this repository and are read by both host and container Git
See the [Git configuration reference](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corecheckStat)

## Local checks

Run web checks inside the container

```sh
pnpm check:web
pnpm build
```

This runs ESLint with Next.js and TypeScript rules, strict TypeScript, web unit tests and Prettier
`pnpm format` applies web/document formatting

Run C++ checks inside the rebuilt container

```sh
pnpm format:cpp:check
pnpm lint:cpp
cd apps/api
ctest --preset dev
cmake --preset sanitize
cmake --build --preset sanitize --parallel 2
ctest --preset sanitize
```

`pnpm format:cpp` applies Google clang-format
clang-tidy checks project source and tests using the real compilation database
Compiler warnings and clang-tidy findings fail checks
Sanitizer presets enable AddressSanitizer, UndefinedBehaviorSanitizer and leak detection for project C++ targets
Drogon and system libraries are built without instrumentation

Watcher integration checks compile a small real C++ fixture in a temporary directory
They cover edits, compile/configuration failures, file deletion/addition, recovery and process cleanup

```sh
pnpm test:tools
```

Run full-stack tests from the host with Docker, Node.js and the fixed pnpm version
Install web packages and Playwright Chromium first as described in README

```sh
sh tests/test-stack.sh
COMPOSE_FILE=compose.yaml:tests/compose.sanitize.yaml sh tests/test-stack.sh
```

Each run creates an isolated Compose project and a fresh database
Only that test project's containers and volumes are removed on exit
The tests cover real PostgreSQL responses, browser success/retry at two screen sizes, DB/API outages, recovery and data persistence
The sanitizer variant also runs the instrumented API against real HTTP/DB traffic and checks its logs after graceful shutdown
Set `TEST_WEB_PORT` if 3100 is in use

## CI

`.github/workflows/ci.yaml` runs on pushes and pull requests
It has web quality/build checks, C++ format/static/unit/watcher checks and release/sanitizer stack jobs
Each stack job builds real images and runs the browser and PostgreSQL outage tests
Failure output includes Compose logs and retained browser traces
The workflow has read-only repository permissions and makes no deployment
A local run of these commands is not a confirmed GitHub Actions run

## Dependency policy

- Node.js is fixed to 24.15.0 in images, CI and `.nvmrc`
- pnpm is fixed to 11.25.0 in `packageManager`, image installation and CI
- Direct web dependencies use exact versions, including PostCSS
- TypeScript 7 runs `tsc`, the official TypeScript 6 compatibility alias supplies the API required by typescript-eslint
- Package downloads allow up to 10 minutes per request for slow development networks
- Scripts fail on stale dependencies instead of silently installing changed versions
- Commit `pnpm-lock.yaml`, use `pnpm install --frozen-lockfile` for normal setup and CI
- pnpm settings use `pnpm-workspace.yaml`, `.npmrc` contains only registry configuration
- Only esbuild and sharp dependency build scripts are allowed by the workspace policy
- unrs-resolver uses prebuilt platform packages, its fallback build script is explicitly disabled
- Drogon source and its submodules stay fixed by the Dockerfile commit
- Keep the existing CMake source build for Drogon, no additional vcpkg layer is needed in this stage
- Container base images use explicit tags and multi-platform digests in Dockerfiles/Compose
- Debian packages come from Bookworm repositories, their exact versions are not locked
- GitHub Actions use major version tags, updates within those tags are allowed

This fixes application dependency resolution, but does not promise bit-for-bit identical images
Debian repository updates can change compiler patch versions and system libraries
The CI toolchain image is also the dev toolchain, keeping local and CI checks aligned

For an update, change exact versions together with the lockfile and any related CI/image versions
Use `pnpm install --no-frozen-lockfile` only for an intentional dependency update
Review the lockfile diff and run web, C++ and stack checks before accepting it
Refresh base image digests deliberately to receive OS fixes
Do not commit local `.env`, generated build files, database volumes or uploaded data

TypeScript compatibility follows the [Microsoft side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)

Package settings follow the [pnpm 11 configuration format](https://pnpm.io/blog/releases/11.0)
