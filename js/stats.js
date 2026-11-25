/*
 * stats.js — keeps a record of every closed ("connected") circle and works out
 * accuracy averages from them, for either scoring mode:
 *
 *   - "score": the classic 0–100% score
 *   - "bits":  precision in bits, ½·log₂(1 + r̄²/σ²)
 *
 * Averaging bits averages logarithms, so the average precision is the
 * precision of the geometric-mean wobble.
 *
 * Records live in the browser's localStorage, so they stay on this device and
 * survive reloads. Each record is a few hundred bytes; the newest MAX_SHAPES
 * also keep a small outline for the history thumbnails. If more than
 * MAX_RECORDS pile up, the oldest are folded into a running "archive" total so
 * the all-time averages stay exact.
 *
 * Works in the browser (window.CircleStats) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./circle-fit.js'));
  } else {
    root.CircleStats = factory(root.CircleFit);
  }
})(typeof self !== 'undefined' ? self : this, function (CircleFit) {
  'use strict';

  var STORAGE_KEY = 'circle-judge:stats:v1';
  var MAX_RECORDS = 5000;
  var MAX_SHAPES = 120;
  var SHAPE_POINTS = 48;
  var ROLLING_WINDOW = 10;
  var MAX_BITS = (CircleFit && CircleFit.MAX_BITS) || 52;
  var METRICS = ['score', 'bits'];

  var GROUPS = {
    input: [
      ['pen', 'Apple Pencil / pen'],
      ['touch', 'Finger'],
      ['mouse', 'Mouse / trackpad'],
      ['other', 'Other']
    ],
    dir: [
      ['cw', 'Clockwise'],
      ['ccw', 'Counter-clockwise']
    ],
    size: [
      ['small', 'Small (radius under 100 px)'],
      ['medium', 'Medium (100–200 px)'],
      ['large', 'Large (200 px or more)']
    ]
  };

  // Histogram bins per metric: [from, to, label].
  var BINS = { score: [[-Infinity, 50, '<50']], bits: [[-Infinity, 3, '<3']] };
  for (var b = 50; b < 100; b += 5) BINS.score.push([b, b + 5, String(b)]);
  BINS.score[BINS.score.length - 1][1] = Infinity; // 95 includes 100
  for (var h = 3; h < 9; h += 0.5) BINS.bits.push([h, h + 0.5, String(h)]);
  BINS.bits.push([9, Infinity, '9+']);

  function round(v, places) {
    var f = Math.pow(10, places);
    return Math.round(v * f) / f;
  }

  function sizeOf(radius) {
    return radius < 100 ? 'small' : radius < 200 ? 'medium' : 'large';
  }

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Precision of an older record that predates bits, from its stroke → circle wobble (%). */
  function bitsFromWobble(wobblePct) {
    if (!(wobblePct > 0)) return MAX_BITS;
    var ratio = 100 / wobblePct;
    return Math.min(MAX_BITS, 0.5 * Math.log2(1 + ratio * ratio));
  }

  function metricOf(rec, metric) {
    if (metric === 'bits') return typeof rec.bits === 'number' && isFinite(rec.bits) ? rec.bits : bitsFromWobble(rec.wobble);
    return rec.score;
  }

  /** Outline relative to the located center, scaled so the average radius is 100. */
  function makeShape(result, points) {
    if (!CircleFit || !points || points.length < 2) return null;
    var pts = CircleFit.resample(points, SHAPE_POINTS);
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      out.push(Math.round((pts[i].x - result.center.x) / result.radius * 100));
      out.push(Math.round((pts[i].y - result.center.y) / result.radius * 100));
    }
    return out;
  }

  /** Turn an analysis result into a compact record. Percentages are of the average radius. */
  function makeRecord(result, points, meta) {
    meta = meta || {};
    var input = meta.input === 'pen' || meta.input === 'touch' || meta.input === 'mouse' ? meta.input : 'other';
    var rec = {
      at: meta.at || Date.now(),
      score: round(result.score, 2),
      bits: round(result.precision ? result.precision.bits : bitsFromWobble(result.relativeRms * 100), 3),
      radius: round(result.radius, 1),
      wobble: round(result.relativeRms * 100, 2),
      miss: round(Math.abs(result.maxDeviation) / result.radius * 100, 2),
      spread: round(result.peakToValley / result.radius * 100, 2),
      oval: round(((result.oval && result.oval.aspect) || 1) * 100 - 100, 2),
      sweep: Math.round(result.sweptDegrees),
      duration: result.duration == null ? null : Math.round(result.duration),
      input: input,
      dir: result.direction >= 0 ? 'cw' : 'ccw'
    };
    var shape = makeShape(result, points);
    if (shape) rec.shape = shape;
    return rec;
  }

  // ---------- Aggregates ----------

  function emptyMetric() { return { sum: 0, sq: 0, best: null, bestAt: null }; }

  function emptyGroup() {
    return { count: 0, m: { score: { sum: 0, best: null }, bits: { sum: 0, best: null } } };
  }

  function emptyAggregate() {
    return {
      count: 0,
      m: { score: emptyMetric(), bits: emptyMetric() },
      wobble: 0, miss: 0, spread: 0, oval: 0,
      duration: 0, durationCount: 0,
      firstAt: null,
      groups: { input: {}, dir: {}, size: {} }
    };
  }

  function better(a, b) { return a != null && (b == null || a > b); }

  function addToGroup(groups, kind, key, rec) {
    var g = groups[kind][key] || (groups[kind][key] = emptyGroup());
    g.count++;
    METRICS.forEach(function (metric) {
      var v = metricOf(rec, metric);
      g.m[metric].sum += v;
      if (better(v, g.m[metric].best)) g.m[metric].best = v;
    });
  }

  function accumulate(agg, rec) {
    agg.count++;
    METRICS.forEach(function (metric) {
      var v = metricOf(rec, metric), m = agg.m[metric];
      m.sum += v;
      m.sq += v * v;
      if (better(v, m.best)) { m.best = v; m.bestAt = rec.at; }
    });
    agg.wobble += rec.wobble;
    agg.miss += rec.miss;
    agg.spread += rec.spread;
    agg.oval += rec.oval;
    if (rec.duration != null) { agg.duration += rec.duration; agg.durationCount++; }
    if (agg.firstAt == null || rec.at < agg.firstAt) agg.firstAt = rec.at;
    addToGroup(agg.groups, 'input', rec.input, rec);
    addToGroup(agg.groups, 'dir', rec.dir, rec);
    addToGroup(agg.groups, 'size', sizeOf(rec.radius), rec);
    return agg;
  }

  function mergeAggregate(into, from) {
    if (!from || !from.count) return into;
    into.count += from.count;
    METRICS.forEach(function (metric) {
      var a = into.m[metric], f = from.m[metric];
      a.sum += f.sum;
      a.sq += f.sq;
      if (better(f.best, a.best)) { a.best = f.best; a.bestAt = f.bestAt; }
    });
    into.wobble += from.wobble;
    into.miss += from.miss;
    into.spread += from.spread;
    into.oval += from.oval;
    into.duration += from.duration;
    into.durationCount += from.durationCount;
    if (from.firstAt != null && (into.firstAt == null || from.firstAt < into.firstAt)) into.firstAt = from.firstAt;
    ['input', 'dir', 'size'].forEach(function (kind) {
      var groups = from.groups[kind] || {};
      for (var key in groups) {
        var g = into.groups[kind][key] || (into.groups[kind][key] = emptyGroup());
        g.count += groups[key].count;
        METRICS.forEach(function (metric) {
          g.m[metric].sum += groups[key].m[metric].sum;
          if (better(groups[key].m[metric].best, g.m[metric].best)) g.m[metric].best = groups[key].m[metric].best;
        });
      }
    });
    return into;
  }

  function mean(list, metric) {
    if (!list.length) return null;
    var s = 0;
    for (var i = 0; i < list.length; i++) s += metricOf(list[i], metric);
    return s / list.length;
  }

  /**
   * All the averages the stats panel shows, from the records plus any archived
   * total. options: { metric: 'score' | 'bits', now: ms }.
   */
  function summarize(data, options) {
    options = options || {};
    var metric = options.metric === 'bits' ? 'bits' : 'score';
    var now = options.now || Date.now();
    var records = data.records;
    var agg = mergeAggregate(emptyAggregate(), data.archive);
    records.forEach(function (r) { accumulate(agg, r); });
    var n = agg.count;
    if (!n) return { count: 0, metric: metric };

    var m = agg.m[metric];
    var average = m.sum / n;
    var variance = Math.max(0, m.sq / n - average * average);

    var last10 = records.slice(-ROLLING_WINDOW);
    var today = startOfDay(now);
    var todays = records.filter(function (r) { return r.at >= today; });

    var groups = {};
    Object.keys(GROUPS).forEach(function (kind) {
      groups[kind] = GROUPS[kind].map(function (entry) {
        var g = agg.groups[kind][entry[0]];
        return {
          key: entry[0],
          label: entry[1],
          count: g ? g.count : 0,
          average: g && g.count ? g.m[metric].sum / g.count : null,
          best: g ? g.m[metric].best : null
        };
      }).filter(function (g) { return g.count > 0; });
    });

    var histogram = BINS[metric].map(function (bin) {
      return { from: bin[0], to: bin[1], label: bin[2], count: 0 };
    });
    records.forEach(function (r) {
      var v = metricOf(r, metric);
      for (var i = 0; i < histogram.length; i++) {
        if (v < histogram[i].to) { histogram[i].count++; break; }
      }
    });

    var archived = data.archive ? data.archive.count : 0;
    var series = [];
    var windowSum = 0;
    for (var i = 0; i < records.length; i++) {
      var v = metricOf(records[i], metric);
      windowSum += v;
      if (i >= ROLLING_WINDOW) windowSum -= metricOf(records[i - ROLLING_WINDOW], metric);
      series.push({ n: archived + i + 1, at: records[i].at, value: v, rolling: windowSum / Math.min(i + 1, ROLLING_WINDOW) });
    }

    return {
      metric: metric,
      count: n,
      stored: records.length,
      archived: archived,
      average: average,
      stdev: Math.sqrt(variance),
      best: m.best,
      bestAt: m.bestAt,
      firstAt: agg.firstAt,
      lastAt: records.length ? records[records.length - 1].at : null,
      wobble: agg.wobble / n,
      miss: agg.miss / n,
      spread: agg.spread / n,
      oval: agg.oval / n,
      duration: agg.durationCount ? agg.duration / agg.durationCount : null,
      last10: { count: last10.length, average: mean(last10, metric) },
      today: { count: todays.length, average: mean(todays, metric) },
      groups: groups,
      histogram: histogram,
      series: series,
      rollingWindow: ROLLING_WINDOW
    };
  }

  // ---------- Storage ----------

  function emptyData() {
    return { v: 1, records: [], archive: null };
  }

  var NUMERIC_FIELDS = ['at', 'score', 'radius', 'wobble', 'miss', 'spread', 'oval'];
  var ARCHIVE_FIELDS = ['count', 'wobble', 'miss', 'spread', 'oval', 'duration', 'durationCount'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function allFinite(obj, fields) {
    for (var i = 0; i < fields.length; i++) if (!isNum(obj[fields[i]])) return false;
    return true;
  }

  function isRecord(r) {
    return !!r && typeof r === 'object' && allFinite(r, NUMERIC_FIELDS) &&
      (r.dir === 'cw' || r.dir === 'ccw') && typeof r.input === 'string';
  }

  /**
   * Validate an archived total. Archives written before precision existed hold
   * score totals only; their bits totals are estimated from the mean wobble.
   */
  function readArchive(a) {
    if (!a || typeof a !== 'object' || !allFinite(a, ARCHIVE_FIELDS) || !(a.count > 0) || !a.groups) return null;
    var out = emptyAggregate();
    ['count', 'wobble', 'miss', 'spread', 'oval', 'duration', 'durationCount'].forEach(function (k) { out[k] = a[k]; });
    out.firstAt = isNum(a.firstAt) ? a.firstAt : null;
    var estBits = bitsFromWobble(a.wobble / a.count);
    if (a.m && a.m.score && a.m.bits) {
      METRICS.forEach(function (metric) {
        var f = a.m[metric];
        if (!isNum(f.sum) || !isNum(f.sq)) return;
        out.m[metric] = { sum: f.sum, sq: f.sq, best: isNum(f.best) ? f.best : null, bestAt: isNum(f.bestAt) ? f.bestAt : null };
      });
    } else if (isNum(a.score) && isNum(a.scoreSq)) {
      out.m.score = { sum: a.score, sq: a.scoreSq, best: isNum(a.best) ? a.best : null, bestAt: isNum(a.bestAt) ? a.bestAt : null };
      out.m.bits = { sum: estBits * a.count, sq: estBits * estBits * a.count, best: null, bestAt: null };
    } else {
      return null;
    }
    ['input', 'dir', 'size'].forEach(function (kind) {
      var groups = a.groups[kind] || {};
      for (var key in groups) {
        var g = groups[key];
        if (!g || !(g.count > 0)) continue;
        var ng = emptyGroup();
        ng.count = g.count;
        if (g.m && g.m.score && g.m.bits) {
          METRICS.forEach(function (metric) {
            ng.m[metric].sum = isNum(g.m[metric].sum) ? g.m[metric].sum : 0;
            ng.m[metric].best = isNum(g.m[metric].best) ? g.m[metric].best : null;
          });
        } else {
          ng.m.score.sum = isNum(g.score) ? g.score : 0;
          ng.m.score.best = isNum(g.best) ? g.best : null;
          ng.m.bits.sum = estBits * g.count;
        }
        out.groups[kind][key] = ng;
      }
    });
    return out;
  }

  function parse(text) {
    try {
      var d = JSON.parse(text);
      if (!d || !Array.isArray(d.records)) return emptyData();
      return { v: 1, records: d.records.filter(isRecord), archive: readArchive(d.archive) };
    } catch (e) {
      return emptyData();
    }
  }

  function defaultStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }

  /**
   * Create a store. `options.storage` is anything with getItem/setItem/removeItem
   * (defaults to localStorage); without one, stats are kept in memory only.
   */
  function createStore(options) {
    options = options || {};
    var storage = options.storage !== undefined ? options.storage : defaultStorage();
    var key = options.key || STORAGE_KEY;
    var maxRecords = options.maxRecords || MAX_RECORDS;
    var maxShapes = options.maxShapes == null ? MAX_SHAPES : options.maxShapes;
    var data = load();
    var persistent = !!storage;

    function load() {
      if (!storage) return emptyData();
      try {
        var text = storage.getItem(key);
        return text ? parse(text) : emptyData();
      } catch (e) {
        return emptyData();
      }
    }

    function foldOldest(count) {
      var old = data.records.splice(0, count);
      var agg = data.archive ? mergeAggregate(emptyAggregate(), data.archive) : emptyAggregate();
      old.forEach(function (r) { accumulate(agg, r); });
      data.archive = agg;
    }

    function trim() {
      if (data.records.length > maxRecords) foldOldest(data.records.length - maxRecords);
      for (var i = 0; i < data.records.length - maxShapes; i++) delete data.records[i].shape;
    }

    function save() {
      if (!storage) return false;
      for (var attempt = 0; attempt < 6; attempt++) {
        try {
          storage.setItem(key, JSON.stringify(data));
          persistent = true;
          return true;
        } catch (e) {
          // With only a few records this isn't a space problem (e.g. private
          // browsing blocks storage): keep everything in memory and stop.
          if (data.records.length < 50) break;
          // Probably out of space: drop outlines, then fold older records into the archive.
          if (attempt === 0) maxShapes = Math.min(maxShapes, 24);
          else foldOldest(Math.ceil(data.records.length / 2));
          trim();
        }
      }
      persistent = false;
      return false;
    }

    return {
      /** Save a judged circle. Only connected (closed) circles are recorded; returns the record or null. */
      add: function (result, points, meta) {
        if (!result || !result.ok || !result.connected) return null;
        var rec = makeRecord(result, points, meta);
        data.records.push(rec);
        trim();
        save();
        return rec;
      },
      records: function () { return data.records.slice(); },
      /** options: { metric: 'score' | 'bits', now: ms } */
      summary: function (options) { return summarize(data, options); },
      count: function () { return data.records.length + (data.archive ? data.archive.count : 0); },
      isPersistent: function () { return persistent; },
      /** Re-read storage (e.g. after another tab saved). Kept in memory if storage isn't working. */
      reload: function () { if (persistent) data = load(); },
      clear: function () {
        data = emptyData();
        if (storage) {
          try { storage.removeItem(key); } catch (e) { /* ignore */ }
        }
      },
      toJSON: function () {
        return JSON.stringify({
          app: 'circle-judge',
          exportedAt: new Date().toISOString(),
          summary: { score: summarize(data, { metric: 'score' }), bits: summarize(data, { metric: 'bits' }) },
          records: data.records.map(function (r) {
            var copy = {};
            for (var k in r) if (k !== 'shape') copy[k] = r[k];
            if (copy.bits == null) copy.bits = round(metricOf(r, 'bits'), 3);
            return copy;
          })
        }, null, 2);
      },
      toCSV: function () {
        var archived = data.archive ? data.archive.count : 0;
        var rows = [[
          'circle', 'date', 'score', 'precision_bits', 'wobble_rms_pct', 'biggest_miss_pct',
          'widest_minus_narrowest_pct', 'oval_pct', 'average_radius_px', 'sweep_deg', 'time_s', 'input', 'direction'
        ].join(',')];
        data.records.forEach(function (r, i) {
          rows.push([
            archived + i + 1,
            new Date(r.at).toISOString(),
            r.score, round(metricOf(r, 'bits'), 3), r.wobble, r.miss, r.spread, r.oval, r.radius, r.sweep,
            r.duration == null ? '' : (r.duration / 1000).toFixed(2),
            r.input, r.dir
          ].join(','));
        });
        return rows.join('\n') + '\n';
      }
    };
  }

  return {
    createStore: createStore,
    makeRecord: makeRecord,
    summarize: summarize,
    metricOf: metricOf,
    bitsFromWobble: bitsFromWobble,
    GROUPS: GROUPS,
    STORAGE_KEY: STORAGE_KEY
  };
});
