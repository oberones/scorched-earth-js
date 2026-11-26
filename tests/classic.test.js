const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game, Physics, Terrain, AI, Campaign, TEAM_COLORS, WEAPONS, ITEMS, CFG } = require('../server/lib/engine');
const { Lobby } = require('../server/lib/lobby');
const Leaderboard = require('../src/leaderboard');

function campaign(settings = {}, count = 2) {
  const players = Array.from({ length: count }, (_, i) => ({
    type: 'human', name: 'Pilot ' + i, color: TEAM_COLORS[i].hex, team: i % 2,
  }));
  return new Game({ seed: 42, players, windMode: 'none', ...settings });
}

function field(settings = {}, count = 2) {
  const g = campaign(settings, count);
  g.startRound(); g.terrain.ground.fill(500); g.terrain.holes.clear();
  g.turn = 0; g.turnOrder = g.tanks.map(t => t.id);
  g.tanks.forEach((t, i) => { t.x = 200 + 110 * i; t.y = 500; t.angle = 40; t.power = 600; });
  return g;
}

function arm(g, id) {
  const t = g.current;
  t.inventory[id] = id === 'baby' ? Infinity : 1; t.weapon = id;
  assert.ok(g.fire(t));
  return g.projectiles[0];
}

function impact(g, p, type, x = 390, y = 500) {
  p.x = x; p.y = y;
  g.handleImpact(p, { type, x, y });
}

test('all catalog entries can be acquired in their DOS bundles; arms and mode filters apply at checkout', () => {
  const g = campaign({ startingCash: 1000000, suspend: 100 }), t = g.current || g.tanks[0];
  assert.equal(Object.keys(WEAPONS).length, 33);
  assert.equal(Object.keys(ITEMS).length, 15);
  for (const [id, def] of Object.entries({ ...WEAPONS, ...ITEMS })) {
    if (id === 'baby') { assert.equal(t.inventory[id], Infinity); continue; }
    assert.ok(g.buy(t, id), id);
    const count = (WEAPONS[id] ? t.inventory : t.items)[id];
    assert.equal(count, def.bundle * (id === 'fuel' ? 10 : 1), id);
  }
  assert.equal(Campaign.available({ ...g.settings, arms: 0 }, 'nuke'), false);
  assert.equal(Campaign.available({ ...g.settings, format: 'simultaneous' }, 'ballistic'), false);
  assert.equal(Campaign.available({ ...g.settings, suspend: 0 }, 'disrupter'), false);
  assert.equal(g.buy(t, 'constructor'), false);
});

test('tunnel roofs support tanks and full and incremental terrain updates reproduce cavities', () => {
  const g = field(), land = g.terrain, x = g.current.x;
  const copy = new Terrain(CFG.W, CFG.H);
  copy.applyChanges(land.changes(-1));
  const prior = land.version;
  land.crater(x, 550, 28, true);
  assert.ok(land.isSolid(x, 510)); assert.ok(!land.isSolid(x, 550));
  assert.equal(g.restY(g.current), 500);
  assert.equal(land.support(x, 550), 578);
  const delta = land.changes(prior);
  assert.ok(delta.runs[0].heights.length < CFG.W / 2);
  copy.applyChanges(delta);
  assert.equal(copy.support(x, 550), 578);
  land.collapse(); copy.applyChanges(land.changes(delta.version));
  assert.equal(copy.holes.size, 0); assert.equal(copy.heightAt(x), land.heightAt(x));
});

test('ordinary shell clears a thin ridge; a contact trigger stops it on entry', () => {
  const g = field(), env = { terrain: g.terrain, tanks: [], wind: 0, walls: 'open' };
  const make = contact => ({ ...Physics.makeProjectile(g.current, 0, 800, 'missile'), x: 150, y: 465, vx: 420, vy: 0, contact });
  for (let x = 156; x < 160; x++) g.terrain.ground[x] = 440;
  const shell = make(false), contact = make(true);
  let ev;
  while (shell.x < 170) assert.notEqual(Physics.step(shell, env)?.type, 'ground');
  while (!ev) ev = Physics.step(contact, env);
  assert.equal(ev.type, 'ground'); assert.ok(shell.vx < contact.vx);
});

