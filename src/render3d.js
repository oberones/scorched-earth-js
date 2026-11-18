// ---------------------------------------------------------------------------
// Tiny flat-shaded 3D mesh renderer for Canvas2D. Draws the low-poly models from
// models.js (exported from the Blender/tank_spec pipeline) with a fixed 3/4 view,
// directional light, specular for metals, back-face culling and depth sorting.
// ---------------------------------------------------------------------------
const Mesh3D = (() => {
  const YAW = 0.24, PITCH = 0.3;
  const cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  const L = (() => { const v = [-0.45, 0.78, 0.5], l = Math.hypot(...v); return v.map(c => c / l); })();
  const Hh = (() => { const v = [L[0], L[1], L[2] + 1], l = Math.hypot(...v); return v.map(c => c / l); })();
  const SPEC = { metal: 0.55, gunmetal: 0.7, accent: 0.35, body: 0.12, bodyDark: 0.08 };
  const cache = {};

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function model(name) {
    if (cache[name]) return cache[name];
    const parts = MODELS[name].map(p => ({
      name: p.name, mat: p.mat, pivot: p.pivot, v: Float32Array.from(p.v), f: p.f,
      out: new Float32Array(p.v.length),
    }));
    return (cache[name] = parts);
  }

  // opts: { scale, roll (rad, model about Z), barrel (rad, local), colors: {mat: [r,g,b]}, alpha, flip }
  function draw(ctx, name, x, y, opts) {
    const parts = model(name);
    const s = opts.scale, roll = opts.roll || 0, cr = Math.cos(roll), sr = Math.sin(roll);
    const cb = Math.cos(opts.barrel || 0), sb = Math.sin(opts.barrel || 0);
    const faces = [];
    for (const p of parts) {
      const v = p.v, o = p.out;
      for (let i = 0; i < v.length; i += 3) {
        let px = v[i], py = v[i + 1], pz = v[i + 2];
        if (opts.flip) { px = -px; pz = -pz; }        // face left without mirroring winding
        if (p.pivot) {                                // jointed barrel
          const bx = px * cb - py * sb, by = px * sb + py * cb;
          px = bx + p.pivot[0]; py = by + p.pivot[1]; pz += p.pivot[2];
        }
        const rx = px * cr - py * sr, ry = px * sr + py * cr;          // roll (ground tilt)
        const yx = rx * cy + pz * sy, yz = -rx * sy + pz * cy;        // yaw
        o[i] = yx; o[i + 1] = ry * cp - yz * sp; o[i + 2] = ry * sp + yz * cp; // pitch
      }
      const base = (opts.colors && opts.colors[p.mat]) || MODEL_MATERIALS[p.mat];
      for (const f of p.f) {
        // Newell normal in view space
        let nx = 0, ny = 0, nz = 0, zsum = 0;
        for (let k = 0; k < f.length; k++) {
          const a = f[k] * 3, b = f[(k + 1) % f.length] * 3;
          nx += (o[a + 1] - o[b + 1]) * (o[a + 2] + o[b + 2]);
          ny += (o[a + 2] - o[b + 2]) * (o[a] + o[b]);
          nz += (o[a] - o[b]) * (o[a + 1] + o[b + 1]);
          zsum += o[a + 2];
        }
        if (nz <= 0) continue;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const spec = Math.pow(Math.max(0, nx * Hh[0] + ny * Hh[1] + nz * Hh[2]), 24) * (SPEC[p.mat] || 0);
        const lit = p.mat === 'glow' ? 1.2 : 0.36 + 0.7 * diff;
        const r = Math.min(255, base[0] * lit + 255 * spec), g = Math.min(255, base[1] * lit + 255 * spec),
              bl = Math.min(255, base[2] * lit + 255 * spec);
        const pts = new Array(f.length * 2);
        for (let k = 0; k < f.length; k++) {
          pts[k * 2] = x + o[f[k] * 3] * s;
          pts[k * 2 + 1] = y - o[f[k] * 3 + 1] * s;
        }
        faces.push({ z: zsum / f.length, pts, col: `rgb(${r | 0},${g | 0},${bl | 0})` });
      }
    }
    faces.sort((a, b) => a.z - b.z);
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.6;
    for (const fc of faces) {
      const p = fc.pts;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
      ctx.closePath();
      ctx.fillStyle = fc.col;
      ctx.strokeStyle = fc.col;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function teamColors(hex, dead) {
    if (dead) return { body: [52, 44, 40], bodyDark: [36, 30, 28], accent: [70, 60, 50], metal: [60, 58, 56], gunmetal: [40, 38, 36], track: [24, 22, 22] };
    const c = hexToRgb(hex);
    return { body: c, bodyDark: c.map(v => v * 0.62) };
  }

  return { draw, teamColors, hexToRgb, YAW, PITCH };
})();
