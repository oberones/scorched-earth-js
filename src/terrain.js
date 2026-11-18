// ---------------------------------------------------------------------------
// Seeded RNG + destructible heightmap terrain
// ---------------------------------------------------------------------------
class RNG {
  constructor(seed = Date.now()) { this.s = (seed >>> 0) || 1; }
  next() { // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  gauss() { // Box-Muller
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// Heightmap terrain: ground[x] is the screen-space y of the surface in column x
// (y grows downward). Blasts remove a disc of dirt; dirt above a blast collapses
// down into the hole, like the original game's falling soil.
class Terrain {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.ground = new Float32Array(width);
    this.version = 0; // bumped on every change so the renderer can cache
  }

  generate(rng, style = 'hills') {
    const { w, h } = this;
    const base = h * rng.range(0.55, 0.7);
    const amp = style === 'mountains' ? h * 0.26 : style === 'flat' ? h * 0.05 : h * 0.15;
    // sum of random sines + midpoint-displacement-style roughness
    const waves = [];
    for (let i = 0; i < 5; i++) {
      waves.push({ f: rng.range(0.6, 1.4) * (i + 1) * Math.PI * 2 / w, p: rng.range(0, Math.PI * 2), a: amp / (i + 1) ** 1.1 });
    }
    let rough = 0;
    for (let x = 0; x < w; x++) {
      let y = base;
      for (const wv of waves) y -= Math.sin(x * wv.f + wv.p) * wv.a;
      rough += rng.range(-1, 1) * 0.6; rough *= 0.97;
      this.ground[x] = Math.max(h * 0.22, Math.min(h - 30, y + rough));
    }
    this.smooth(2);
    this.version++;
  }

  smooth(passes) {
    const g = this.ground, w = this.w;
    for (let p = 0; p < passes; p++) {
      let prev = g[0];
      for (let x = 1; x < w - 1; x++) {
        const cur = g[x];
        g[x] = (prev + cur * 2 + g[x + 1]) / 4;
        prev = cur;
      }
    }
  }

  heightAt(x) {
    const xi = Math.max(0, Math.min(this.w - 1, Math.floor(x)));
    const xj = Math.min(this.w - 1, xi + 1);
    const t = Math.max(0, Math.min(1, x - xi));
    return this.ground[xi] * (1 - t) + this.ground[xj] * t;
  }

  // slope angle (radians) under a tank of given half width; positive = right side higher
  slopeAt(x, half = 12) {
    return Math.atan2(this.heightAt(x - half) - this.heightAt(x + half), half * 2);
  }

  isSolid(x, y) {
    if (x < 0 || x >= this.w) return false;
    return y >= this.heightAt(x);
  }

  // Remove a disc of dirt. Returns the number of dirt "pixels" removed.
  crater(cx, cy, r) {
    let removed = 0;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const half = Math.sqrt(Math.max(0, r * r - dx * dx));
      const top = cy - half, bot = cy + half;
      const g = this.ground[x];
      if (g >= bot) continue;                       // surface below the disc
      const overlap = bot - Math.max(g, top);       // dirt inside the disc
      if (overlap <= 0) continue;
      this.ground[x] = Math.min(this.h, g + overlap); // soil above collapses into hole
      removed += overlap;
    }
    if (removed > 0) this.version++;
    return removed;
  }

  // Drop a ball of dirt; it lands as a mound on the surface.
  addDirt(cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const chord = 2 * Math.sqrt(Math.max(0, r * r - dx * dx));
      this.ground[x] = Math.max(8, this.ground[x] - chord * 0.85);
    }
    this.version++;
  }

  // Level a small pad (used when placing tanks)
  flatten(cx, half) {
    const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(this.w - 1, Math.ceil(cx + half));
    let sum = 0;
    for (let x = x0; x <= x1; x++) sum += this.ground[x];
    const y = sum / (x1 - x0 + 1);
    for (let x = x0; x <= x1; x++) this.ground[x] = y;
    // blend edges
    for (let k = 1; k <= 10; k++) {
      const t = k / 11;
      if (x0 - k >= 0) this.ground[x0 - k] = y * (1 - t) + this.ground[x0 - k] * t;
      if (x1 + k < this.w) this.ground[x1 + k] = y * (1 - t) + this.ground[x1 + k] * t;
    }
    this.version++;
  }
}
