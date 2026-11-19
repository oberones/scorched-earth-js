// ---------------------------------------------------------------------------
// AI opponents: target selection, trajectory solving, weapon choice, shopping
// ---------------------------------------------------------------------------
const AI = {
  enemiesOf(game, tank) { return game.tanks.filter(t => t.alive && t !== tank); },

  // Every AI picks a random opponent (human or AI) and pursues it until it is destroyed,
  // then picks a new random one. Memory resets each round.
  pickTarget(game, tank, prof, rng) {
    const cur = tank.ai.target;
    if (cur && cur.alive && cur !== tank) return cur;
    const enemies = AI.enemiesOf(game, tank);
    return enemies.length ? rng.pick(enemies) : null;
  },

  // Grid search + refinement over (angle, power) using the real physics step.
  solve(game, tank, target, wind) {
    const tc = Physics.tankCenter(target);
    const right = target.x >= tank.x;
    const evalShot = (angle, power) => {
      const r = Physics.simulate(game.terrain, game.tanks, tank, angle, power, wind, game.settings.walls);
      if (r.lost) return 1e6;
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
    for (const angle of angles) {
      for (let power = 120; power <= maxP; power += 30) {
        const err = evalShot(angle, power);
        if (err < best.err) best = { angle, power, err };
      }
    }
    // refine
    const a0 = best.angle, p0 = best.power;
    for (let da = -3; da <= 3; da += 0.5) {
      for (let dp = -30; dp <= 30; dp += 4) {
        const angle = a0 + da, power = Math.max(50, Math.min(maxP, p0 + dp));
        const err = evalShot(angle, power);
        if (err < best.err) best = { angle, power, err };
      }
    }
    return best;
  },

  chooseWeapon(game, tank, prof, target, solution, rng) {
    const inv = tank.inventory;
    const owned = WEAPON_ORDER.filter(w => w !== 'dirt' && w !== 'digger' && (inv[w] || 0) > 0);
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
    const sol = AI.solve(game, tank, target, wind);

    // aim error shrinks as the AI keeps shooting at the same target ("bracketing")
    const mem = tank.ai;
    if (mem.target !== target) { mem.target = target; mem.focus = 1; }
    else mem.focus = Math.max(0.15, mem.focus * (1 - prof.learn));
    const angle = sol.angle + rng.gauss() * prof.aimErr * mem.focus;
    const power = sol.power * (1 + rng.gauss() * prof.powErr * mem.focus);
    const weapon = AI.chooseWeapon(game, tank, prof, target, sol, rng);
    return {
      target, weapon,
      angle: Math.max(0, Math.min(180, angle)),
      power: Math.max(50, Math.min(game.maxPower(tank), power)),
      think: prof.think * (0.7 + rng.next() * 0.6),
    };
  },

  shop(tank, rng) {
    const prof = tank.difficulty;
    const wish = {
      easy:   ['missile', 'babynuke', 'parachute', 'missile', 'dirt'],
      medium: ['missile', 'parachute', 'babynuke', 'missile', 'leapfrog', 'shield'],
      hard:   ['shield', 'babynuke', 'missile', 'mirv', 'parachute', 'nuke', 'repair'],
      expert: ['shield', 'repair', 'babynuke', 'mirv', 'nuke', 'missile', 'parachute', 'babynuke'],
    }[prof] || [];
    const list = prof === 'easy' ? wish.slice().sort(() => rng.next() - 0.5) : wish;
    const reserve = prof === 'expert' ? 0 : 300;
    for (const id of list) {
      const def = WEAPONS[id] || ITEMS[id];
      if (tank.money - def.price < reserve) continue;
      tank.money -= def.price;
      if (WEAPONS[id]) tank.inventory[id] = (tank.inventory[id] || 0) + def.bundle;
      else tank.items[id] = (tank.items[id] || 0) + def.bundle;
    }
  },
};
