// ---------------------------------------------------------------------------
// Lobby, rooms, start-vote and the authoritative match loop.
//
// Protocol: JSON text messages, each with a `t` (type) field.
//   client -> server: hello, createRoom, joinRoom, leaveRoom, color, vote, settings,
//                     addBot, removeBot, chat, aim, fire, repair, buy, sell, shopDone
//   server -> client: welcome, rooms, room, error, chat, gameStart, snap, shop,
//                     roundOver, gameOver
// The server runs the real Game; clients send inputs and render snapshots.
// ---------------------------------------------------------------------------
'use strict';
const crypto = require('crypto');
const E = require('./engine');

const MAX_SEATS = 6;
const TICK_HZ = 60;
const SNAP_EVERY = 2;              // snapshots at 30 Hz
const COUNTDOWN_MS = +process.env.COUNTDOWN_MS || 3000;
const ROUND_PAUSE_MS = +process.env.ROUND_PAUSE_MS || 7000;       // round summary on screen before the shop opens
const SHOP_MS = +process.env.SHOP_MS || 45000;
const EMPTY_ROOM_GRACE_MS = 60000; // keep a battle alive this long with nobody connected
const CLIENT_GRACE_MS = 120000;    // remember a disconnected client (for reconnect)
const MAX_ROOMS = +process.env.MAX_ROOMS || 200;
const DIFFS = ['easy', 'medium', 'hard', 'expert'];
const TURN_TIMES = [0, 20, 30, 45, 60, 90];

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(+v) ? +v : a));
const rid = (n) => crypto.randomBytes(n).toString('hex');

function encodeTerrain(ground) {
  const b = Buffer.alloc(ground.length * 2);
  for (let i = 0; i < ground.length; i++) b.writeUInt16LE(Math.round(Math.max(0, ground[i]) * 8), i * 2);
  return b.toString('base64');
}

// Replace tank references in events with {$t: id}; drop bulky arrays.
function serEvent(e) {
  const o = {};
  for (const k in e) {
    const v = e[k];
    if (v && typeof v === 'object') {
      if ('inventory' in v) o[k] = { $t: v.id };
      continue;
    }
    o[k] = v;
  }
  return o;
}

class Client {
  constructor(lobby, ws) {
    this.lobby = lobby;
    this.id = rid(4);
    this.token = rid(16);
    this.name = 'Player';
    this.room = null;
    this.ws = null;
    this.connected = false;
    this.tv = -1;                 // terrain version this client has
    this.bucket = 80; this.bucketAt = Date.now();
    this.attach(ws);
  }
  attach(ws) {
    this.ws = ws;
    this.connected = true;
    this.tv = -1;
    clearTimeout(this.forgetTimer);
  }
  send(msg) { if (this.connected && this.ws) this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
  allow() { // token bucket: ~40 msgs/s sustained, burst 80
    const now = Date.now();
    this.bucket = Math.min(80, this.bucket + (now - this.bucketAt) * 0.04);
    this.bucketAt = now;
    if (this.bucket < 1) return false;
    this.bucket--;
    return true;
  }
}

class Room {
  constructor(lobby, host, name) {
    this.lobby = lobby;
    let code;
    do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (lobby.rooms.has(code));
    this.code = code;
    this.name = clean(name, 24) || `${host.name}'s battle`;
    this.hostId = host.id;
    this.members = [];            // Client objects, join order
    this.colors = new Map();      // clientId|botId -> colour index
    this.votes = new Set();
    this.bots = [];
    this.settings = { rounds: 5, terrain: 'random', walls: 'open', windMode: 'changing', turnTime: 45 };
    this.stage = 'lobby';         // lobby | countdown | shop | play | roundOver
    this.game = null;
    this.tankOf = new Map();      // clientId -> tank id
    this.chatLog = [];
  }

