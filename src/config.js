// ---------------------------------------------------------------------------
// Scorched Earth - game configuration & content tables
// ---------------------------------------------------------------------------
const APP_VERSION = '0.4.0';

const CFG = {
  W: 1536,               // logical world width  (px)
  H: 864,                // logical world height (px)
  DT: 1 / 120,           // fixed physics step (s)
  GRAVITY: 400,          // px/s^2
  MAX_SPEED: 900,        // launch speed at maximum power (px/s)
  MAX_POWER: 1000,
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
  ROUND_BASE_INCOME: 1500,
  MONEY_PER_POINT: 15,
};

// The DOS 1.5 tables specify bundle prices and arms levels. Radii use world pixels.
function weapon(name, family, price, bundle, level, radius, damage, desc, extra = {}) {
  const palette = { Missiles: '#ffac66', Fire: '#ff6036', Tracers: '#81efc5', Rollers: '#a1ce72',
    'Earth removal': '#82cbe7', Burrowers: '#91baff', 'Earth building': '#d8a479', Energy: '#cb91ff' };
  return { name, family, price, bundle, level, radius, damage, desc, color: palette[family],
    model: radius >= 50 ? 'nuke' : 'missile', scale: radius >= 50 ? 14 : 10, ...extra };
}

const WEAPONS = {
  baby: weapon('Baby Missile', 'Missiles', 400, 10, 0, 22, 35, 'Unlimited ammunition', { infinite: true }),
  missile: weapon('Missile', 'Missiles', 1875, 5, 0, 34, 55, 'Conventional explosive shell'),
  babynuke: weapon('Baby Nuke', 'Missiles', 10000, 3, 0, 62, 80, 'Wide nuclear blast', { nuke: true }),
  nuke: weapon('Nuke', 'Missiles', 12000, 1, 1, 115, 110, 'Large nuclear blast', { nuke: true }),
  leapfrog: weapon('Leapfrog', 'Missiles', 10000, 2, 3, 34, 48, 'Three successive, growing blasts', { bounces: 2 }),
  funky: weapon('Funky Bomb', 'Missiles', 7000, 2, 4, 48, 60, 'Scatters a chain of colorful blasts'),
  mirv: weapon('MIRV', 'Missiles', 10000, 3, 2, 34, 55, 'Splits into five shells at apogee', { split: 5 }),
  deathhead: weapon("Death’s Head", 'Missiles', 20000, 1, 4, 58, 80, 'Nine heavy warheads at apogee', { split: 9 }),
  napalm: weapon('Napalm', 'Fire', 10000, 10, 2, 32, 35, 'Burning liquid collects in hollows'),
  hotnapalm: weapon('Hot Napalm', 'Fire', 20000, 2, 4, 48, 55, 'Larger, hotter pools'),
  tracer: weapon('Tracer', 'Tracers', 10, 20, 0, 0, 0, 'Harmless ranging shot'),
  smoke: weapon('Smoke Tracer', 'Tracers', 500, 10, 1, 0, 0, 'Leaves a persistent colored trajectory'),
  babyroller: weapon('Baby Roller', 'Rollers', 5000, 10, 2, 22, 35, 'Rolls downhill to a hollow or tank'),
  roller: weapon('Roller', 'Rollers', 6000, 5, 2, 34, 55, 'Rolls downhill with a missile-sized charge'),
  heavyroller: weapon('Heavy Roller', 'Rollers', 6750, 2, 3, 70, 88, 'Heavy downhill charge'),
  riotcharge: weapon('Riot Charge', 'Earth removal', 2000, 10, 2, 58, 0, 'Clears a wedge from the turret', { wedge: true }),
  riotblast: weapon('Riot Blast', 'Earth removal', 5000, 5, 3, 94, 0, 'Clears a large wedge from the turret', { wedge: true }),
  riotbomb: weapon('Riot Bomb', 'Earth removal', 5000, 5, 3, 48, 0, 'Removes soil at impact'),
  heavyriot: weapon('Heavy Riot Bomb', 'Earth removal', 4750, 2, 3, 72, 0, 'Removes a larger disc of soil'),
  babydigger: weapon('Baby Digger', 'Burrowers', 3000, 10, 0, 6, 0, 'Digs one short tunnel', { digger: 46 }),
  digger: weapon('Digger', 'Burrowers', 2500, 5, 0, 9, 0, 'Digs through soil and fizzles on a tank', { digger: 85 }),
  heavydigger: weapon('Heavy Digger', 'Burrowers', 6750, 2, 1, 13, 0, 'Digs a long, wide tunnel', { digger: 135 }),
  babysandhog: weapon('Baby Sandhog', 'Burrowers', 10000, 10, 0, 29, 42, 'One explosive burrowing charge', { hogs: 1 }),
  sandhog: weapon('Sandhog', 'Burrowers', 16750, 5, 0, 34, 55, 'Three explosive burrowing charges', { hogs: 3 }),
  heavyhog: weapon('Heavy Sandhog', 'Burrowers', 25000, 2, 1, 42, 68, 'Five explosive burrowing charges', { hogs: 5 }),
  dirtclod: weapon('Dirt Clod', 'Earth building', 5000, 10, 0, 30, 0, 'Builds a small mound', { dirt: true }),
  dirt: weapon('Dirt Ball', 'Earth building', 5000, 5, 0, 48, 0, 'Builds a mound of soil', { dirt: true }),
  ton: weapon('Ton of Dirt', 'Earth building', 6750, 2, 1, 105, 0, 'Buries a large area', { dirt: true }),
  liquiddirt: weapon('Liquid Dirt', 'Earth building', 5000, 10, 2, 50, 0, 'Flows downhill and fills hollows'),
  dirtcharge: weapon('Dirt Charge', 'Earth building', 5000, 5, 1, 85, 0, 'Builds a wedge from the turret', { wedge: true, dirt: true }),
  disrupter: weapon('Earth Disrupter', 'Earth removal', 5000, 10, 0, 0, 0, 'Collapses all suspended soil'),
  plasma: weapon('Plasma Blast', 'Energy', 9000, 5, 3, 24, 38, 'Expends batteries for a radial discharge'),
  laser: weapon('Laser', 'Energy', 5000, 5, 2, 8, 35, 'Cuts a straight beam through terrain'),
};
const WEAPON_ORDER = Object.keys(WEAPONS);

