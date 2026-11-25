// ---------------------------------------------------------------------------
// Ballistics. One deterministic step function is shared by the live game and the
// AI's trajectory solver, so the AI "predicts" exactly what the game will do.
// ---------------------------------------------------------------------------
const Physics = {
  launchSpeed(power) { return (power / CFG.MAX_POWER) * CFG.MAX_SPEED; },

  muzzle(tank, angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    const px = tank.x, py = tank.y - CFG.TURRET_H;
    return { x: px + Math.cos(a) * CFG.BARREL_LEN, y: py - Math.sin(a) * CFG.BARREL_LEN };
  },

  makeProjectile(tank, angleDeg, power, weaponId) {
    const m = Physics.muzzle(tank, angleDeg);
    const a = (angleDeg * Math.PI) / 180, v = Physics.launchSpeed(power);
    return { x: m.x, y: m.y, vx: Math.cos(a) * v, vy: -Math.sin(a) * v, weapon: weaponId,
             owner: tank, age: 0, bounces: 0, split: false, alive: true, trail: [] };
  },

  tankCenter(t) { return { x: t.x, y: t.y - 9 }; },

  // Advance one fixed step. Returns null or an event object.
  step(p, env) {
    const dt = CFG.DT;
    p.vx += env.wind * CFG.WIND_ACCEL * dt;
    p.vy += CFG.GRAVITY * dt;
    const prevVy = p.vy - CFG.GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.age += dt;

    // side walls
    if (p.x < 0 || p.x >= env.terrain.w) {
      if (env.walls === 'wrap') p.x = (p.x + env.terrain.w) % env.terrain.w;
      else if (env.walls === 'bounce') {
        p.x = p.x < 0 ? -p.x : 2 * (env.terrain.w - 1) - p.x;
        p.vx = -p.vx * 0.85;
      } else if (p.x < -60 || p.x > env.terrain.w + 60) return { type: 'lost' };
    }

    // tanks
    if (env.tanks) {
      for (const t of env.tanks) {
        if (!t.alive) continue;
        if (t === p.owner && p.age < 0.3) continue;
        const c = Physics.tankCenter(t);
        const dx = p.x - c.x, dy = p.y - c.y;
        if (dx * dx + dy * dy < CFG.TANK_RADIUS * CFG.TANK_RADIUS) return { type: 'tank', tank: t, x: p.x, y: p.y };
      }
    }

    // ground
    if (p.x >= 0 && p.x < env.terrain.w && p.y >= env.terrain.heightAt(p.x)) {
      return { type: 'ground', x: p.x, y: Math.min(p.y, env.terrain.heightAt(p.x) + 2) };
    }
    if (p.y > env.terrain.h + 20) return { type: 'ground', x: p.x, y: env.terrain.h };

    // apex (used by MIRV)
    if (prevVy < 0 && p.vy >= 0) return { type: 'apex', x: p.x, y: p.y };
    return null;
  },

  // Fly a shot to its first impact without side effects. Used by the AI.
  simulate(terrain, tanks, owner, angleDeg, power, wind, walls, maxTime = 12) {
    const p = Physics.makeProjectile(owner, angleDeg, power, 'baby');
    const env = { terrain, tanks, wind, walls };
    const steps = Math.ceil(maxTime / CFG.DT);
    for (let i = 0; i < steps; i++) {
      const ev = Physics.step(p, env);
      if (!ev || ev.type === 'apex') continue;
      if (ev.type === 'lost') return { lost: true, x: p.x, y: p.y };
      return { x: ev.x, y: ev.y, tank: ev.tank || null, time: p.age };
    }
    return { lost: true, x: p.x, y: p.y };
  },
};
