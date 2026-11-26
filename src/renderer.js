// ---------------------------------------------------------------------------
// Scene renderer: procedural sky & parallax hills, textured destructible terrain,
// 3D tanks/projectiles, explosions, particles, screen shake.
// ---------------------------------------------------------------------------
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const mk = () => { const c = document.createElement('canvas'); c.width = CFG.W; c.height = CFG.H; return c; };
    this.bg = mk(); this.dirt = mk(); this.terr = mk();
    this.k = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.particles = []; this.texts = []; this.flashes = [];
    this.shake = 0; this.screenFlash = 0; this.time = 0;
    this.terrVersion = -1; this.roundKey = null; this.clouds = [];
    this.game = null;
  }

  // Render at the display's real pixel density; game logic stays in CFG.W x CFG.H units.
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const k = Math.max(1, Math.min(2.5, ((rect.width || CFG.W) * (window.devicePixelRatio || 1)) / CFG.W));
    if (Math.abs(k - this.k) < 0.01 && this.canvas.width) { if (this.canvas.width === Math.round(CFG.W * k)) return; }
    this.k = k;
    this.canvas.width = Math.round(CFG.W * k); this.canvas.height = Math.round(CFG.H * k);
    this.terr.width = this.canvas.width; this.terr.height = this.canvas.height;
    this.terrVersion = -1;
  }

  setGame(game) { this.game = game; this.roundKey = null; this.particles = []; this.texts = []; }

  // -------------------------------------------------------------- per-round art
  buildRoundArt() {
    const g = this.game, th = SKY_THEMES[g.theme], rng = new RNG(g.settings.seed + g.round * 977);
    this.themeDef = th;
    const { W, H } = CFG;
    // sky
    const c = this.bg.getContext('2d');
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, th.top); grad.addColorStop(0.5, th.mid); grad.addColorStop(0.9, th.bot);
    c.fillStyle = grad; c.fillRect(0, 0, W, H);
    // stars
    for (let i = 0; i < 320 * th.stars; i++) {
      const x = rng.range(0, W), y = rng.range(0, H * 0.6), s = rng.next();
      c.fillStyle = `rgba(255,255,255,${(0.2 + s * 0.8) * (1 - y / (H * 0.6))})`;
      c.fillRect(x, y, s > 0.95 ? 2 : 1, s > 0.95 ? 2 : 1);
    }
    // sun / moon with glow
    const sx = rng.range(W * 0.15, W * 0.85), sy = rng.range(H * 0.12, H * 0.3), sr = rng.range(26, 46);
    const glow = c.createRadialGradient(sx, sy, sr * 0.5, sx, sy, sr * 6);
    glow.addColorStop(0, th.sun + 'aa'); glow.addColorStop(1, th.sun + '00');
    c.fillStyle = glow; c.fillRect(0, 0, W, H);
    c.fillStyle = th.sun; c.beginPath(); c.arc(sx, sy, sr, 0, Math.PI * 2); c.fill();
    // parallax hill silhouettes
    th.hills.forEach((col, layer) => {
      const base = H * (0.5 + layer * 0.1), amp = H * (0.12 - layer * 0.03);
      const ph = [rng.range(0, 6), rng.range(0, 6), rng.range(0, 6)];
      c.fillStyle = col; c.globalAlpha = 0.75 + layer * 0.25;
      c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x <= W; x += 4) {
        const y = base - amp * (0.6 * Math.sin(x * 0.004 + ph[0]) + 0.3 * Math.sin(x * 0.011 + ph[1]) + 0.15 * Math.sin(x * 0.031 + ph[2]));
        c.lineTo(x, y);
      }
      c.lineTo(W, H); c.closePath(); c.fill();
      c.globalAlpha = 1;
      // atmospheric haze between layers
      const hz = c.createLinearGradient(0, base - amp, 0, H);
      hz.addColorStop(0, th.bot + '00'); hz.addColorStop(1, th.bot + '55');
      c.fillStyle = hz; c.fillRect(0, base - amp, W, H);
    });

    // dirt texture: layered strata + speckle + pebbles
    const d = this.dirt.getContext('2d');
    const img = d.createImageData(W, H), px = img.data;
    const cols = th.dirt.map(h => Mesh3D.hexToRgb(h));
    const wave = new Float32Array(W);
    const wp = [rng.range(0, 6), rng.range(0, 6)];
    for (let x = 0; x < W; x++) wave[x] = Math.sin(x * 0.013 + wp[0]) * 9 + Math.sin(x * 0.047 + wp[1]) * 4;
    for (let y = 0; y < H; y++) {
      const depth = Math.max(0, Math.min(1, (y - H * 0.25) / (H * 0.75)));
      for (let x = 0; x < W; x++) {
        const s = y + wave[x];
        const band = 0.5 + 0.5 * Math.sin(s * 0.11) * Math.sin(s * 0.023 + 1.3);
        const t = Math.min(1.999, depth * 1.6 + band * 0.35);
        const i0 = Math.floor(t), f = t - i0;
        const a = cols[i0], b = cols[Math.min(2, i0 + 1)];
        const n = (rng.next() - 0.5) * 18;
        const k = (y * W + x) * 4;
        px[k] = a[0] + (b[0] - a[0]) * f + n;
        px[k + 1] = a[1] + (b[1] - a[1]) * f + n;
        px[k + 2] = a[2] + (b[2] - a[2]) * f + n;
        px[k + 3] = 255;
      }
    }
    d.putImageData(img, 0, 0);
    for (let i = 0; i < 260; i++) {
      const x = rng.range(0, W), y = rng.range(H * 0.3, H), r = rng.range(1.5, 4.5);
      d.fillStyle = `rgba(0,0,0,${rng.range(0.15, 0.35)})`;
      d.beginPath(); d.ellipse(x, y, r * 1.3, r, rng.range(0, 3), 0, Math.PI * 2); d.fill();
      d.fillStyle = 'rgba(255,255,255,0.08)';
      d.beginPath(); d.ellipse(x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.4, 0, 0, Math.PI * 2); d.fill();
    }

    this.clouds = [];
    for (let i = 0; i < 6; i++) {
      this.clouds.push({ x: rng.range(0, W), y: rng.range(H * 0.08, H * 0.4), w: rng.range(80, 200),
        a: th.name === 'Night' ? 0.05 : rng.range(0.06, 0.14), puffs: Array.from({ length: 5 }, () => [rng.range(-0.5, 0.5), rng.range(-0.15, 0.15), rng.range(0.25, 0.45)]) });
    }
    this.terrVersion = -1;
  }

  redrawTerrain() {
    const g = this.game.terrain.ground, { W, H } = CFG, th = this.themeDef;
    const c = this.terr.getContext('2d');
    c.setTransform(this.k, 0, 0, this.k, 0, 0);
    c.clearRect(0, 0, W, H);
    const path = new Path2D();
    path.moveTo(0, H);
    for (let x = 0; x < W; x++) path.lineTo(x, g[x]);
    path.lineTo(W, H); path.closePath();
    const edge = new Path2D();
    edge.moveTo(0, g[0]);
    for (let x = 1; x < W; x++) edge.lineTo(x, g[x]);
    c.save();
    c.clip(path);
    c.drawImage(this.dirt, 0, 0);
    c.strokeStyle = 'rgba(0,0,0,0.28)'; c.lineWidth = 26; c.stroke(edge);   // soft inner shading
    c.strokeStyle = th.grass; c.lineWidth = 7; c.stroke(edge);              // topsoil band
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1; c.stroke(edge); // rim light
    for (const [x, intervals] of this.game.terrain.holes) {
      for (const [top, bottom] of intervals) c.clearRect(x, top, 1, bottom - top);
    }
    this.terrVersion = this.game.terrain.version;
  }

  // ------------------------------------------------------------------ effects
  spawn(n, f) { for (let i = 0; i < n && this.particles.length < 1800; i++) this.particles.push(f(i)); }

  consume(events) {
    const th = this.themeDef || SKY_THEMES[0];
    const S = this.silent ? Renderer.SILENT : Sfx;
    for (const e of events) {
      switch (e.type) {
        case 'fire': {
          S.fire();
          const a = (e.angle * Math.PI) / 180;
          this.flashes.push({ x: e.x, y: e.y, r: 16, life: 0.12, max: 0.12 });
          this.spawn(14, () => {
            const s = 60 + Math.random() * 160, d = a + (Math.random() - 0.5) * 0.6;
            return { x: e.x, y: e.y, vx: Math.cos(d) * s, vy: -Math.sin(d) * s, life: 0.6, max: 0.6, size: 4 + Math.random() * 5, kind: 'smoke', col: '200,200,200', grav: -20, drag: 2.5 };
          });
          this.shake = Math.max(this.shake, 2);
          break;
        }
        case 'explode': {
          S.explode(e.r);
          this.shake = Math.max(this.shake, Math.min(22, e.r / 5));
          if (e.nuke) this.screenFlash = Math.min(1, e.r / 110);
          const dirtCols = th.dirt.map(h => Mesh3D.hexToRgb(h).join(','));
          this.spawn(Math.min(140, e.r * 1.4), () => {
            const ang = -Math.PI * Math.random(), s = 80 + Math.random() * e.r * 6;
            return { x: e.x, y: e.y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s, life: 1 + Math.random(), max: 2, size: 1.5 + Math.random() * 3, kind: 'debris', col: dirtCols[(Math.random() * 3) | 0], grav: 520, drag: 0.4 };
          });
          this.spawn(Math.min(90, e.r), () => {
            const ang = Math.random() * Math.PI * 2, s = 100 + Math.random() * e.r * 7;
            return { x: e.x, y: e.y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s, life: 0.3 + Math.random() * 0.5, max: 0.8, size: 1.5, kind: 'spark', col: '255,220,140', grav: 200, drag: 2 };
          });
          this.spawn(Math.min(60, e.r / 2.5), () => {
            const ang = Math.random() * Math.PI * 2, d = Math.random() * e.r * 0.6;
            return { x: e.x + Math.cos(ang) * d, y: e.y + Math.sin(ang) * d * 0.6, vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * (e.nuke ? 90 : 40), life: 2 + Math.random() * 2, max: 4, size: e.r * (0.15 + Math.random() * 0.2), kind: 'smoke', col: '60,55,55', grav: -10, drag: 0.8 };
          });
          if (e.nuke) { // mushroom stem + cap
            this.spawn(70, i => {
              const stem = i < 35, h = stem ? Math.random() * e.r * 1.4 : e.r * 1.4 + Math.random() * 20;
              const spread = stem ? e.r * 0.2 : e.r * 0.8;
              return { x: e.x + (Math.random() - 0.5) * spread, y: e.y - h * 0.3, vx: (Math.random() - 0.5) * (stem ? 10 : 50), vy: -(h * 0.7 + 20), life: 3 + Math.random() * 1.5, max: 4.5, size: e.r * (0.18 + Math.random() * 0.15), kind: 'smoke', col: stem ? '90,70,60' : '120,90,70', grav: 0, drag: 1.1 };
            });
          }
          break;
        }
        case 'dirt': {
          S.dirt();
          const dirtCol = Mesh3D.hexToRgb(th.dirt[0]).join(',');
          this.spawn(60, () => ({ x: e.x + (Math.random() - 0.5) * e.r, y: e.y + (Math.random() - 0.5) * e.r, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 120, life: 1.2, max: 1.2, size: 2 + Math.random() * 3, kind: 'debris', col: dirtCol, grav: 500, drag: 0.5 }));
          break;
        }
        case 'hit':
          if (e.dmg > 0) { S.hit(); this.text(e.tank.x, e.tank.y - 40, `-${e.dmg}`, '#ff6b5e'); }
          if (e.absorbed > 0) this.text(e.tank.x + 18, e.tank.y - 54, `shield -${e.absorbed}`, '#7fe7ff');
          break;
        case 'death':
          this.text(e.tank.x, e.tank.y - 60, 'DESTROYED', '#ffd34d', 2.2);
          break;
        case 'land':
          if (e.drop > 6) {
            S.land();
            this.spawn(16, () => ({ x: e.tank.x + (Math.random() - 0.5) * 30, y: e.tank.y, vx: (Math.random() - 0.5) * 80, vy: -Math.random() * 30, life: 0.8, max: 0.8, size: 4 + Math.random() * 4, kind: 'smoke', col: '160,140,120', grav: 0, drag: 2 }));
          }
          break;
        case 'split': S.split(); this.flashes.push({ x: e.x, y: e.y, r: 22, life: 0.2, max: 0.2 }); break;
        case 'bounce': S.bounce(); break;
        case 'repair': this.text(e.tank.x, e.tank.y - 44, `+${e.restored} health`, '#7dff9a'); S.buy(); break;
        case 'turn': S.turn(); break;
      }
    }
  }

  text(x, y, s, col, life = 1.4) { this.texts.push({ x, y, s, col, life, max: life }); }

  // --------------------------------------------------------------------- draw
  draw(dt) {
    const g = this.game, ctx = this.ctx, { W, H } = CFG;
    if (!g || !g.round) return;
    this.time += dt;
    const key = g.round + ':' + g.settings.seed;
    if (this.roundKey !== key) { this.roundKey = key; this.buildRoundArt(); }
    if (this.terrVersion !== g.terrain.version) this.redrawTerrain();

    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    ctx.save();
    if (this.shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.004, dt);
    }
    ctx.drawImage(this.bg, 0, 0);
    this.drawClouds(dt);

    const buried = t => g.terrain.heightAt(t.x) < t.y - 14;
    for (const t of g.tanks) if (buried(t)) this.drawTank(t);
    ctx.drawImage(this.terr, 0, 0, W, H);
    for (const t of g.tanks) if (!buried(t)) this.drawTank(t);

    for (const mark of g.marks || []) {
      ctx.beginPath(); ctx.strokeStyle = mark.color; ctx.lineWidth = 2;
      ctx.moveTo(mark.points[0], mark.points[1]);
      for (let i = 2; i < mark.points.length; i += 2) ctx.lineTo(mark.points[i], mark.points[i + 1]);
      ctx.stroke();
    }
    this.drawAimGuide();
    for (const p of g.projectiles) this.drawProjectile(p, dt);
    this.drawBlasts();
    this.updateParticles(dt);
    this.drawHud(dt);
    ctx.restore();

    if (this.screenFlash > 0.01) {
      ctx.fillStyle = `rgba(255,250,235,${this.screenFlash * 0.75})`;
      ctx.fillRect(0, 0, W, H);
      this.screenFlash *= Math.pow(0.02, dt);
    }
  }

  drawClouds(dt) {
    const ctx = this.ctx, wind = this.game.wind;
    for (const c of this.clouds) {
      c.x += (wind * 5 + 3) * dt;
      if (c.x > CFG.W + c.w) c.x = -c.w; if (c.x < -c.w) c.x = CFG.W + c.w;
      ctx.fillStyle = `rgba(255,255,255,${c.a})`;
      for (const [dx, dy, r] of c.puffs) {
        ctx.beginPath(); ctx.ellipse(c.x + dx * c.w, c.y + dy * c.w, c.w * r, c.w * r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawTank(t) {
    const ctx = this.ctx, g = this.game;
    const roll = t.falling ? 0 : g.terrain.slopeAt(t.x, 12, t.y) * 0.8;
    const a = (t.angle * Math.PI) / 180;
    // contact shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(t.x, g.terrain.support(t.x, t.y) + 1, 22, 3.5, 0, 0, Math.PI * 2); ctx.fill();

    if (t.chute && t.falling) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(t.x - 14, t.y - 14); ctx.lineTo(t.x - 20, t.y - 50); ctx.moveTo(t.x + 14, t.y - 14); ctx.lineTo(t.x + 20, t.y - 50); ctx.stroke();
      ctx.fillStyle = t.color;
      ctx.beginPath(); ctx.arc(t.x, t.y - 50, 22, Math.PI, 0); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(t.x, t.y - 50, 22, Math.PI, Math.PI * 1.33); ctx.lineTo(t.x, t.y - 50); ctx.fill();
    }

    Mesh3D.draw(ctx, 'tank', t.x, t.y, {
      scale: CFG.TANK_SCALE, roll, barrel: a - roll, colors: Mesh3D.teamColors(t.color, !t.alive),
    });

    if (!t.alive) {
      if (Math.random() < 0.15) this.particles.push({ x: t.x + (Math.random() - 0.5) * 10, y: t.y - 10, vx: 6, vy: -25, life: 2, max: 2, size: 5, kind: 'smoke', col: '40,40,40', grav: -5, drag: 0.5 });
      return;
    }
    if (t.shield > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4 + t.id);
      const gr = ctx.createRadialGradient(t.x, t.y - 10, 12, t.x, t.y - 10, 32);
      gr.addColorStop(0, 'rgba(120,230,255,0)'); gr.addColorStop(0.8, `rgba(120,230,255,${0.12 + pulse * 0.1})`); gr.addColorStop(1, 'rgba(160,240,255,0.55)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(t.x, t.y - 10, 32, 0, Math.PI * 2); ctx.fill();
    }
    // health bar + name
    const bw = 36, bx = t.x - bw / 2, by = t.y - 42;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx - 1, by - 1, bw + 2, 6);
    const hp = t.health / CFG.MAX_HEALTH;
    ctx.fillStyle = hp > 0.6 ? '#5ee07a' : hp > 0.3 ? '#f2c94c' : '#ff5e57';
    ctx.fillRect(bx, by, bw * hp, 4);
    if (t.shield > 0) { ctx.fillStyle = '#7fe7ff'; ctx.fillRect(bx, by - 3, bw * (t.shield / (ITEMS[t.shieldType]?.strength || 80)), 2); }
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(t.name, t.x + 1, by - 6);
    ctx.fillStyle = '#fff'; ctx.fillText(t.name, t.x, by - 7);
    // current-turn marker
    if (g.current === t && (g.phase === 'aim' || g.phase === 'flight')) {
      const bob = Math.sin(this.time * 5) * 3, my = by - 26 + bob;
      ctx.fillStyle = t.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(t.x - 7, my - 8); ctx.lineTo(t.x + 7, my - 8); ctx.lineTo(t.x, my); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  drawAimGuide() {
    const g = this.game, t = g.current;
    if (!g.canControl(t)) return;
    const ctx = this.ctx, m = Physics.muzzle(t, t.angle), a = (t.angle * Math.PI) / 180;
    const len = 26 + t.power * 0.09;
    ctx.save();
    ctx.setLineDash([3, 6]); ctx.lineDashOffset = -this.time * 30;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + Math.cos(a) * len, m.y - Math.sin(a) * len); ctx.stroke();
    ctx.restore();
  }

  drawProjectile(p, dt) {
    const ctx = this.ctx, W = WEAPONS[p.weapon];
    const tr = p.trail;
    if (tr.length > 4) {
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 2; i < tr.length; i += 2) {
        const k = i / tr.length;
        ctx.strokeStyle = `rgba(255,255,255,${k * 0.35})`;
        ctx.beginPath(); ctx.moveTo(tr[i - 2], tr[i - 1]); ctx.lineTo(tr[i], tr[i + 1]); ctx.stroke();
      }
    }
    if (Math.random() < 0.8) this.particles.push({ x: p.x, y: p.y, vx: -p.vx * 0.05, vy: -p.vy * 0.05, life: 0.7, max: 0.7, size: 3, kind: 'smoke', col: '220,220,220', grav: -15, drag: 1.5 });
    if (p.y < -6) { // off the top of the screen: altitude marker
      ctx.fillStyle = W.color;
      ctx.beginPath(); ctx.moveTo(p.x, 4); ctx.lineTo(p.x - 7, 16); ctx.lineTo(p.x + 7, 16); ctx.closePath(); ctx.fill();
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText(`${Math.round(-p.y)}`, p.x, 28);
      return;
    }
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14);
    glow.addColorStop(0, W.color + 'aa'); glow.addColorStop(1, W.color + '00');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
    Mesh3D.draw(ctx, W.model, p.x, p.y, { scale: W.scale, roll: Math.atan2(-p.vy, p.vx) });
  }

  drawBlasts() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.game.blasts) {
      const k = b.t / b.dur;
      if (b.dirt) continue;
      const grow = Math.min(1, b.t / 0.12);
      const r = b.r * (0.35 + 0.65 * grow) * (b.nuke ? 1 + 0.25 * k : 1);
      const a = Math.pow(1 - k, 1.4);
      const rgb = Mesh3D.hexToRgb(b.color).join(',');
      const gr = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
      gr.addColorStop(0, `rgba(255,255,235,${a})`);
      gr.addColorStop(0.3, `rgba(255,210,110,${a * 0.9})`);
      gr.addColorStop(0.65, `rgba(${rgb},${a * 0.6})`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,240,210,${a * 0.5})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (0.5 + k * 1.3), 0, Math.PI * 2); ctx.stroke();
    }
    for (const f of this.flashes) {
      const a = f.life / f.max;
      const gr = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
      gr.addColorStop(0, `rgba(255,240,200,${a})`); gr.addColorStop(1, 'rgba(255,180,80,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  updateParticles(dt) {
    const ctx = this.ctx;
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter(f => f.life > 0);
    const terrain = this.game.terrain;
    const out = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vx *= Math.exp(-p.drag * dt); p.vy *= Math.exp(-p.drag * dt);
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'debris' && p.y > terrain.heightAt(p.x)) { p.y = terrain.heightAt(p.x); p.vx *= 0.3; p.vy *= -0.2; }
      out.push(p);
      const k = p.life / p.max;
      if (p.kind === 'smoke') {
        const s = p.size * (1.8 - k);
        ctx.fillStyle = `rgba(${p.col},${k * 0.35})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === 'spark') {
        ctx.strokeStyle = `rgba(${p.col},${k})`; ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${p.col},${Math.min(1, k * 2)})`;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    this.particles = out;
  }

  drawHud(dt) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    for (const t of this.texts) {
      t.life -= dt; t.y -= 22 * dt;
      const a = Math.min(1, t.life / t.max * 2);
      ctx.font = '800 15px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = `rgba(0,0,0,${a * 0.6})`; ctx.fillText(t.s, t.x + 1, t.y + 1);
      ctx.globalAlpha = a; ctx.fillStyle = t.col; ctx.fillText(t.s, t.x, t.y); ctx.globalAlpha = 1;
    }
    this.texts = this.texts.filter(t => t.life > 0);
  }
}

Renderer.SILENT = new Proxy({}, { get: () => () => {} });
