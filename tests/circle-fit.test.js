'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CircleFit = require('../js/circle-fit.js');

const TAU = Math.PI * 2;

// Deterministic pseudo-random numbers so tests are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function circle({ cx = 400, cy = 300, r = 150, turns = 1, n = 300, start = 0.3, noise = 0, seed = 1, warp } = {}) {
  const rand = rng(seed);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = start + TAU * turns * (warp ? warp(u) : u);
    const rr = r + (rand() * 2 - 1) * noise;
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), t: i * 4 });
  }
  return pts;
}

test('perfect circle scores ~100 and finds the true center', () => {
  const res = CircleFit.analyze(circle({ cx: 512, cy: 384, r: 200 }));
  assert.equal(res.ok, true);
  assert.ok(res.score > 99.5, `score ${res.score}`);
  assert.ok(Math.abs(res.center.x - 512) < 0.5);
  assert.ok(Math.abs(res.center.y - 384) < 0.5);
  assert.ok(Math.abs(res.radius - 200) < 0.5);
  assert.equal(res.closed, true);
});

test('center is located from the drawing, wherever it is drawn', () => {
  for (const [cx, cy, r] of [[50, 60, 40], [1500, 900, 320], [-200, 75, 90]]) {
    const res = CircleFit.analyze(circle({ cx, cy, r, noise: 2, seed: cx }));
    assert.equal(res.ok, true);
    assert.ok(Math.hypot(res.center.x - cx, res.center.y - cy) < 1.5, `center off for ${cx},${cy}`);
    assert.ok(Math.abs(res.radius - r) < 1.5);
  }
});

test('radius is the average distance from the located center', () => {
  const pts = circle({ r: 180, noise: 6, seed: 7 });
  const res = CircleFit.analyze(pts);
  const samples = CircleFit.resample(pts, res.sampleCount);
  const avg = samples.reduce((s, p) => s + Math.hypot(p.x - res.center.x, p.y - res.center.y), 0) / samples.length;
  assert.ok(Math.abs(avg - res.radius) < 1e-9);
});

test('uneven drawing speed does not bias the center', () => {
  // Points crowd together on one side (slow drawing) and spread out on the other.
  const pts = circle({ cx: 300, cy: 300, r: 120, n: 400, warp: (u) => u * u });
  const res = CircleFit.analyze(pts);
  assert.ok(Math.hypot(res.center.x - 300, res.center.y - 300) < 0.5);
  assert.ok(res.score > 99);
});

test('wobblier circles score lower', () => {
  const scores = [0, 2, 5, 10].map((noise) => CircleFit.analyze(circle({ r: 200, noise, seed: 3 })).score);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1], scores.join(', '));
});

test('an ellipse scores clearly worse than a circle', () => {
  const pts = [];
  for (let i = 0; i <= 400; i++) {
    const a = (i / 400) * TAU;
    pts.push({ x: 400 + 200 * Math.cos(a), y: 300 + 150 * Math.sin(a) });
  }
  const res = CircleFit.analyze(pts);
  assert.equal(res.ok, true);
  assert.ok(res.score < 60 && res.score > 20, `score ${res.score}`);
  assert.ok(Math.hypot(res.center.x - 400, res.center.y - 300) < 0.5);
  // Ovality is detected, with the long axis horizontal.
  assert.ok(res.oval.share > 0.9, `share ${res.oval.share}`);
  assert.ok(Math.abs(res.oval.aspect - 200 / 150) < 0.05, `aspect ${res.oval.aspect}`);
  assert.ok(Math.abs(Math.sin(res.oval.axisAngle)) < 0.05, `axis ${res.oval.axisAngle}`);
});

test('a tall oval reports a vertical long axis; a circle reports no ovality', () => {
  const pts = [];
  for (let i = 0; i <= 400; i++) {
    const a = (i / 400) * TAU;
    pts.push({ x: 400 + 140 * Math.cos(a), y: 300 + 160 * Math.sin(a) });
  }
  const tall = CircleFit.analyze(pts);
  assert.ok(Math.abs(Math.cos(tall.oval.axisAngle)) < 0.05, `axis ${tall.oval.axisAngle}`);
  const round = CircleFit.analyze(circle({ noise: 0 }));
  assert.ok(round.oval.aspect < 1.001);
});

test('a square scores poorly', () => {
  const corners = [[100, 100], [300, 100], [300, 300], [100, 300], [100, 100]];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 50; i++) {
      const t = i / 50;
      pts.push({
        x: corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t,
        y: corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t
      });
    }
  }
  pts.push({ x: 100, y: 100 });
  const res = CircleFit.analyze(pts);
  assert.equal(res.ok, true);
  assert.ok(res.score < 55, `score ${res.score}`);
  assert.ok(Math.hypot(res.center.x - 200, res.center.y - 200) < 1);
});

test('an unclosed loop is penalised, a half circle is rejected', () => {
  const full = CircleFit.analyze(circle({ turns: 1 }));
  const gap = CircleFit.analyze(circle({ turns: 0.9 }));
  assert.equal(gap.ok, true);
  assert.equal(gap.closed, false);
  assert.ok(Math.abs(gap.gapDegrees - 36) < 1);
  assert.ok(full.score - gap.score > 8, `${full.score} vs ${gap.score}`);

  const half = CircleFit.analyze(circle({ turns: 0.5 }));
  assert.equal(half.ok, false);
  assert.equal(half.reason, 'open');
});

