// ---------------------------------------------------------------------------
// Procedural sound effects (Web Audio) - no audio files needed
// ---------------------------------------------------------------------------
const Sfx = (() => {
  let ac = null, master = null, noiseBuf = null, muted = false;

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.55;
    const comp = ac.createDynamicsCompressor();
    master.connect(comp); comp.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function noise(dur, freq, q, gain, endFreq) {
    const t = ac.currentTime;
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(endFreq || 60, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur);
  }

  function tone(type, f0, f1, dur, gain, delay = 0) {
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  const play = (fn) => { if (ac && !muted) try { fn(); } catch (e) { /* ignore */ } };

  return {
    init,
    get muted() { return muted; },
    toggle() { muted = !muted; return muted; },
    fire: () => play(() => { noise(0.35, 2400, 1, 0.5, 200); tone('sine', 140, 40, 0.3, 0.6); }),
    explode: (r) => play(() => {
      const big = Math.min(1, r / 115);
      noise(0.6 + big * 2.2, 1400 - big * 600, 0.7, 0.9, 40);
      tone('sine', 90 - big * 40, 25, 0.5 + big * 1.5, 0.9);
    }),
    dirt: () => play(() => noise(0.5, 600, 0.5, 0.5, 80)),
    hit: () => play(() => { tone('square', 420, 180, 0.12, 0.12); tone('triangle', 900, 300, 0.1, 0.08, 0.02); }),
    split: () => play(() => { for (let i = 0; i < 4; i++) tone('triangle', 1200 - i * 150, 600, 0.08, 0.08, i * 0.04); }),
    bounce: () => play(() => tone('sine', 300, 600, 0.15, 0.2)),
    land: () => play(() => noise(0.25, 500, 0.6, 0.35, 60)),
    click: () => play(() => tone('triangle', 900, 700, 0.05, 0.06)),
    buy: () => play(() => { tone('triangle', 660, 660, 0.08, 0.1); tone('triangle', 990, 990, 0.1, 0.1, 0.07); }),
    turn: () => play(() => tone('sine', 520, 780, 0.12, 0.07)),
    win: () => play(() => [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.25, 0.12, i * 0.12))),
  };
})();
