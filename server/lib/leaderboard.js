'use strict';
const fs = require('fs');
const path = require('path');
const Leaderboard = require('../../src/leaderboard');

function openLeaderboard(file) {
  let saved = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Expected a leaderboard array');
    saved = Leaderboard.rank(data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let pending = saved;

  return {
    get entries() { return saved; },
    record(game) {
      pending = Leaderboard.rank([...pending, ...Leaderboard.fromMatch(game)]);
      const json = JSON.stringify(pending);
      if (json === JSON.stringify(saved)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, json + '\n', { mode: 0o600 });
      fs.renameSync(temporary, file);
      saved = pending;
    },
  };
}

module.exports = { openLeaderboard };
