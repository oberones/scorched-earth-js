// ---------------------------------------------------------------------------
// Online play: connection, lobby/room screens, and NetGame - a client-side mirror
// of the server's authoritative Game that the existing renderer/HUD draw from.
// Snapshots are buffered and played back ~100 ms behind real time so tanks and
// shells move smoothly between 30 Hz updates.
// ---------------------------------------------------------------------------
const INTERP_DELAY = 110; // ms

class NetGame {
  constructor(start, net) {
    this.net = net;
    this.isNet = true;
    this.settings = Object.assign({}, start.settings, { seed: start.seed, players: start.tanks });
    this.terrain = new Terrain(CFG.W, CFG.H);
    this.myTankId = start.yourTank;
    this.tanks = start.tanks.map(t => ({
      id: t.id, name: t.name, color: t.color, type: t.type, difficulty: t.difficulty || 'medium',
      x: 0, y: 0, angle: 60, power: 500, weapon: 'baby', health: CFG.MAX_HEALTH, shield: 0, alive: true,
      falling: false, chute: false, score: 0, money: 0, kills: 0, wins: 0, roundPoints: 0, roundDamage: 0,
      inventory: { baby: Infinity }, items: {},
    }));
    this.projectiles = []; this.blasts = []; this.events = [];
    this.round = 0; this.phase = 'shop'; this.stage = 'shop'; this.wind = 0; this.turn = 0; this.turnCount = 0; this.theme = 0;
    this.queue = []; this.cur = null; this.offset = null;
    this.trails = new Map(); this.marks = []; this.marketPrices = {};
    this.lastAim = ''; this.lastAimAt = 0; this.firedKey = null;
  }

  get current() { return this.settings.format && this.settings.format !== 'sequential' && this.me?.alive ? this.me : this.tanks[this.turn]; }
  get me() { return this.myTankId == null ? null : this.tanks[this.myTankId]; }
  get turnKey() { return `${this.round}:${this.me?.serial || 0}`; }
  serverNow() { return Date.now() - (this.offset || 0); }

  canControl(t) {
    return !!t && t.id === this.myTankId && t === this.current && this.stage === 'play' &&
      this.phase === 'aim' && t.alive && !t.falling && !t.committed && t.type === 'human';
  }
  maxPower() { return CFG.MAX_POWER; }
  standings() { return this.ranking ? this.ranking.map(id => this.tanks[id]) : Game.prototype.standings.call(this); }
  equip(t, id, value) { this.net.send({ t: 'equip', id, value }); }

  // ---------------------------------------------------------------- inputs
  fire() {
    const t = this.me;
    if (!this.canControl(t) || this.firedKey === this.turnKey || (this.settings.format === 'simultaneous' && t.busy)) return false;
    this.firedKey = this.turnKey;
    this.net.send({ t: 'fire', serial: t.serial || 0, round: this.round, a: t.angle, p: t.power, w: t.weapon });
    return true;
  }
  moveTank(t, direction) {
    const dir = Math.sign(direction);
    if (!this.canControl(t) || (dir !== -1 && dir !== 1) || !(t.items.fuel >= 1)) return { moved: false, reason: 'fuel' };
    this.net.send({ t: 'move', d: dir });
    return { moved: true };
  }
  cycleWeapon(t, dir = 1) { Game.prototype.cycleWeapon.call(this, t, dir); }
  useRepair(t) { if (this.canControl(t)) this.net.send({ t: 'repair' }); }
  buy(t, id) { this.net.send({ t: 'buy', id }); return false; }   // server confirms via snapshot
  sell(t, id) { this.net.send({ t: 'sell', id }); return false; }

  // ------------------------------------------------------------- receiving
  push(msg) {
    if (msg.t === 'snap') {
      const sample = Date.now() - msg.ts;
      // track the lowest-latency sample, drifting slowly so clock skew changes are absorbed
      this.offset = this.offset == null ? sample : Math.min(sample, this.offset + 2);
      this.lastTs = msg.ts;
      this.queue.push(msg);
    } else {
      this.queue.push({ ctl: msg, ts: this.lastTs || 0 });
    }
  }

