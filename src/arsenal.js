// Arcade weapon effects run in the authoritative simulation. The renderer reads their marks.
const Arsenal = {
  equip(game, t, id, value) {
    if (!t) return false;
    const preparing = game.phase === 'shop' && t.items.autodefense > 0;
    if (!preparing && !game.eligible(t)) return false;
    if (id === 'parachute') t.parachuteOn = !!value;
    else if (id === 'threshold' && Number.isInteger(value) && value >= 0 && value <= 100) t.threshold = value;
    else if (id === 'shield' && (!value || (Object.hasOwn(ITEMS, value) && ITEMS[value].strength && t.items[value] > 0))) {
      if (preparing) t.defense = value;
      else if (game.settings.format !== 'simultaneous') {
        t.shieldType = value;
        t.shield = value ? ITEMS[value].strength : 0;
        if (value) t.items[value]--;
      } else return false;
    } else if (preparing) return false;
    else if (id === 'battery') return game.useRepair(t);
    else if (id === 'energy' && Number.isInteger(value) && value >= 0 && value <= 9) t.energy = value;
    else if (id === 'trigger' && t.items.trigger > 0 && game.settings.format !== 'simultaneous') t.contact = !!value;
    else if (id === 'target' && (value === null || (Number.isInteger(value) && value !== t.id && game.tanks[value]?.alive))) t.targetId = value;
    else if (id === 'guidance' && (!value || (ITEMS[value]?.family === 'Guidance' && t.items[value] > 0))) t.guidance = value;
    else return false;
    return true;
  },

  prepare(game, t, p) {
    const w = WEAPONS[p.weapon];
    const guidance = t.guidance;
    if (guidance && t.items[guidance] > 0 && !w.split && !w.wedge && p.weapon !== 'plasma') {
      p.target = game.tanks[t.targetId];
      if (guidance === 'heat' || p.target?.alive) {
        t.items[guidance]--; p.guidance = guidance; t.guidance = null;
        if (guidance === 'ballistic') {
          let best = Infinity, power = t.power;
          for (let v = 0; v <= CFG.MAX_POWER; v += 5) {
            const hit = Physics.simulate(game.terrain, game.tanks, t, t.angle, v, game.wind, game.wall);
            const distance = Math.hypot(hit.x - p.target.x, hit.y - p.target.y);
            if (distance < best) { best = distance; power = v; }
          }
          const shot = Physics.makeProjectile(t, t.angle, power, t.weapon);
          p.vx = shot.vx; p.vy = shot.vy;
        }
      }
    }
    const acceptsTrigger = !w.wedge && !w.digger && !w.hogs && !['Rollers', 'Energy', 'Tracers'].includes(w.family);
    if (acceptsTrigger && t.contact && t.items.trigger > 0) { p.contact = true; t.items.trigger--; }
    p.suspended = game.settings.suspend > 0 && game.rng.int(1, 100) <= game.settings.suspend;
    if (!p.suspended) game.terrain.collapse();
    if (w.wedge) {
      const a = t.angle * Math.PI / 180;
      for (let d = 4; d <= w.radius; d += 4) {
        const x = t.x + Math.cos(a) * d, y = t.y - CFG.TURRET_H - Math.sin(a) * d;
        const radius = 3 + d * (p.weapon === 'riotblast' ? 0.42 : 0.28);
        if (w.dirt) game.terrain.addDirt(x, y, radius * 0.4, p.suspended);
        else game.terrain.crater(x, y, radius, p.suspended);
      }
      return false;
    }
    if (w.family === 'Energy') {
      const cells = Math.min(t.energy ?? 1, t.items.battery || 0);
      if (cells) t.items.battery -= cells;
      if (p.weapon === 'plasma') {
        const radius = 20 + cells * 12;
        game.terrain.crater(t.x, t.y, radius, p.suspended);
        game.damageArea(t.x, t.y - 9, radius, 25 + cells * 13, t, true);
        game.blasts.push({ x: t.x, y: t.y, r: radius, dur: 0.6, t: 0, color: '#c38cff' });
      } else {
        const a = t.angle * Math.PI / 180, hit = new Set();
        let x = p.x, y = p.y;
        for (let d = 0; d < 180 + cells * 200; d += 6) {
          x += Math.cos(a) * 6; y -= Math.sin(a) * 6;
          if (x < 0 || x >= CFG.W || y < 0 || y >= CFG.H) break;
          game.terrain.crater(x, y, 4 + cells, p.suspended);
          for (const tank of game.alive()) {
            if (tank === t || hit.has(tank) || Math.hypot(tank.x - x, tank.y - 9 - y) > 18) continue;
            hit.add(tank);
            if (tank.shieldType !== 'supermag' || !tank.shield) game.applyDamage(tank, 25 + cells * 15, t);
          }
        }
        game.mark([p.x, p.y, x, y], '#ff6262', 0.45);
      }
      return false;
    }
    return true;
  },

  impact(game, p, ev) {
    const w = WEAPONS[p.weapon];
    if (ev.type === 'shield') {
      const t = ev.tank;
      if (!Physics.shieldContact(p, t)) p.alive = false;
      game.applyDamage(t, Math.min(t.shield, 4), p.owner);
      return true;
    }
    if (ev.type === 'dig') {
      game.terrain.crater(p.x, p.y, w.digger ? w.radius : 5, true);
      p.remaining -= Math.hypot(p.vx, p.vy) * CFG.DT;
      if (p.remaining <= 0 || p.y >= CFG.H || ev.tank) {
        if (w.hogs) game.detonate(p.x, p.y, p.weapon, p.owner, 1, p.suspended);
        if (!p.suspended) game.terrain.collapse();
        p.alive = false;
      }
      return true;
    }
    if (w.digger || w.hogs) {
      if (ev.type === 'ground' && !p.burrowing) {
        const count = w.hogs || 1;
        const heading = Math.atan2(p.vy, p.vx);
        for (let i = 0; i < count; i++) {
          const a = heading + (i - (count - 1) / 2) * 0.55;
          game.projectiles.push({ ...p, id: game.nextProjId++, vx: Math.cos(a) * 140, vy: Math.sin(a) * 140,
            burrowing: true, remaining: w.digger || 78, trail: [] });
        }
      } else if (w.hogs) game.detonate(p.x, p.y, p.weapon, p.owner, 1, p.suspended);
      if (p.burrowing && !p.suspended) game.terrain.collapse();
      p.alive = false;
      return true;
    }
    if (w.family === 'Tracers') {
      if (p.weapon === 'smoke') game.mark(p.smokePath || p.trail, p.owner.color, Infinity);
      p.alive = false; return true;
    }
    if (w.family === 'Rollers' && ev.type === 'ground') {
      p.rolling = true; p.y = game.terrain.heightAt(p.x) - 2; return true;
    }
    if (w.family === 'Fire') {
      const pool = game.terrain.pool(p.x, w.radius, w.radius * 9, false);
      // Flame intensity and reach depend on the depth of liquid at each tank.
      for (const tank of game.alive()) {
        let heat = 0;
        for (const cell of pool) {
          if (Math.abs(tank.x - cell.x) < 20 && tank.y >= cell.y - 16 && tank.y <= cell.y + cell.depth + 22)
            heat += cell.depth;
        }
        if (heat) game.applyDamage(tank, Math.min(w.damage * 2, Math.ceil(heat / 5)), p.owner);
      }
      for (const cell of pool) game.mark([cell.x, cell.y, cell.x, cell.y + cell.depth], '#ff782d', 1.4);
    } else if (p.weapon === 'liquiddirt') game.terrain.pool(p.x, 75, 3300, true);
    else if (p.weapon === 'disrupter') game.terrain.collapse();
    else if (p.weapon === 'funky') {
      for (let i = 0; i < 6; i++) game.pending.push({ x: p.x + game.rng.range(-70, 70), y: p.y + game.rng.range(-35, 30),
        delay: i * 0.14, weapon: 'funky', owner: p.owner, scale: 0.85, color: game.rng.pick(TEAM_COLORS).hex });
    } else return false;
    p.alive = false; return true;
  },
};