  // ---------------------------------------------------------------- members
  seatsUsed() { return this.players().length + this.bots.length; }
  players() {
    if (this.inGame()) return this.members.filter(c => this.tankOf.has(c.id));
    const free = MAX_SEATS - this.bots.length;
    return this.members.slice(0, Math.max(0, free));
  }
  isPlayer(c) { return this.players().includes(c); }
  inGame() { return this.stage === 'shop' || this.stage === 'play' || this.stage === 'roundOver'; }

  freeColor() {
    const used = new Set(this.colors.values());
    for (let i = 0; i < E.TEAM_COLORS.length; i++) if (!used.has(i)) return i;
    return 0;
  }

  join(c) {
    if (this.members.includes(c)) return;
    this.members.push(c);
    c.room = this;
    this.colors.set(c.id, this.freeColor());
    this.system(`${c.name} joined`);
    this.changed();
    if (this.inGame()) this.sendGameState(c);
  }

  leave(c, reason = 'left') {
    const i = this.members.indexOf(c);
    if (i < 0) return;
    if (this.inGame() && this.tankOf.has(c.id)) {
      // keep the tank in the battle, flown by autopilot
      this.autopilot(c, true);
    }
    this.members.splice(i, 1);
    this.colors.delete(c.id);
    this.votes.delete(c.id);
    c.room = null;
    if (this.hostId === c.id) this.hostId = this.members[0] ? this.members[0].id : null;
    this.system(`${c.name} ${reason}`);
    if (!this.members.length) return this.destroy();
    this.changed();
  }

  autopilot(c, on) {
    if (!this.game || !this.tankOf.has(c.id)) return;
    const t = this.game.tanks[this.tankOf.get(c.id)];
    if (on) { t.type = 'ai'; t.difficulty = 'medium'; t.autopilot = true; t.aiPlan = null; }
    else if (t.autopilot) { t.type = 'human'; t.autopilot = false; t.aiPlan = null; }
  }

  onDisconnect(c) {
    if (this.inGame()) {
      this.autopilot(c, true);
      this.system(`${c.name} lost connection - autopilot engaged`);
      if (!this.members.some(m => m.connected)) {
        this.emptyTimer = setTimeout(() => this.destroy(), EMPTY_ROOM_GRACE_MS);
      }
      this.changed();
    } else {
      this.leave(c, 'disconnected');
    }
  }

  onReconnect(c) {
    clearTimeout(this.emptyTimer);
    this.autopilot(c, false);
    this.system(`${c.name} reconnected`);
    this.changed();
    if (this.inGame()) this.sendGameState(c);
  }

  destroy() {
    clearInterval(this.loop);
    clearTimeout(this.timer);
    clearTimeout(this.emptyTimer);
    for (const c of this.members) c.room = null;
    this.members = [];
    this.lobby.rooms.delete(this.code);
    this.lobby.roomsChanged();
  }

  // ------------------------------------------------------------------- info
  info(forClient) {
    const players = this.players();
    return {
      t: 'room', code: this.code, name: this.name, hostId: this.hostId, stage: this.stage,
      countdownEnds: this.stage === 'countdown' ? this.countdownEnds : null,
      settings: this.settings, you: forClient.id, maxSeats: MAX_SEATS,
      members: this.members.map(m => ({
        id: m.id, name: m.name, color: E.TEAM_COLORS[this.colors.get(m.id)].hex,
        vote: this.votes.has(m.id), spectator: !players.includes(m), conn: m.connected,
      })),
      bots: this.bots.map(b => ({ id: b.id, name: b.name, difficulty: b.difficulty, color: E.TEAM_COLORS[this.colors.get(b.id)].hex })),
      chat: this.chatLog.slice(-40),
    };
  }

  changed() {
    this.checkVotes();
    for (const m of this.members) m.send(this.info(m));
    this.lobby.roomsChanged();
  }

  broadcast(msg) { const s = JSON.stringify(msg); for (const m of this.members) m.send(s); }

  system(text) { this.pushChat({ sys: true, text }); }
  pushChat(entry) {
    entry.ts = Date.now();
    this.chatLog.push(entry);
    if (this.chatLog.length > 100) this.chatLog.shift();
    this.broadcast(Object.assign({ t: 'chat' }, entry));
  }

