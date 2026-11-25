const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Leaderboard = require('../src/leaderboard');
const { openLeaderboard } = require('../server/lib/leaderboard');

const score = (name, score, kills = 0, rounds = 1) => ({ name, score, kills, rounds });

test('ranks the ten best personal scores with deterministic ties', () => {
  const entries = [
    score(' Zulu ', 100, 2, 3), score('ZULU', 100, 1), score('zulu', 100, 2, 10),
    score('Alice', 100, 2, 5), score('Bob', 101), score('Bob', 102),
    ...Array.from({ length: 10 }, (_, i) => score(`Pilot ${i}`, i)),
    score('Invalid', 200, 0, 0), null,
  ];
  const result = Leaderboard.rank(entries);
  assert.equal(result.length, 10);
  assert.deepEqual(result.slice(0, 4), [
    score('Bob', 102), score('Alice', 100, 2, 5), score('Zulu', 100, 2, 3), score('Pilot 9', 9),
  ]);
  assert.equal(result.at(-1).name, 'Pilot 3');
});

test('back-to-back match finishes persist eligible human records together', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorched-leaderboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'leaderboard.json');
  const board = openLeaderboard(file);
  assert.deepEqual(board.entries, []);
  board.record({ round: 2, tanks: [
    { ...score('Pilot', 40), type: 'human' },
    { ...score('Autopilot', 120), type: 'ai', autopilot: true },
    { ...score('Bot', 150), type: 'ai' },
  ] });
  board.record({ round: 5, tanks: [{ ...score('Rookie', 100, 1), type: 'human' }] });
  assert.deepEqual(openLeaderboard(file).entries, [score('Rookie', 100, 1, 5), score('Pilot', 40, 0, 2)]);
  assert.deepEqual(fs.readdirSync(directory), ['leaderboard.json']);
});
