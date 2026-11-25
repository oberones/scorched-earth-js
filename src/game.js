// ---------------------------------------------------------------------------
// Game rules & state machine (no DOM). Phases:
//   shop -> aim -> flight -> settle -> (aim ... ) -> roundOver -> shop | gameOver
// Visual/audio layers read `game.events` (drained each frame) and live state.
// ---------------------------------------------------------------------------
class Game {
  constructor(settings) {
    this.settings = Object.assign({ rounds: 5, walls: 'open', terrain: 'random', windMode: 'changing', seed: Date.now() }, settings);
    this.rng = new RNG(this.settings.seed);
    this.terrain = new Terrain(CFG.W, CFG.H);
    this.round = 0;
    this.events = [];
    this.projectiles = [];
    this.blasts = [];          // active explosions (gameplay timers + visuals)
    this.pending = [];         // delayed detonations (tank death explosions)
    this.acc = 0;
    this.nextProjId = 1;
    this.phase = 'shop';
    this.tanks = this.settings.players.map((p, i) => ({
      id: i, name: p.name, color: p.color, type: p.type, difficulty: p.difficulty || 'medium',
      score: 0, money: CFG.START_MONEY, kills: 0, wins: 0,
      inventory: { baby: Infinity }, items: {},
      x: 0, y: 0, vy: 0, health: CFG.MAX_HEALTH, shield: 0, alive: true,
      angle: 60, power: 500, weapon: 'baby', falling: false, fallStart: 0, chute: false,
      ai: { target: null, focus: 1 }, roundPoints: 0, roundDamage: 0, lastShot: null,
    }));
  }

  // Can the local player steer this tank right now? (NetGame overrides this.)
  canControl(t) { return !!t && t.type === 'human' && this.phase === 'aim' && t === this.current; }

  emit(type, data = {}) { this.events.push(Object.assign({ type }, data)); }
  get current() { return this.tanks[this.turn]; }
  alive() { return this.tanks.filter(t => t.alive); }

  // ------------------------------------------------------------------ rounds
  startRound() {
    this.round++;
    const rng = this.rng;
    let style = this.settings.terrain;
    if (style === 'random') {
      const terrainRoll = rng.next();
      style = terrainRoll < 0.5 ? 'hills' : terrainRoll < 0.9 ? 'mountains' : 'flat';
    }
    this.terrain.generate(rng, style);
    this.theme = rng.int(0, SKY_THEMES.length - 1);
    this.wind = Math.round(rng.range(-CFG.MAX_WIND, CFG.MAX_WIND));
    if (this.settings.windMode === 'none') this.wind = 0;
    this.projectiles = []; this.blasts = []; this.pending = [];
    this.resumeAfterSettle = false;
    this.turnCount = 0;

    // spread tanks across the map in random order
    const n = this.tanks.length;
    const order = this.tanks.map((t, i) => i).sort(() => rng.next() - 0.5);
    const margin = Math.round(CFG.W * 0.055), span = (CFG.W - margin * 2) / n;
    order.forEach((ti, slot) => {
      const t = this.tanks[ti];
      t.x = Math.round(margin + span * (slot + 0.5) + rng.range(-span * 0.25, span * 0.25));
      this.terrain.flatten(t.x, 16);
    });
    for (const t of this.tanks) {
      Object.assign(t, { health: CFG.MAX_HEALTH, shield: 0, alive: true, vy: 0, falling: false, chute: false,
        weapon: 'baby', roundPoints: 0, roundDamage: 0, ai: { target: null, focus: 1 }, lastShot: null });
      t.y = this.restY(t);
      t.angle = t.x < CFG.W / 2 ? 55 : 125;
      t.power = 500;
      if ((t.items.shield || 0) > 0) { t.items.shield--; t.shield = 80; }
    }
    this.turn = this.rng.int(0, n - 1);
    this.phase = 'aim';
    this.emit('roundStart', { round: this.round });
    this.beginTurn();
  }

  restY(t) {
    // rest on the highest point under the treads
    const h = this.terrain;
    return Math.min(h.heightAt(t.x - 9), h.heightAt(t.x), h.heightAt(t.x + 9));
  }

  beginTurn() {
    const t = this.current;
    t.aiPlan = null;
    t.aiMove = null;
    t.aiTimer = 0;
    if (!(t.inventory[t.weapon] > 0)) t.weapon = 'baby';
    this.emit('turn', { tank: t });
  }