  activate(s) {
    if (s.ctl) { if (this.onControl) this.onControl(s.ctl); return; }
    const mine = this.canControl(this.me);
    const sameRound = this.inited && s.round === this.round;
    this.stage = s.stage; this.phase = s.phase; this.round = s.round; this.theme = s.theme;
    this.wind = s.wind; this.turn = s.turn; this.turnCount = s.turnCount; this.turnEnds = s.turnEnds;
    this.settings.rounds = s.rounds;
    this.lastWinner = s.winner == null ? null : this.tanks[s.winner];
    if (s.terrain) this.terrain.applyChanges(s.terrain);
    if (s.marks) this.marks = s.marks;
    this.ranking = s.ranking; this.lastTeam = s.teamWinner; this.betrayal = s.betrayal;
    this.marketPrices = s.marketPrices || {}; this.wall = s.wall; this.environment = s.environment;
    this.turnEnds = s.deadlines?.[this.myTankId] ?? s.turnEnds;
    for (const st of s.tanks) {
      const t = this.tanks[st.id];
      // Our own turret is ours: the server only ever echoes what we sent, so keep the local
      // aim between turns (no snap-back after firing). Take the server's value at round
      // start (tanks are re-placed) and while autopilot is flying the tank.
      const own = t === this.me && sameRound && !st.auto;
      const keepAim = own || (mine && t === this.me && this.canControl(t));
      t._own = own;
      Object.assign(t, {
        health: st.h, shield: st.sh, alive: st.alive, falling: st.falling, chute: st.chute,
        score: st.score, money: st.money, kills: st.kills, wins: st.wins, roundPoints: st.rp, roundDamage: st.rd,
        team: st.team, committed: st.committed, busy: st.busy, serial: st.serial,
        defense: st.defense, shieldType: st.shieldType, parachuteOn: st.parachuteOn, threshold: st.threshold,
        targetId: st.targetId, energy: st.energy, guidance: st.guidance, contact: st.contact,
        items: st.items, type: st.type, autopilot: st.auto,
        inventory: Object.fromEntries(Object.entries(st.inv).map(([k, v]) => [k, v === -1 ? Infinity : v])),
      });
      if (!keepAim) { t.power = st.p; t.weapon = st.w; t._a1 = st.a; }
      else {
        if (!(t.inventory[t.weapon] > 0)) t.weapon = st.w;       // ran out of that weapon
        if (t._a1 == null) t._a1 = st.a;
      }
      t._x1 = st.x; t._y1 = st.y;
      if (t._x0 == null || Math.abs(t._x0 - st.x) > 200) { t.x = st.x; t.y = st.y; t.angle = st.a; }
    }
    this.blasts = s.blasts.map(b => Object.assign({}, b));
    this.projData = new Map(s.proj.map(p => [p.id, p]));
    for (const e of s.ev) {
      for (const k in e) if (e[k] && typeof e[k] === 'object' && e[k].$t != null) e[k] = this.tanks[e[k].$t];
      this.events.push(e);
    }
    if (this.firedKey && (this.phase !== 'aim' || this.firedKey !== this.turnKey)) this.firedKey = null;
    this.inited = true;
    if (this.onSnap) this.onSnap(s);
  }

  update(dt) {
    if (this.offset == null) return;
    const rt = this.serverNow() - INTERP_DELAY;
    // fall too far behind (tab in background, lag spike) -> skip ahead
    while (this.queue.length > 12) this.activateNext();
    while (this.queue.length && this.queue[0].ts <= rt) this.activateNext();
    const next = this.queue.find(q => !q.ctl);
    const cur = this.cur;
    const alpha = cur && next ? Math.max(0, Math.min(1, (rt - cur.ts) / Math.max(1, next.ts - cur.ts))) : 1;

    for (const t of this.tanks) {
      if (t._x1 == null) continue;
      const n = next && next.tanks[t.id];
      t.x = n ? t._x1 + (n.x - t._x1) * alpha : t._x1;
      t.y = n ? t._y1 + (n.y - t._y1) * alpha : t._y1;
      if (!t._own && !this.canControl(t) && t._a1 != null) t.angle = n ? t._a1 + (n.a - t._a1) * alpha : t._a1;
      t._x0 = t.x;
    }

    // projectiles: interpolate between snapshots, extrapolate briefly if starved
    const list = [];
    if (this.projData) {
      for (const [id, p] of this.projData) {
        const n = next && next.proj.find(q => q.id === id);
        let x, y, vx = p.vx, vy = p.vy;
        if (n) { x = p.x + (n.x - p.x) * alpha; y = p.y + (n.y - p.y) * alpha; vx = n.vx; vy = n.vy; }
        else {
          const ahead = Math.min(0.1, Math.max(0, (rt - (cur ? cur.ts : rt)) / 1000));
          x = p.x + p.vx * ahead; y = p.y + p.vy * ahead;
        }
        let tr = this.trails.get(id);
        if (!tr) { tr = []; this.trails.set(id, tr); }
        tr.push(x, y); if (tr.length > 240) tr.splice(0, 2);
        list.push({ id, x, y, vx, vy, weapon: p.w, trail: tr });
      }
    }
    for (const id of this.trails.keys()) if (!this.projData || !this.projData.has(id)) this.trails.delete(id);
    this.projectiles = list;
    for (const b of this.blasts) b.t += dt;
    this.blasts = this.blasts.filter(b => b.t < b.dur);

    // stream our aim so everyone sees the turret move
    const me = this.me;
    if (this.canControl(me)) {
      const key = `${me.angle.toFixed(1)}|${Math.round(me.power)}|${me.weapon}`;
      const now = performance.now();
      if (key !== this.lastAim && now - this.lastAimAt > 80) {
        this.lastAim = key; this.lastAimAt = now;
        this.net.send({ t: 'aim', a: me.angle, p: me.power, w: me.weapon });
      }
    }
  }