for (const [id, w] of Object.entries(WEAPONS)) {
  test(w.name + ' performs its catalog behavior', () => {
    const g = field({ suspend: 100 });
    const t = g.current, start = g.terrain.version;
    t.items.battery = 4; t.energy = 2;
    if (id === 'disrupter') g.terrain.crater(390, 555, 15, true);
    const p = arm(g, id);
    if (w.wedge) {
      assert.equal(p, undefined);
      if (!w.dirt) {
        const buried = field(); buried.terrain.ground.fill(420);
        const before = buried.terrain.version; arm(buried, id);
        assert.ok(buried.terrain.version > before);
      } else assert.ok(g.terrain.version > start);
    } else if (w.family === 'Energy') {
      assert.equal(t.items.battery, 2); assert.ok(id === 'laser' ? g.marks.length : g.blasts.length);
    } else if (w.split) {
      impact(g, p, 'apex', 360, 125);
      assert.equal(g.projectiles.filter(q => q.child).length, w.split);
      const early = field(); impact(early, arm(early, id), 'ground');
      assert.equal(early.blasts.length, 0);
    } else if (w.digger || w.hogs) {
      impact(g, p, 'ground', 390, 510);
      const children = g.projectiles.filter(q => q.burrowing);
      assert.equal(children.length, w.hogs || 1);
      for (const q of children) { q.remaining = 0.1; impact(g, q, 'dig', 392, 530); }
      assert.ok(g.terrain.version > start);
      assert.equal(g.blasts.length, w.hogs || 0);
      if (w.digger) {
        const direct = field(); impact(direct, arm(direct, id), 'tank');
        assert.equal(direct.blasts.length, 0); assert.equal(direct.tanks[1].health, 100);
      }
    } else if (w.family === 'Rollers') {
      for (let i = 380; i < 420; i++) g.terrain.ground[i] = 500 + (i - 380) * 0.6;
      impact(g, p, 'ground');
      assert.ok(p.rolling); Physics.step(p, { terrain: g.terrain, tanks: [], wind: 0, walls: 'open' });
      assert.ok(p.x > 390); impact(g, p, 'rest'); assert.equal(g.blasts.length, 1);
    } else if (w.bounces) {
      for (let i = 0; i < 3; i++) impact(g, p, 'ground');
      assert.ok(!p.alive && g.blasts[0].r < g.blasts[1].r && g.blasts[1].r < g.blasts[2].r);
    } else {
      impact(g, p, 'ground');
      if (w.dirt || id === 'liquiddirt') assert.ok(g.terrain.heightAt(390) < 500);
      else if (w.family === 'Fire') assert.ok(g.marks.some(m => m.points[3] > m.points[1]));
      else if (w.family === 'Tracers') { assert.equal(g.blasts.length, 0); assert.equal(g.marks.length, id === 'smoke' ? 1 : 0); }
      else if (id === 'disrupter') assert.equal(g.terrain.holes.size, 0);
      else if (id === 'funky') assert.equal(g.pending.length, 6);
      else { assert.equal(g.blasts.length, 1); assert.ok(g.terrain.heightAt(390) > 500); }
    }
  });
}

