// Headless tests: run with `node tests/headless.test.js`
// Loads the DOM-free game modules into a VM context and plays full AI-vs-AI games.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src');
const ctx = vm.createContext({ console, Math, Date, Float32Array, Infinity });
for (const f of ['config.js', 'terrain.js', 'physics.js', 'ai.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}
const run = code => vm.runInContext(code, ctx);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

test('crater lowers terrain and collapses soil into the hole', () => {
  run(`var T = new Terrain(400, 300); T.ground.fill(150); T.crater(200, 150, 30);`);
  const g = run('T.ground');
  assert(Math.abs(g[200] - 180) < 0.01, 'centre column should drop by r');
  assert(g[100] === 150, 'outside columns untouched');
  run(`T.crater(200, 100, 20)`); // blast in the air above a column with no dirt in disc
  assert(Math.abs(run('T.ground[200]') - 180) < 0.01, 'air blast removes nothing');
});

test('dirt ball raises the ground', () => {
  run(`var T2 = new Terrain(400, 300); T2.ground.fill(200); T2.addDirt(200, 190, 30);`);
  assert(run('T2.ground[200]') < 160);
});

test('tank movement spends fuel, charges for climbing, and preserves the turn', () => {
  run(`
    var M = new Game({ seed: 1, players: [
      { name: 'Mover', type: 'human', color: '#f00' }, { name: 'Other', type: 'human', color: '#00f' }] });
    M.terrain.ground.fill(300); M.phase = 'aim'; M.turn = 0; M.turnCount = 7;
    M.tanks[0].x = 200; M.tanks[0].y = M.restY(M.tanks[0]); M.tanks[0].items.fuel = 10;
    M.tanks[1].x = 500; M.tanks[1].y = M.restY(M.tanks[1]);
    var flatMove = M.moveTank(M.tanks[0], 1);
  `);
  assert(run('flatMove.moved'));
  assert.strictEqual(run('M.tanks[0].x'), 201);
  assert.strictEqual(run('M.tanks[0].items.fuel'), 9);
  assert.strictEqual(run('M.turnCount'), 7);
  assert.strictEqual(run('M.phase'), 'aim');

  run(`
    for (var x = 0; x < M.terrain.w; x++) M.terrain.ground[x] = 400 - x * 0.25;
    M.tanks[0].y = M.restY(M.tanks[0]); var fuelBeforeHill = M.tanks[0].items.fuel;
    var hillMove = M.moveTank(M.tanks[0], 1);
  `);
  assert(run('hillMove.moved'));
  assert(run('hillMove.cost > 1 && hillMove.cost < 2'));
  assert(Math.abs(run('fuelBeforeHill - M.tanks[0].items.fuel') - run('hillMove.cost')) < 1e-6);
});

test('movement rejects invalid turns, bounds, collisions, steep climbs, and missing fuel', () => {
  run(`
    var B = new Game({ seed: 2, players: [
      { name: 'A', type: 'human', color: '#f00' }, { name: 'B', type: 'human', color: '#00f' }] });
    B.terrain.ground.fill(300); B.phase = 'aim'; B.turn = 0;
    var a = B.tanks[0], b = B.tanks[1]; a.x = 200; b.x = 233; a.y = B.restY(a); b.y = B.restY(b); a.items.fuel = 20;
    var collision = B.moveTank(a, 1), wrongTank = B.moveTank(b, 1), invalidDir = B.moveTank(a, 0);
    b.x = 500; b.y = B.restY(b); a.x = CFG.TANK_RADIUS;
    var edge = B.moveTank(a, -1);
    a.x = 200; for (var x = 0; x < B.terrain.w; x++) B.terrain.ground[x] = 650 - x * 2;
    a.y = B.restY(a); var steep = B.moveTank(a, 1);
    B.terrain.ground.fill(300); a.y = B.restY(a); a.items.fuel = 0; var empty = B.moveTank(a, 1);
    B.phase = 'flight'; a.items.fuel = 20; var flight = B.moveTank(a, 1);
  `);
  for (const name of ['collision', 'wrongTank', 'invalidDir', 'edge', 'steep', 'empty', 'flight']) assert(!run(`${name}.moved`), name);
  assert.strictEqual(run('collision.reason'), 'tank');
  assert.strictEqual(run('steep.reason'), 'slope');
});

test('a steep descent settles, applies fall rules, and resumes the same turn', () => {
  run(`
    var F = new Game({ seed: 3, players: [
      { name: 'A', type: 'human', color: '#f00' }, { name: 'B', type: 'human', color: '#00f' }] });
    F.terrain.ground.fill(420); for (var x = 0; x <= 200; x++) F.terrain.ground[x] = 320;
    F.phase = 'aim'; F.turn = 0; F.turnCount = 4;
    var ft = F.tanks[0]; ft.x = 209; ft.y = F.restY(ft); ft.items.fuel = 10;
    F.tanks[1].x = 600; F.tanks[1].y = F.restY(F.tanks[1]);
    var fallMove = F.moveTank(ft, 1), frames = 0;
    while (F.phase === 'settle' && frames++ < 1000) F.update(1 / 60);
  `);
  assert(run('fallMove.falling'));
  assert.strictEqual(run('F.phase'), 'aim');
  assert.strictEqual(run('F.turn'), 0);
  assert.strictEqual(run('F.turnCount'), 4);
  assert(run('ft.health < 100 && ft.health > 0'));

  run(`
    F.phase = 'aim'; ft.x = 209; ft.y = 320; ft.health = 100; ft.items.fuel = 10; ft.items.parachute = 1;
    F.moveTank(ft, 1); frames = 0; while (F.phase === 'settle' && frames++ < 1000) F.update(1 / 60);
  `);
  assert.strictEqual(run('ft.health'), 100);
  assert.strictEqual(run('ft.items.parachute'), 0);
});

test('AI simulation matches live flight exactly', () => {
  run(`
    var G = new Game({ seed: 42, rounds: 1, players: [
      { name: 'A', type: 'ai', difficulty: 'expert', color: '#f00' },
      { name: 'B', type: 'ai', difficulty: 'expert', color: '#00f' }] });
    G.startRound();
    var shooter = G.tanks[0];
    var pred = Physics.simulate(G.terrain, G.tanks, shooter, 50, 640, G.wind, 'open');
    var p = Physics.makeProjectile(shooter, 50, 640, 'baby');
    var env = { terrain: G.terrain, tanks: G.tanks, wind: G.wind, walls: 'open' };
    var ev; for (var i = 0; i < 5000; i++) { ev = Physics.step(p, env); if (ev && ev.type !== 'apex') break; }
  `);
  const pred = run('pred'), ev = run('ev');
  if (pred.lost) assert.strictEqual(ev.type, 'lost');
  else { assert.strictEqual(pred.x, ev.x); assert.strictEqual(pred.y, ev.y); }
});

function playGame(difficulty, seed, nPlayers = 4, rounds = 3) {
  run(`
    var players = [];
    for (var i = 0; i < ${nPlayers}; i++) players.push({ name: 'P' + i, type: 'ai', difficulty: '${difficulty}', color: TEAM_COLORS[i].hex });
    var G = new Game({ seed: ${seed}, rounds: ${rounds}, players: players });
    var shots = 0, hits = 0, frames = 0;
    G.startRound();
    while (G.phase !== 'gameOver' && frames < 600000) {
      G.update(1 / 30); frames++;
      for (const e of G.events) {
        if (e.type === 'fire') shots++;
        if (e.type === 'hit' && e.dmg + e.absorbed > 0) hits++;
      }
      G.events.length = 0;
      if (G.phase === 'roundOver') G.continueAfterRound();
      else if (G.phase === 'shop') G.startRound();
    }
  `);
  return run(`({ phase: G.phase, shots, hits, frames, round: G.round,
    scores: G.tanks.map(t => t.score), money: G.tanks.map(t => t.money), simSeconds: frames / 30 })`);
}

const results = {};
for (const d of ['easy', 'medium', 'hard', 'expert']) {
  test(`full ${d} AI game completes (3 rounds, 4 tanks)`, () => {
    const t0 = Date.now();
    let shots = 0, rounds = 0;
    for (const seed of [1, 2, 3]) {
      const r = playGame(d, seed);
      assert.strictEqual(r.phase, 'gameOver', 'game should reach gameOver');
      assert.strictEqual(r.round, 3);
      assert(r.scores.some(s => s > 0), 'someone should score');
      shots += r.shots; rounds += r.round;
    }
    results[d] = { shotsPerRound: +(shots / rounds).toFixed(1), ms: Date.now() - t0 };
  });
}

test('higher difficulty finishes rounds in fewer shots', () => {
  console.log('    shots per round:', JSON.stringify(results));
  assert(results.expert.shotsPerRound < results.easy.shotsPerRound, 'expert should beat easy');
});

test('mixed difficulty: expert outscores easy over several games', () => {
  let expertWins = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    run(`
      var G = new Game({ seed: ${seed}, rounds: 3, players: [
        { name: 'E', type: 'ai', difficulty: 'easy', color: '#f00' },
        { name: 'X', type: 'ai', difficulty: 'expert', color: '#00f' }] });
      G.startRound(); var f = 0;
      while (G.phase !== 'gameOver' && f++ < 400000) {
        G.update(1/30); G.events.length = 0;
        if (G.phase === 'roundOver') G.continueAfterRound(); else if (G.phase === 'shop') G.startRound();
      }`);
    if (run('G.tanks[1].score > G.tanks[0].score')) expertWins++;
  }
  console.log(`    expert beat easy in ${expertWins}/6 games`);
  assert(expertWins >= 4);
});

test('destroyed tanks fall into the crater instead of hovering', () => {
  run(`
    var G = new Game({ seed: 7, rounds: 1, players: [
      { name: 'A', type: 'human', color: '#f00' }, { name: 'B', type: 'human', color: '#0f0' },
      { name: 'C', type: 'human', color: '#00f' }] });
    G.startRound();
    var victim = G.tanks[1]; victim.health = 1;
    var before = victim.y;
    G.phase = 'settle'; G.settleTime = 0;
    G.detonate(victim.x, victim.y + 4, 'nuke', G.tanks[0]);   // big crater right under it
    for (var i = 0; i < 600 && G.phase === 'settle'; i++) G.update(1 / 60);
  `);
  assert.strictEqual(run('victim.alive'), false, 'victim should be destroyed');
  const y = run('victim.y'), rest = run('G.restY(victim)'), before = run('before');
  assert(rest - before > 20, 'crater should be well below the old position');
  assert(Math.abs(y - rest) < 1, `wreck should rest on the ground (y=${y.toFixed(1)}, ground=${rest.toFixed(1)})`);
  assert.strictEqual(run('victim.falling'), false);
});

test('each AI picks a random opponent and pursues it until it is destroyed', () => {
  run(`
    var picks = [], violations = [];
    var origPlan = AI.plan;
    AI.plan = function (game, tank) {
      var prev = tank.ai.target, prevRound = tank.ai.round;
      var plan = origPlan(game, tank);
      if (plan.target) {
        picks.push({ round: game.round, shooter: tank.id, target: plan.target.id, human: plan.target.type === 'human' });
        // switching targets is only allowed once the old one is dead (or a new round began)
        if (prev && prev !== plan.target && prev.alive && prevRound === game.round) violations.push(tank.name + ' switched off a live target');
      }
      tank.ai.round = game.round;
      return plan;
    };
    for (var seed = 21; seed < 29; seed++) {
      var G = new Game({ seed: seed, rounds: 2, players: [
        { name: 'Human', type: 'human', color: '#f00' },
        { name: 'E', type: 'ai', difficulty: 'easy', color: '#0f0' },
        { name: 'M', type: 'ai', difficulty: 'medium', color: '#00f' },
        { name: 'X', type: 'ai', difficulty: 'expert', color: '#ff0' }] });
      G.startRound();
      for (var f = 0; f < 400000 && G.phase !== 'gameOver'; f++) {
        if (G.phase === 'aim' && G.current.type === 'human') { G.current.angle = 20 + Math.random() * 140; G.current.power = 400; G.fire(); }
        G.update(1 / 30); G.events.length = 0;
        if (G.phase === 'roundOver') G.continueAfterRound(); else if (G.phase === 'shop') G.startRound();
      }
    }
    AI.plan = origPlan;
  `);
  assert.strictEqual(run('violations.length'), 0, run('violations.join("; ")'));
  // across all AI shots, targets should be spread over every combatant, not just the human
  const firsts = run('picks');
  const humanShare = firsts.filter(p => p.human).length / firsts.length;
  const distinctTargets = new Set(firsts.map(p => p.target)).size;
  console.log(`    ${firsts.length} AI shots, ${(humanShare * 100).toFixed(0)}% aimed at the human, ${distinctTargets} different targets`);
  assert(humanShare < 0.6, 'AIs should not gang up on the human');
  assert(humanShare > 0.1, 'the human should still get shot at');
  assert.strictEqual(distinctTargets, 4);
});

test('shop: buy and sell update money and inventory', () => {
  run(`var G = new Game({ seed: 5, players: [{ name: 'H', type: 'human', color: '#fff' }, { name: 'A', type: 'ai', color: '#000' }] });
       var t = G.tanks[0]; var m0 = t.money; var ok = G.buy(t, 'missile');`);
  assert(run('ok'));
  assert.strictEqual(run('t.inventory.missile'), 5);
  assert.strictEqual(run('m0 - t.money'), 600);
  run('G.sell(t, "missile")');
  assert.strictEqual(run('t.inventory.missile'), 0);
  run(`var fuelMoney = t.money; G.buy(t, 'fuel');`);
  assert.strictEqual(run('t.items.fuel'), 50);
  assert.strictEqual(run('fuelMoney - t.money'), 500);
  run(`G.startRound(); var fuelAfterRoundStart = t.items.fuel; G.sell(t, 'fuel');`);
  assert.strictEqual(run('fuelAfterRoundStart'), 50);
  assert.strictEqual(run('t.items.fuel'), 0);
});

test('AI buys fuel and moves away from a nearby enemy before aiming', () => {
  run(`
    var AM = new Game({ seed: 8, players: [
      { name: 'Bot', type: 'ai', difficulty: 'expert', color: '#f00' },
      { name: 'Enemy', type: 'human', color: '#00f' }] });
    var bot = AM.tanks[0], enemy = AM.tanks[1]; bot.money = 10000; AI.shop(bot, AM.rng); var fuelBought = bot.items.fuel;
    AM.terrain.ground.fill(300); AM.phase = 'aim'; AM.turn = 0;
    bot.x = 300; bot.y = AM.restY(bot); enemy.x = 400; enemy.y = AM.restY(enemy);
    var movePlan = AI.planMove(AM, bot), startX = bot.x;
    for (var f = 0; f < 120 && bot.aiPlan == null; f++) AM.update(1 / 60);
  `);
  assert(run('fuelBought >= 100'));
  assert.strictEqual(run('movePlan.direction'), -1);
  assert(run('bot.x < startX'));
  assert(run('bot.items.fuel < fuelBought'));
});

console.log(`\n${passed} tests passed`);