  nextTurn() {
    this.turnCount++;
    if (this.settings.windMode === 'changing') {
      this.wind = Math.max(-CFG.MAX_WIND, Math.min(CFG.MAX_WIND, this.wind + this.rng.int(-2, 2)));
    }
    const n = this.tanks.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.turn + k) % n;
      if (this.tanks[i].alive) { this.turn = i; break; }
    }
    this.phase = 'aim';
    this.beginTurn();
  }

  endRound() {
    const alive = this.alive();
    const winner = alive.length === 1 ? alive[0] : null;
    if (winner) { winner.wins++; this.award(winner, 150); }
    for (const t of this.tanks) {
      t.money += CFG.ROUND_BASE_INCOME + Math.max(0, t.roundPoints) * CFG.MONEY_PER_POINT;
    }
    this.lastWinner = winner;
    this.phase = 'roundOver';
    this.emit('roundOver', { winner });
  }

  // Called by the UI after the round summary.
  continueAfterRound() {
    if (this.round >= this.settings.rounds) {
      this.phase = 'gameOver';
      this.emit('gameOver', { standings: this.standings() });
    } else {
      this.phase = 'shop';
      for (const t of this.tanks) if (t.type === 'ai') AI.shop(t, this.rng);
    }
  }

  standings() { return this.tanks.slice().sort((a, b) => b.score - a.score || b.kills - a.kills); }

  award(t, pts) { t.score += pts; t.roundPoints += pts; }

  // ---------------------------------------------------------------- shopping
  buy(t, id) {
    const def = WEAPONS[id] || ITEMS[id];
    if (!def || def.infinite || t.money < def.price) return false;
    t.money -= def.price;
    if (WEAPONS[id]) t.inventory[id] = (t.inventory[id] || 0) + def.bundle;
    else t.items[id] = (t.items[id] || 0) + def.bundle;
    return true;
  }
  sell(t, id) {
    const def = WEAPONS[id] || ITEMS[id];
    const bag = WEAPONS[id] ? t.inventory : t.items;
    if (!def || def.infinite || (bag[id] || 0) < def.bundle) return false;
    bag[id] -= def.bundle;
    t.money += Math.floor(def.price * 0.8);
    return true;
  }

  useRepair(t) {
    if (this.phase !== 'aim' || t !== this.current || !(t.items.repair > 0) || t.health >= CFG.MAX_HEALTH) return false;
    t.items.repair--;
    t.health = Math.min(CFG.MAX_HEALTH, t.health + 50);
    this.emit('repair', { tank: t });
    return true;
  }

  // --------------------------------------------------------------- movement
  // Calculate one terrain-aware movement step without mutating game state.
  movementStep(t, direction) {
    const dir = Math.sign(direction);
    if (!t || !t.alive || (dir !== -1 && dir !== 1)) return { moved: false, reason: 'invalid' };
    const x = t.x + dir;
    if (x < CFG.TANK_RADIUS || x > this.terrain.w - CFG.TANK_RADIUS) return { moved: false, reason: 'bounds' };

    const oldY = this.restY(t);
    const probe = { x };
    const y = this.restY(probe);
    const rise = Math.max(0, oldY - y);
    const slope = Math.abs(this.terrain.slopeAt(x, 9));
    if (rise > 0.01 && slope > CFG.MAX_CLIMB) return { moved: false, reason: 'slope' };

    const cy = y - 9;
    for (const other of this.tanks) {
      if (other === t || !other.alive) continue;
      if (Math.hypot(x - other.x, cy - (other.y - 9)) < CFG.TANK_RADIUS * 2) return { moved: false, reason: 'tank' };
    }
    const cost = 1 + rise;
    if ((t.items.fuel || 0) + 1e-6 < cost) return { moved: false, reason: 'fuel', cost };
    const drop = y - oldY;
    return { moved: true, x, y, cost, falling: drop > 0.5 && (slope > CFG.MAX_CLIMB || drop > 1) };
  }

  moveTank(t, direction) {
    if (this.phase !== 'aim' || t !== this.current) return { moved: false, reason: 'turn' };
    const step = this.movementStep(t, direction);
    if (!step.moved) return step;
    t.items.fuel = Math.max(0, (t.items.fuel || 0) - step.cost);
    t.x = step.x;
    if (step.falling) {
      // Keep the old height so the existing settle physics performs the drop.
      this.resumeAfterSettle = true;
      this.phase = 'settle';
      this.settleTime = 0;
    } else t.y = step.y;
    return step;
  }

  // Return the furthest legal, non-falling endpoint without spending fuel.
  previewMovement(t, direction, maxSteps = 20) {
    const saved = { x: t.x, y: t.y, fuel: t.items.fuel };
    let cost = 0, steps = 0;
    for (; steps < maxSteps; steps++) {
      const step = this.movementStep(t, direction);
      if (!step.moved || step.falling) break;
      t.x = step.x; t.y = step.y; t.items.fuel -= step.cost; cost += step.cost;
    }
    const result = { x: t.x, y: t.y, cost, steps, direction: Math.sign(direction) };
    t.x = saved.x; t.y = saved.y; t.items.fuel = saved.fuel;
    return result;
  }

  // ------------------------------------------------------------------ firing
  maxPower() { return CFG.MAX_POWER; }

  cycleWeapon(t, dir = 1) {
    const owned = WEAPON_ORDER.filter(w => (t.inventory[w] || 0) > 0);
    const i = owned.indexOf(t.weapon);
    t.weapon = owned[(i + dir + owned.length) % owned.length];
  }

  fire() {
    if (this.phase !== 'aim') return false;
    const t = this.current;
    if (!(t.inventory[t.weapon] > 0)) t.weapon = 'baby';
    if (t.inventory[t.weapon] !== Infinity) t.inventory[t.weapon]--;
    t.power = Math.min(t.power, this.maxPower(t));
    const p = Physics.makeProjectile(t, t.angle, t.power, t.weapon);
    p.id = this.nextProjId++;
    this.projectiles.push(p);
    t.lastShot = { angle: t.angle, power: t.power };
    this.phase = 'flight';
    this.resumeAfterSettle = false;
    this.flightTime = 0;
    this.emit('fire', { tank: t, weapon: t.weapon, x: p.x, y: p.y, angle: t.angle });
    return true;
  }

  // -------------------------------------------------------------- explosions
  detonate(x, y, weaponId, owner, scale = 1) {
    const W = WEAPONS[weaponId] || WEAPONS.baby;
    const r = W.radius * scale;
    if (W.dirt) {
      this.terrain.addDirt(x, y, r);
      this.blasts.push({ x, y, r, t: 0, dur: 0.6, dirt: true, color: W.color });
      this.emit('dirt', { x, y, r });
      return;
    }
    this.terrain.crater(x, y, r);
    this.blasts.push({ x, y, r, t: 0, dur: W.nuke ? 1.6 : 0.8, nuke: !!W.nuke, color: W.color, digger: !!W.digger });
    this.emit('explode', { x, y, r, nuke: !!W.nuke, weapon: weaponId });
    if (W.damage > 0) this.damageArea(x, y, r, W.damage * scale, owner);
  }

  damageArea(x, y, r, maxDmg, owner) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const c = Physics.tankCenter(t);
      const d = Math.max(0, Math.hypot(c.x - x, c.y - y) - 8);
      if (d >= r) continue;
      const dmg = Math.round(maxDmg * Math.pow(1 - d / r, 0.75));
      if (dmg > 0) this.applyDamage(t, dmg, owner);
    }
  }

  applyDamage(t, dmg, owner) {
    let absorbed = 0;
    if (t.shield > 0) { absorbed = Math.min(t.shield, dmg); t.shield -= absorbed; dmg -= absorbed; }
    const real = Math.min(t.health, dmg);
    t.health -= real;
    if (owner && owner !== t) { this.award(owner, real); owner.roundDamage += real; }
    else if (owner === t) this.award(t, -Math.round(real / 2));
    this.emit('hit', { tank: t, dmg: real, absorbed });
    if (t.health <= 0 && t.alive) this.kill(t, owner);
  }

  kill(t, owner) {
    t.alive = false;
    t.health = 0;
    if (owner && owner !== t) { owner.kills++; this.award(owner, 100); }
    else if (owner === t) this.award(t, -100);
    this.emit('death', { tank: t, by: owner });
    // tanks go out with a bang - chain reactions are part of the fun
    this.pending.push({ x: t.x, y: t.y - 6, delay: 0.35, weapon: 'missile', owner, scale: 0.9 });
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    dt = Math.min(dt, 0.1);
    for (const b of this.blasts) b.t += dt;
    this.blasts = this.blasts.filter(b => b.t < b.dur);

    if (this.phase === 'aim') this.updateAim(dt);
    else if (this.phase === 'flight') this.updateFlight(dt);
    else if (this.phase === 'settle') this.updateSettle(dt);
  }

  updateAim(dt) {
    const t = this.current;
    if (t.type !== 'ai') return;
    if (!t.aiMove) t.aiMove = AI.planMove(this, t);
    if (t.aiMove.steps > 0) {
      t.aiMove.acc = (t.aiMove.acc || 0) + dt * CFG.MOVE_SPEED;
      while (t.aiMove.acc >= 1 && t.aiMove.steps > 0 && this.phase === 'aim') {
        t.aiMove.acc--;
        const moved = this.moveTank(t, t.aiMove.direction);
        if (!moved.moved || moved.falling) t.aiMove.steps = 0;
        else t.aiMove.steps--;
      }
      if (this.phase !== 'aim' || t.aiMove.steps > 0) return;
    }
    if (!t.aiPlan) {
      if (t.health <= 50) this.useRepair(t);
      t.aiPlan = AI.plan(this, t); t.aiTimer = 0; t.weapon = t.aiPlan.weapon;
    }
    const plan = t.aiPlan;
    t.aiTimer += dt;
    // swing the turret and dial in power visibly, like a human would
    const da = plan.angle - t.angle;
    t.angle += Math.sign(da) * Math.min(Math.abs(da), 70 * dt);
    const dp = plan.power - t.power;
    t.power += Math.sign(dp) * Math.min(Math.abs(dp), 500 * dt);
    if (t.aiTimer >= plan.think && Math.abs(da) < 0.01 && Math.abs(dp) < 0.5) this.fire();
  }

  updateFlight(dt) {
    this.flightTime += dt;
    this.acc += dt;
    const env = { terrain: this.terrain, tanks: this.tanks, wind: this.wind, walls: this.settings.walls };
    let steps = 0;
    while (this.acc >= CFG.DT && steps < 400) {
      this.acc -= CFG.DT; steps++;
      for (const p of this.projectiles) {
        if (!p.alive) continue;
        const ev = Physics.step(p, env);
        if ((p.trailTick = (p.trailTick || 0) + 1) % 2 === 0) {
          p.trail.push(p.x, p.y);
          if (p.trail.length > 240) p.trail.splice(0, 2);
        }
        if (!ev) { if (p.age > 25) p.alive = false; continue; }
        this.handleImpact(p, ev);
      }
      this.projectiles = this.projectiles.filter(p => p.alive);
      if (!this.projectiles.length) { this.acc = 0; this.phase = 'settle'; this.settleTime = 0; break; }
    }
  }

  handleImpact(p, ev) {
    const W = WEAPONS[p.weapon];
    if (ev.type === 'apex') {
      if (W.split && !p.split) {
        p.alive = false;
        for (let k = 0; k < W.split; k++) {
          const off = (k - (W.split - 1) / 2) * 75;
          this.projectiles.push({ id: this.nextProjId++, x: p.x, y: p.y, vx: p.vx + off, vy: p.vy, weapon: p.weapon, owner: p.owner,
            age: 1, bounces: 0, split: true, alive: true, trail: [], child: true });
        }
        this.emit('split', { x: p.x, y: p.y });
      }
      return;
    }
    if (ev.type === 'lost') { p.alive = false; this.emit('lost', {}); return; }
    this.detonate(ev.x, ev.y, p.weapon, p.owner);
    if (W.bounces && p.bounces < W.bounces && ev.type === 'ground') {
      p.bounces++;
      p.vy = -Math.abs(p.vy) * 0.6 - 120;
      p.vx *= 0.8;
      p.y = this.terrain.heightAt(p.x) - 4;
      this.emit('bounce', { x: p.x, y: p.y });
      return;
    }
    p.alive = false;
  }

  updateSettle(dt) {
    this.settleTime += dt;
    // delayed detonations (destroyed tanks)
    for (const d of this.pending) d.delay -= dt;
    const due = this.pending.filter(d => d.delay <= 0);
    this.pending = this.pending.filter(d => d.delay > 0);
    for (const d of due) this.detonate(d.x, d.y, d.weapon, d.owner, d.scale);

    // tank falling - wrecks fall too, so destroyed tanks settle into their craters
    let moving = false;
    for (const t of this.tanks) {
      const rest = this.restY(t);
      if (t.y < rest - 0.5) {
        if (!t.falling) {
          t.falling = true; t.fallStart = t.y; t.vy = 0;
          if (t.alive && rest - t.y > CFG.FALL_SAFE && (t.items.parachute || 0) > 0) { t.items.parachute--; t.chute = true; }
        }
        t.vy = t.chute ? 70 : t.vy + CFG.GRAVITY * dt;
        t.y = Math.min(rest, t.y + t.vy * dt);
        moving = true;
      } else if (t.falling) {
        t.falling = false;
        const drop = t.y - t.fallStart;
        if (t.alive && !t.chute && drop > CFG.FALL_SAFE) {
          this.applyDamage(t, Math.round((drop - CFG.FALL_SAFE) * CFG.FALL_DMG), null);
        }
        t.chute = false;
        this.emit('land', { tank: t, drop });
      }
      if (t.alive && t.y >= CFG.H - 2) this.kill(t, null); // fell into the abyss
    }

    const busy = moving || this.pending.length || this.blasts.some(b => b.t < b.dur * 0.7);
    if (!busy && this.settleTime > 0.45) {
      const alive = this.alive();
      const cap = 30 * this.tanks.length;
      if (alive.length <= 1 || this.turnCount >= cap) this.endRound();
      else if (this.resumeAfterSettle && this.current.alive) {
        this.resumeAfterSettle = false;
        this.phase = 'aim';
      }
      else { this.resumeAfterSettle = false; this.nextTurn(); }
    }
  }
}