  // ----------------------------------------------------------------- voting
  canStart() {
    const players = this.players();
    return players.length >= 1 && players.length + this.bots.length >= 2 &&
      players.every(p => this.votes.has(p.id) && p.connected);
  }

  checkVotes() {
    if (this.stage === 'lobby' && this.canStart()) {
      this.stage = 'countdown';
      this.countdownEnds = Date.now() + COUNTDOWN_MS;
      this.timer = setTimeout(() => { if (this.stage === 'countdown' && this.canStart()) this.startGame(); }, COUNTDOWN_MS);
      this.system('Everyone voted - battle starting!');
    } else if (this.stage === 'countdown' && !this.canStart()) {
      clearTimeout(this.timer);
      this.stage = 'lobby';
      this.system('Countdown cancelled');
    }
  }

  // ------------------------------------------------------------------- game
  startGame() {
    const players = this.players();
    const list = [
      ...players.map(c => ({ name: c.name, color: E.TEAM_COLORS[this.colors.get(c.id)].hex, type: 'human', clientId: c.id })),
      ...this.bots.map(b => ({ name: b.name, color: E.TEAM_COLORS[this.colors.get(b.id)].hex, type: 'ai', difficulty: b.difficulty })),
    ];
    const seed = crypto.randomInt(1, 2 ** 31);
    this.game = new E.Game(Object.assign({}, this.settings, { players: list, seed }));
    this.tankOf = new Map();
    list.forEach((p, i) => { if (p.clientId) this.tankOf.set(p.clientId, i); });
    this.votes.clear();
    this.lastTurnKey = null;
    this.broadcastGameStart();
    this.openShop();
    this.lobby.roomsChanged();
  }

  gameStartMsg(c) {
    const g = this.game;
    return {
      t: 'gameStart', seed: g.settings.seed, settings: this.settings,
      yourTank: this.tankOf.has(c.id) ? this.tankOf.get(c.id) : null,
      tanks: g.tanks.map(t => ({ id: t.id, name: t.name, color: t.color, type: t.type, difficulty: t.difficulty })),
    };
  }
  broadcastGameStart() { for (const m of this.members) m.send(this.gameStartMsg(m)); }

  sendGameState(c) {
    c.send(this.gameStartMsg(c));
    c.tv = -1;
    this.sendSnap([c]);
    if (this.stage === 'shop') c.send({ t: 'shop', ends: this.shopEnds, done: [...this.shopDone] });
    if (this.stage === 'roundOver') c.send({ t: 'roundOver', winner: this.game.lastWinner ? this.game.lastWinner.id : null });
  }

  openShop() {
    this.stage = 'shop';
    this.shopEnds = Date.now() + SHOP_MS;
    this.shopDone = new Set();
    this.broadcast({ t: 'shop', ends: this.shopEnds, done: [] });
    this.sendSnap();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.startRound(), SHOP_MS);
    this.checkShopDone();
  }

  checkShopDone() {
    if (this.stage !== 'shop') return;
    const waiting = this.players().filter(c => c.connected && !this.shopDone.has(c.id));
    if (!waiting.length) { clearTimeout(this.timer); this.timer = setTimeout(() => this.startRound(), 400); }
  }

  startRound() {
    if (this.stage !== 'shop') return;
    clearTimeout(this.timer);
    this.game.startRound();
    this.stage = 'play';
    this.turnStart = Date.now();
    this.tick = 0;
    this.last = Date.now();
    clearInterval(this.loop);
    this.loop = setInterval(() => this.step(), 1000 / TICK_HZ);
    this.lobby.roomsChanged();
  }

