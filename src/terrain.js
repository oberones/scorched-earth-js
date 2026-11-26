// ---------------------------------------------------------------------------
// Seeded RNG and destructible terrain columns with underground cavities
// ---------------------------------------------------------------------------
class RNG {
  constructor(seed = Date.now()) { this.s = (seed >>> 0) || 1; }
  next() { // mulberry32
    let t = this.s = (this.s + 0x6d2b79f5) >>> 0;
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

const TERRAIN_PROFILES = {
  flat:      { amplitude: 0.06,  waves: 5, ridges: 1, ridgeAmplitude: 0.08, roughness: 0.4 },
  hills:     { amplitude: 0.18,  waves: 6, ridges: 2, ridgeAmplitude: 0.12, roughness: 0.7 },
  mountains: { amplitude: 0.275, waves: 7, ridges: 3, ridgeAmplitude: 0.08, roughness: 0.9 },
};

// Heightmap terrain: ground[x] is the screen-space y of the surface in column x
// (y grows downward). Blasts remove a disc of dirt; dirt above a blast collapses
// down into the hole, like the original game's falling soil.
class Terrain {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.ground = new Float32Array(width);
    this.holes = new Map(); // column -> sorted, nonoverlapping underground air intervals
    this.revisions = new Float64Array(width);
    this.version = 0; // bumped on every change so the renderer can cache
  }

  generate(rng, style = 'hills') {
    const { w, h } = this;
    const profile = TERRAIN_PROFILES[style] || TERRAIN_PROFILES.hills;
    const base = h * rng.range(0.55, 0.7);
    const amp = h * profile.amplitude;
    // Broad waves establish the skyline; folded sine waves add sharper ridges.
    const waves = [], ridges = [];
    for (let i = 0; i < profile.waves; i++) {
      waves.push({
        f: rng.range(0.65, 1.55) * (i + 1) * Math.PI * 2 / w,
        p: rng.range(0, Math.PI * 2),
        a: amp / (i + 1) ** 1.02,
      });
    }
    for (let i = 0; i < profile.ridges; i++) {
      ridges.push({
        f: rng.range(2.2, 4.2) * (i + 1) * Math.PI * 2 / w,
        p: rng.range(0, Math.PI * 2),
        a: amp * profile.ridgeAmplitude / (i + 1) ** 0.8,
      });
    }
    let rough = 0;
    for (let x = 0; x < w; x++) {
      let y = base;
      for (const wv of waves) y -= Math.sin(x * wv.f + wv.p) * wv.a;
      for (const ridge of ridges) {
        y -= (1 - 2 * Math.abs(Math.sin(x * ridge.f + ridge.p))) * ridge.a;
      }
      rough += rng.range(-1, 1) * profile.roughness; rough *= 0.968;
      this.ground[x] = Math.max(h * 0.2, Math.min(h - 36, y + rough));
    }
    this.holes.clear();
    this.smooth(1);
    this.touch(0, w - 1);
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
  slopeAt(x, half = 12, y) {
    return Math.atan2(this.support(x - half, y) - this.support(x + half, y), half * 2);
  }

  isSolid(x, y) {
    if (x < 0 || x >= this.w) return false;
    if (y < this.heightAt(x)) return false;
    const holes = this.holes.get(Math.floor(x));
    return !holes || !holes.some(([top, bottom]) => y >= top && y < bottom);
  }

  support(x, y) {
    const surface = this.heightAt(x);
    const holes = this.holes.get(Math.floor(x));
    const hole = holes && holes.find(([top, bottom]) => y >= top && y <= bottom + 0.5);
    return hole ? hole[1] : surface;
  }

  touch(left, right) {
    this.revisions.fill(++this.version, Math.max(0, Math.floor(left)), Math.min(this.w, Math.ceil(right) + 1));
  }

  carveColumn(x, top, bottom) {
    top = Math.max(this.ground[x], top);
    bottom = Math.min(this.h, bottom);
    if (bottom <= top) return;
    const merged = [];
    for (const interval of this.holes.get(x) || []) {
      if (interval[1] < top || interval[0] > bottom) merged.push(interval);
      else { top = Math.min(top, interval[0]); bottom = Math.max(bottom, interval[1]); }
    }
    if (top <= this.ground[x]) this.ground[x] = bottom;
    else merged.push([top, bottom]);
    if (merged.length) this.holes.set(x, merged.sort((a, b) => a[0] - b[0]));
    else this.holes.delete(x);
  }

  crater(cx, cy, r, suspended = false) {
    const left = Math.max(0, Math.floor(cx - r)), right = Math.min(this.w - 1, Math.ceil(cx + r));
    let removed = 0;
    for (let x = left; x <= right; x++) {
      const half = Math.sqrt(Math.max(0, r * r - (x - cx) ** 2));
      const overlap = Math.min(this.h, cy + half) - Math.max(cy - half, this.ground[x]);
      if (overlap <= 0) continue;
      this.carveColumn(x, cy - half, cy + half);
      if (!suspended) this.collapseColumn(x);
      removed += overlap;
    }
    if (removed) this.touch(left, right);
    return removed;
  }

  collapseColumn(x) {
    for (const [top, bottom] of this.holes.get(x) || []) this.ground[x] += bottom - top;
    this.holes.delete(x);
  }

  collapse() {
    for (const x of this.holes.keys()) { this.collapseColumn(x); this.touch(x, x); }
  }

  // A revision describes only the modified contiguous runs of columns.
  changes(since) {
    const runs = [];
    for (let x = 0; x < this.w;) {
      if (this.revisions[x] <= since) { x++; continue; }
      const start = x, heights = [], holes = [];
      while (x < this.w && this.revisions[x] > since) {
        heights.push(Math.round(this.ground[x] * 8));
        if (this.holes.has(x)) holes.push([x, this.holes.get(x)]);
        x++;
      }
      runs.push({ start, heights, holes });
    }
    return { version: this.version, runs };
  }

  applyChanges(update) {
    for (const { start, heights, holes } of update.runs) {
      heights.forEach((value, i) => { this.ground[start + i] = value / 8; this.holes.delete(start + i); });
      for (const [x, intervals] of holes) this.holes.set(x, intervals);
    }
    this.version = update.version;
  }

  // Fill neighboring low points a layer at a time, yielding a level pool.
  pool(cx, width, volume, deposit) {
    const left = Math.max(0, Math.round(cx - width)), right = Math.min(this.w - 1, Math.round(cx + width));
    if (left > right) return [];
    const depths = new Float32Array(right - left + 1);
    for (let n = 0; n < volume; n++) {
      let x = Math.max(left, Math.min(right, Math.round(cx)));
      const level = i => this.ground[i] - depths[i - left];
      while (x > left && level(x - 1) > level(x)) x--;
      while (x < right && level(x + 1) > level(x)) x++;
      depths[x - left]++;
    }
    const pools = [];
    for (let x = left; x <= right; x++) {
      const depth = depths[x - left];
      if (!depth) continue;
      pools.push({ x, y: this.ground[x] - depth, depth });
      if (deposit) this.ground[x] = Math.max(0, this.ground[x] - depth);
    }
    if (deposit) this.touch(left, right);
    return pools;
  }

  // Drop a ball of dirt; it lands as a mound on the surface.
  addDirt(cx, cy, r, suspended = false) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const chord = 2 * Math.sqrt(Math.max(0, r * r - dx * dx));
      const top = Math.max(0, cy - chord / 2), bottom = Math.min(this.h, cy + chord / 2);
      if (suspended) {
        if (bottom <= top) continue;
        const gaps = [];
        if (bottom < this.ground[x]) gaps.push([bottom, this.ground[x]]);
        for (const [a, b] of this.holes.get(x) || []) {
          if (a < top) gaps.push([a, Math.min(b, top)]);
          if (b > bottom) gaps.push([Math.max(a, bottom), b]);
        }
        this.ground[x] = Math.min(top, this.ground[x]);
        if (gaps.length) this.holes.set(x, gaps); else this.holes.delete(x);
      } else this.ground[x] = Math.max(8, this.ground[x] - chord * 0.85);
    }
    this.touch(x0, x1);
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
    this.touch(x0 - 10, x1 + 10);
  }
}