function accessory(name, family, price, bundle, level, desc, strength = 0) {
  return { name, family, price, bundle, level, desc, strength };
}
const ITEMS = {
  heat: accessory('Heat Guidance', 'Guidance', 10000, 6, 2, 'Homes when a tank is nearby'),
  ballistic: accessory('Ballistic Guidance', 'Guidance', 10000, 2, 2, 'Sets power for the chosen angle and target'),
  horizontal: accessory('Horizontal Guidance', 'Guidance', 15000, 5, 1, 'Turns horizontally at target height'),
  vertical: accessory('Vertical Guidance', 'Guidance', 20000, 5, 1, 'Turns vertically over the target'),
  lazy: accessory('Lazy Boy', 'Guidance', 20000, 2, 3, 'Flies directly toward the selected target'),
  parachute: accessory('Parachute', 'Supplies', 10000, 8, 2, 'Protects a falling tank'),
  battery: accessory('Battery', 'Supplies', 5000, 10, 2, 'Restores 10 health or powers an energy weapon'),
  mag: accessory('Mag Deflector', 'Shields', 10000, 2, 2, 'Pushes approaching shells upward', 45),
  shield: accessory('Shield', 'Shields', 20000, 3, 3, 'Intercepts incoming shells', 80),
  force: accessory('Force Shield', 'Shields', 25000, 3, 3, 'Reflects incoming shells', 110),
  heavy: accessory('Heavy Shield', 'Shields', 30000, 2, 4, 'Heavy protection against direct hits', 155),
  supermag: accessory('Super Mag', 'Shields', 40000, 2, 4, 'Magnetic reflection and laser immunity', 185),
  autodefense: accessory('Auto Defense', 'Supplies', 1500, 1, 3, 'Configure defenses during the shop'),
  fuel: accessory('Fuel Tank', 'Supplies', 10000, 10, 3, 'Each tank contains ten units of movement fuel'),
  trigger: accessory('Contact Trigger', 'Supplies', 1000, 25, 3, 'Detonates a shell on contact'),
};