  activateNext() {
    const s = this.queue.shift();
    this.activate(s);
    if (!s.ctl) this.cur = s;
  }
}

// ---------------------------------------------------------------------------
const Net = (() => {
  let ws = null, me = null, room = null, rooms = [], game = null, wantOpen = false, retry = 0, retryTimer = null;
  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const served = /^https?:$/.test(location.protocol);

  function preferredServer() {
    return new URLSearchParams(location.search).get('server') || (served ? '' : store.get('scorched.server', ''));
  }

  function serverUrl() {
    const custom = $('#net-server').value.trim();
    if (custom) return custom;
    if (served) { // relative to the page, so the game also works under a reverse-proxy path prefix
      const u = new URL('ws', location.href);
      u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      u.hash = ''; u.search = '';
      return u.href;
    }
    return '';
  }

  function fetchLeaderboard() {
    const url = serverUrl();
    if (!url) return Promise.reject(new Error('Choose a game server in Play online.'));
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = new WebSocket(url); } catch {
        reject(new Error('Invalid game server address.'));
        return;
      }
      const finish = (error, entries) => {
        clearTimeout(timeout);
        socket.onmessage = socket.onerror = socket.onclose = null;
        if (socket.readyState < WebSocket.CLOSING) socket.close();
        if (error) reject(new Error(error));
        else resolve(entries);
      };
      const unavailable = () => finish('Online leaderboard unavailable.');
      const timeout = setTimeout(unavailable, 4000);
      socket.onopen = () => socket.send(JSON.stringify({ t: 'leaderboard' }));
      socket.onerror = socket.onclose = unavailable;
      socket.onmessage = ({ data }) => {
        let message;
        try { message = JSON.parse(data); } catch { return unavailable(); }
        if (message?.t !== 'leaderboard' || !Array.isArray(message.entries)) return unavailable();
        finish(null, Leaderboard.rank(message.entries));
      };
    });
  }

  function status(text, kind = '') {
    const el = $('#net-status');
    el.textContent = text; el.className = 'net-status ' + kind;
  }

  function connect() {
    clearTimeout(retryTimer);
    const url = serverUrl();
    if (!url) { status('Enter the address of your game server (e.g. wss://games.example.com/ws).', 'warn'); return; }
    if (ws && ws.readyState <= 1) return;
    wantOpen = true;
    status('Connecting…');
    try { ws = new WebSocket(url); } catch (e) { status('Invalid server address', 'err'); return; }
    ws.onopen = () => {
      retry = 0;
      send({ t: 'hello', name: myName(), token: store.sget('scorched.token') });
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      ws = null;
      if (!wantOpen) return;
      retry++;
      const wait = Math.min(8000, 500 * 2 ** retry);
      status(`Connection lost - retrying in ${Math.round(wait / 1000)}s…`, 'err');
      UI.toast('Reconnecting…', '#ff8a8a', 1500);
      retryTimer = setTimeout(connect, wait);
    };
  }

  function disconnect() { wantOpen = false; if (ws) ws.close(); ws = null; }
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function myName() { return ($('#net-name').value || '').trim().slice(0, 16) || 'Commander'; }

  // ------------------------------------------------------------- messages
  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        me = m.id; store.sset('scorched.token', m.token);
        status(`Connected as ${m.name}`, 'ok');
        if (pendingJoin) { send({ t: 'joinRoom', code: pendingJoin }); pendingJoin = null; }
        break;
      case 'rooms': // only sent to clients that are not in a room
        store.sset('scorched.inRoom', '0');
        rooms = m.rooms;
        if (room || game) { room = null; if (game) endGame(); }
        renderRooms();
        UI.show('screen-online');
        break;
      case 'room':
        room = m; store.sset('scorched.inRoom', '1');
        renderRoom();
        if (!game) UI.show('screen-room');
        break;
      case 'error': UI.toast(m.msg, '#ff8a8a', 2200); status(m.msg, 'err'); break;
      case 'chat': addChat(m); break;
      case 'gameStart': startNetGame(m); break;
      case 'snap': case 'shop': case 'roundOver': case 'gameOver':
        if (game) game.push(m);
        break;
    }
  }

  // ---------------------------------------------------------------- lobby
  function open() {
    UI.show('screen-online');
    $('#net-name').value = store.get('scorched.name', '');
    $('#net-server-wrap').hidden = served && !new URLSearchParams(location.search).get('server');
    if (!$('#net-server').value) $('#net-server').value = preferredServer();
    renderRooms();
    connect();
  }

  function renderRooms() {
    const box = $('#room-list');
    if (!rooms.length) { box.innerHTML = '<div class="empty">No battles yet - create one and share the code.</div>'; return; }
    box.innerHTML = rooms.map(r => `
      <div class="room-row">
        <div><div class="rn">${esc(r.name)}</div><div class="sub">Host ${esc(r.host)} · code ${r.code}</div></div>
        <span class="badge ${r.stage}">${r.stage === 'battle' ? `In battle · round ${r.round}` : r.stage === 'countdown' ? 'Starting' : 'Lobby'}</span>
        <span class="seats">${r.players}/${r.seats}</span>
        <button class="join" data-code="${r.code}">${r.stage === 'battle' ? 'Watch' : 'Join'}</button>
      </div>`).join('');
  }

  function renderRoom() {
    if (!room) return;
    const host = room.hostId === me;
    const self = room.members.find(x => x.id === me) || {};
    $('#room-name').textContent = room.name;
    $('#room-code').textContent = room.code;
    const players = room.members.filter(x => !x.spectator);
    $('#seat-count').textContent = `${players.length + room.bots.length}/${room.maxSeats}`;
    $('#room-members').innerHTML = [
      ...room.members.map(x => `
        <div class="member ${x.spectator ? 'spec' : ''} ${x.conn ? '' : 'off'}">
          <button class="swatch sm" ${x.id === me && !x.spectator ? 'data-act="color" title="Change colour"' : 'disabled'} style="background:${x.color}"></button>
          <span class="mn">${esc(x.name)}${x.id === me ? ' <span class="sub">(you)</span>' : ''}</span>
          ${x.id === room.hostId ? '<span class="tagh">HOST</span>' : ''}
          <span class="vote ${x.vote ? 'yes' : ''}">${x.spectator ? 'spectating' : x.vote ? '✔ ready' : 'not ready'}</span>
        </div>`),
      ...room.bots.map(b => `
        <div class="member bot">
          <span class="swatch sm" style="background:${b.color}"></span>
          <span class="mn">${esc(b.name)} <span class="sub">${DIFFICULTY[b.difficulty].label} AI</span></span>
          ${host ? `<button class="del" data-act="rmbot" data-id="${b.id}" title="Remove bot">✕</button>` : '<span class="vote yes">bot</span>'}
        </div>`),
    ].join('');
    $('#bot-controls').hidden = !host;
    for (const k of [...Object.keys(RULES), 'turnTime']) {
      const sel = $(`#rs-${k}`);
      if (!host || sel !== document.activeElement || sel.type !== 'number') sel.value = String(room.settings[k]);
      sel.disabled = !host || room.stage !== 'lobby';
    }
    $('#room-settings-note').textContent = host ? 'You are the host: changing a setting resets votes.' : 'Only the host can change settings.';
    if (room.settings.teams !== 'none') {
      const rows = $('#room-members').querySelectorAll('.member');
      [...room.members, ...room.bots].forEach((member, i) => {
        if (member.spectator) return;
        const select = UI.teamSelect(member.team);
        select.disabled = !host || room.stage !== 'lobby';
        select.onchange = () => send({ t: 'team', id: member.id, team: +select.value });
        rows[i].append(select);
      });
    }
    const need = players.filter(x => !x.vote).length;
    const vb = $('#vote-btn');
    vb.disabled = !!self.spectator;
    vb.textContent = self.vote ? 'Cancel my vote' : 'Vote to start';
    vb.classList.toggle('voted', !!self.vote);
    let st;
    if (players.length + room.bots.length < 2) st = 'Need at least 2 combatants - invite a friend or add a bot.';
    else if (room.stage === 'countdown') st = 'All votes in - launching!';
    else if (room.stage !== 'lobby') st = 'Battle in progress - you are watching.';
    else st = `${players.length - need}/${players.length} commanders voted to start` + (need ? ` · waiting for ${need}` : '');
    $('#vote-status').textContent = st;
    renderChat();
    clearInterval(renderRoom.cd);
    if (room.stage === 'countdown') {
      const tick = () => {
        const s = Math.max(0, Math.ceil((room.countdownEnds - Date.now()) / 1000));
        $('#vote-status').textContent = `All votes in - battle begins in ${s}…`;
      };
      tick(); renderRoom.cd = setInterval(tick, 200);
    }
  }

  // ----------------------------------------------------------------- chat
  function chatLine(c) {
    return c.sys ? `<div class="cl sys">${esc(c.text)}</div>`
      : `<div class="cl"><b style="color:${c.color}">${esc(c.from)}</b> ${esc(c.text)}</div>`;
  }
  function renderChat() {
    const log = $('#chat-log');
    log.innerHTML = (room ? room.chat : []).map(chatLine).join('');
    log.scrollTop = log.scrollHeight;
  }
  function addChat(c) {
    if (room) { room.chat.push(c); if (room.chat.length > 60) room.chat.shift(); }
    const log = $('#chat-log');
    log.insertAdjacentHTML('beforeend', chatLine(c));
    log.scrollTop = log.scrollHeight;
    // in-game feed
    const feed = $('#chatfeed');
    const el = document.createElement('div');
    el.innerHTML = chatLine(c);
    feed.appendChild(el.firstChild);
    while (feed.children.length > 6) feed.removeChild(feed.firstChild);
    const node = feed.lastChild;
    setTimeout(() => node.classList.add('fade'), 9000);
    setTimeout(() => node.remove(), 10000);
  }
  function openChatInput() {
    if (!room) return;
    const box = $('#chatbox');
    box.hidden = false;
    $('#chatbox-input').focus();
  }

  // ----------------------------------------------------------------- game
  function startNetGame(m) {
    Sfx.init();
    game = new NetGame(m, { send });
    game.onControl = onControl;
    game.onSnap = (s) => {
      if (UI._shopRedraw && !$('#screen-shop').hidden) UI._shopRedraw();
      if (s.stage === 'play' && (!$('#screen-shop').hidden || !$('#screen-wait').hidden)) UI.hideScreens();
    };
    App.useGame(game);
    UI.hideScreens();
    $('#hud-timer').hidden = false;
    if (m.yourTank == null) UI.toast('Spectating', '#8fd3ff', 1800);
  }

  function onControl(m) {
    const g = game;
    if (m.t === 'shop') {
      const t = g.me;
      if (t && !m.done.includes(me)) {
        if ($('#screen-shop').hidden) UI.renderShop(g, t, () => {
          send({ t: 'shopDone' });
          showWaiting(m.ends);
        });
      } else showWaiting(m.ends, m.done.length);
      g.shopEnds = m.ends;
    } else if (m.t === 'roundOver') {
      setTimeout(() => {
        if (game !== g) return;
        UI.showRound(g, () => UI.hideScreens());
        $('#round-next').textContent = 'Close';
      }, 1200);
    } else if (m.t === 'gameOver') {
      g.finished = true;
      setTimeout(() => {
        if (game !== g) return;
        UI.showGameOver(g, () => backToRoom(), () => leaveRoom());
        $('#over-again').textContent = 'Back to room';
        $('#over-new').textContent = 'Leave room';
      }, 1500);
    }
  }

  function showWaiting(ends) {
    UI.show('screen-wait');
    clearInterval(showWaiting.t);
    const tick = () => {
      if (!game || game.stage !== 'shop') { clearInterval(showWaiting.t); if (!$('#screen-wait').hidden) UI.hideScreens(); return; }
      const s = Math.max(0, Math.ceil((ends - game.serverNow()) / 1000));
      $('#wait-sub').textContent = `The round starts when everyone is ready (max ${s}s)`;
    };
    tick(); showWaiting.t = setInterval(tick, 250);
  }

  function endGame() {
    game = null;
    $('#hud-timer').hidden = true;
    App.stopGame();
  }

  function backToRoom() { endGame(); renderRoom(); UI.show('screen-room'); }
  function leaveRoom() {
    store.sset('scorched.inRoom', '0');
    send({ t: 'leaveRoom' });
    room = null;
    endGame();
    renderRooms();
    UI.show('screen-online');
  }

  // --------------------------------------------------------------- wiring
  let pendingJoin = null;
  function init() {
    $('#net-server').value = preferredServer();
    $('#btn-online').onclick = () => { Sfx.init(); open(); };
    $('#net-back').onclick = () => { disconnect(); room = null; App.startDemo(); };
    $('#net-name').addEventListener('change', () => {
      store.set('scorched.name', myName());
      send({ t: 'rename', name: myName() });
    });
    $('#net-server').addEventListener('change', () => { store.set('scorched.server', $('#net-server').value.trim()); disconnect(); connect(); });
    $('#create-room').onclick = () => {
      store.set('scorched.name', myName());
      send({ t: 'rename', name: myName() });
      send({ t: 'createRoom', name: $('#new-room-name').value });
    };
    const joinCode = () => {
      const code = $('#join-code').value.trim();
      if (!code) return;
      send({ t: 'rename', name: myName() });
      send({ t: 'joinRoom', code });
    };
    $('#join-room').onclick = joinCode;
    $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(); });
    $('#room-list').addEventListener('click', (e) => {
      const b = e.target.closest('.join');
      if (!b) return;
      store.set('scorched.name', myName());
      send({ t: 'rename', name: myName() });
      send({ t: 'joinRoom', code: b.dataset.code });
    });
    $('#room-members').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'color') send({ t: 'color' });
      if (b.dataset.act === 'rmbot') send({ t: 'removeBot', id: b.dataset.id });
    });
    $('#add-bot').onclick = () => send({ t: 'addBot', difficulty: $('#bot-diff').value });
    for (const k of [...Object.keys(RULES), 'turnTime']) {
      const control = $(`#rs-${k}`);
      const submit = () => {
        if (control.validity.valid) send({ t: 'settings', settings: { [k]: RULES[k]?.choices ? control.value : +control.value } });
      };
      if (control.type === 'number') control.oninput = submit;
      else control.onchange = submit;
    }
    $('#vote-btn').onclick = () => {
      const self = room && room.members.find(x => x.id === me);
      send({ t: 'vote', on: !(self && self.vote) });
      Sfx.click();
    };
    $('#room-leave').onclick = () => leaveRoom();
    $('#copy-code').onclick = async () => {
      const link = served ? `${location.origin}${location.pathname}#room-${room.code}` : room.code;
      try { await navigator.clipboard.writeText(link); UI.toast('Invite copied', '#7dff9a', 1200); }
      catch { prompt('Share this invite:', link); }
    };
    const sendChat = (input) => {
      const text = input.value.trim();
      if (text) send({ t: 'chat', text });
      input.value = '';
    };
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chat-input')); });
    $('#chatbox').addEventListener('submit', (e) => {
      e.preventDefault(); sendChat($('#chatbox-input'));
      $('#chatbox').hidden = true; $('#chatbox-input').blur();
    });
    $('#chatbox-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#chatbox').hidden = true; e.target.blur(); }
      e.stopPropagation();
    });

    // invite links: …/#room-ABCD
    const mm = /^#room-([A-Za-z]{4})$/.exec(location.hash);
    if (mm) { pendingJoin = mm[1].toUpperCase(); history.replaceState(null, '', location.pathname + location.search); setTimeout(open, 50); }
    else if (store.sget('scorched.inRoom') === '1') setTimeout(open, 50);
  }

  return { init, open, send, openChatInput, leaveRoom, fetchLeaderboard, get room() { return room; }, get game() { return game; } };
})();
