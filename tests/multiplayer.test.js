// Multiplayer protocol test: node tests/multiplayer.test.js
// Starts the real server, connects several WebSocket clients and plays a full game:
// lobby -> bots/settings -> vote -> countdown -> shop -> rounds -> game over,
// including a mid-game disconnect + reconnect and a spectator joining.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  env: Object.assign({}, process.env, { PORT, LOG_LEVEL: 'quiet', COUNTDOWN_MS: 300, ROUND_PAUSE_MS: 300, SHOP_MS: 4000 }),
  stdio: ['ignore', 'inherit', 'inherit'],
});

class TestClient {
  constructor(name) { this.name = name; this.msgs = []; this.waiters = []; this.fired = new Set(); this.autoFire = true; }
  connect(token) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.onopen = () => { this.send({ t: 'hello', name: this.name, token }); };
      this.ws.onerror = rej;
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        this.msgs.push(m);
        if (m.t === 'welcome') { this.id = m.id; this.token = m.token; res(this); }
        if (m.t === 'gameStart') { this.tank = m.yourTank; this.gameStarts = (this.gameStarts || 0) + 1; }
        if (m.t === 'room') this.room = m;
        if (m.t === 'snap') {
          this.snap = m;
          if (m.terrain) this.gotTerrain = (this.gotTerrain || 0) + 1;
          const key = `${m.round}:${m.turnCount}`;
          if (this.autoFire && m.stage === 'play' && m.phase === 'aim' && m.turn === this.tank && !this.fired.has(key)) {
            this.fired.add(key);
            const me = m.tanks[this.tank];
            // aim roughly at the nearest live enemy
            const foes = m.tanks.filter(t => t.alive && t.id !== this.tank);
            const f = foes.sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
            const a = f && f.x > me.x ? 50 : 130;
            const d = f ? Math.abs(f.x - me.x) : 300;
            this.send({ t: 'aim', a: a - 5, p: 300 });
            this.send({ t: 'fire', a, p: Math.min(me.h * 10, 260 + d * 0.62), w: 'baby' });
          }
        }
        this.waiters = this.waiters.filter(w => { if (w.pred(m)) { w.res(m); return false; } return true; });
      };
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  // resolves with the first not-yet-consumed message (history included) matching pred
  wait(pred, ms = 20000, label = '', after = null) {
    this.used = this.used || new Set();
    const start = after ? this.msgs.indexOf(after) + 1 : 0;
    const hit = this.msgs.slice(start).find(m => !this.used.has(m) && pred(m));
    if (hit) { this.used.add(hit); return Promise.resolve(hit); }
    return new Promise((res, rej) => {
      const w = { pred: (m) => pred(m), res: (m) => { this.used.add(m); res(m); } };
      this.waiters.push(w);
      setTimeout(() => rej(new Error(`${this.name}: timeout waiting for ${label}`)), ms);
    });
  }
  next(type, ms, extra = () => true, after = null) { return this.wait(m => m.t === type && extra(m), ms, type, after); }
  close() { this.ws.close(); }
}