const RULES = {
  rounds: { label: 'Rounds', min: 1, max: 1000, value: 5 },
  terrain: { label: 'Terrain', choices: ['random', 'hills', 'mountains', 'flat'] },
  walls: { label: 'Walls', choices: ['open', 'concrete', 'padded', 'bounce', 'spring', 'wrap', 'random', 'erratic'] },
  windMode: { label: 'Wind', choices: ['changing', 'constant', 'none'] },
  format: { label: 'Firing format', choices: ['sequential', 'volley', 'simultaneous'] },
  teams: { label: 'Teams', choices: ['none', 'standard', 'corporate', 'vicious'] },
  order: { label: 'Turn order', choices: ['random', 'round-robin', 'winners-first', 'losers-first'] },
  gravity: { label: 'Gravity (%)', min: 25, max: 400, value: 100 },
  drag: { label: 'Air resistance', min: 0, max: 20, value: 0 },
  tunneling: { label: 'Shell penetration', choices: ['on', 'off'] },
  suspend: { label: 'Chance of suspended dirt (%)', min: 0, max: 100, value: 0 },
  environment: { label: 'Environment', choices: ['clear', 'lightning', 'meteors', 'random'] },
  hostile: { label: 'Hazard damage', choices: ['on', 'off'] },
  startingCash: { label: 'Starting cash ($)', min: 0, max: 1000000, value: 0 },
  interest: { label: 'Bank interest (%)', min: 0, max: 30, value: 5 },
  market: { label: 'Free market', choices: ['off', 'on'] },
  computersBuy: { label: 'Computer purchases', choices: ['on', 'off'] },
  scoring: { label: 'Scoring', choices: ['standard', 'basic', 'greedy'] },
  arms: { label: 'Arms level', min: 0, max: 4, value: 4 },
  taunts: { label: 'Talking tanks', choices: ['off', 'computers', 'all'] },
  talkChance: { label: 'Talk probability (%)', min: 0, max: 100, value: 100 },
};
function matchRules(input = {}, base = {}) {
  const rules = {};
  for (const [key, def] of Object.entries(RULES)) {
    const value = input[key];
    const valid = def.choices ? def.choices.includes(value)
      : Number.isInteger(value) && value >= def.min && value <= def.max;
    rules[key] = valid ? value : base[key] ?? def.value ?? def.choices[0];
  }
  return rules;
}

// AI personalities. aimErr = degrees std-dev, powErr = fraction of power std-dev.
const DIFFICULTY = {
  easy:   { label: 'Easy',   aimErr: 7,   powErr: 0.12, useWind: false, learn: 0.25, think: 1.6, smartWeapons: false },
  medium: { label: 'Medium', aimErr: 3,   powErr: 0.05, useWind: true,  learn: 0.5,  think: 1.3, smartWeapons: false },
  hard:   { label: 'Hard',   aimErr: 1.2, powErr: 0.02, useWind: true,  learn: 0.7,  think: 1.1, smartWeapons: true },
  expert: { label: 'Expert', aimErr: 0.3, powErr: 0.006,useWind: true,  learn: 0.9,  think: 0.9, smartWeapons: true },
};

const PERSONAS = ['moron', 'shooter', 'poolshark', 'tosser', 'chooser', 'spoiler', 'cyborg'];
for (const name of [...PERSONAS, 'unknown']) {
  DIFFICULTY[name] = { ...DIFFICULTY.medium, label: name[0].toUpperCase() + name.slice(1) };
}

const TEAM_COLORS = [
  { name: 'Crimson', hex: '#e2483d' },
  { name: 'Azure',   hex: '#3d8de2' },
  { name: 'Olive',   hex: '#8fb339' },
  { name: 'Amber',   hex: '#e2a23d' },
  { name: 'Violet',  hex: '#9b5de5' },
  { name: 'Teal',    hex: '#2ec4b6' },
  { name: 'Rose', hex: '#ff84b5' }, { name: 'Ivory', hex: '#f8f3cb' },
  { name: 'Copper', hex: '#bd7645' }, { name: 'Mint', hex: '#94f2a7' },
];
const DEFAULT_NAMES = ['Rommel', 'Patton', 'Zhukov', 'Montgomery', 'Guderian', 'Abrams', 'Atlas', 'Vega', 'Luna', 'Orion'];

const SKY_THEMES = [
  { name: 'Dusk',     top: '#1b1036', mid: '#6b2d5c', bot: '#f08a4b', stars: 0.5, sun: '#ffcf70', hills: ['#3a1f45', '#2a1636'], dirt: ['#7a4b2a', '#5e3820', '#43271a'], grass: '#b07a3a' },
  { name: 'Night',    top: '#02040f', mid: '#0b1638', bot: '#24396b', stars: 1.0, sun: '#e8ecff', hills: ['#141c3a', '#0c1229'], dirt: ['#4a4f63', '#363a4c', '#25283a'], grass: '#7d89a8' },
  { name: 'Day',      top: '#2f78c4', mid: '#79b7e8', bot: '#d9eefc', stars: 0,   sun: '#fff6c9', hills: ['#6b8fb0', '#58799a'], dirt: ['#8a6a3f', '#6d5232', '#4f3b25'], grass: '#5d9b3a' },
  { name: 'Mars',     top: '#2a0e08', mid: '#7a2a14', bot: '#d9774a', stars: 0.2, sun: '#ffd9b0', hills: ['#5a1f10', '#41150b'], dirt: ['#a1462a', '#7d3520', '#5a2516'], grass: '#d4774a' },
  { name: 'Toxic',    top: '#07130c', mid: '#14402a', bot: '#7fbf5a', stars: 0.3, sun: '#eaffb0', hills: ['#123322', '#0b2418'], dirt: ['#4d5a2e', '#3a4422', '#283018'], grass: '#a6d84a' },
];
