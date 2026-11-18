// ---------------------------------------------------------------------------
// Bootstrap, main loop & input
// ---------------------------------------------------------------------------
(() => {
  const canvas = $('#game');
  const renderer = new Renderer(canvas);
  let game = null, demo = true, paused = false, speed = 1, lastPhase = null, roundTimer = 0;
  let lastSettings = null;
  const keys = {}, hold = { angle: 0, power: 0 };

  // ------------------------------------------------------------ game setup
  function startDemo() {
    demo = true;
    const players = [0, 1, 2, 3].map(i => ({ name: DEFAULT_NAMES[i], color: TEAM_COLORS[i].hex, type: 'ai', difficulty: ['hard', 'expert', 'medium', 'hard'][i] }));
    game = new Game({ players, rounds: 999, seed: (Math.random() * 1e9) | 0 });
    renderer.setGame(game);
    game.startRound();
    $('#hud').hidden = true; $('#scoreboard').hidden = true; $('#chatfeed').hidden = true; $('#chatbox').hidden = true;
    UI.renderSetup();
    UI.show('screen-setup');
  }

  function startGame(settings) {
    Sfx.init();
    demo = false; paused = false;
    lastSettings = settings;
    $('#btn-speed').hidden = false; $('#chatfeed').hidden = true;
    game = new Game(settings);
    renderer.setGame(game);
    lastPhase = null;
    UI.hideScreens();
    UI.runShop(game, () => beginRound());
  }

  function beginRound() {
    game.startRound();
    $('#hud').hidden = false; $('#scoreboard').hidden = false;
    UI.toast(`Round ${game.round}`, '#ffc23d', 1300);
  }

  function onRoundOver() {
    if (demo) { setTimeout(() => { if (demo) { game.continueAfterRound(); game.startRound(); } }, 2500); return; }
    const humans = game.tanks.some(t => t.type === 'human');
    UI.showRound(game, () => {
      game.continueAfterRound();
      if (game.phase === 'gameOver') {
        Sfx.win();
        UI.showGameOver(game,
          () => startGame(Object.assign({}, lastSettings, { seed: (Math.random() * 1e9) | 0 })),
          () => startDemo());
      } else if (humans) UI.runShop(game, () => beginRound());
      else { UI.hideScreens(); beginRound(); }
    });
    if (!humans) setTimeout(() => { if (!$('#screen-round').hidden) $('#round-next').click(); }, 4000);
  }

  // ------------------------------------------------------------------ input
  const humanTurn = () => game && !demo && (!paused || game.isNet) && game.canControl(game.current);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    keys[e.key] = true;
    if (e.key === 'Escape' && !demo && game && game.round) { togglePause(); return; }
    if ((e.key === 't' || e.key === 'T') && game && game.isNet) { e.preventDefault(); keys[e.key] = false; Net.openChatInput(); return; }
    if (!humanTurn()) return;
    const t = game.current;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); game.fire(); }
    else if (e.key === 'Tab' || e.key === 'e' || e.key === 'E') { e.preventDefault(); game.cycleWeapon(t, e.shiftKey ? -1 : 1); Sfx.click(); }
    else if (e.key === 'q' || e.key === 'Q') { game.cycleWeapon(t, -1); Sfx.click(); }
    else if (e.key === 'r' || e.key === 'R') game.useRepair(t);
    if (e.key.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; hold.angle = hold.power = 0; });

  function applyHeldInput(dt) {
    if (!humanTurn()) return;
    const t = game.current, fine = keys.Shift;
    const da = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0) + hold.angle;
    const dp = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0) + hold.power;
    if (da) t.angle = Math.max(0, Math.min(180, t.angle + da * (fine ? 8 : 50) * dt));
    if (dp) t.power = Math.max(0, Math.min(game.maxPower(t), t.power + dp * (fine ? 60 : 320) * dt));
  }

  // HUD hold-to-repeat buttons
  for (const b of document.querySelectorAll('[data-hold]')) {
    const [k, v] = b.dataset.hold.split(':');
    const start = (e) => {
      e.preventDefault(); b.setPointerCapture?.(e.pointerId);
      if (!humanTurn()) return;
      const t = game.current;
      if (k === 'angle') t.angle = Math.max(0, Math.min(180, Math.round(t.angle) + +v));
      else t.power = Math.max(0, Math.min(game.maxPower(t), Math.round(t.power) + +v * 5));
      b._t = setTimeout(() => { hold[k] = +v; }, 280);
    };
    const stop = () => { clearTimeout(b._t); hold[k] = 0; };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('pointerleave', stop);
  }
  $('#btn-fire').onclick = () => { if (humanTurn()) game.fire(); };
  $('#wpn-prev').onclick = () => { if (humanTurn()) { game.cycleWeapon(game.current, -1); Sfx.click(); } };
  $('#wpn-next').onclick = () => { if (humanTurn()) { game.cycleWeapon(game.current, 1); Sfx.click(); } };
  $('#hud-items').addEventListener('click', (e) => { if (e.target.id === 'btn-repair' && humanTurn()) game.useRepair(game.current); });
  $('#btn-sound').onclick = (e) => { e.currentTarget.textContent = Sfx.toggle() ? '🔇' : '🔊'; };
  $('#btn-speed').onclick = (e) => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; e.currentTarget.textContent = `${speed}×`; };
  $('#btn-help').onclick = () => togglePause();
  $('#help-resume').onclick = () => togglePause(false);
  $('#help-quit').onclick = () => {
    paused = false;
    if (game && game.isNet) { $('#screen-help').hidden = true; Net.leaveRoom(); } else startDemo();
  };

  function togglePause(force) {
    paused = force === undefined ? !paused : force;
    if (paused) UI.show('screen-help'); else $('#screen-help').hidden = true;
  }

  // drag on the battlefield to aim: direction = angle, distance = power
  let dragging = false;
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (CFG.W / r.width), y: (e.clientY - r.top) * (CFG.H / r.height) };
  };
  const aimAt = (e) => {
    const t = game.current, p = toWorld(e);
    const dx = p.x - t.x, dy = (t.y - CFG.TURRET_H) - p.y;
    t.angle = Math.max(0, Math.min(180, (Math.atan2(Math.max(dy, -5), dx) * 180) / Math.PI));
    t.power = Math.max(0, Math.min(game.maxPower(t), Math.hypot(dx, dy) * 2.2));
  };
  canvas.addEventListener('pointerdown', (e) => { if (!humanTurn()) return; dragging = true; canvas.setPointerCapture(e.pointerId); aimAt(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging && humanTurn()) aimAt(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });

  // setup screen
  $('#add-player').onclick = () => {
    const used = new Set(UI.setupPlayers.map(p => p.color));
    const color = TEAM_COLORS.findIndex((c, i) => !used.has(i));
    UI.setupPlayers.push({ name: DEFAULT_NAMES[UI.setupPlayers.length], color, type: 'medium' });
    UI.renderSetup();
  };
  $('#start').onclick = () => startGame(UI.readSettings());

  // -------------------------------------------------------------- main loop
  let last = performance.now(), hudTick = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (game && (!paused || game.isNet)) {
      applyHeldInput(dt);
      const reps = demo || game.isNet ? 1 : speed;
      for (let i = 0; i < reps; i++) game.update(dt);
      const evs = game.events.splice(0);
      renderer.silent = demo;
      if (!demo) {
        for (const e of evs) {
          if (e.type === 'turn' && game.round) {
            const t = e.tank;
            if (game.isNet) {
              if (t.id === game.myTankId && t.type === 'human') { UI.toast('Your shot!', t.color, 1100); Sfx.win(); }
              else UI.toast(`${t.name}'s turn`, t.color, 900);
            } else if (t.type === 'human') UI.toast(`${t.name}, your shot`, t.color, 1100);
          }
          if (e.type === 'death') UI.toast(`${e.tank.name} destroyed`, '#ffd34d', 1300);
        }
      }
      renderer.consume(demo ? evs.filter(e => e.type !== 'turn') : evs);
      if (game.phase === 'roundOver' && lastPhase !== 'roundOver') roundTimer = demo ? 0 : 1.6;
      if (game.phase === 'roundOver' && roundTimer !== null && !game.isNet) {
        roundTimer -= dt;
        if (roundTimer <= 0) { roundTimer = null; onRoundOver(); }
      }
      lastPhase = game.phase;
    }
    if (game && game.round) renderer.draw(paused ? 0 : dt);
    if (game && !demo && game.round && ++hudTick % 3 === 0) { UI.updateHud(game); UI.updateScoreboard(game); }
    requestAnimationFrame(frame);
  }

  // hooks for the online client (net.js)
  window.App = {
    useGame(g) {
      demo = false; paused = false; speed = 1; $('#btn-speed').textContent = '1×';
      game = g; renderer.setGame(g); lastPhase = null; roundTimer = null;
      $('#hud').hidden = false; $('#scoreboard').hidden = false;
      $('#btn-speed').hidden = !!g.isNet; $('#chatfeed').hidden = !g.isNet;
    },
    stopGame() { startDemo(); },
    startDemo,
  };
  Net.init();
  startDemo();
  requestAnimationFrame(frame);
  // expose for debugging / automated tests
  window.__scorched = { get game() { return game; }, renderer, startGame, UI, Net };
})();