(async () => {
  let ok = 0;
  const pass = (s) => { ok++; console.log('  ok -', s); };
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await sleep(100); } }

  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.strictEqual(page.status, 200);
  assert((await page.text()).includes('Scorched Earth'));
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/../server/server.js`)).status, 404);
  pass('serves the game page and blocks path traversal');

  const A = await new TestClient('Alice').connect();
  const B = await new TestClient('Bob').connect();
  const roomP = A.next('room');
  A.send({ t: 'createRoom', name: 'Test Arena' });
  const room = await roomP;
  assert.strictEqual(room.members.length, 1);
  assert.strictEqual(room.hostId, A.id);
  const list = await B.next('rooms', 3000, m => m.rooms.some(r => r.code === room.code));
  assert(list.rooms.find(r => r.code === room.code).name === 'Test Arena');
  pass('host creates a room and it appears in the lobby list');

  B.send({ t: 'joinRoom', code: room.code.toLowerCase() });
  await A.next('room', 3000, m => m.members.length === 2);
  pass('second player joins by code (case-insensitive)');

  B.send({ t: 'settings', settings: { rounds: 1 } });
  await B.next('error', 3000);
  A.send({ t: 'settings', settings: { rounds: 2, turnTime: 20 } });
  A.send({ t: 'addBot', difficulty: 'hard' });
  const withBot = await B.next('room', 3000, m => m.bots.length === 1 && m.settings.rounds === 2);
  assert.strictEqual(withBot.settings.turnTime, 20);
  pass('only the host may change settings / add bots');

  A.send({ t: 'chat', text: 'gl hf <script>' });
  const chat = await B.next('chat', 3000, m => m.from === 'Alice');
  assert.strictEqual(chat.text, 'gl hf script');
  pass('chat is relayed and sanitised');

  A.send({ t: 'vote', on: true });
  const one = await A.next('room', 3000, m => m.members.find(x => x.id === A.id).vote);
  assert.strictEqual(one.stage, 'lobby', 'one vote of two should not start');
  B.send({ t: 'vote', on: true });
  await A.next('room', 3000, m => m.stage === 'countdown');
  pass('game waits for every player to vote, then counts down');

  const gsA = await A.next('gameStart', 5000);
  await B.next('gameStart', 5000);
  assert.strictEqual(gsA.tanks.length, 3);
  assert.notStrictEqual(A.tank, B.tank);
  await A.next('shop', 3000);
  A.send({ t: 'buy', id: 'missile' });
  await A.wait(m => m.t === 'snap' && m.tanks[A.tank].inv.missile === 5, 3000, 'missile bought');
  A.send({ t: 'shopDone' }); B.send({ t: 'shopDone' });
  await A.wait(m => m.t === 'snap' && m.stage === 'play' && m.terrain, 5000, 'round start');
  pass('vote starts the game, shop works, round begins with terrain');

  // mid-game: B drops and comes back with its token
  await sleep(1500);
  const token = B.token, tank = B.tank;
  B.close();
  await A.next('chat', 5000, m => /autopilot/.test(m.text));
  await A.wait(m => m.t === 'snap' && m.tanks[tank].auto, 3000, 'autopilot');
  const B2 = new TestClient('Bob');
  await B2.connect(token);
  await B2.next('gameStart', 3000);
  assert.strictEqual(B2.tank, tank);
  await B2.wait(m => m.t === 'snap' && m.terrain && !m.tanks[tank].auto, 3000, 'reconnected snapshot');
  pass('disconnect hands the tank to autopilot; reconnect restores control + full state');

  const S = await new TestClient('Sam').connect();
  S.send({ t: 'joinRoom', code: room.code });
  const gsS = await S.next('gameStart', 3000);
  assert.strictEqual(gsS.yourTank, null);
  pass('late joiner spectates the running battle');

  const over = await A.next('gameOver', 240000);
  assert.strictEqual(over.standings.length, 3);
  const lobbyAgain = await A.next('room', 5000, m => m.stage === 'lobby', over);
  assert.strictEqual(lobbyAgain.members.length, 3);
  assert.strictEqual(lobbyAgain.members.filter(m => !m.spectator).length, 3, 'spectator gets a seat for the next game');
  const firedA = A.fired.size, firedB = B2.fired.size;
  console.log(`    shots fired by clients: Alice ${firedA}, Bob ${firedB}; snapshots seen by Alice: ${A.msgs.filter(m => m.t === 'snap').length}`);
  assert(firedA > 0 && firedB > 0);
  pass('full 2-round game completes and the room returns to the lobby');

  S.send({ t: 'leaveRoom' });
  await A.next('room', 3000, m => m.members.length === 2);
  A.send({ t: 'leaveRoom' });
  await B2.next('room', 3000, m => m.hostId === B2.id);
  pass('host hand-over when the host leaves');

  console.log(`\n${ok} multiplayer tests passed`);
  srv.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); srv.kill(); process.exit(1); });
