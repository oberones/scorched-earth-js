# Scorched Earth — JavaScript MVP

A modern take on the classic artillery game, played in the browser. You can play locally against AI or hotseat by opening `dist/index.html` (run `npm run build` first in a fresh clone), or online with friends through the bundled multiplayer server. Neither needs any npm dependencies.

## Features
- **Game loop:** setup → arms dealer → rounds of turn-based play → round summary → final standings. It supports 2–6 combatants, hotseat play for several humans, and AI-only games you can watch.
- **Ballistics:** a fixed-step (120 Hz) simulation with gravity and wind. The wind can be gusty, steady or calm. Walls can be open, rubber (bouncy) or wrap-around. A damaged tank has less maximum power (health × 10, as in the classic game).
- **Destructible terrain:** a procedural heightmap (hills, mountains or plains). Blasts carve craters and the soil above collapses into them. Dirt balls build mounds. Tanks fall and take fall damage unless they carry a parachute.
- **Weapons:** Baby Missile (unlimited), Missile, Leapfrog (bounces), MIRV (splits at the top of its arc), Baby Nuke, Nuke, Dirt Ball, Digger. **Items:** Shield, Parachute, Repair Kit.
- **Scoring:** 1 point per point of damage dealt, +100 per kill and +150 for surviving a round. You lose points for hitting yourself. Points turn into cash for the shop.
- **AI:** solves its shots by running the same physics as the game, so it knows exactly where a shot will land. Each AI picks a random opponent (human or AI) and keeps attacking it until it is destroyed, then picks a new random target; targets reset every round. Each difficulty adds aim noise that shrinks as the AI keeps firing at the same target ("bracketing"):
  - **Easy** ignores wind and picks weapons at random.
  - **Medium** reads wind and uses its better weapons when they're safe.
  - **Hard / Expert** aim more precisely, pick weapons that won't blow themselves up, and shop smarter.
- **3D assets:** low-poly tank, missile and nuke models. The renderer draws them on a 2D canvas with flat shading, specular highlights and depth sorting, and the barrel is jointed so it follows the aim.

## Online multiplayer

### Running the server
```
node server/server.js            # http://localhost:8080  (Node >= 18, no npm install)
PORT=3000 HOST=127.0.0.1 node server/server.js
```
The server does two jobs on one port. It serves the game page (`dist/index.html`) at `/` and the WebSocket endpoint at `/ws`, and `/healthz` returns JSON status. Players open the server's URL and click **Play online**.

