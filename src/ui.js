// ---------------------------------------------------------------------------
// DOM UI: setup, shop, round summary, game over, HUD & scoreboard
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const UI = {
  movementMode: false,
  setupPlayers: [
    { name: 'You', color: 0, type: 'human' },
    { name: DEFAULT_NAMES[1], color: 1, type: 'easy' },
    { name: DEFAULT_NAMES[2], color: 2, type: 'medium' },
    { name: DEFAULT_NAMES[3], color: 3, type: 'hard' },
  ],

  show(id) { for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; },
  hideScreens() { for (const s of document.querySelectorAll('.screen')) s.hidden = true; },
  setMovementMode(on) {
    UI.movementMode = !!on;
    const bar = $('.hud-bar');
    if (bar) bar.classList.toggle('moving', UI.movementMode);
    const controls = $('#move-controls');
    if (controls) controls.hidden = !UI.movementMode;
    const button = $('#btn-move');
    if (button) button.title = UI.movementMode ? 'Finish moving (F)' : 'Move tank (F)';
  },

  // ----------------------------------------------------------------- setup
  renderSetup() {
    const list = $('#player-list');
    list.innerHTML = '';
    UI.setupPlayers.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `
        <button class="swatch" title="Change colour" style="background:${TEAM_COLORS[p.color].hex}"></button>
        <input maxlength="12" value="${esc(p.name)}" aria-label="Name">
        <select aria-label="Controller">
          <option value="human">Human</option>
          <option value="easy">AI · Easy</option>
          <option value="medium">AI · Medium</option>
          <option value="hard">AI · Hard</option>
          <option value="expert">AI · Expert</option>
        </select>
        <button class="del" title="Remove">✕</button>`;
      const [sw, inp, sel, del] = row.children;
      sel.value = p.type;
      sw.onclick = () => {
        const used = new Set(UI.setupPlayers.map(q => q.color));
        let c = p.color;
        for (let k = 0; k < TEAM_COLORS.length; k++) { c = (c + 1) % TEAM_COLORS.length; if (!used.has(c)) break; }
        p.color = c; UI.renderSetup(); Sfx.click();
      };
      inp.oninput = () => { p.name = inp.value; };
      sel.onchange = () => { p.type = sel.value; };
      del.disabled = UI.setupPlayers.length <= 2;
      del.onclick = () => { UI.setupPlayers.splice(i, 1); UI.renderSetup(); };
      list.appendChild(row);
    });
    $('#add-player').hidden = UI.setupPlayers.length >= 6;
  },

  readSettings() {
    return {
      rounds: +$('#opt-rounds').value,
      terrain: $('#opt-terrain').value,
      walls: $('#opt-walls').value,
      windMode: $('#opt-wind').value,
      seed: (Math.random() * 1e9) | 0,
      players: UI.setupPlayers.map((p, i) => ({
        name: (p.name || '').trim() || DEFAULT_NAMES[i],
        color: TEAM_COLORS[p.color].hex,
        type: p.type === 'human' ? 'human' : 'ai',
        difficulty: p.type === 'human' ? null : p.type,
      })),
    };
  },

  // ------------------------------------------------------------------ shop
  runShop(game, done) {
    const humans = game.tanks.filter(t => t.type === 'human');
    let i = 0;
    const next = () => {
      if (i >= humans.length) { UI.hideScreens(); done(); return; }
      UI.renderShop(game, humans[i], () => { i++; next(); });
    };
    next();
  },

  renderShop(game, t, done) {
    UI.show('screen-shop');
    $('#shop-title').innerHTML = `<span style="color:${t.color}">${esc(t.name)}</span> · Arms dealer`;
    $('#shop-sub').textContent = `Next up: round ${game.round + 1} of ${game.settings.rounds} · Score ${t.score}`;
    const draw = () => {
      $('#shop-money').textContent = `$${t.money.toLocaleString()}`;
      const grid = $('#shop-grid');
      grid.innerHTML = '';
      const entries = [...WEAPON_ORDER.filter(w => !WEAPONS[w].infinite).map(w => ['w', w]), ...Object.keys(ITEMS).map(k => ['i', k])];
      for (const [kind, id] of entries) {
        const def = kind === 'w' ? WEAPONS[id] : ITEMS[id];
        const owned = kind === 'w' ? (t.inventory[id] || 0) : (t.items[id] || 0);
        const shownOwned = id === 'fuel' ? Math.floor(owned) : owned;
        const card = document.createElement('div');
        card.className = 'card';
        const stats = kind === 'w'
          ? (def.dirt ? `Adds a ${def.radius}px mound of soil` : `Blast ${def.radius}px · Damage ${def.damage}${def.split ? ` ×${def.split} warheads` : ''}${def.bounces ? ` · bounces ${def.bounces}×` : ''}${def.digger ? ' · tunnels' : ''}`)
          : def.desc;
        const pct = kind === 'w' ? Math.min(100, def.radius / 1.15) : 0;
        card.innerHTML = `
          <div class="t"><span style="color:${kind === 'w' ? def.color : '#7fe7ff'}">${def.name}</span><span class="own">owned ${shownOwned}</span></div>
          <div class="stats">${stats}</div>
          ${kind === 'w' ? `<div class="bar"><i style="width:${pct}%;background:${def.color}"></i></div>` : ''}
          <div class="stats">$${def.price.toLocaleString()} for ${def.bundle}</div>
          <div class="acts"><button class="sell">Sell</button><button class="buy">Buy</button></div>`;
        const [sell, buy] = card.querySelectorAll('button');
        buy.disabled = t.money < def.price;
        sell.disabled = owned < def.bundle;
        buy.onclick = () => { if (game.buy(t, id)) { Sfx.buy(); draw(); } };
        sell.onclick = () => { if (game.sell(t, id)) { Sfx.click(); draw(); } };
        grid.appendChild(card);
      }
    };
    draw();
    UI._shopRedraw = draw;
    $('#shop-done').onclick = () => { Sfx.click(); done(); };
  },

  // --------------------------------------------------------------- results
  showRound(game, onNext) {
    UI.show('screen-round');
    const w = game.lastWinner;
    $('#round-title').innerHTML = w ? `<span style="color:${w.color}">${esc(w.name)}</span> wins round ${game.round}` : `Round ${game.round} · no survivors`;
    $('#round-sub').textContent = game.round < game.settings.rounds ? `${game.settings.rounds - game.round} round(s) to go` : 'Final round complete';
    const rows = game.standings().map((t, i) => `<tr class="${i === 0 ? 'first' : ''}">
      <td class="name"><span class="sw" style="background:${t.color}"></span>${esc(t.name)}${t.type === 'ai' ? ` <span class="sub">${DIFFICULTY[t.difficulty].label} AI</span>` : ''}</td>
      <td>${t.roundDamage}</td><td>${t.roundPoints >= 0 ? '+' : ''}${t.roundPoints}</td><td><b>${t.score}</b></td><td>${t.kills}</td><td>$${t.money.toLocaleString()}</td></tr>`).join('');
    $('#round-table').innerHTML = `<tr><th>Commander</th><th>Damage</th><th>Round pts</th><th>Score</th><th>Kills</th><th>Cash</th></tr>${rows}`;
    $('#round-next').onclick = () => { Sfx.click(); onNext(); };
  },

  showGameOver(game, onAgain, onNew) {
    UI.show('screen-over');
    const st = game.standings();
    $('#over-sub').innerHTML = `<span style="color:${st[0].color}">${esc(st[0].name)}</span> is the supreme commander after ${game.round} rounds`;
    const medal = ['🥇', '🥈', '🥉'];
    $('#over-table').innerHTML = `<tr><th>#</th><th>Commander</th><th>Score</th><th>Kills</th><th>Rounds won</th></tr>` +
      st.map((t, i) => `<tr class="${i === 0 ? 'first' : ''}"><td>${medal[i] || i + 1}</td><td class="name"><span class="sw" style="background:${t.color}"></span>${esc(t.name)}</td><td><b>${t.score}</b></td><td>${t.kills}</td><td>${t.wins}</td></tr>`).join('');
    $('#over-again').onclick = onAgain;
    $('#over-new').onclick = onNew;
  },

  // ------------------------------------------------------------------- HUD
  toast(text, color = '#fff', ms = 1400) {
    const el = $('#toast');
    el.textContent = text; el.style.color = color;
    el.classList.add('show');
    clearTimeout(UI._toastT);
    UI._toastT = setTimeout(() => el.classList.remove('show'), ms);
  },

  updateHud(game) {
    const t = game.current;
    if (!t) return;
    const bar = $('.hud-bar');
    const human = t.type === 'human';
    const rawControl = game.canControl(t);
    const control = rawControl && !UI.movementMode;
    bar.classList.toggle('ai-turn', !rawControl);
    $('#hud-dot').style.color = t.color;
    $('#hud-name').textContent = t.name;
    const mine = game.isNet ? t.id === game.myTankId : human;
    $('#hud-role').textContent = t.autopilot ? `Autopilot · Score ${t.score}`
      : mine ? `Score ${t.score} · $${t.money.toLocaleString()}`
      : human ? `Online player · Score ${t.score}` : `${DIFFICULTY[t.difficulty].label} AI · Score ${t.score}`;
    const timer = $('#hud-timer');
    if (game.isNet && game.turnEnds && game.phase === 'aim') {
      const s = Math.max(0, Math.ceil((game.turnEnds - game.serverNow()) / 1000));
      timer.textContent = `⏱ ${s}s`; timer.classList.toggle('low', s <= 5); timer.style.visibility = 'visible';
    } else if (timer) timer.style.visibility = 'hidden';
    $('#hud-angle').textContent = `${Math.round(t.angle)}°`;
    const maxP = game.maxPower(t);
    $('#hud-power').textContent = `${Math.round(t.power)} / ${maxP}`;
    $('#hud-power-fill').style.width = `${t.power / 10}%`;
    const W = WEAPONS[t.weapon];
    $('#hud-weapon').textContent = W.name;
    $('#hud-weapon').style.color = W.color;
    const n = t.inventory[t.weapon];
    $('#hud-ammo').textContent = n === Infinity ? '∞ ammo' : `×${n}`;
    const w = game.wind;
    $('#hud-wind').innerHTML = w === 0 ? '<span class="sub">calm</span>'
      : `<span class="arrow" style="transform:scaleX(${w > 0 ? 1 : -1})">➜</span>${Math.abs(w)}`;
    $('#hud-round').textContent = `${game.round}/${game.settings.rounds}`;
    $('#btn-fire').disabled = !control;
    const fuel = Math.max(0, t.items.fuel || 0);
    $('#hud-fuel').textContent = `${Math.floor(fuel)}`;
    $('#btn-move').disabled = !rawControl || fuel < 1;
    const items = [];
    if (t.shield > 0) items.push(`<span class="chip" style="color:#7fe7ff">Shield ${t.shield}</span>`);
    if (t.items.parachute) items.push(`<span class="chip">Chute ×${t.items.parachute}</span>`);
    if (t.items.repair) items.push(`<button class="chip" id="btn-repair" title="Use repair kit (R)">Repair ×${t.items.repair}</button>`);
    const html = items.join('');
    const box = $('#hud-items');
    if (UI._itemsHtml !== html) { UI._itemsHtml = html; box.innerHTML = html; }
    box.hidden = !items.length;
  },

  updateScoreboard(game) {
    const html = game.tanks.slice().sort((a, b) => b.score - a.score).map(t => `
      <div class="r ${t.alive ? '' : 'dead'} ${game.current === t ? 'cur' : ''}">
        <span class="sw" style="background:${t.color}"></span><span class="n">${esc(t.name)}</span><span>${t.score}</span>
        <span class="hp" style="width:${t.health}%;background:${t.health > 60 ? '#5ee07a' : t.health > 30 ? '#f2c94c' : '#ff5e57'}"></span>
      </div>`).join('');
    if (UI._sbHtml !== html) { UI._sbHtml = html; $('#scoreboard').innerHTML = html; }
  },
};