test('all shield types activate, intercept or reflect, and auto defense equips before play', () => {
  for (const [id, def] of Object.entries(ITEMS).filter(([, d]) => d.strength)) {
    const g = field(), t = g.current;
    t.items[id] = 1; assert.ok(g.equip(t, 'shield', id));
    const p = Physics.makeProjectile(g.tanks[1], 180, 500, 'missile');
    Object.assign(p, { x: t.x + 25, y: t.y - 9, vy: 0, age: 1 });
    const ev = Physics.step(p, { terrain: g.terrain, tanks: g.tanks, wind: 0, walls: 'open' });
    assert.equal(ev.type, 'shield');
    if (id === 'mag' || id === 'supermag') assert.ok(p.vy < 0);
    g.handleImpact(p, ev);
    if (id === 'force' || id === 'supermag') assert.ok(p.alive && p.vx > 0);
    else assert.ok(!p.alive);
    assert.equal(t.shield, def.strength - 4);
  }
  const g = campaign({ startingCash: 100000 }), t = g.tanks[0];
  assert.ok(g.buy(t, 'autodefense')); assert.ok(g.buy(t, 'force'));
  assert.ok(g.equip(t, 'shield', 'force')); g.startRound(); assert.equal(t.shieldType, 'force');
});

test('five guidance systems act on compatible shots and preserve inventory for MIRVs', () => {
  for (const id of ['heat', 'horizontal', 'vertical', 'ballistic', 'lazy']) {
    const g = field(), t = g.current, foe = g.tanks[1];
    t.items[id] = 1; g.equip(t, 'target', foe.id); g.equip(t, 'guidance', id);
    const p = arm(g, 'missile');
    assert.equal(p.guidance, id); assert.equal(t.items[id], 0);
    if (id === 'ballistic') assert.notEqual(Math.round(Math.hypot(p.vx, p.vy)), Physics.launchSpeed(600));
    else {
      Object.assign(p, { x: foe.x - (id === 'vertical' ? 0 : 30), y: foe.y - 9 - (id === 'horizontal' ? 0 : 20) });
      Physics.guide(p, g.tanks); assert.ok(p.straight);
      if (id === 'horizontal') assert.equal(p.vy, 0);
      if (id === 'vertical') assert.equal(p.vx, 0);
    }
    const other = field(), shooter = other.current;
    shooter.items[id] = 1; other.equip(shooter, 'guidance', id); arm(other, 'mirv');
    assert.equal(shooter.items[id], 1);
  }
});

test('parachute threshold, batteries, triggers and fuel are configurable resources', () => {
  const g = field(), t = g.current;
  Object.assign(t.items, { fuel: 10, parachute: 2, battery: 2, trigger: 1 });
  assert.ok(g.equip(t, 'parachute', 0)); assert.equal(t.parachuteOn, false);
  assert.ok(g.equip(t, 'threshold', 30)); assert.equal(t.threshold, 30);
  t.health = 2; assert.ok(g.useRepair(t)); assert.equal(t.health, 12); assert.equal(g.maxPower(t), 1000);
  assert.ok(g.moveTank(t, 1).moved); assert.equal(t.items.fuel, 9);
  assert.ok(g.equip(t, 'trigger', true)); assert.ok(arm(g, 'missile').contact); assert.equal(t.items.trigger, 0);
});

test('friendly fire, shared wallets, betrayal, scoring modes and a ten-seat long campaign', () => {
  const g = campaign({ teams: 'corporate', rounds: 1000, startingCash: 2000 }, 10);
  assert.ok(g.buy(g.tanks[0], 'missile')); assert.equal(g.tanks[2].money, 125);
  assert.equal(g.buy(g.tanks[2], 'missile'), false);
  assert.equal(Campaign.teams(g).find(t => t.team === 0).worth, 1625);
  g.startRound(); assert.equal(new Set(g.tanks.map(t => t.x)).size, 10);
  g.applyDamage(g.tanks[2], 8, g.tanks[0]); assert.ok(g.tanks[0].score < 0);
  for (const t of g.tanks.filter(t => t.team === 1)) t.alive = false;
  assert.ok(g.battleDone()); g.endRound(); assert.equal(g.lastTeam, 0);
  const v = field({ teams: 'vicious' }, 3); v.tanks[1].alive = false;
  assert.equal(v.battleDone(), false); assert.ok(!v.allied(v.tanks[0], v.tanks[2]));
  const standard = field({ teams: 'standard' }, 3); standard.tanks[1].alive = false; assert.ok(standard.battleDone());
  const basic = field({ scoring: 'basic' }); basic.applyDamage(basic.tanks[1], 10, basic.current); assert.equal(basic.current.score, 0);
  const greedy = field({ scoring: 'greedy' }); greedy.tanks[1].money = 100000; assert.equal(greedy.standings()[0].id, 1);
  g.round = 1000; g.continueAfterRound(); assert.equal(g.phase, 'gameOver');
  assert.equal(Leaderboard.rank(Leaderboard.fromMatch(g))[0].rounds, 1000);
});

