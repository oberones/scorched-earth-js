# Repository Guidelines

## Project Structure & Module Organization

Browser code lives in `src/`; rules, physics, AI, rendering, UI, audio, and networking have separate modules. `server/server.js` is the HTTP/WebSocket entry point, supported by `server/lib/`. Tests are under `tests/`; release and delivery checks are in `scripts/`. Model sources and exports live in `models/`, with generators in `tools/` and `blender/`. Deployment files are in `deploy/` and `.github/workflows/`. `dist/index.html` is generated and ignored—do not edit or commit it.

## Build, Test, and Development Commands

The project requires Node 18+ (CI uses `.nvmrc`) and has no npm dependencies or lockfile.

- `npm run build` bundles `src/` into the self-contained `dist/index.html`.
- `npm start` serves the built game and WebSocket endpoint at `http://localhost:8080`.
- `npm test` runs the engine/AI and multiplayer protocol suites.
- `npm run test:release` checks SemVer-to-container-tag behavior.
- `npm run test:browser` runs Python Playwright smoke and multiplayer flows; install Playwright and Chromium first.
- `npm run validate` performs the standard release, build, Node, and browser checks.
- `npm run models` regenerates glTF files and `src/models.js` after edits to `models/tank_spec.py`.

## Coding Style & Naming Conventions

Match existing JavaScript: two-space indentation, single quotes, semicolons, `camelCase` variables/functions, and `PascalCase` classes. Use `UPPER_SNAKE_CASE` for constants. Keep browser files compatible with the global/script loading model; core engine files are also loaded by Node. No formatter or linter is configured, so follow neighboring code.

## Testing Guidelines

Add deterministic regression tests for gameplay, physics, protocol, or release changes. Node tests use built-in `assert`; release tests use `node:test`. Name Node suites `*.test.js` and browser flows descriptively as `*.py`. There is no numeric coverage threshold. Run the narrowest relevant script while iterating, then `npm run validate` before opening a PR.

## Commit & Pull Request Guidelines

Commitizen is configured for Conventional Commits. Prefer concise, imperative subjects such as `fix: update shot mechanics` or `feat: add spectator chat`; use `test:`, `docs:`, and `chore:` where appropriate. PRs should explain user-visible behavior and architecture impact, link related issues, list validation commands, and include screenshots for UI or rendering changes. Call out protocol, deployment, environment-variable, or generated-model changes explicitly.

## Security & Configuration

Never commit `.env` files or credentials; extend `deploy/.env.example` for new settings. Preserve WebSocket origin checks, CSP/security headers, path traversal protections, and the hardened container defaults when changing server or deployment code.
