// ---------------------------------------------------------------------------
// AI opponents: target selection, trajectory solving, weapon choice, shopping
// ---------------------------------------------------------------------------
const AI = {
  enemiesOf(game, tank) { return game.tanks.filter(t => t.alive && t !== tank && !game.allied(tank, t)); },

  // Every AI picks a random opponent (human or AI) and pursues it until it is destroyed,
  // then picks a new random one. Memory resets each round.
  pickTarget(game, tank, prof, rng) {
    const cur = tank.ai.target;
    const enemies = AI.enemiesOf(game, tank);
    if (tank.persona === 'cyborg') {
      const priority = t => (t.id === tank.lastAttacker ? 150 : 0) + (100 - t.health) + Math.min(100, t.score / 10);
      return enemies.sort((a, b) => priority(b) - priority(a))[0];
    }
    if (cur && enemies.includes(cur)) return cur;
    return enemies.length ? rng.pick(enemies) : null;
  },

  // A cheap trajectory search used only to decide whether a short move is useful.
  coarseError(game, tank, target, position, wind) {
    const saved = { x: tank.x, y: tank.y };
    tank.x = position.x; tank.y = position.y;
    const tc = Physics.tankCenter(target), right = target.x >= tank.x;
    let best = Infinity;
    for (let a = 15; a <= 165; a += 15) {
      const angle = right ? a : 180 - a;
      for (let power = 150; power <= game.maxPower(tank); power += 100) {
        const r = Physics.simulate(game.terrain, game.tanks, tank, angle, power, wind, game.wall || game.settings.walls);
        if (!r.lost) best = Math.min(best, r.tank === target ? 0 : Math.hypot(r.x - tc.x, r.y - tc.y));
      }
    }
    tank.x = saved.x; tank.y = saved.y;
    return best;
  },

  planMove(game, tank) {
    const fuel = tank.items.fuel || 0;
    if (fuel < 1) return { direction: 0, steps: 0 };
    const prof = DIFFICULTY[tank.difficulty] || DIFFICULTY.medium;
    const target = AI.pickTarget(game, tank, prof, game.rng);
    if (!target) return { direction: 0, steps: 0 };
    tank.ai.target = target;
    const candidates = [
      { x: tank.x, y: tank.y, steps: 0, direction: 0 },
      game.previewMovement(tank, -1, 20),
      game.previewMovement(tank, 1, 20),
    ].filter(c => c.steps === 0 || c.cost <= fuel + 1e-6);
    const enemies = AI.enemiesOf(game, tank);
    const nearest = Math.min(...enemies.map(e => Math.abs(e.x - tank.x)));
    let best = candidates[0];
    if (nearest < 150) {
      const clearance = c => Math.min(...enemies.map(e => Math.hypot(c.x - e.x, (c.y - 9) - (e.y - 9))));
      for (const c of candidates) if (clearance(c) > clearance(best)) best = c;
    } else {
      const wind = prof.useWind ? game.wind : 0;
      const base = AI.coarseError(game, tank, target, candidates[0], wind);
      let error = base;
      for (const c of candidates.slice(1)) {
        const e = AI.coarseError(game, tank, target, c, wind);
        if (e < error) { error = e; best = c; }
      }
      if (base - error < 10) best = candidates[0];
    }
    return { direction: best.direction, steps: best.steps };
  },

  // Grid search + refinement over (angle, power) using the real physics step.
  solve(game, tank, target, wind, style = null) {
    const tc = Physics.tankCenter(target);
    const right = target.x >= tank.x;
    const evalShot = (angle, power) => {
      const r = Physics.simulate(game.terrain, game.tanks, tank, angle, power, wind, game.wall || game.settings.walls);
      if (r.lost) return 1e6;
      if (style === 'bank' && !r.banked) return 1e5;
      if (r.tank === target) return 0;
      let d = Math.hypot(r.x - tc.x, r.y - tc.y);
      const self = Math.hypot(r.x - tank.x, r.y - tank.y);
      if (self < 45) d += 2000;            // never plan to hit ourselves
      return d;
    };
    const maxP = game.maxPower(tank);
    let best = { angle: right ? 45 : 135, power: Math.min(600, maxP), err: Infinity };
    const angles = [];
    for (let a = 12; a <= 86; a += 3.5) angles.push(right ? a : 180 - a);
    for (let a = 94; a <= 168; a += 7) angles.push(right ? 180 - a : a); // occasional steep lob over a hill
    if (style === 'bank') {
      const reverse = angles.map(a => 180 - a);
      angles.unshift(...reverse);
    }
    if (style === 'direct') {
      const rise = Math.atan2(tank.y - target.y, Math.abs(target.x - tank.x)) * 180 / Math.PI;
      const direct = Array.from({ length: 9 }, (_, i) => Math.max(0, Math.min(90, rise + i * 2)));
      angles.splice(0, angles.length, ...direct.map(elevation => right ? elevation : 180 - elevation));
    }
    for (const angle of angles) {
      for (let power = 120; power <= maxP; power += 30) {
        const err = evalShot(angle, power);
        if (err === 0) return { angle, power, err };
        if (err < best.err) best = { angle, power, err };
      }
    }
    // refine
    const a0 = best.angle, p0 = best.power;
    for (let da = -3; da <= 3; da += 0.5) {
      for (let dp = -30; dp <= 30; dp += 4) {
        const angle = a0 + da, power = Math.max(50, Math.min(maxP, p0 + dp));
        const err = evalShot(angle, power);
        if (err === 0) return { angle, power, err };
        if (err < best.err) best = { angle, power, err };
      }
    }
    return best;
  },

  chooseWeapon(game, tank, prof, target, solution, rng) {
    const inv = tank.inventory;
    if (game.terrain.isSolid(tank.x, tank.y - CFG.TURRET_H)) {
      for (const id of ['riotblast', 'riotcharge', 'digger']) if (inv[id] > 0) return id;
    }
    const owned = WEAPON_ORDER.filter(w => WEAPONS[w].damage > 0 && (inv[w] || 0) > 0);
    if (!prof.smartWeapons) {
      if (prof === DIFFICULTY.easy) return rng.next() < 0.4 ? rng.pick(owned) : 'baby';
      // medium: best owned weapon that won't obviously kill us
      const safe = owned.filter(w => Math.abs(target.x - tank.x) > WEAPONS[w].radius + 30);
      return safe.length && rng.next() < 0.6 ? safe[safe.length - 1] : 'baby';
    }
    const dist = Math.abs(target.x - tank.x);
    const need = target.health + target.shield;
    let pick = 'baby', pickScore = -Infinity;
    for (const w of owned) {
      const W = WEAPONS[w];
      if (dist < W.radius + 35) continue; // splash would reach us
      const expected = Math.min(W.damage * (W.split ? 1.6 : 1), need);
      // prefer the cheapest weapon that finishes the job, otherwise the strongest
      const score = expected * 10 - W.price / 400 + (expected >= need ? 200 : 0);
      if (score > pickScore) { pickScore = score; pick = w; }
    }
    // splash weapons forgive aim error - accept them when the solution is poor
    if (solution.err > 25 && (inv.babynuke || 0) > 0 && dist > 120) pick = 'babynuke';
    return pick;
  },

  plan(game, tank) {
    const prof = DIFFICULTY[tank.difficulty] || DIFFICULTY.medium;
    const rng = game.rng;
    const target = AI.pickTarget(game, tank, prof, rng);
    if (!target) return { angle: tank.angle, power: tank.power, weapon: 'baby' };
    const wind = prof.useWind ? game.wind : 0;
    const persona = tank.persona;
    const direction = target.x >= tank.x ? 1 : -1;
    const random = () => ({ angle: rng.range(0, 180), power: rng.range(50, 1000), err: 80 });
    let sol;
    if (persona === 'moron') sol = random();
    else if (persona === 'tosser') {
      const prior = tank.ai.bracket;
      if (!prior || prior.id !== target.id) sol = { angle: direction > 0 ? 50 : 130, power: rng.range(240, 840), err: 55 };
      else {
        const miss = (target.x - (tank.impactX ?? target.x)) * direction;
        sol = { angle: prior.angle, power: Math.max(50, Math.min(1000, prior.power + miss * 0.38)), err: Math.abs(miss) };
      }
      tank.ai.bracket = { id: target.id, angle: sol.angle, power: sol.power };
    } else if (persona === 'shooter') sol = AI.solve(game, tank, target, wind, 'direct');
    else if (persona === 'poolshark') sol = AI.solve(game, tank, target, wind,
      ['bounce', 'spring', 'padded'].includes(game.wall) ? 'bank' : 'direct');
    else if (persona === 'chooser') {
      const direct = AI.solve(game, tank, target, wind, 'direct');
      sol = direct.err < CFG.TANK_RADIUS ? direct : AI.solve(game, tank, target, wind);
      if (sol.err >= CFG.TANK_RADIUS && ['bounce', 'spring', 'padded'].includes(game.wall)) {
        const bank = AI.solve(game, tank, target, wind, 'bank');
        if (bank.err < sol.err) sol = bank;
      }
    } else sol = AI.solve(game, tank, target, wind);

    // aim error shrinks as the AI keeps shooting at the same target ("bracketing")
    const mem = tank.ai;
    if (mem.target !== target) { mem.target = target; mem.focus = 1; }
    else mem.focus = Math.max(0.15, mem.focus * (1 - prof.learn));
    const precision = persona === 'spoiler' || persona === 'cyborg' ? 0.04 : 1;
    const angle = sol.angle + rng.gauss() * prof.aimErr * mem.focus * precision;
    const power = sol.power * (1 + rng.gauss() * prof.powErr * mem.focus * precision);
    const weapon = AI.chooseWeapon(game, tank, prof, target, sol, rng);
    return {
      target, weapon,
      angle: Math.max(0, Math.min(180, angle)),
      power: Math.max(50, Math.min(game.maxPower(tank), power)),
      think: prof.think * (0.7 + rng.next() * 0.6),
    };
  },

  shop(tank, game) {
    const preferred = {
      easy: ['missile', 'fuel', 'leapfrog'], medium: ['fuel', 'missile', 'babynuke'],
      hard: ['shield', 'fuel', 'mirv', 'battery'], expert: ['supermag', 'fuel', 'nuke', 'battery'],
    };
    const choices = game.rng.pick([['roller', 'napalm'], ['sandhog', 'funky'], ['laser', 'battery']]);
    for (const id of [...(preferred[tank.difficulty] || preferred.medium), ...choices, 'parachute', 'missile']) game.buy(tank, id);
  },
};