test('overshooting a little is fine, multiple laps are rejected', () => {
  const over = CircleFit.analyze(circle({ turns: 1.1, noise: 1 }));
  assert.equal(over.ok, true);
  assert.ok(over.score > 97);
  const loops = CircleFit.analyze(circle({ turns: 2.2 }));
  assert.equal(loops.ok, false);
  assert.equal(loops.reason, 'loops');
});

test('connected: ends that meet or cross count, gaps and spirals do not', () => {
  assert.equal(CircleFit.analyze(circle({ turns: 1 })).connected, true);
  assert.equal(CircleFit.analyze(circle({ turns: 1.15, noise: 1 })).connected, true); // crosses its start
  assert.equal(CircleFit.analyze(circle({ turns: 0.997, r: 150 })).connected, true); // ~3 px short
  const gap = CircleFit.analyze(circle({ turns: 0.95, r: 150 }));
  assert.equal(gap.ok, true);
  assert.equal(gap.connected, false);
  assert.ok(gap.endGap > 40);

  // A spiral goes all the way round but its ends never meet.
  const spiral = [];
  for (let i = 0; i <= 300; i++) {
    const u = i / 300, a = TAU * 1.1 * u, r = 150 + 45 * u;
    spiral.push({ x: 400 + r * Math.cos(a), y: 300 + r * Math.sin(a) });
  }
  const s = CircleFit.analyze(spiral);
  assert.equal(s.ok, true);
  assert.equal(s.closed, true);
  assert.equal(s.connected, false);
});

test('precision: bits = log2(radius / RMS error), one bit per halving', () => {
  // Uniform noise of ±a has RMS a/√3.
  const bits = [8, 4, 2, 1].map((a) => CircleFit.analyze(circle({ r: 200, n: 2000, noise: a, seed: 11 })).precision.bits);
  for (let i = 1; i < bits.length; i++) {
    const gain = bits[i] - bits[i - 1];
    assert.ok(gain > 0.8 && gain < 1.2, `halving the noise gained ${gain.toFixed(2)} bits`);
  }
  const res = CircleFit.analyze(circle({ r: 200, noise: 2, seed: 4 }));
  const p = res.precision;
  assert.ok(Math.abs(p.bits - 0.5 * Math.log2(1 + (res.radius / p.sigma) ** 2)) < 1e-9);
  assert.ok(Math.abs(p.bits - Math.log2(p.ratio)) < 0.001);
  assert.ok(Math.abs(p.strokeRms - res.rms) < 1e-12);
});

test('precision: infinite slope at perfection, capped at double precision', () => {
  const { precisionBits, MAX_BITS } = CircleFit;
  assert.equal(precisionBits(100, 0), MAX_BITS);
  // Equal steps toward zero error buy ever more bits: the slope keeps growing.
  const slope = (s) => (precisionBits(100, s) - precisionBits(100, s * 1.001)) / (s * 0.001);
  assert.ok(slope(1e-3) > 1000 * slope(1));
  assert.ok(slope(1e-6) > 1000 * slope(1e-3));
  // It is the n → ∞ limit of an extreme exponent: n·(1 − x^(1/n)) → ln(1/x).
  const x = 0.01, n = 1e6;
  assert.ok(Math.abs(n * (1 - Math.pow(x, 1 / n)) / Math.LN2 - Math.log2(1 / x)) < 1e-3);
  assert.ok(precisionBits(100, 100) > 0 && precisionBits(100, 1e6) >= 0);
});

test('precision: gaps cost bits without any penalty constant', () => {
  const closed = CircleFit.analyze(circle({ turns: 1, noise: 2, seed: 2 })).precision.bits;
  const small = CircleFit.analyze(circle({ turns: 0.97, noise: 2, seed: 2 })).precision.bits;
  const big = CircleFit.analyze(circle({ turns: 0.85, noise: 2, seed: 2 })).precision.bits;
  assert.ok(closed > small && small > big, `${closed} > ${small} > ${big}`);
  const over = CircleFit.analyze(circle({ turns: 1.1, noise: 2, seed: 2 })).precision.bits;
  assert.ok(Math.abs(over - closed) < 0.3, 'overshooting is not penalised');
});

test('direction of drawing does not matter', () => {
  const cw = CircleFit.analyze(circle({ noise: 3, seed: 9 }));
  const ccw = CircleFit.analyze(circle({ noise: 3, seed: 9 }).reverse());
  assert.equal(cw.direction, -ccw.direction);
  assert.ok(Math.abs(cw.score - ccw.score) < 0.5);
});

test('tiny circles, straight lines and taps are rejected', () => {
  assert.equal(CircleFit.analyze(circle({ r: 8 })).reason, 'small');
  const line = Array.from({ length: 60 }, (_, i) => ({ x: 10 + i * 5, y: 50 + i * 0.01 * i }));
  assert.equal(CircleFit.analyze(line).ok, false);
  assert.equal(CircleFit.analyze([{ x: 1, y: 1 }, { x: 2, y: 2 }]).reason, 'short');
  assert.equal(CircleFit.analyze([]).reason, 'short');
});

test('resample produces evenly spaced points that keep both ends', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }];
  const out = CircleFit.resample(pts, 41);
  assert.equal(out.length, 41);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[40], { x: 10, y: 30 });
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
    assert.ok(Math.abs(d - 1) < 1e-6 || (i === 10 && d < 1.0001), `gap ${d} at ${i}`);
  }
});
