'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CircleFit = require('../js/circle-fit.js');
const CircleStats = require('../js/stats.js');

const TAU = Math.PI * 2;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    raw: map
  };
}

function loop({ cx = 400, cy = 300, r = 150, turns = 1.02, wobble = 0, reverse = false, n = 240 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = TAU * turns * (i / n);
    const rr = r * (1 + wobble * Math.sin(5 * a));
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), t: i * 5 });
  }
  return reverse ? pts.reverse() : pts;
}

function judge(opts) {
  const pts = loop(opts);
  return { res: CircleFit.analyze(pts), pts };
}

test('only connected circles are recorded', () => {
  const store = CircleStats.createStore({ storage: memoryStorage() });
  const closed = judge({ turns: 1.05 });
  const open = judge({ turns: 0.9 });
  assert.equal(closed.res.connected, true);
  assert.equal(open.res.ok, true);
  assert.equal(open.res.connected, false);

  assert.ok(store.add(closed.res, closed.pts, { input: 'mouse' }));
  assert.equal(store.add(open.res, open.pts, { input: 'mouse' }), null);
  assert.equal(store.add(CircleFit.analyze(loop({ turns: 0.5 })), [], {}), null); // rejected stroke
  assert.equal(store.count(), 1);
});

test('records keep the accuracy figures as percentages of the radius', () => {
  const store = CircleStats.createStore({ storage: memoryStorage() });
  const { res, pts } = judge({ wobble: 0.02, r: 180 });
  const rec = store.add(res, pts, { input: 'pen', at: 1700000000000 });
  assert.equal(rec.input, 'pen');
  assert.equal(rec.at, 1700000000000);
  assert.ok(Math.abs(rec.score - res.score) < 0.01);
  assert.ok(Math.abs(rec.wobble - res.relativeRms * 100) < 0.01);
  assert.ok(Math.abs(rec.radius - 180) < 1);
  assert.equal(rec.shape.length, 96);
  // Outline is scaled so the average radius is ~100.
  const r0 = Math.hypot(rec.shape[0], rec.shape[1]);
  assert.ok(r0 > 90 && r0 < 110, `outline radius ${r0}`);
});

test('summary averages, best, groups and histogram', () => {
  const store = CircleStats.createStore({ storage: memoryStorage() });
  const wobbles = [0, 0.01, 0.02, 0.04];
  const scores = [];
  wobbles.forEach((w, i) => {
    const { res, pts } = judge({ wobble: w, r: i < 2 ? 80 : 250, reverse: i % 2 === 1 });
    scores.push(res.score);
    store.add(res, pts, { input: i < 3 ? 'pen' : 'touch', at: 1000 + i });
  });
  const s = store.summary({ now: 5000 });
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  assert.equal(s.count, 4);
  assert.ok(Math.abs(s.average - avg) < 0.01);
  assert.ok(Math.abs(s.best - Math.max(...scores)) < 0.01);
  assert.equal(s.groups.input.find((g) => g.key === 'pen').count, 3);
  assert.equal(s.groups.input.find((g) => g.key === 'touch').count, 1);
  assert.equal(s.groups.dir.length, 2);
  assert.deepEqual(s.groups.size.map((g) => g.key), ['small', 'large']);
  assert.equal(s.histogram.reduce((a, h) => a + h.count, 0), 4);
  assert.equal(s.series.length, 4);
  assert.equal(s.series[3].n, 4);
  assert.ok(Math.abs(s.series[3].rolling - avg) < 0.01);
  assert.equal(s.last10.count, 4);
});

test('stats persist across reloads and can be cleared', () => {
  const storage = memoryStorage();
  const a = CircleStats.createStore({ storage });
  const { res, pts } = judge();
  a.add(res, pts, { input: 'mouse' });
  a.add(res, pts, { input: 'mouse' });

  const b = CircleStats.createStore({ storage });
  assert.equal(b.count(), 2);
  assert.ok(Math.abs(b.summary().average - res.score) < 0.01);

  b.clear();
  assert.equal(b.count(), 0);
  assert.equal(CircleStats.createStore({ storage }).count(), 0);
});

test('old records fold into an archive without changing all-time averages', () => {
  const store = CircleStats.createStore({ storage: memoryStorage(), maxRecords: 5, maxShapes: 2 });
  const scores = [];
  for (let i = 0; i < 12; i++) {
    const { res, pts } = judge({ wobble: (i % 4) * 0.01 });
    scores.push(res.score);
    store.add(res, pts, { input: 'mouse', at: i });
  }
  const s = store.summary();
  assert.equal(s.count, 12);
  assert.equal(s.stored, 5);
  assert.equal(s.archived, 7);
  assert.ok(Math.abs(s.average - scores.reduce((a, b) => a + b, 0) / 12) < 0.01);
  assert.equal(s.series[0].n, 8); // numbering continues after the archived circles
  assert.equal(store.records().filter((r) => r.shape).length, 2);
});

