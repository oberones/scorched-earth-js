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

test('shop: buy and sell update money and inventory', () => {
  run(`var G = new Game({ seed: 5, players: [{ name: 'H', type: 'human', color: '#fff' }, { name: 'A', type: 'ai', color: '#000' }] });
       var t = G.tanks[0]; var m0 = t.money; var ok = G.buy(t, 'missile');`);
  assert(run('ok'));
  assert.strictEqual(run('t.inventory.missile'), 5);
  assert.strictEqual(run('m0 - t.money'), 600);
  run('G.sell(t, "missile")');
  assert.strictEqual(run('t.inventory.missile'), 0);
});

console.log(`\n${passed} tests passed`);
