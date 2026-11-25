# Contributing and operations

- [Validate](#validate)
- [Docker](#docker)
- [GitHub checks and GHCR releases](#github-checks-and-ghcr-releases)
- [Production Compose, updates, and rollback](#production-compose)

The delivery setup follows the conventions of the sibling `hyperprism-js` project (multi-stage digest-pinned image, hardened Compose, SemVer-tag GHCR publishing). That project is a reference only; nothing here depends on it at build or run time.

## Validate

Run `make` for the target list. The Makefile provides syntax and whitespace checks with Node, Python, and Bash. It uses the existing test suites and requires no npm packages. Use the Node version in `.nvmrc` for validation so the multiplayer tests have the built-in WebSocket client.

| Target | What it runs |
| --- | --- |
| `make lint` | JavaScript, Python, and Bash syntax checks and source whitespace checks |
| `make test-unit` | Engine, leaderboard, and release tests |
| `make test-multiplayer` | Multiplayer protocol tests with a dedicated server |
| `make validate-single` | Engine and leaderboard tests plus the offline browser flow |
| `make validate-multiplayer` | Multiplayer protocol tests plus a two-browser online match |
| `make validate` | Lint, all Node tests, and both browser suites |

For manual validation, run `make serve-single` and open `http://127.0.0.1:8069/` to start a local battle. Run `make serve-multiplayer` and open `http://127.0.0.1:8070/` in two separate browser profiles to create and join an online battle. Both servers bind to loopback and run in the foreground. Stop either one with Ctrl+C.

Override `SINGLE_PORT`, `MULTIPLAYER_PORT`, or `BIND` on the Make command line, for example `make serve-multiplayer MULTIPLAYER_PORT=8090`. To run the delivery checks against that server, use `make test-delivery MULTIPLAYER_PORT=8090` from a second terminal after the server starts. For a different base URL, set `DELIVERY_URL`. Browser targets accept `PYTHON=/path/to/venv/bin/python` for a virtual environment with Playwright installed.

```sh
npm run test:release      # release-tag policy (node --test)
npm run build             # src/ -> dist/index.html
npm run test:engine       # engine, physics, terrain, AI games (~80 s)
npm run test:multiplayer  # real server + WebSocket clients, full games, reconnect, spectate (~60 s)
npm start &               # then:
npm run test:delivery     # HTTP contract + WebSocket origin policy + live lobby/battle session
npm run test:browser      # Playwright/Chromium: local play + two-browser online match
```

`npm run validate` runs the release, build, unit and browser checks in sequence. The browser suites need Python 3 with Playwright and Chromium (`pip install playwright && playwright install chromium`).

There are no npm dependencies and no lockfile. The bundler, server, tests and scripts use only Node built-ins, so `npm ci` is never needed. CI uses the Node version in `.nvmrc`; the server itself runs on Node 18 or newer.

`scripts/check-delivery.mjs` takes one or more base URLs (default `http://127.0.0.1:8080/`). For each one it checks:
- The served page matches the local `dist/index.html` byte for byte.
- Security headers, plus a CSP whose hashes match the page's inline `<script>` and `<style>`.
- `no-cache`, gzip, ETag/304 and HEAD.
- 404 for source, config and traversal paths, and 405 for other methods.
- `/healthz` reports healthy.
- A cross-site WebSocket is refused (403) and a same-origin one accepted (101).
- A real session plays through: lobby → room → bot → vote → shop → battle with terrain.

Build `dist/` from the same source as the server you check.

## Docker

The image is multi-stage, using the digest-pinned `node:24.21.0-alpine` base for both stages.
- **Build stage:** runs natively (`--platform=$BUILDPLATFORM`) and bundles `src/` into `dist/index.html`.
- **Runtime stage:** contains the server, shared game and leaderboard code, and `dist/`. Application files are root-owned and read-only to the runtime user `1000:1000`.
- **Process:** Node is PID 1 on port `8080` and handles SIGTERM itself. It warns players in every room, stops accepting connections and closes sockets with code 1001.
- **Build context:** `.dockerignore` is an allowlist, so only the build inputs are sent.

```sh
npm run build
docker build -t scorched-earth:local .
npm run test:container
```

The smoke check needs Docker Compose v2+, Python 3, curl and Node. It starts the real `deploy/compose.production.yml` under its own project and network, then:
- Asserts the hardening actually applied: uid 1000, read-only root filesystem, no effective capabilities, no-new-privileges, `/tmp` tmpfs flags, pids/memory/CPU limits, log rotation, loopback port binding, healthy status and the Node heap cap.
- Runs the delivery check at the root.
- Runs it again behind a stock nginx (digest-pinned, `deploy/nginx/test-prefix.conf`) at `/qa/scorched/`, including the WebSocket upgrade through the proxy.
- Stops the container and requires exit code 0 within 15 s.

It uses loopback ports 18096 and 18097, which you can override with `SCORCHED_PORT` and `SCORCHED_PROXY_PORT`. Evidence and logs go to `evidence/deployment/<arch>/`. Set `SCORCHED_IMAGE` to test another image and `SCORCHED_SKIP_PREFIX=1` to skip the nginx stage. It never touches a running production stack.

ARM64 images build and run locally (the smoke check derives the platform from the image). GitHub Actions publishes only `linux/amd64`.

## GitHub checks and GHCR releases

[Verify and publish](.github/workflows/publish.yml) runs on every pull request, every push to `main`, and every version-tag push.
- **Security:** it uses Node from `.nvmrc`, SHA-pinned actions, a read-only default token, and checkout without persisted credentials.
- **Permissions:** PRs never log in to GHCR or get `packages: write`. Only the publish job has that permission, using the repository's `GITHUB_TOKEN`; no personal token or deploy secret is needed.

| Job | Runs on | What it does |
| --- | --- | --- |
| `Validate release metadata` | everything | Parses the ref with `scripts/release-metadata.mjs`; invalid version-like tags fail before any build |
| `Build and test` | everything | Release-policy tests, bundle build, engine/AI tests, multiplayer protocol tests, delivery check against a live server (15 min timeout) |
| `Build PR container (amd64)` | pull requests | Builds and loads the image without pushing, runs it hardened (read-only, no capabilities) and repeats the delivery check, then verifies a clean SIGTERM exit |
| `Publish GHCR image` | valid version tags | Builds `linux/amd64` with OCI labels, SBOM and BuildKit provenance, pushes the tags, prints the digest in the job summary |

Set branch protection to require `Validate release metadata`, `Build and test` and `Build PR container (amd64)`. Protect version tags with repository rulesets.

| Git tag | GHCR tags |
| --- | --- |
| `v0.1.0` or `0.1.0` | `0.1.0`, `sha-<full commit SHA>`, `latest` |
| `v0.2.0-rc.1` or `0.2.0-rc.1` | `0.2.0-rc.1`, `sha-<full commit SHA>` |

Tags must be valid SemVer without leading zeros or `+build` metadata. Prereleases never move `latest`. Publications are serialised, but `latest` follows publication order. Prefer the digest for production and rollback; only the digest is immutable.

Versions are managed with commitizen (`.cz.toml`, `version_provider = "npm"`). `package.json` is the source of truth, while `version_files` keeps the browser/server `APP_VERSION` in `src/config.js` synchronized. `cz bump` updates both files and `CHANGELOG.md`, then creates the tag. You can also tag manually:

```sh
git tag -a v0.1.0 -m "Release 0.1.0"
git push origin v0.1.0
```

The registry path is `ghcr.io/<lowercase owner>/<lowercase repository>`. For example, `oberones/scorched-earth-claude` publishes to `ghcr.io/oberones/scorched-earth-claude`. Package visibility is managed in GitHub Packages. The workflow only publishes images; deployment is a separate operator action.

## Production Compose

Copy `deploy/.env.example` to `deploy/.env` and set `SCORCHED_IMAGE` to the published version or, preferably, the digest from the workflow summary. The Compose file requires an explicit image and never builds. It joins the shared external `web-backend` network, like the other services behind your reverse proxy.

```sh
cp deploy/.env.example deploy/.env
# Edit deploy/.env: image, platform, port, network, allowed origins.
docker network inspect web-backend   # create it only if missing: docker network create web-backend
docker compose --env-file deploy/.env -f deploy/compose.production.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.production.yml pull
docker compose --env-file deploy/.env -f deploy/compose.production.yml up -d --no-build --pull never --wait --wait-timeout 90
docker compose --env-file deploy/.env -f deploy/compose.production.yml ps
docker compose --env-file deploy/.env -f deploy/compose.production.yml logs --tail 100
```

For a private package, log in on the host with `docker login ghcr.io --username YOUR_GITHUB_USER --password-stdin` using a token with `read:packages`. Keep credentials out of `.env`, Compose and Git.

Compose keeps the online leaderboard in the `leaderboard` named volume at `/var/lib/scorched`. Keep that volume when replacing containers. Outside Docker, the server stores records in `.data/leaderboard.json` by default. Set `LEADERBOARD_FILE` to choose a writable location.

Compose applies these limits:
- **Security:** read-only root filesystem, all capabilities dropped, no-new-privileges.
- **Resources:** a 16 MiB non-executable `/tmp`, 64 processes, 256 MiB memory with the V8 heap capped at 192 MiB, and one CPU.
- **Health and logs:** a `/healthz` health check and rotating logs.
- **Lifecycle:** a 30-second stop grace period, restart unless stopped, and loopback-only binding (default `127.0.0.1:8095`).

TLS belongs to your HTTPS reverse proxy; the container speaks HTTP and WebSocket only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCORCHED_IMAGE` | (required) | Image tag or `@sha256:` digest |
| `SCORCHED_PORT` | `8095` | Loopback port on the host |
| `SCORCHED_NETWORK` | `web-backend` | External proxy network |
| `SCORCHED_ALLOWED_ORIGINS` | empty | Extra browser origins allowed to open `/ws`; same-host pages are always allowed, `*` disables the check |
| `SCORCHED_MAX_CLIENTS` / `SCORCHED_MAX_ROOMS` | `1000` / `200` | Connection and room caps |
| `SCORCHED_LOG_LEVEL` | `info` | `quiet` silences connection logs |

**Reverse proxy.** `/ws` needs the WebSocket upgrade headers and a read timeout above the server's 25 s ping. Forward the original `Host` (`$http_host`), because the server compares it with the browser's `Origin`. The client resolves `ws` relative to the page, so the game works at a dedicated hostname or under a path prefix. See `deploy/nginx/scorched.conf.example`. For a proxy container on `web-backend`, proxy to `http://scorched-earth:8080/`.

**Single instance.** Rooms and battles live in the server's memory. Run exactly one replica; do not scale it horizontally or put it behind a non-sticky load balancer. One process comfortably handles dozens of concurrent battles (an AI turn costs about 60 ms of CPU to plan).

**Update and rollback.** Keep the previous digest. Change `SCORCHED_IMAGE`, then repeat `pull` and `up --wait`.
- On SIGTERM the old container warns every room and closes sockets cleanly.
- Browsers reconnect automatically to the new container and land in the lobby. Battles in progress are not carried across a restart, so deploy between game nights if you can.
- To roll back, restore the previous digest and repeat the same commands. There is no persistent data or migration.
- Update the pinned base-image digests and action SHAs through reviewed PRs.