test('mid-shop save continues identically including buyers, prices, interest, RNG and resolved unknown AI', () => {
  const g = campaign({ startingCash: 30000, market: 'on', suspend: 50 }, 3);
  g.settings.players[2].type = 'ai'; g.settings.players[2].difficulty = 'unknown';
  const game = new Game(g.settings);
  game.shopBots(); game.shopper = 1; assert.ok(game.buy(game.tanks[1], 'missile'));
  const saved = Campaign.save(game), loaded = Campaign.restore(saved);
  assert.equal(Campaign.save(loaded), saved);
  const expectedPrice = 100 + (game.demand.missile + 1) * 3;
  for (const match of [game, loaded]) {
    match.buy(match.tanks[1], 'missile'); match.startRound();
    assert.equal(match.marketPrices.missile, expectedPrice);
    match.endRound(); match.continueAfterRound();
  }
  assert.equal(Campaign.save(loaded), Campaign.save(game));
  assert.equal(Campaign.price(campaign({ market: 'on' }), 'missile'), 1875);
  assert.throws(() => Campaign.restore('{"version":99}'));
});

test('the first visit to the free market opens at list prices with a zero starting balance', () => {
  const game = campaign({ market: 'on' });
  game.startRound(); game.endRound(); game.continueAfterRound();
  assert.equal(game.phase, 'shop');
  assert.equal(Campaign.price(game, 'missile'), WEAPONS.missile.price);
});

test('playing a round after restoring a partially completed shop reproduces combat and standings', () => {
  const original = campaign({ startingCash: 30000, market: 'on', suspend: 40, environment: 'meteors' });
  original.shopper = 1; original.buy(original.tanks[0], 'babynuke');
  const restored = Campaign.restore(Campaign.save(original));
  function play(game) {
    game.startRound();
    for (let tick = 0; tick < 40000 && game.phase !== 'roundOver'; tick++) {
      if (game.phase === 'aim') {
        const tank = game.current, target = game.alive().find(t => t !== tank);
        const shot = AI.solve(game, tank, target, game.wind);
        tank.angle = shot.angle; tank.power = shot.power;
        tank.weapon = tank.inventory.babynuke ? 'babynuke' : 'baby';
        game.fire(tank);
      }
      game.update(1 / 30);
    }
    assert.equal(game.phase, 'roundOver');
    const ranked = game.standings().map(t => [t.id, t.score, t.kills, t.health]);
    game.continueAfterRound();
    return { ranked, terrain: game.terrain.changes(-1), saved: Campaign.save(game) };
  }
  assert.equal(JSON.stringify(play(restored)), JSON.stringify(play(original)));
});

test('sequential turn orders honor standings and rotate the opening round-robin shot', () => {
  const game = campaign({ order: 'round-robin' }, 4);
  for (let i = 0; i < 5; i++) {
    game.startRound();
    assert.equal(game.turn, i % 4); assert.equal(new Set(game.turnOrder).size, 4);
  }
  game.tanks.forEach((t, i) => { t.score = i; t.money = 100 - i; });
  game.settings.order = 'winners-first'; assert.deepEqual(game.makeOrder(), [3, 2, 1, 0]);
  game.settings.order = 'losers-first'; assert.deepEqual(game.makeOrder(), [0, 1, 2, 3]);
  game.settings.scoring = 'greedy'; assert.deepEqual(game.makeOrder(), [3, 2, 1, 0]);
});