  step() {
    const g = this.game;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    // turn timer for human players
    const key = `${g.round}:${g.turnCount}:${g.turn}`;
    if (key !== this.lastTurnKey) { this.lastTurnKey = key; this.turnStart = now; }
    const limit = this.settings.turnTime * 1000;
    const cur = g.current;
    if (g.phase === 'aim' && cur && cur.type === 'human' && limit > 0 && now - this.turnStart > limit) {
      g.fire(); // time's up: shoot with whatever is dialled in
    }

    try { g.update(dt); } catch (err) { console.error(`[room ${this.code}]`, err); }
    this.tick++;
    if (g.phase === 'roundOver') return this.roundOver();
    if (this.tick % SNAP_EVERY === 0 || g.events.length > 8) this.sendSnap();
  }

  roundOver() {
    clearInterval(this.loop);
    this.sendSnap();
    this.stage = 'roundOver';
    const g = this.game;
    this.broadcast({ t: 'roundOver', winner: g.lastWinner ? g.lastWinner.id : null });
    this.timer = setTimeout(() => {
      g.continueAfterRound();
      if (g.phase === 'gameOver') this.gameOver();
      else this.openShop();
    }, ROUND_PAUSE_MS);
  }

  gameOver() {
    const g = this.game;
    this.sendSnap();
    this.broadcast({ t: 'gameOver', standings: g.standings().map(t => t.id) });
    const champ = g.standings()[0];
    this.system(`${champ.name} wins the war with ${champ.score} points`);
    this.stage = 'lobby';
    this.game = null;
    this.tankOf = new Map();
    // drop autopiloted players who never came back
    for (const m of this.members.filter(m => !m.connected)) this.leave(m, 'timed out');
    if (this.members.length) this.changed();
  }

  // ------------------------------------------------------------- snapshots
  snapshot(consumeEvents = true) {
    const g = this.game;
    return {
      t: 'snap', ts: Date.now(), stage: this.stage, phase: g.phase, round: g.round, rounds: g.settings.rounds,
      theme: g.theme, wind: g.wind, turn: g.turn, turnCount: g.turnCount,
      turnEnds: (this.stage === 'play' && g.phase === 'aim' && g.current && g.current.type === 'human' && this.settings.turnTime)
        ? this.turnStart + this.settings.turnTime * 1000 : null,
      winner: g.lastWinner ? g.lastWinner.id : null,
      tanks: g.tanks.map(t => ({
        id: t.id, x: +t.x.toFixed(2), y: +t.y.toFixed(2), a: +t.angle.toFixed(2), p: Math.round(t.power), w: t.weapon,
        h: t.health, sh: t.shield, alive: t.alive, falling: t.falling, chute: t.chute,
        score: t.score, money: t.money, kills: t.kills, wins: t.wins, rp: t.roundPoints, rd: t.roundDamage,
        inv: Object.fromEntries(Object.entries(t.inventory).map(([k, v]) => [k, v === Infinity ? -1 : v])),
        items: t.items, type: t.type, auto: !!t.autopilot,
      })),
      proj: g.projectiles.map(p => ({ id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1), w: p.weapon })),
      blasts: g.blasts.map(b => ({ x: b.x, y: b.y, r: b.r, t: +b.t.toFixed(3), dur: b.dur, nuke: !!b.nuke, dirt: !!b.dirt, color: b.color })),
      ev: consumeEvents ? g.events.splice(0).map(serEvent) : [],
    };
  }

  // `only` = send a private catch-up snapshot to these clients without consuming events
  sendSnap(only) {
    if (!this.game) return;
    const snap = this.snapshot(!only);
    const tv = this.game.terrain.version;
    const base = JSON.stringify(snap);
    let withTerrain = null;
    for (const m of only || this.members) {
      if (this.game.round && m.tv !== tv) {
        if (!withTerrain) withTerrain = JSON.stringify(Object.assign(snap, { terrain: encodeTerrain(this.game.terrain.ground), tv }));
        m.send(withTerrain);
        m.tv = tv;
      } else m.send(base);
    }
  }

  // ------------------------------------------------------------------ input
  myTank(c) {
    if (!this.game || !this.tankOf.has(c.id)) return null;
    return this.game.tanks[this.tankOf.get(c.id)];
  }

  applyAim(t, m) {
    const g = this.game;
    if (m.a != null) t.angle = clamp(m.a, 0, 180);
    if (m.p != null) t.power = clamp(m.p, 0, g.maxPower(t));
    if (typeof m.w === 'string' && E.WEAPONS[m.w] && t.inventory[m.w] > 0) t.weapon = m.w;
  }

  handleGame(c, m) {
    const g = this.game, t = this.myTank(c);
    if (!g || !t) return;
    const myTurn = this.stage === 'play' && g.phase === 'aim' && g.current === t && t.type === 'human';
    switch (m.t) {
      case 'aim': if (myTurn) this.applyAim(t, m); break;
      case 'fire': if (myTurn) { this.applyAim(t, m); g.fire(); } break;
      case 'repair': if (myTurn) g.useRepair(t); break;
      case 'buy': case 'sell':
        if (this.stage === 'shop' && !this.shopDone.has(c.id)) {
          if (m.t === 'buy') g.buy(t, String(m.id)); else g.sell(t, String(m.id));
          this.sendSnap();
        }
        break;
      case 'shopDone':
        if (this.stage === 'shop') {
          this.shopDone.add(c.id);
          this.broadcast({ t: 'shop', ends: this.shopEnds, done: [...this.shopDone] });
          this.checkShopDone();
        }
        break;
    }
  }
}