**Deploying:** the project ships a hardened container image, a production Docker Compose file and a GitHub Actions pipeline that publishes to GHCR on version tags. See [CONTRIBUTING.md](CONTRIBUTING.md#production-compose) for the full runbook. In short:
```
docker build -t scorched-earth:local . && npm run test:container      # local image + smoke test
git tag -a v0.1.0 -m "Release 0.1.0" && git push origin v0.1.0        # CI publishes ghcr.io/<owner>/<repo>
cp deploy/.env.example deploy/.env                                    # set SCORCHED_IMAGE to the digest
docker compose --env-file deploy/.env -f deploy/compose.production.yml up -d --wait
```
Behind a reverse proxy, `/ws` needs the WebSocket upgrade headers (see `deploy/nginx/scorched.conf.example`). The game works at its own hostname or under a path prefix.

### How it plays
1. **Lobby:** pick a callsign, then create a battle or join one from the list. You can also join by its 4-letter code, or share an invite link (`…/#room-ABCD`).
2. **Room:** shows players, colours, chat and AI bots, with a cap of 6 combatants. The host (the first player in) adds or removes bots and sets rounds, terrain, walls, wind and the turn timer. Changing a setting resets votes.
3. **Vote to start:** the game launches once every seated player has voted and there are at least 2 combatants. Withdrawing a vote cancels the countdown.
4. **Battle:** everyone shops in parallel between rounds, with a 45 s limit. Each turn has a timer, and a shot fires automatically when it runs out. Press **T** to chat.
5. **After the game:** final standings are shown and the room returns to the lobby for a rematch vote.

**Resilience:**
- If a player disconnects mid-battle, their tank switches to **autopilot**.
- Reloading the tab, or a dropped connection, reconnects automatically and restores control. The session token is kept per tab.
- People who join during a battle **spectate** and get a seat in the next game.

### Architecture
- **Server-authoritative.** The server loads the *same* engine files the browser uses (`src/config, terrain, physics, ai, game`) and runs each room's match at 60 Hz.
- **Clients send only inputs:** `aim`, `fire`, `repair`, `buy`, `sell`, `shopDone`. They receive 30 Hz snapshots: tanks, shells, blasts and events. Terrain is sent only when it changes, quantised to about 3.4 KB.
- **Smooth rendering:** the browser plays snapshots back about 110 ms behind live, interpolating tanks, turrets and shells (`NetGame` in `src/net.js`). It then hands them to the unchanged renderer and HUD.
- **Your own turret responds instantly** and streams your aim at 12 Hz, so others watch you line up the shot.
- **WebSocket layer:** `server/lib/websocket.js` is a small RFC 6455 implementation with ping keepalive, a 64 KB frame limit and per-client rate limiting.
- **Protocol:** documented at the top of `server/lib/lobby.js`.

**Scaling note:** each room runs in the server process. AI turns take about 60 ms of CPU to plan, so one process comfortably handles dozens of concurrent rooms.

## Layout
```
models/tank_spec.py        geometry source of truth (plain Python)
models/*.gltf              glTF 2.0 exports (open in Blender, three.js, etc.)
blender/build_models.py    Blender script: builds the models, materials and barrel joint; exports .glb + .blend
tools/export_models.py     spec → models/*.gltf + src/models.js (no Blender needed)
tools/build.js             bundles src/ into dist/index.html (one self-contained file)
src/                       game: config, terrain, physics, ai, game (rules/state machine),
                           render3d (mesh renderer), renderer, audio (Web Audio), ui, main
src/net.js                 online client: connection, lobby/room UI, NetGame snapshot interpolation
server/server.js           HTTP + WebSocket server entry point
server/lib/                websocket.js (RFC 6455), engine.js (loads src/ engine), lobby.js (rooms, votes, matches),
                           static.js (cached delivery: security headers, CSP hashes, gzip, ETag)
Dockerfile, .dockerignore  multi-stage, digest-pinned, non-root runtime image
deploy/                    compose.production.yml, .env.example, nginx proxy configs
.github/workflows/         publish.yml - verify on PRs/main, publish to GHCR on SemVer tags
scripts/                   release-metadata (+ tests), check-delivery.mjs, check-container.sh
tests/headless.test.js     full AI-vs-AI games in Node, physics/terrain/shop tests
tests/multiplayer.test.js  protocol test: real server + WebSocket clients, full game, reconnect, spectate
tests/multiplayer_browser.py  two Chromium players play an online match end-to-end
tests/browser_check.py     Playwright smoke test of local play with screenshots
```

## Workflow
```
npm run models                                       # after editing models/tank_spec.py
blender --background --python blender/build_models.py  # optional: get .glb/.blend in Blender
npm run build                                        # rebuild dist/index.html (gitignored)
npm start                                            # server on :8080
npm test                                             # engine + multiplayer tests
```
See [CONTRIBUTING.md](CONTRIBUTING.md#validate) for the full validation list.
To develop, you can also open `src/index.html` directly, since it loads the scripts one by one.

## Controls
←/→ aim · ↑/↓ power (Shift = fine) · Q/E/Tab weapon · R repair · Space fire · T chat (online) · Esc pause/menu.
Your turret keeps its angle and power between turns (it resets each round, when tanks are re-placed). You can also click and drag on the battlefield to aim; a plain click doesn't change your aim. The ◄ ► − + buttons work by mouse or touch.