test('corrupt or foreign storage contents are ignored safely', () => {
  const storage = memoryStorage();
  storage.setItem(CircleStats.STORAGE_KEY, '{not json');
  assert.equal(CircleStats.createStore({ storage }).count(), 0);
  storage.setItem(CircleStats.STORAGE_KEY, JSON.stringify({ records: [{ score: 'x' }, null, { score: 50 }], archive: { count: 'lots' } }));
  const store = CircleStats.createStore({ storage });
  assert.equal(store.count(), 0);
  assert.equal(store.summary().count, 0);
});

test('storage that refuses writes keeps stats in memory', () => {
  const store = CircleStats.createStore({
    storage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} }
  });
  const { res, pts } = judge();
  store.add(res, pts, {});
  assert.equal(store.count(), 1);
  assert.equal(store.isPersistent(), false);
});

test('CSV and JSON exports', () => {
  const store = CircleStats.createStore({ storage: memoryStorage() });
  const { res, pts } = judge();
  store.add(res, pts, { input: 'pen', at: Date.UTC(2026, 0, 2) });
  const csv = store.toCSV().trim().split('\n');
  assert.equal(csv.length, 2);
  assert.ok(csv[0].startsWith('circle,date,score'));
  assert.ok(csv[1].startsWith('1,2026-01-02T00:00:00.000Z,'));
  const json = JSON.parse(store.toJSON());
  assert.equal(json.records.length, 1);
  assert.equal(json.records[0].shape, undefined);
  assert.equal(json.summary.score.count, 1);
  assert.equal(json.summary.bits.count, 1);
  assert.ok(json.records[0].bits > 5);
});

test('bits metric: averages, best, groups and histogram in bits', () => {
  const store = CircleStats.createStore({ storage: memoryStorage() });
  const bits = [];
  [0.004, 0.01, 0.02].forEach((w, i) => {
    const { res, pts } = judge({ wobble: w, reverse: i === 1 });
    bits.push(res.precision.bits);
    store.add(res, pts, { input: 'pen' });
  });
  const s = store.summary({ metric: 'bits' });
  assert.equal(s.metric, 'bits');
  assert.ok(Math.abs(s.average - bits.reduce((a, b) => a + b, 0) / 3) < 0.01);
  assert.ok(Math.abs(s.best - Math.max(...bits)) < 0.01);
  assert.equal(s.groups.input[0].count, 3);
  assert.ok(Math.abs(s.groups.input[0].average - s.average) < 1e-9);
  assert.equal(s.histogram[0].label, '<3');
  assert.equal(s.histogram.reduce((a, h) => a + h.count, 0), 3);
  assert.ok(Math.abs(s.series[2].value - bits[2]) < 0.01);
  // The score view of the same data is unaffected.
  assert.equal(store.summary({ metric: 'score' }).metric, 'score');
});

test('records saved before precision existed get bits from their wobble', () => {
  const storage = memoryStorage();
  storage.setItem(CircleStats.STORAGE_KEY, JSON.stringify({
    v: 1,
    records: [{ at: 1, score: 95, radius: 150, wobble: 1, miss: 2, spread: 4, oval: 1, sweep: 365, duration: 1000, input: 'mouse', dir: 'cw' }],
    archive: {
      count: 2, score: 180, scoreSq: 16200, best: 91, bestAt: 0, wobble: 4, miss: 6, spread: 10, oval: 2,
      duration: 2000, durationCount: 2, firstAt: 0,
      groups: { input: { mouse: { count: 2, score: 180, best: 91 } }, dir: { cw: { count: 2, score: 180, best: 91 } }, size: { medium: { count: 2, score: 180, best: 91 } } }
    }
  }));
  const store = CircleStats.createStore({ storage });
  const s = store.summary({ metric: 'bits' });
  assert.equal(s.count, 3);
  const fromOne = CircleStats.bitsFromWobble(1);  // record: 1% wobble
  const fromTwo = CircleStats.bitsFromWobble(2);  // archive: mean wobble 2%
  assert.ok(Math.abs(fromOne - Math.log2(100)) < 0.001);
  assert.ok(Math.abs(s.average - (fromOne + 2 * fromTwo) / 3) < 1e-9);
  assert.equal(store.summary().average, (95 + 180) / 3);
  assert.ok(store.toCSV().split('\n')[1].includes(',6.644,'));
});