class Lobby {
  constructor({ log = console.log } = {}) {
    this.clients = new Map();   // token -> Client
    this.rooms = new Map();     // code -> Room
    this.log = log;
  }

  onConnection(ws) {
    let client = null;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (!client) {
        if (m.t !== 'hello') return;
        client = this.hello(ws, m);
        return;
      }
      if (!client.allow()) return;
      try { this.handle(client, m); } catch (err) { this.log('handler error', err); }
    });
    ws.on('close', () => { if (client && client.ws === ws) this.disconnect(client); });
  }

  hello(ws, m) {
    let c = m.token && this.clients.get(String(m.token));
    const resumed = !!(c && !c.connected);
    if (c && c.connected) c = null;          // token already in use in another tab
    if (c) c.attach(ws);
    else { c = new Client(this, ws); this.clients.set(c.token, c); }
    c.name = clean(m.name, 16) || c.name;
    c.send({ t: 'welcome', id: c.id, token: c.token, name: c.name });
    if (resumed && c.room) c.room.onReconnect(c);
    else c.send(this.roomList());
    return c;
  }

  disconnect(c) {
    c.connected = false;
    c.ws = null;
    if (c.room) c.room.onDisconnect(c);
    c.forgetTimer = setTimeout(() => {
      if (c.connected) return;
      if (c.room) c.room.leave(c, 'timed out');
      this.clients.delete(c.token);
    }, CLIENT_GRACE_MS);
  }

  // Tell everyone before the process exits (deploys / restarts).
  shutdown() {
    for (const r of this.rooms.values()) {
      r.system('Server is restarting - you will be returned to the lobby');
      clearInterval(r.loop); clearTimeout(r.timer); clearTimeout(r.emptyTimer);
    }
  }

  stats() {
    return { rooms: this.rooms.size, battles: [...this.rooms.values()].filter(r => r.inGame()).length,
      clients: [...this.clients.values()].filter(c => c.connected).length };
  }

  roomList() {
    return {
      t: 'rooms',
      rooms: [...this.rooms.values()].map(r => ({
        code: r.code, name: r.name, players: r.players().length + r.bots.length, humans: r.members.length,
        seats: MAX_SEATS, stage: r.inGame() ? 'battle' : r.stage,
        round: r.game ? r.game.round : 0,
        host: (r.members.find(x => x.id === r.hostId) || {}).name || '',
      })),
    };
  }

  roomsChanged() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const s = JSON.stringify(this.roomList());
      for (const c of this.clients.values()) if (!c.room) c.send(s);
    }, 100);
  }

  handle(c, m) {
    const r = c.room;
    const err = (msg) => c.send({ t: 'error', msg });
    switch (m.t) {
      case 'rename':
        c.name = clean(m.name, 16) || c.name;
        if (r) r.changed();
        return;
      case 'listRooms': return c.send(this.roomList());
      case 'createRoom': {
        if (r) r.leave(c);
        if (this.rooms.size >= MAX_ROOMS) return err('Server is full - try again later');
        const room = new Room(this, c, m.name);
        this.rooms.set(room.code, room);
        room.join(c);
        return;
      }
      case 'joinRoom': {
        const room = this.rooms.get(clean(m.code, 8).toUpperCase());
        if (!room) return err('No room with that code');
        if (r === room) return;
        if (room.members.length >= 16) return err('That room is full');
        if (r) r.leave(c);
        room.join(c);
        return;
      }
    }
    if (!r) return;
    const isHost = r.hostId === c.id;
    switch (m.t) {
      case 'leaveRoom': r.leave(c); c.send(this.roomList()); return;
      case 'chat': {
        const text = clean(m.text, 200);
        if (!text) return;
        const now = Date.now();
        if (now - (c.lastChat || 0) < 400) return;
        c.lastChat = now;
        r.pushChat({ from: c.name, color: E.TEAM_COLORS[r.colors.get(c.id)].hex, text });
        return;
      }
    }
    if (r.inGame()) return r.handleGame(c, m);
    switch (m.t) {
      case 'vote':
        if (!r.isPlayer(c)) return err('Spectators cannot vote - wait for a free seat');
        if (m.on) r.votes.add(c.id); else r.votes.delete(c.id);
        r.changed();
        return;
      case 'color': {
        const used = new Set(r.colors.values());
        let ci = r.colors.get(c.id);
        for (let k = 0; k < E.TEAM_COLORS.length; k++) { ci = (ci + 1) % E.TEAM_COLORS.length; if (!used.has(ci)) break; }
        r.colors.set(c.id, ci);
        r.changed();
        return;
      }
      case 'settings': {
        if (!isHost) return err('Only the host can change settings');
        const s = m.settings || {};
        if (Number.isInteger(+s.rounds) && +s.rounds >= 1 && +s.rounds <= 10) r.settings.rounds = +s.rounds;
        if (['random', 'hills', 'mountains', 'flat'].includes(s.terrain)) r.settings.terrain = s.terrain;
        if (['open', 'bounce', 'wrap'].includes(s.walls)) r.settings.walls = s.walls;
        if (['changing', 'constant', 'none'].includes(s.windMode)) r.settings.windMode = s.windMode;
        if (TURN_TIMES.includes(+s.turnTime)) r.settings.turnTime = +s.turnTime;
        r.votes.clear();   // settings changed: everyone re-confirms
        r.changed();
        return;
      }
      case 'addBot': {
        if (!isHost) return err('Only the host can add bots');
        if (r.seatsUsed() >= MAX_SEATS || r.players().length + r.bots.length >= MAX_SEATS) return err('No free seats');
        const difficulty = DIFFS.includes(m.difficulty) ? m.difficulty : 'medium';
        const taken = new Set([...r.members.map(x => x.name), ...r.bots.map(b => b.name)]);
        const name = E.DEFAULT_NAMES.find(n => !taken.has(n)) || `Bot ${r.bots.length + 1}`;
        const bot = { id: 'bot-' + rid(3), name, difficulty };
        r.bots.push(bot);
        r.colors.set(bot.id, r.freeColor());
        r.changed();
        return;
      }
      case 'removeBot': {
        if (!isHost) return err('Only the host can remove bots');
        const i = r.bots.findIndex(b => b.id === m.id);
        if (i >= 0) { r.colors.delete(r.bots[i].id); r.bots.splice(i, 1); r.changed(); }
        return;
      }
    }
  }
}

module.exports = { Lobby, MAX_SEATS };