test('a delayed blast resolves while another volley shell is still in flight', () => {
  const game = field({ format: 'volley' });
  game.tanks[0].weapon = 'funky'; game.tanks[0].inventory.funky = 1;
  for (const tank of game.tanks) game.fire(tank);
  impact(game, game.projectiles[0], 'ground');
  for (let i = 0; i < 20; i++) game.update(1 / 60);
  assert.equal(game.phase, 'flight');
  assert.ok(game.blasts.length > 0 && game.pending.length > 0);
});

test('volley commitments lock once, real-time shots overlap, and mutual destruction yields a draw', () => {
  const volley = field({ format: 'volley' });
  assert.ok(volley.fire(volley.tanks[1])); assert.equal(volley.projectiles.length, 0);
  assert.ok(!volley.fire(volley.tanks[1])); assert.ok(volley.fire(volley.tanks[0]));
  assert.equal(volley.projectiles.length, 2);
  const g = field({ format: 'simultaneous' });
  for (const t of g.tanks) { t.health = 1; assert.ok(g.fire(t)); }
  assert.equal(g.projectiles.length, 2); assert.ok(!g.fire(g.current));
  g.projectiles.forEach((p, i) => {
    const target = g.tanks[1 - i];
    Object.assign(p, { x: target.x, y: target.y - 9, vx: 0, vy: 0, age: 1 });
  });
  for (let i = 0; i < 600 && g.phase !== 'roundOver'; i++) g.update(1 / 60);
  assert.equal(g.phase, 'roundOver'); assert.equal(g.alive().length, 0); assert.equal(g.lastWinner, null);
});

test('full terrain and a committed volley survive reconnect and spectator catch-up', t => {
  const lobby = new Lobby(); t.after(() => lobby.shutdown());
  function connect(name, token) {
    const messages = [];
    const client = lobby.hello({ send: data => messages.push(JSON.parse(data)) }, { name, token });
    return { client, messages };
  }
  const a = connect('Alice'), b = connect('Bob');
  lobby.handle(a.client, { t: 'createRoom' });
  const room = a.client.room;
  lobby.handle(b.client, { t: 'joinRoom', code: room.code });
  lobby.handle(a.client, { t: 'settings', settings: { format: 'volley', suspend: 100 } });
  room.startGame(); const g = room.game;
  room.handleGame(a.client, { t: 'fire', serial: 0 });
  const tank = g.tanks[room.tankOf.get(a.client.id)]; assert.ok(tank.committed);
  g.terrain.crater(300, g.terrain.heightAt(300) + 60, 16, true);
  lobby.disconnect(a.client); const resumed = connect('Alice', a.client.token);
  const watch = connect('Watch'); lobby.handle(watch.client, { t: 'joinRoom', code: room.code });
  for (const peer of [resumed, watch]) {
    const snap = peer.messages.findLast(m => m.t === 'snap');
    assert.equal(snap.tanks[tank.id].committed, true);
    assert.equal(snap.terrain.runs[0].heights.length, CFG.W);
    const copy = new Terrain(CFG.W, CFG.H); copy.applyChanges(snap.terrain); assert.ok(copy.holes.has(300));
  }
  room.handleGame(resumed.client, { t: 'fire', serial: 0 }); assert.equal(g.projectiles.length, 0);
  room.handleGame(b.client, { t: 'fire' }); assert.equal(g.projectiles.length, 2);
  room.handleGame(watch.client, { t: 'fire' }); assert.equal(g.projectiles.length, 2);
});

