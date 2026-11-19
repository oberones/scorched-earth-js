// ---------------------------------------------------------------------------
// Scorched Earth - game configuration & content tables
// ---------------------------------------------------------------------------
const APP_VERSION = '0.2.1';

const CFG = {
  W: 1280,               // logical world width  (px)
  H: 720,                // logical world height (px)
  DT: 1 / 120,           // fixed physics step (s)
  GRAVITY: 400,          // px/s^2
  MAX_SPEED: 900,        // launch speed at power 1000 (px/s)
  WIND_ACCEL: 7,         // px/s^2 per wind unit
  MAX_WIND: 10,
  TANK_RADIUS: 17,       // hit radius (px)
  TANK_SCALE: 16,        // px per model unit when drawing the 3D tank
  BARREL_LEN: 23,        // px from turret pivot to muzzle
  TURRET_H: 13,          // px above ground to turret pivot
  MAX_HEALTH: 100,
  FALL_SAFE: 18,         // px a tank can drop without damage
  FALL_DMG: 0.6,         // damage per px fallen beyond FALL_SAFE
  MOVE_SPEED: 20,        // tank movement speed in world px/s
  MAX_CLIMB: Math.PI / 4,// steepest slope a tank can drive uphill
  START_MONEY: 2500,
  ROUND_BASE_INCOME: 1500,
  MONEY_PER_POINT: 15,
};

// Weapon table. radius = blast radius px, damage = max damage at centre.
const WEAPONS = {
  baby:     { name: 'Baby Missile', radius: 22,  damage: 35,  price: 0,    bundle: 0,  model: 'missile', scale: 9,  color: '#ffb347', infinite: true },
  missile:  { name: 'Missile',      radius: 34,  damage: 55,  price: 600,  bundle: 5,  model: 'missile', scale: 11, color: '#ff8c42' },
  leapfrog: { name: 'Leapfrog',     radius: 28,  damage: 45,  price: 1400, bundle: 2,  model: 'missile', scale: 10, color: '#7dd87d', bounces: 2 },
  mirv:     { name: 'MIRV',         radius: 30,  damage: 45,  price: 2200, bundle: 2,  model: 'nuke',    scale: 12, color: '#c58cff', split: 5 },
  babynuke: { name: 'Baby Nuke',    radius: 62,  damage: 80,  price: 1600, bundle: 2,  model: 'nuke',    scale: 13, color: '#ffe066', nuke: true },
  nuke:     { name: 'Nuke',         radius: 115, damage: 110, price: 3200, bundle: 1,  model: 'nuke',    scale: 17, color: '#ff5e5e', nuke: true },
  dirt:     { name: 'Dirt Ball',    radius: 48,  damage: 0,   price: 500,  bundle: 4,  model: 'nuke',    scale: 10, color: '#c49a6c', dirt: true },
  digger:   { name: 'Digger',       radius: 40,  damage: 8,   price: 450,  bundle: 4,  model: 'missile', scale: 9,  color: '#8fd3ff', digger: true },
};
const WEAPON_ORDER = ['baby', 'missile', 'leapfrog', 'mirv', 'babynuke', 'nuke', 'dirt', 'digger'];

const ITEMS = {
  shield:    { name: 'Shield',    desc: 'Absorbs 80 damage',          price: 1500, bundle: 1 },
  parachute: { name: 'Parachute', desc: 'No fall damage (one use)',   price: 500,  bundle: 2 },
  repair:    { name: 'Repair Kit',desc: 'Restore 50 health (R key)',   price: 900,  bundle: 1 },
  fuel:      { name: 'Fuel',      desc: 'Move before firing (F key)',  price: 500,  bundle: 50 },
};

// AI personalities. aimErr = degrees std-dev, powErr = fraction of power std-dev.
const DIFFICULTY = {
  easy:   { label: 'Easy',   aimErr: 7,   powErr: 0.12, useWind: false, learn: 0.25, think: 1.6, smartWeapons: false },
  medium: { label: 'Medium', aimErr: 3,   powErr: 0.05, useWind: true,  learn: 0.5,  think: 1.3, smartWeapons: false },
  hard:   { label: 'Hard',   aimErr: 1.2, powErr: 0.02, useWind: true,  learn: 0.7,  think: 1.1, smartWeapons: true },
  expert: { label: 'Expert', aimErr: 0.3, powErr: 0.006,useWind: true,  learn: 0.9,  think: 0.9, smartWeapons: true },
};

const TEAM_COLORS = [
  { name: 'Crimson', hex: '#e2483d' },
  { name: 'Azure',   hex: '#3d8de2' },
  { name: 'Olive',   hex: '#8fb339' },
  { name: 'Amber',   hex: '#e2a23d' },
  { name: 'Violet',  hex: '#9b5de5' },
  { name: 'Teal',    hex: '#2ec4b6' },
];
const DEFAULT_NAMES = ['Rommel', 'Patton', 'Zhukov', 'Montgomery', 'Guderian', 'Abrams'];

const SKY_THEMES = [
  { name: 'Dusk',     top: '#1b1036', mid: '#6b2d5c', bot: '#f08a4b', stars: 0.5, sun: '#ffcf70', hills: ['#3a1f45', '#2a1636'], dirt: ['#7a4b2a', '#5e3820', '#43271a'], grass: '#b07a3a' },
  { name: 'Night',    top: '#02040f', mid: '#0b1638', bot: '#24396b', stars: 1.0, sun: '#e8ecff', hills: ['#141c3a', '#0c1229'], dirt: ['#4a4f63', '#363a4c', '#25283a'], grass: '#7d89a8' },
  { name: 'Day',      top: '#2f78c4', mid: '#79b7e8', bot: '#d9eefc', stars: 0,   sun: '#fff6c9', hills: ['#6b8fb0', '#58799a'], dirt: ['#8a6a3f', '#6d5232', '#4f3b25'], grass: '#5d9b3a' },
  { name: 'Mars',     top: '#2a0e08', mid: '#7a2a14', bot: '#d9774a', stars: 0.2, sun: '#ffd9b0', hills: ['#5a1f10', '#41150b'], dirt: ['#a1462a', '#7d3520', '#5a2516'], grass: '#d4774a' },
  { name: 'Toxic',    top: '#07130c', mid: '#14402a', bot: '#7fbf5a', stars: 0.3, sun: '#eaffb0', hills: ['#123322', '#0b2418'], dirt: ['#4d5a2e', '#3a4422', '#283018'], grass: '#a6d84a' },
];
