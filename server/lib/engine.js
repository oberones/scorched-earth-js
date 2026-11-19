// ---------------------------------------------------------------------------
// Loads the browser game engine (src/*.js - plain DOM-free scripts) into a VM
// context so the server runs exactly the same rules, physics and AI as the client.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.SCORCHED_SRC || path.join(__dirname, '..', '..', 'src');
const FILES = ['config.js', 'terrain.js', 'physics.js', 'ai.js', 'game.js'];

const ctx = vm.createContext({ console, Math, Date, Float32Array, Infinity });
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}
// top-level class/const declarations aren't properties of the context; export explicitly
const engine = vm.runInContext(
  '({ APP_VERSION, Game, AI, Physics, Terrain, RNG, CFG, WEAPONS, ITEMS, DIFFICULTY, TEAM_COLORS, WEAPON_ORDER, DEFAULT_NAMES })', ctx);

module.exports = engine;