test('two corporate teammates bidding from separate connections share the last affordable bundle', t => {
  const lobby = new Lobby(); t.after(() => lobby.shutdown());
  const clients = ['Ada', 'Bo', 'Cy'].map(name => lobby.hello({ send() {} }, { name }));
  const [host, teammate] = clients;
  lobby.handle(host, { t: 'createRoom' });
  const room = host.room;
  for (const c of clients.slice(1)) lobby.handle(c, { t: 'joinRoom', code: room.code });
  clients.forEach((c, i) => lobby.handle(host, { t: 'team', id: c.id, team: i === 2 ? 1 : 0 }));
  lobby.handle(host, { t: 'settings', settings: { teams: 'corporate', startingCash: 2000 } });
  room.startGame();
  for (const c of [host, teammate]) lobby.handle(c, { t: 'buy', id: 'missile' });
  const [first, second, opponent] = room.game.tanks;
  assert.deepEqual([first.money, second.money, opponent.money], [125, 125, 2000]);
  assert.equal(first.inventory.missile, 5); assert.equal(second.inventory.missile, undefined);
  lobby.disconnect(teammate);
  assert.ok(Leaderboard.fromMatch(room.game).some(entry => entry.name === 'Bo'));
});

test('named computer opponents select distinctive firing strategies', () => {
  function setup(persona) {
    const g = campaign({ seed: 12, walls: 'bounce' }, 3);
    Object.assign(g.settings.players[0], { type: 'ai', difficulty: persona });
    const match = new Game(g.settings); match.startRound(); match.terrain.ground.fill(550);
    match.tanks.forEach((t, i) => { t.x = 250 + i * 400; t.y = 550; });
    return match;
  }
  const plan = g => AI.plan(g, g.tanks[0]);
  const flight = (g, shot) => Physics.simulate(g.terrain, g.tanks, g.tanks[0], shot.angle, shot.power, 0, g.wall);
  for (const id of ['shooter', 'chooser', 'spoiler']) {
    const g = setup(id), shot = plan(g);
    assert.equal(flight(g, shot).tank?.id, shot.target.id, id);
    if (id !== 'spoiler') assert.ok(shot.angle < 20);
  }
  const pool = setup('poolshark');
  assert.equal(flight(pool, plan(pool)).banked, true);
  const tosser = setup('tosser'), first = plan(tosser);
  tosser.tanks[0].impactX = first.target.x - 140;
  assert.ok(plan(tosser).power > first.power);
  const moron = setup('moron');
  assert.notEqual(plan(moron).angle, plan(moron).angle);
  const cyborg = setup('cyborg');
  cyborg.tanks[0].lastAttacker = 2;
  assert.equal(plan(cyborg).target.id, 2);
  const unknown = setup('unknown'); assert.ok(unknown.tanks[0].persona); assert.notEqual(unknown.tanks[0].persona, 'unknown');
});

test('wall material, air resistance, lightning and meteors affect the simulated battlefield', () => {
  const g = field();
  function bounce(wall) {
    const p = Physics.makeProjectile(g.current, 180, 500, 'missile');
    Object.assign(p, { x: 0, y: 200, vx: -200, vy: 0 });
    const ev = Physics.step(p, { terrain: g.terrain, wind: 0, tanks: [], walls: wall });
    return { p, ev };
  }
  assert.equal(bounce('concrete').ev.type, 'wall');
  assert.ok(bounce('wrap').p.x > CFG.W - 5);
  assert.ok(bounce('padded').p.vx < bounce('bounce').p.vx);
  assert.ok(bounce('spring').p.vx > bounce('bounce').p.vx);
  g.settings.drag = 15;
  assert.ok(bounce('bounce').p.vx < 200);
  for (const environment of ['lightning', 'meteors']) {
    const active = field({ environment }), cosmetic = field({ environment, hostile: 'off' });
    for (const match of [active, cosmetic]) { match.hazardClock = 7.99; match.update(0.05); assert.ok(match.marks.length); }
    assert.ok(active.blasts.length); assert.equal(cosmetic.blasts.length, 0);
  }
});
