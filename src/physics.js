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
    const rules = env.terrain.rules;
    const kind = WEAPONS[p.weapon];
    const previousX = p.x, previousY = p.y, prevVy = p.vy;
    const gravity = CFG.GRAVITY * (rules ? rules.gravity / 100 : 1);
    const drag = rules ? 1 - rules.drag * 0.08 * dt : 1;
    if (p.rolling) {
      const terrain = env.terrain;
      const left = terrain.heightAt(p.x - 2), right = terrain.heightAt(p.x + 2);
      const dir = right > left ? 1 : -1;
      const next = p.x + dir * 100 * dt;
      if (next < 0 || next >= terrain.w || terrain.heightAt(next) <= terrain.heightAt(p.x) + 0.0001)
        return { type: 'rest', x: p.x, y: p.y };
      p.x = next; p.y = terrain.heightAt(next) - 2; p.vx = dir * 100; p.vy = 0;
    } else {
      if (!p.burrowing && !p.straight) {
        p.vx = p.vx * drag + env.wind * CFG.WIND_ACCEL * dt;
        p.vy = p.vy * drag + gravity * dt;
      }
      if (p.guidance) Physics.guide(p, env.tanks);
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    p.age += dt;

    const wall = env.walls;
    const side = p.x < 0 || p.x >= env.terrain.w;
    const ceiling = p.y < 0 && ['padded', 'bounce', 'spring', 'concrete'].includes(wall);
    if (side || ceiling) {
      if (side && wall === 'wrap') p.x = (p.x + env.terrain.w) % env.terrain.w;
      else if (wall === 'concrete') return { type: 'wall', x: p.x, y: Math.max(0, p.y) };
      else if (wall === 'padded' || wall === 'bounce' || wall === 'spring') {
        const factor = wall === 'spring' ? 1.22 : wall === 'padded' ? 0.65 : 1;
        if (side) { p.x = Math.max(0, Math.min(env.terrain.w - 1, p.x)); p.vx *= -factor; }
        if (ceiling) { p.y = 0; p.vy = Math.abs(p.vy) * factor; }
        p.banked = true;
      } else if (p.x < -60 || p.x > env.terrain.w + 60) return { type: 'lost' };
    }

    // tanks
    if (env.tanks) {
      for (const t of env.tanks) {
        if (!t.alive) continue;
        if (t === p.owner && p.age < 0.3) continue;
        const c = Physics.tankCenter(t);
        const dx = p.x - c.x, dy = p.y - c.y;
        const distance = dx * dx + dy * dy;
        if (t !== p.owner && t.shield > (env.shieldLoss?.get(t) || 0) && !p.burrowing && t.shieldType) {
          if ((t.shieldType === 'mag' || t.shieldType === 'supermag') && distance < 70 ** 2) p.vy -= 1200 * dt;
          if (distance <= 27 ** 2 && dx * p.vx + dy * p.vy < 0)
            return { type: 'shield', tank: t, x: p.x, y: p.y };
        }
        if (distance < CFG.TANK_RADIUS * CFG.TANK_RADIUS) return { type: 'tank', tank: t, x: p.x, y: p.y };
      }
    }

    // ground
    if (p.burrowing) return { type: 'dig', x: p.x, y: p.y };
    if (!p.rolling && env.terrain.isSolid(p.x, p.y)) {
      if (!p.contact && rules && rules.tunneling === 'on' && !kind.digger && !kind.hogs &&
          (!kind.split || p.child) && !kind.bounces && kind.family !== 'Rollers' && kind.family !== 'Tracers') {
        if (p.penetration == null) p.penetration = Math.min(24, Math.hypot(p.vx, p.vy) / 35);
        p.penetration -= Math.hypot(p.x - previousX, p.y - previousY);
        p.vx *= 0.88; p.vy *= 0.88;
        if (p.penetration > 0.1 && Math.hypot(p.vx, p.vy) > 8) return null;
      }
      return { type: 'ground', x: p.x, y: p.y };
    }
    if (p.y > env.terrain.h + 20) return { type: 'lost', x: p.x, y: p.y };

    // apex (used by MIRV)
    if (prevVy < 0 && p.vy >= 0) return { type: 'apex', x: p.x, y: p.y };
    return null;
  },

  shieldContact(p, t) {
    if (!['force', 'supermag'].includes(t.shieldType) && WEAPONS[p.weapon].family !== 'Rollers') return false;
    const dx = p.x - t.x, dy = p.y - (t.y - 9), distance = Math.max(1, Math.hypot(dx, dy));
    const normal = (p.vx * dx + p.vy * dy) / (distance * distance);
    p.vx -= 2 * normal * dx; p.vy -= 2 * normal * dy;
    p.rolling = false;
    p.x = t.x + 29 * dx / distance; p.y = t.y - 9 + 29 * dy / distance;
    return true;
  },

  guide(p, tanks) {
    let target = p.target;
    if (p.guidance === 'heat') target = (tanks || []).find(t => t !== p.owner && t.alive && Math.hypot(t.x - p.x, t.y - 9 - p.y) < 85);
    if (!target) return;
    const dx = target.x - p.x, dy = target.y - 9 - p.y;
    const speed = Math.max(180, Math.hypot(p.vx, p.vy));
    if (p.guidance === 'horizontal' && Math.abs(dy) < speed * CFG.DT + 2) {
      p.vx = Math.sign(dx) * speed; p.vy = 0;
    } else if (p.guidance === 'vertical' && Math.abs(dx) < speed * CFG.DT + 2) {
      p.vy = Math.sign(dy) * speed; p.vx = 0;
    } else if (p.guidance === 'heat' || p.guidance === 'lazy') {
      const d = Math.max(1, Math.hypot(dx, dy));
      p.vx = speed * dx / d; p.vy = speed * dy / d;
    } else return;
    p.straight = true;
  },

  // Fly a shot to its first impact without side effects. Used by the AI.
  simulate(terrain, tanks, owner, angleDeg, power, wind, walls, maxTime = 12) {
    const p = Physics.makeProjectile(owner, angleDeg, power, 'baby');
    const env = { terrain, tanks, wind, walls };
    const steps = Math.ceil(maxTime / CFG.DT);
    for (let i = 0; i < steps; i++) {
      const ev = Physics.step(p, env);
      if (!ev || ev.type === 'apex') continue;
      if (ev.type === 'shield' && Physics.shieldContact(p, ev.tank)) {
        if (!env.shieldLoss) env.shieldLoss = new Map();
        env.shieldLoss.set(ev.tank, (env.shieldLoss.get(ev.tank) || 0) + 4);
        continue;
      }
      if (ev.type === 'lost') return { lost: true, x: p.x, y: p.y };
      return { x: ev.x, y: ev.y, tank: ev.tank || null, time: p.age, banked: !!p.banked };
    }
    return { lost: true, x: p.x, y: p.y };
  },
};
