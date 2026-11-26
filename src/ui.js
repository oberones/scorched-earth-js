// ---------------------------------------------------------------------------
// DOM UI: setup, shop, round summary, game over, HUD & scoreboard
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LOCAL_LEADERBOARD_KEY = 'scorched.leaderboard.v1';
let localLeaderboard = [];
let onlineLeaderboard = false;
let leaderboardRequest = null;

const UI = {
  movementMode: false,
  setupPlayers: [
    { name: 'You', color: 0, type: 'human' },
    { name: DEFAULT_NAMES[1], color: 1, type: 'easy' },
    { name: DEFAULT_NAMES[2], color: 2, type: 'medium' },
    { name: DEFAULT_NAMES[3], color: 3, type: 'hard' },
  ],

  show(id) { $('#equipment-panel').hidden = true; for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; },
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
  initLeaderboard() {
    for (const [type, online] of [['local', false], ['online', true]]) {
      $(`#leaderboard-${type}`).onclick = () => {
        onlineLeaderboard = online;
        UI.refreshLeaderboard();
      };
    }
    $('#leaderboard-retry').onclick = UI.refreshLeaderboard;
    window.addEventListener('storage', event => {
      if (event.key === LOCAL_LEADERBOARD_KEY && !onlineLeaderboard) UI.refreshLeaderboard();
    });
  },

  readLocalLeaderboard() {
    try {
      const entries = JSON.parse(localStorage.getItem(LOCAL_LEADERBOARD_KEY));
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  },

  recordLocalResult(game) {
    const entries = Leaderboard.fromMatch(game);
    if (!entries.length) return;
    const best = Leaderboard.rank([...UI.readLocalLeaderboard(), ...localLeaderboard, ...entries]);
    try {
      localStorage.setItem(LOCAL_LEADERBOARD_KEY, JSON.stringify(best));
      localLeaderboard = [];
    } catch {
      localLeaderboard = best;
    }
  },

  async refreshLeaderboard() {
    $('#leaderboard-local').setAttribute('aria-pressed', !onlineLeaderboard);
    $('#leaderboard-online').setAttribute('aria-pressed', onlineLeaderboard);
    if (!onlineLeaderboard) {
      const entries = Leaderboard.rank([...UI.readLocalLeaderboard(), ...localLeaderboard]);
      UI.showLeaderboard(entries, localLeaderboard.length ? 'Browser storage is unavailable. Records last for this session.' : 'No local records yet.');
      if (localLeaderboard.length) $('#leaderboard-status').hidden = false;
      return;
    }
    UI.showLeaderboard([], 'Loading online records…');
    if (leaderboardRequest) return;
    leaderboardRequest = Net.fetchLeaderboard();
    try {
      const entries = await leaderboardRequest;
      if (onlineLeaderboard) UI.showLeaderboard(entries, 'No online records yet.');
    } catch (error) {
      if (onlineLeaderboard) UI.showLeaderboard([], error.message, true);
    } finally {
      leaderboardRequest = null;
    }
  },

  showLeaderboard(entries, message, retry = false) {
    const status = $('#leaderboard-status');
    status.textContent = message;
    status.hidden = entries.length > 0;
    $('#leaderboard-retry').hidden = !retry;
    $('#leaderboard-table').hidden = !entries.length;
    $('#leaderboard-table tbody').innerHTML = entries.map((entry, i) =>
      `<tr class="${i === 0 ? 'first' : ''}"><td>${i + 1}</td><td>${esc(entry.name)}</td><td>${entry.score.toLocaleString()}</td><td>${entry.kills}</td><td>${entry.rounds}</td></tr>`
    ).join('');
  },

  initRules() {
    const basic = ['rounds', 'format', 'teams', 'terrain'];
    const labels = { bounce: 'Rubber', volley: 'Synchronous volley', simultaneous: 'Real-time simultaneous', none: 'None' };
    for (const [prefix, container] of [['opt', '#local-rules'], ['rs', '#room-rules']]) {
      const control = key => {
        const def = RULES[key], id = prefix + '-' + key;
        if (def.choices) return `<label>${def.label}<select id="${id}">${def.choices.map(value =>
          `<option value="${value}">${labels[value] || value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label>`;
        return `<label>${def.label}<input id="${id}" type="number" min="${def.min}" max="${def.max}" value="${def.value}" required></label>`;
      };
      $(container).innerHTML = `<div class="settings">${basic.map(control).join('')}</div>
        <details><summary>Battlefield and economy</summary><div class="settings">
        ${Object.keys(RULES).filter(k => !basic.includes(k)).map(control).join('')}</div></details>`;
    }
    $('#opt-teams').onchange = $('#opt-format').onchange = () => UI.renderSetup();
    $('#bot-diff').innerHTML = Object.entries(DIFFICULTY).map(([id, d]) => `<option value="${id}">${d.label}</option>`).join('');
    $('#bot-diff').value = 'medium';
  },

  teamSelect(value) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Team');
    for (let i = 0; i < 10; i++) select.add(new Option('Team ' + (i + 1), i));
    select.value = value;
    return select;
  },

  bindings() {
    const humans = UI.setupPlayers.filter(p => p.type === 'human');
    const codes = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Slash', 'Space',
      ...'ADWSQEJLIKOUZXCVBNRTYFGHMP'.split('').map(c => 'Key' + c),
      ...'1234567890'.split('').map(c => 'Digit' + c),
      'Comma', 'Period', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal',
      'Backquote', 'Enter', 'ShiftLeft', 'ShiftRight', 'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'NumpadAdd', 'NumpadSubtract'];
    const used = new Set();
    for (const p of humans) {
      p.keys = Array.from({ length: 6 }, (_, i) => {
        const old = p.keys?.[i];
        if (!old || used.has(old)) return null;
        used.add(old); return old;
      });
    }
    for (const p of humans) p.keys = p.keys.map(key => {
      if (key) return key;
      const available = codes.find(code => !used.has(code)); used.add(available); return available;
    });
    const box = $('#binding-list');
    box.replaceChildren();
    for (const p of humans) {
      const row = document.createElement('div');
      const title = document.createElement('b'); title.textContent = p.name; row.append(title);
      ['Left', 'Right', 'Power +', 'Power −', 'Weapon', 'Fire'].forEach((label, i) => {
        const button = document.createElement('button'); button.className = 'ghost';
        button.textContent = label + ' · ' + p.keys[i].replace(/^Key|^Digit/, '');
        button.onclick = () => { button.textContent = 'Press a key'; button.focus(); };
        button.onkeydown = e => {
          e.preventDefault(); e.stopPropagation();
          if (e.code !== 'Escape' && !used.has(e.code)) p.keys[i] = e.code;
          UI.bindings();
        };
        row.append(button);
      });
      box.append(row);
    }
  },

  renderSetup() {
    $('#app-version').textContent = `v${APP_VERSION}`;
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
          ${Object.entries(DIFFICULTY).map(([id, d]) => `<option value="${id}">AI · ${d.label}</option>`).join('')}
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
      sel.onchange = () => { p.type = sel.value; UI.renderSetup(); };
      if ($('#opt-teams').value !== 'none') {
        const team = UI.teamSelect(p.team ?? i % 2);
        team.onchange = () => { p.team = +team.value; };
        row.append(team);
      }
      del.disabled = UI.setupPlayers.length <= 2;
      del.onclick = () => { UI.setupPlayers.splice(i, 1); UI.renderSetup(); };
      list.appendChild(row);
    });
    $('#add-player').hidden = UI.setupPlayers.length >= 10;
    $('#key-bindings').hidden = $('#opt-format').value !== 'simultaneous';
    if (!$('#key-bindings').hidden) UI.bindings();
    try { $('#resume-campaign').hidden = !localStorage.getItem('scorched.campaign'); } catch { $('#resume-campaign').hidden = true; }
  },

  readSettings() {
    return {
      ...Object.fromEntries(Object.entries(RULES).map(([key, def]) => [key,
        def.choices ? $(`#opt-${key}`).value : +$(`#opt-${key}`).value])),
      seed: (Math.random() * 1e9) | 0,
      players: UI.setupPlayers.map((p, i) => ({
        name: (p.name || '').trim() || DEFAULT_NAMES[i],
        color: TEAM_COLORS[p.color].hex, team: p.team ?? i % 2, keys: p.keys,
        type: p.type === 'human' ? 'human' : 'ai',
        difficulty: p.type === 'human' ? null : p.type,
      })),
    };
  },

  // ------------------------------------------------------------------ shop
  runShop(game, done) {
    const humans = game.tanks.filter(t => t.type === 'human');
    let i = game.shopper;
    const next = () => {
      if (i >= humans.length) { UI.hideScreens(); done(); return; }
      game.shopper = i;
      UI.renderShop(game, humans[i], () => { i++; next(); });
    };
    next();
  },

  renderShop(game, t, done) {
    UI.show('screen-shop');
    $('#save-status').textContent = '';
    $('#save-campaign').hidden = !!game.isNet;
    $('#save-campaign').onclick = () => {
      try { localStorage.setItem('scorched.campaign', Campaign.save(game)); $('#save-status').textContent = 'Campaign saved'; }
      catch { $('#save-status').textContent = 'Could not save in this browser'; }
    };
    $('#shop-defenses').onclick = () => UI.equipment(game, t, true);
    $('#shop-title').innerHTML = `<span style="color:${t.color}">${esc(t.name)}</span> · Arms dealer`;
    $('#shop-sub').textContent = `Next up: round ${game.round + 1} of ${game.settings.rounds} · Score ${t.score}`;
    const filter = $('#shop-family');
    const families = [...new Set([...Object.keys(WEAPONS), ...Object.keys(ITEMS)]
      .filter(id => Campaign.available(game.settings, id)).map(id => (WEAPONS[id] || ITEMS[id]).family))];
    filter.replaceChildren(new Option('All equipment', ''), ...families.map(f => new Option(f, f)));
    const draw = () => {
      $('#shop-money').textContent = `$${t.money.toLocaleString()}`;
      const grid = $('#shop-grid');
      grid.innerHTML = '';
      const entries = [...WEAPON_ORDER.filter(w => !WEAPONS[w].infinite).map(w => ['w', w]), ...Object.keys(ITEMS).map(k => ['i', k])];
      $('#shop-defenses').hidden = !t.items.autodefense;
      let family = '';
      entries.sort((a, b) => (WEAPONS[a[1]] || ITEMS[a[1]]).family.localeCompare((WEAPONS[b[1]] || ITEMS[b[1]]).family));
      for (const [kind, id] of entries) {
        if (!Campaign.available(game.settings, id)) continue;
        const def = kind === 'w' ? WEAPONS[id] : ITEMS[id];
        if (filter.value && filter.value !== def.family) continue;
        if (family !== def.family) {
          family = def.family; const heading = document.createElement('h3'); heading.textContent = family; grid.append(heading);
        }
        const price = Campaign.price(game, id);
        const owned = kind === 'w' ? (t.inventory[id] || 0) : (t.items[id] || 0);
        const shownOwned = id === 'fuel' ? Math.floor(owned) : owned;
        const card = document.createElement('div');
        card.className = 'card';
        const stats = def.desc;
        card.innerHTML = `
          <div class="t"><span style="color:${kind === 'w' ? def.color : '#7fe7ff'}">${def.name}</span><span class="own">owned ${shownOwned}</span></div>
          <div class="stats">${stats}</div>
          <div class="stats">$${price.toLocaleString()} for ${def.bundle}${id === 'fuel' ? ' tanks · 100 fuel' : ''}</div>
          <div class="acts"><button class="sell">Sell</button><button class="buy">Buy</button></div>`;
        const [sell, buy] = card.querySelectorAll('button');
        buy.disabled = t.money < price || (id === 'autodefense' && owned > 0);
        sell.disabled = owned < def.bundle * (id === 'fuel' ? 10 : 1);
        buy.onclick = () => { if (game.buy(t, id)) { Sfx.buy(); draw(); } };
        sell.onclick = () => { if (game.sell(t, id)) { Sfx.click(); draw(); } };
        grid.appendChild(card);
      }
    };
    draw();
    filter.onchange = draw;
    UI._shopRedraw = draw;
    $('#shop-done').onclick = () => { $('#equipment-panel').hidden = true; Sfx.click(); done(); };
  },

  equipment(game, t, preparing = false) {
    const panel = $('#equipment-panel'), box = $('#equipment-controls');
    panel.hidden = false; box.replaceChildren();
    $('#equipment-title').textContent = t.name + (preparing ? ' · pre-round defenses' : ' · equipment');
    $('#equipment-close').onclick = () => { panel.hidden = true; };
    const select = (label, key, options, current, numeric = false) => {
      const wrapper = document.createElement('label'), field = document.createElement('select');
      wrapper.textContent = label; field.setAttribute('aria-label', label);
      for (const [value, text] of options) field.add(new Option(text, value));
      field.value = current ?? '';
      field.onchange = () => game.equip(t, key, field.value === '' ? null : numeric ? +field.value : field.value);
      wrapper.append(field); box.append(wrapper);
    };
    const owned = family => Object.keys(ITEMS).filter(id => ITEMS[id].family === family && t.items[id] > 0)
      .map(id => [id, ITEMS[id].name + ' ×' + t.items[id]]);
    if (preparing || game.settings.format !== 'simultaneous') {
      const shields = owned('Shields');
      if (!preparing && t.shield) {
        shields.unshift(['active', 'Keep current shield']);
      }
      select('Shield', 'shield', [['', preparing ? 'None' : 'Lower shield'], ...shields],
        preparing ? t.defense : t.shield ? 'active' : null);
    }
    if (!preparing && t.shield) {
      const shield = document.createElement('span'); shield.textContent = ITEMS[t.shieldType].name + ' · ' + t.shield;
      box.append(shield);
    }
    select('Parachute', 'parachute', [[1, 'Deployed'], [0, 'Passive']], Number(t.parachuteOn !== false), true);
    const threshold = document.createElement('input'); threshold.type = 'number'; threshold.min = 0; threshold.max = 100;
    threshold.value = t.threshold ?? 5;
    const label = document.createElement('label'); label.textContent = 'Minimum fall damage'; label.append(threshold); box.append(label);
    threshold.onchange = () => game.equip(t, 'threshold', +threshold.value);
    if (preparing) return;
    if (game.settings.format !== 'simultaneous') {
      select('Guidance', 'guidance', [['', 'Unaided'], ...owned('Guidance')], t.guidance);
      const targets = game.tanks.filter(other => other.alive && other !== t);
      select('Target', 'target', [['', 'Choose target'], ...targets.map(other => [other.id, other.name])], t.targetId, true);
      if (t.items.trigger) select('Contact trigger', 'trigger', [[0, 'Passive'], [1, 'Armed']], +!!t.contact, true);
    }
    select('Energy weapon batteries', 'energy', Array.from({ length: Math.min(9, t.items.battery || 0) + 1 }, (_, i) => [i, String(i)]),
      Math.min(t.energy ?? 1, t.items.battery || 0), true);
    if (t.items.battery) {
      const button = document.createElement('button'); button.className = 'ghost'; button.textContent = 'Use battery (+10 health)';
      button.onclick = () => game.useRepair(t); box.append(button);
    }
  },

  // --------------------------------------------------------------- results
  showRound(game, onNext) {
    UI.show('screen-round');
    const w = game.lastWinner;
    $('#round-title').innerHTML = w ? `<span style="color:${w.color}">${esc(w.name)}</span> wins round ${game.round}` : `Round ${game.round} · no survivors`;
    $('#round-sub').textContent = game.round < game.settings.rounds ? `${game.settings.rounds - game.round} round(s) to go` : 'Final round complete';
    if (game.lastTeam != null) $('#round-title').textContent = `Team ${game.lastTeam + 1} wins round ${game.round}`;
    else if (!w) $('#round-title').textContent = `Round ${game.round} · draw`;
    const rows = game.standings().map((t, i) => `<tr class="${i === 0 ? 'first' : ''}">
      <td class="name"><span class="sw" style="background:${t.color}"></span>${esc(t.name)}${t.type === 'ai' ? ` <span class="sub">${DIFFICULTY[t.difficulty].label} AI</span>` : ''}</td>
      <td>${t.roundDamage}</td><td>${t.roundPoints >= 0 ? '+' : ''}${t.roundPoints}</td><td><b>${t.score}</b></td><td>${t.kills}</td><td>$${t.money.toLocaleString()}</td>${game.settings.scoring === 'greedy' ? `<td>$${Campaign.worth(game, t).toLocaleString()}</td>` : ''}</tr>`).join('');
    $('#round-table').innerHTML = `<tr><th>Commander</th><th>Damage</th><th>Round pts</th><th>Score</th><th>Kills</th><th>Cash</th>${game.settings.scoring === 'greedy' ? '<th>Net worth</th>' : ''}</tr>${rows}`;
    $('#round-next').onclick = () => { Sfx.click(); onNext(); };
  },

  showGameOver(game, onAgain, onNew) {
    UI.show('screen-over');
    const st = game.standings();
    $('#over-sub').innerHTML = `<span style="color:${st[0].color}">${esc(st[0].name)}</span> is the supreme commander after ${game.round} rounds`;
    if (['corporate', 'standard'].includes(game.settings.teams)) {
      const top = Campaign.teams(game)[0];
      $('#over-sub').textContent = `Team ${top.team + 1} wins · ${game.settings.scoring === 'greedy' ? '$' + top.worth.toLocaleString() : top.score + ' points'}`;
    }
    const medal = ['🥇', '🥈', '🥉'];
    $('#over-table').innerHTML = `<tr><th>#</th><th>Commander</th><th>Score</th><th>Kills</th><th>Rounds won</th><th>Net worth</th></tr>` +
      st.map((t, i) => `<tr class="${i === 0 ? 'first' : ''}"><td>${medal[i] || i + 1}</td><td class="name"><span class="sw" style="background:${t.color}"></span>${esc(t.name)}</td><td><b>${t.score}</b></td><td>${t.kills}</td><td>${t.wins}</td><td>$${Campaign.worth(game, t).toLocaleString()}</td></tr>`).join('');
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
    $('#equipment-open').disabled = !rawControl;
    if (!rawControl && game.phase !== 'shop') $('#equipment-panel').hidden = true;
    $('#btn-fire').disabled = !control || !!(game.settings.format === 'simultaneous' && (game.isNet ? t.busy : game.outstanding(t)));
    $('#btn-fire').textContent = game.settings.format === 'volley' ? (t.committed ? 'LOCKED' : 'LOCK IN') : 'FIRE';
    const fuel = Math.max(0, t.items.fuel || 0);
    $('#hud-fuel').textContent = `${Math.floor(fuel)}`;
    $('#btn-move').disabled = !rawControl || fuel < 1;
    const items = [];
    if (t.shield > 0) items.push(`<span class="chip" style="color:#7fe7ff">Shield ${t.shield}</span>`);
    if (t.items.parachute) items.push(`<span class="chip">Chute ×${t.items.parachute}</span>`);
    if (t.items.battery) items.push(`<button class="chip" id="btn-repair" title="Use battery (R)">Battery ×${t.items.battery}</button>`);
    const html = items.join('');
    const box = $('#hud-items');
    if (UI._itemsHtml !== html) { UI._itemsHtml = html; box.innerHTML = html; }
    box.hidden = !items.length;
  },

  updateScoreboard(game) {
    const html = game.tanks.slice().sort((a, b) => b.score - a.score).map(t => `
      <div class="r ${t.alive ? '' : 'dead'} ${game.current === t ? 'cur' : ''}">
        <span class="sw" style="background:${t.color}"></span><span class="n">${esc(t.name)}${game.settings.teams !== 'none' ? ' · T' + (t.team + 1) : ''}</span><span>${game.settings.format === 'simultaneous' ? Math.round(t.power) + ' · ' + WEAPONS[t.weapon].name : t.committed ? 'Ready' : t.score}</span>
        <span class="hp" style="width:${t.health}%;background:${t.health > 60 ? '#5ee07a' : t.health > 30 ? '#f2c94c' : '#ff5e57'}"></span>
      </div>`).join('');
    if (UI._sbHtml !== html) { UI._sbHtml = html; $('#scoreboard').innerHTML = html; }
  },
};
