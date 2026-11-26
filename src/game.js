// ---------------------------------------------------------------------------
// Game rules & state machine (no DOM). Phases:
//   shop -> aim -> flight -> settle -> (aim ... ) -> roundOver -> shop | gameOver
// Visual/audio layers read `game.events` (drained each frame) and live state.
// ---------------------------------------------------------------------------
class Game {
  constructor(settings) {
    this.settings = { ...settings, ...matchRules(settings), seed: settings.seed ?? Date.now() };
    this.rng = new RNG(this.settings.seed);
    this.terrain = new Terrain(CFG.W, CFG.H);
    this.terrain.rules = this.settings;
    this.marketPrices = {}; this.demand = {}; this.shopper = 0;
    this.marks = []; this.markVersion = 0;
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
      team: Number.isInteger(p.team) ? p.team : i % 2,
      persona: p.difficulty === 'unknown' ? this.rng.pick(PERSONAS) : PERSONAS.includes(p.difficulty) ? p.difficulty : null,
      parachuteOn: true, threshold: 5, defense: null, energy: 1, targetId: null,
      score: 0, money: this.settings.startingCash, kills: 0, wins: 0,
      inventory: { baby: Infinity }, items: {},
      x: 0, y: 0, vy: 0, health: CFG.MAX_HEALTH, shield: 0, alive: true,
      angle: 60, power: 500, weapon: 'baby', falling: false, fallStart: 0, chute: false,
      ai: { target: null, focus: 1 }, roundPoints: 0, roundDamage: 0, lastShot: null,
    }));
  }

  // Can the local player steer this tank right now? (NetGame overrides this.)
  eligible(t) {
    return !!t && t.alive && !t.falling && this.phase === 'aim' && !t.committed &&
      (this.settings.format !== 'sequential' || t === this.current);
  }
  canControl(t) { return t?.type === 'human' && this.eligible(t); }
  allied(a, b) { return this.settings.teams !== 'none' && !this.betrayal && a.team === b.team; }
  outstanding(t) { return this.projectiles.some(p => p.owner === t) || this.pending.some(d => d.owner === t); }
  equip(t, id, value) { return Arsenal.equip(this, t, id, value); }
  mark(points, color, life) {
    this.marks.push({ points: points.slice(), color, life });
    this.markVersion++;
  }
  talk(t, dying) {
    const mode = this.settings.taunts;
    if (mode === 'off' || (mode === 'computers' && t.type !== 'ai') || this.rng.int(1, 100) > this.settings.talkChance) return;
    const lines = dying ? ['That was my good tread.', 'Keep the change.', 'I liked that hill.']
      : ['Mind the paintwork.', 'I measured this one.', 'A little more elevation…'];
    this.emit('talk', { tank: t, text: this.rng.pick(lines) });
  }


  emit(type, data = {}) { this.events.push(Object.assign({ type }, data)); }
  get current() { return this.tanks[this.turn]; }
  alive() { return this.tanks.filter(t => t.alive); }

  // ------------------------------------------------------------------ rounds
  startRound() {
    Campaign.closeShop(this);
    this.round++;
    this.betrayal = false; this.lastTeam = null; this.marks = []; this.markVersion++;
    this.hazardClock = 0; this.settleTime = 0;
    this.environment = this.settings.environment === 'random' ? this.rng.pick(['clear', 'lightning', 'meteors']) : this.settings.environment;
    this.wall = this.resolveWall();
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
    const order = this.tanks.map(t => t.id);
    for (let i = n - 1; i > 0; i--) {
      const j = rng.int(0, i); [order[i], order[j]] = [order[j], order[i]];
    }
    const margin = Math.round(CFG.W * 0.055), span = (CFG.W - margin * 2) / n;
    order.forEach((ti, slot) => {
      const t = this.tanks[ti];
      t.x = Math.round(margin + span * (slot + 0.5) + rng.range(-span * 0.25, span * 0.25));
      this.terrain.flatten(t.x, 16);
    });
    for (const t of this.tanks) {
      Object.assign(t, { health: CFG.MAX_HEALTH, shield: 0, alive: true, vy: 0, falling: false, chute: false,
        weapon: 'baby', roundPoints: 0, roundDamage: 0, ai: { target: null, focus: 1 }, lastShot: null });
      t.y = this.restY({ x: t.x });
      t.angle = t.x < CFG.W / 2 ? 55 : 125;
      t.power = 500;
      t.energy = 1; t.targetId = null; t.impactX = null;
      t.committed = false; t.shieldType = null; t.contact = false; t.guidance = null;
      t.aiMove = null; t.aiPlan = null; t.aiTimer = 0; t.lastAttacker = null;
      if (t.items.autodefense && ITEMS[t.defense]?.strength && t.items[t.defense] > 0) {
        t.shieldType = t.defense; t.shield = ITEMS[t.defense].strength; t.items[t.defense]--;
      }
    }
    this.turnOrder = this.makeOrder(true);
    this.turn = this.settings.format === 'simultaneous' ? (this.tanks.find(t => t.type === 'human')?.id ?? this.turnOrder[0]) : this.turnOrder[0];
    this.phase = 'aim';
    this.emit('roundStart', { round: this.round });
    this.beginTurn();
  }

  restY(t) {
    // rest on the highest point under the treads
    const h = this.terrain;
    return Math.min(h.support(t.x - 9, t.y), h.support(t.x, t.y), h.support(t.x + 9, t.y));
  }

  beginTurn() {
    const t = this.current;
    t.aiPlan = null;
    t.aiMove = null;
    t.aiTimer = 0;
    if (!(t.inventory[t.weapon] > 0)) t.weapon = 'baby';
    this.emit('turn', { tank: t });
  }

  resolveWall() {
    return ['random', 'erratic'].includes(this.settings.walls)
      ? this.rng.pick(['open', 'concrete', 'padded', 'bounce', 'spring', 'wrap']) : this.settings.walls;
  }

  makeOrder(opening = false) {
    const ids = this.alive().map(t => t.id), order = this.settings.order;
    if (order === 'random' || order === 'round-robin') {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = this.rng.int(0, i); [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      if (opening && order === 'round-robin') {
        const first = (this.round - 1) % this.tanks.length, index = ids.indexOf(first);
        [ids[0], ids[index]] = [ids[index], ids[0]];
      }
    } else {
      const rank = this.standings().map(t => t.id);
      ids.sort((a, b) => (rank.indexOf(a) - rank.indexOf(b)) * (order === 'winners-first' ? 1 : -1));
    }
    return ids;
  }

  nextTurn() {
    this.turnCount++;
    if (this.settings.windMode === 'changing')
      this.wind = Math.max(-CFG.MAX_WIND, Math.min(CFG.MAX_WIND, this.wind + this.rng.int(-2, 2)));
    const previousOrder = this.turnOrder || this.tanks.map(t => t.id);
    this.turnOrder = previousOrder.slice(previousOrder.indexOf(this.turn) + 1).filter(id => this.tanks[id].alive);
    if (!this.turnOrder.length || this.settings.format === 'volley') this.turnOrder = this.makeOrder();
    this.turn = this.turnOrder[0];
    for (const t of this.tanks) t.committed = false;
    this.phase = 'aim';
    this.beginTurn();
  }

  endRound() {
    const alive = this.alive();
    const teamWin = this.settings.teams !== 'none' && !this.betrayal && alive.length && alive.every(t => t.team === alive[0].team);
    this.lastTeam = teamWin ? alive[0].team : null;
    const winner = alive.length === 1 ? alive[0] : null;
    for (const t of teamWin ? alive : winner ? [winner] : []) { t.wins++; this.award(t, 150); }
    const credited = new Set();
    for (const t of this.tanks) {
      const account = this.settings.teams === 'corporate' ? t.team : t.id;
      if (!credited.has(account)) {
        Campaign.cash(this, t, Math.floor(t.money * this.settings.interest / 100));
        credited.add(account);
      }
    }
    for (const t of this.tanks) Campaign.cash(this, t, CFG.ROUND_BASE_INCOME + Math.max(0, t.roundPoints) * CFG.MONEY_PER_POINT);
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
      this.shopBots();
    }
  }

  shopBots() {
    if (this.settings.computersBuy === 'on') for (const t of this.tanks) if (t.type === 'ai') AI.shop(t, this);
  }

  standings() {
    return this.tanks.slice().sort((a, b) => (this.settings.scoring === 'greedy' ? Campaign.worth(this, b) - Campaign.worth(this, a) : 0)
      || b.score - a.score || b.kills - a.kills);
  }

  award(t, pts) { t.score += pts; t.roundPoints += pts; }
  buy(t, id) { return Campaign.trade(this, t, id, true); }
  sell(t, id) { return Campaign.trade(this, t, id, false); }

  useRepair(t) {
    if (!this.eligible(t) || !(t.items.battery > 0) || t.health >= CFG.MAX_HEALTH) return false;
    t.items.battery--;
    const restored = Math.min(10, CFG.MAX_HEALTH - t.health);
    t.health += restored;
    this.emit('repair', { tank: t, restored });
    return true;
  }

  // --------------------------------------------------------------- movement
  // Calculate one terrain-aware movement step without mutating game state.
  movementStep(t, direction) {
    const dir = Math.sign(direction);
    if (!t || !t.alive || (dir !== -1 && dir !== 1)) return { moved: false, reason: 'invalid' };
    if (this.terrain.isSolid(t.x, t.y - CFG.TURRET_H)) return { moved: false, reason: 'buried' };
    const x = t.x + dir;
    if (x < CFG.TANK_RADIUS || x > this.terrain.w - CFG.TANK_RADIUS) return { moved: false, reason: 'bounds' };

    const oldY = this.restY(t);
    const probe = { x, y: t.y };
    const y = this.restY(probe);
    const rise = Math.max(0, oldY - y);
    const slope = Math.abs(this.terrain.slopeAt(x, 9, t.y));
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
    if (!this.eligible(t) || this.settings.format === 'simultaneous') return { moved: false, reason: 'turn' };
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

  fire(t = this.current) {
    if (!this.eligible(t) || (this.settings.format === 'simultaneous' && (this.outstanding(t) || this.battleDone()))) return false;
    t.serial = (t.serial || 0) + 1;
    if (this.settings.format === 'volley') {
      t.committed = true;
      const waiting = this.alive().filter(other => !other.committed);
      if (waiting.length) {
        this.turn = waiting[0].id;
        this.beginTurn();
        return true;
      }
      this.phase = 'flight';
      for (const shooter of this.alive()) this.launch(shooter);
    } else {
      if (this.settings.format === 'sequential') this.phase = 'flight';
      else this.turnCount++;
      this.launch(t);
    }
    return true;
  }

  launch(t) {
    if (!(t.inventory[t.weapon] > 0)) t.weapon = 'baby';
    if (t.inventory[t.weapon] !== Infinity) t.inventory[t.weapon]--;
    t.power = Math.min(t.power, this.maxPower(t));
    const p = Physics.makeProjectile(t, t.angle, t.power, t.weapon);
    p.id = this.nextProjId++;
    if (this.settings.walls === 'erratic') this.wall = this.resolveWall();
    p.wall = this.wall;
    if (Arsenal.prepare(this, t, p)) this.projectiles.push(p);
    t.aiPlan = null; t.aiMove = null; t.aiTimer = 0;
    this.talk(t, false);
    t.lastShot = { angle: t.angle, power: t.power };
    this.resumeAfterSettle = false;
    this.flightTime = 0;
    this.emit('fire', { tank: t, weapon: t.weapon, x: p.x, y: p.y, angle: t.angle });
    return true;
  }

  // -------------------------------------------------------------- explosions
  detonate(x, y, weaponId, owner, scale = 1, suspended = false, color = null) {
    const W = WEAPONS[weaponId] || WEAPONS.baby;
    const r = W.radius * scale;
    if (W.dirt) {
      this.terrain.addDirt(x, y, r, suspended);
      this.blasts.push({ x, y, r, t: 0, dur: 0.6, dirt: true, color: W.color });
      this.emit('dirt', { x, y, r });
      return;
    }
    this.terrain.crater(x, y, r, suspended);
    this.blasts.push({ x, y, r, t: 0, dur: W.nuke ? 1.6 : 0.8, nuke: !!W.nuke, color: color || W.color, digger: !!W.digger });
    this.emit('explode', { x, y, r, nuke: !!W.nuke, weapon: weaponId });
    if (W.damage > 0) this.damageArea(x, y, r, W.damage * scale, owner);
  }

  damageArea(x, y, r, maxDmg, owner, spareOwner = false) {
    for (const t of this.tanks) {
      if (!t.alive || (spareOwner && t === owner)) continue;
      const c = Physics.tankCenter(t);
      const d = Math.max(0, Math.hypot(c.x - x, c.y - y) - 8);
      if (d >= r) continue;
      const dmg = Math.round(maxDmg * Math.pow(1 - d / r, 0.75));
      if (dmg > 0) this.applyDamage(t, dmg, owner);
    }
  }

  applyDamage(t, dmg, owner) {
    let absorbed = 0;
    if (t.shield > 0 && owner !== t) { absorbed = Math.min(t.shield, dmg); t.shield -= absorbed; dmg -= absorbed; }
    const real = Math.min(t.health, dmg);
    t.health -= real;
    if (owner) {
      const enemy = owner !== t && !this.allied(owner, t);
      if (enemy) { owner.roundDamage += real; t.lastAttacker = owner.id; }
      if (this.settings.scoring !== 'basic') this.award(owner, enemy ? real + absorbed : -Math.ceil((real + absorbed) / 2));
    }
    this.emit('hit', { tank: t, dmg: real, absorbed });
    if (t.health <= 0 && t.alive) this.kill(t, owner);
  }

  kill(t, owner) {
    t.alive = false;
    t.health = 0;
    if (owner && owner !== t && !this.allied(owner, t)) { owner.kills++; this.award(owner, this.settings.scoring === 'basic' ? 200 : 100); }
    else if (owner) this.award(owner, -100);
    this.emit('death', { tank: t, by: owner });
    this.talk(t, true);
    // tanks go out with a bang - chain reactions are part of the fun
    this.pending.push({ x: t.x, y: t.y - 6, delay: 0.35, weapon: 'missile', owner, scale: 0.9 });
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    dt = Math.min(dt, 0.1);
    for (const b of this.blasts) b.t += dt;
    this.blasts = this.blasts.filter(b => b.t < b.dur);

    const active = ['aim', 'flight', 'settle'].includes(this.phase);
    if (!active) return;
    if (this.pending.length) this.updatePending(dt);
    for (const m of this.marks) m.life -= dt;
    if (this.marks.some(m => m.life <= 0)) { this.marks = this.marks.filter(m => m.life > 0); this.markVersion++; }
    if (this.environment !== 'clear' && this.environment && (this.hazardClock += dt) >= 8) {
      this.hazardClock = 0;
      const x = this.rng.int(0, CFG.W - 1), y = this.terrain.heightAt(x);
      const meteor = this.environment === 'meteors';
      this.mark([x + (meteor ? -100 : 12), 0, x - 8, y / 2, x, y], meteor ? '#ff9966' : '#bbddff', 0.6);
      if (this.settings.hostile === 'on') {
        this.detonate(x, y, meteor ? 'missile' : 'baby', null);
        if (this.phase === 'aim' && this.settings.format !== 'simultaneous') {
          this.resumeAfterSettle = true; this.phase = 'settle'; this.settleTime = 0;
        }
      }
    }
    if (this.settings.format === 'simultaneous') {
      for (const tank of this.alive()) {
        while (tank.health <= 90 && tank.items.battery > 0 && this.useRepair(tank)) { /* automatic battery bank */ }
      }
      if (!this.battleDone()) for (const t of this.alive()) if (!this.outstanding(t)) this.updateAim(dt, t);
      this.updateFlight(dt);
      this.updateSettle(dt);
    } else if (this.phase === 'aim') {
      if (this.battleDone()) { this.phase = 'settle'; this.settleTime = 0; }
      else this.updateAim(dt, this.current);
    } else if (this.phase === 'flight') this.updateFlight(dt);
    else this.updateSettle(dt);
  }

  battleDone() {
    const alive = this.alive();
    if (alive.length <= 1 || this.turnCount >= 30 * this.tanks.length) return true;
    if (this.settings.teams === 'none' || this.betrayal || !alive.every(t => t.team === alive[0].team)) return false;
    if (this.settings.teams !== 'vicious') return true;
    this.betrayal = true;
    for (const t of alive) { t.aiPlan = null; t.ai.target = null; }
    return false;
  }

  updateAim(dt, t) {
    if (!this.eligible(t) || t.type !== 'ai') return;
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
      if (t.health <= 90) this.useRepair(t);
      if (!t.shield) {
        const shield = Object.keys(ITEMS).reverse().find(id => ITEMS[id].strength && t.items[id] > 0);
        if (shield) this.equip(t, 'shield', shield);
      }
      t.aiPlan = AI.plan(this, t); t.aiTimer = 0; t.weapon = t.aiPlan.weapon;
    }
    const plan = t.aiPlan;
    t.aiTimer += dt;
    // swing the turret and dial in power visibly, like a human would
    const da = plan.angle - t.angle;
    t.angle += Math.sign(da) * Math.min(Math.abs(da), 70 * dt);
    const dp = plan.power - t.power;
    t.power += Math.sign(dp) * Math.min(Math.abs(dp), 500 * dt);
    if (t.aiTimer >= plan.think && Math.abs(da) < 0.01 && Math.abs(dp) < 0.5) this.fire(t);
  }

  updateFlight(dt) {
    this.flightTime += dt;
    this.acc += dt;
    const env = { terrain: this.terrain, tanks: this.tanks, wind: this.wind, walls: this.wall };
    let steps = 0;
    while (this.acc >= CFG.DT && steps < 400) {
      this.acc -= CFG.DT; steps++;
      const impacts = [];
      for (const p of this.projectiles) {
        if (!p.alive) continue;
        env.walls = p.wall || this.wall;
        const ev = Physics.step(p, env);
        if (p.weapon === 'smoke' && (p.trailTick || 0) % 5 === 0) {
          if (!p.smokePath) p.smokePath = [];
          p.smokePath.push(p.x, p.y);
        }
        if ((p.trailTick = (p.trailTick || 0) + 1) % 2 === 0) {
          p.trail.push(p.x, p.y);
          if (p.trail.length > 240) p.trail.splice(0, 2);
        }
        if (!ev) { if (p.age > 25) p.alive = false; continue; }
        impacts.push([p, ev]);
      }
      for (const [projectile, impact] of impacts) this.handleImpact(projectile, impact);
      this.projectiles = this.projectiles.filter(p => p.alive);
      if (!this.projectiles.length && this.settings.format !== 'simultaneous') { this.acc = 0; this.phase = 'settle'; this.settleTime = 0; break; }
    }
  }

  handleImpact(p, ev) {
    const W = WEAPONS[p.weapon];
    if (ev.type === 'apex') {
      if (W.split && !p.split) {
        p.alive = false;
        for (let k = 0; k < W.split; k++) {
          const off = (k - (W.split - 1) / 2) * 75;
          this.projectiles.push({ id: this.nextProjId++, x: p.x, y: p.y, vx: p.vx + off, vy: p.vy, contact: p.contact, wall: p.wall, suspended: p.suspended, weapon: p.weapon, owner: p.owner,
            age: 1, bounces: 0, split: true, alive: true, trail: [], child: true });
        }
        this.emit('split', { x: p.x, y: p.y });
      }
      return;
    }
    if (ev.type === 'lost') {
      if (p.burrowing && !p.suspended) this.terrain.collapse();
      p.alive = false; this.emit('lost', {}); return;
    }
    if (p.owner && ev.type !== 'dig') p.owner.impactX = ev.x;
    if (Arsenal.impact(this, p, ev)) return;
    if (W.split && !p.child) { p.alive = false; return; }
    this.detonate(ev.x, ev.y, p.weapon, p.owner, W.bounces ? 1 + p.bounces * 0.25 : 1, p.suspended);
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

  updatePending(dt) {
    for (const d of this.pending) d.delay -= dt;
    const due = this.pending.filter(d => d.delay <= 0);
    this.pending = this.pending.filter(d => d.delay > 0);
    for (const d of due) this.detonate(d.x, d.y, d.weapon, d.owner, d.scale, false, d.color);
  }

  updateSettle(dt) {
    this.settleTime += dt;
    // tank falling - wrecks fall too, so destroyed tanks settle into their craters
    let moving = false;
    for (const t of this.tanks) {
      const rest = this.restY(t);
      if (t.y < rest - 0.5) {
        if (!t.falling) {
          t.falling = true; t.fallStart = t.y; t.vy = 0;
          if (t.alive && t.parachuteOn && (rest - t.y - CFG.FALL_SAFE) * CFG.FALL_DMG >= t.threshold && (t.items.parachute || 0) > 0) { t.items.parachute--; t.chute = true; }
        }
        t.vy = t.chute ? 70 : t.vy + CFG.GRAVITY * this.settings.gravity / 100 * dt;
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
    if (this.settings.format === 'simultaneous') {
      if (!busy && !this.projectiles.length && this.battleDone()) this.endRound();
      return;
    }
    if (!busy && this.settleTime > 0.45) {
      if (this.battleDone()) this.endRound();
      else if (this.resumeAfterSettle && this.settings.format === 'volley') {
        this.resumeAfterSettle = false;
        const waiting = this.alive().filter(t => !t.committed);
        if (waiting.length) { this.phase = 'aim'; this.turn = waiting[0].id; this.beginTurn(); }
        else { this.phase = 'flight'; for (const t of this.alive()) this.launch(t); }
      } else if (this.resumeAfterSettle && this.current.alive) {
        this.resumeAfterSettle = false;
        this.phase = 'aim';
      }
      else { this.resumeAfterSettle = false; this.nextTurn(); }
    }
  }
}
