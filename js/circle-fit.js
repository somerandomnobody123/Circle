/*
 * circle-fit.js — judges how round a hand-drawn stroke is.
 *
 * Nothing about the circle is known in advance. After the stroke is finished:
 *
 *   1. The stroke is resampled at even spacing along its length, so slow parts
 *      (many input events) and fast parts (few events) count equally.
 *   2. The center is LOCATED from the drawing itself: the least-squares
 *      reference circle — the point whose distances to the stroke are as
 *      uniform as possible (the standard reference used for roundness in
 *      metrology). An algebraic (Kåsa) fit gives a starting guess, and a
 *      Levenberg–Marquardt solver refines the true geometric fit.
 *   3. The radius is the AVERAGE distance from that located center to the
 *      stroke, and the score measures how far the stroke strays from that
 *      average (RMS deviation as a fraction of the radius), with a small
 *      penalty for a loop that is not closed.
 *
 * There are two ways to turn that into a number:
 *
 *   - Classic score (%): 100 − 5 × (RMS deviation as % of the radius), minus
 *     a penalty for any gap in the loop. Easy to read, but the 5 and the gap
 *     penalty are hand-picked.
 *   - Precision (bits): ½·log₂(1 + r̄²/σ²) ≈ log₂(r̄/σ), where σ is the RMS
 *     distance between the stroke and its average-radius circle, measured both
 *     ways (stroke → circle and circle → stroke, so a gap counts as error with
 *     no special penalty). It has no tuning constants: every extra bit means
 *     the wobble halved, and it grows without limit, with infinite slope, as
 *     the drawing approaches a perfect circle. It is the n → ∞ limit of
 *     "1 − (σ/r̄)^(1/n)" scaled by n, i.e. of using an extreme exponent.
 *
 * Works in the browser (window.CircleFit) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CircleFit = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  // A double has 52 fraction bits, so no computed precision can exceed this.
  var MAX_BITS = 52;
  var CIRCLE_PROBES = 512; // points on the reference circle used for circle → stroke distances

  var DEFAULTS = {
    minRadius: 20,          // px; smaller strokes are rejected as too small
    minPoints: 8,           // raw input points needed before judging
    minSweepTurns: 0.75,    // must go at least 270° around the located center
    maxSweepTurns: 1.5,     // more than one and a half laps is not "a circle"
    wobblePenalty: 5,       // score loses 5 points per 1% RMS deviation
    gapPenalty: 100,        // score loses 100 points per full turn left open
    sampleSpacing: 2,       // px between resampled points
    joinTolerance: 0.04,    // ends "meet" within 4% of the radius...
    joinMinPx: 8            // ...or 8 px, whichever is larger
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function pathLength(points) {
    var len = 0;
    for (var i = 1; i < points.length; i++) {
      len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return len;
  }

  /** Resample an open polyline to `n` points evenly spaced along its length. */
  function resample(points, n) {
    var total = pathLength(points);
    if (n < 2 || total === 0) {
      return points.map(function (p) { return { x: p.x, y: p.y }; });
    }
    var step = total / (n - 1);
    var out = [{ x: points[0].x, y: points[0].y }];
    var carried = 0; // distance travelled since the last emitted sample
    for (var i = 1; i < points.length && out.length < n; i++) {
      var ax = points[i - 1].x, ay = points[i - 1].y;
      var bx = points[i].x, by = points[i].y;
      var seg = Math.hypot(bx - ax, by - ay);
      if (seg === 0) continue;
      var along = step - carried; // where the next sample falls on this segment
      while (along <= seg && out.length < n) {
        var t = along / seg;
        out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
        along += step;
      }
      carried = seg - (along - step);
    }
    var last = points[points.length - 1];
    if (out.length < n) {
      out.push({ x: last.x, y: last.y });
    } else {
      out[n - 1] = { x: last.x, y: last.y };
    }
    return out;
  }

  /** Algebraic (Kåsa) circle fit on centerd coordinates. Returns null if degenerate. */
  function kasaFit(points) {
    var n = points.length;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += points[i].x; my += points[i].y; }
    mx /= n; my /= n;
    var suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (i = 0; i < n; i++) {
      var u = points[i].x - mx, v = points[i].y - my;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v;
      suvv += u * v * v; svuu += v * u * u;
    }
    var det = suu * svv - suv * suv;
    if (!(Math.abs(det) > 1e-12 * (suu * svv + 1e-300))) return null;
    var b1 = 0.5 * (suuu + suvv);
    var b2 = 0.5 * (svvv + svuu);
    var uc = (b1 * svv - b2 * suv) / det;
    var vc = (suu * b2 - suv * b1) / det;
    var x = mx + uc, y = my + vc;
    return isFinite(x) && isFinite(y) ? { x: x, y: y } : null;
  }

  /** Centroid of the area enclosed by the (implicitly closed) stroke. */
  function areaCentroid(points) {
    var a = 0, cx = 0, cy = 0, n = points.length;
    for (var i = 0; i < n; i++) {
      var p = points[i], q = points[(i + 1) % n];
      var cross = p.x * q.y - q.x * p.y;
      a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
    }
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sy = 0;
      for (var j = 0; j < n; j++) { sx += points[j].x; sy += points[j].y; }
      return { x: sx / n, y: sy / n };
    }
    return { x: cx / (3 * a), y: cy / (3 * a) };
  }

  function meanDistance(points, x, y) {
    var s = 0;
    for (var i = 0; i < points.length; i++) s += Math.hypot(points[i].x - x, points[i].y - y);
    return s / points.length;
  }

  function fitCost(points, x, y, r) {
    var s = 0;
    for (var i = 0; i < points.length; i++) {
      var e = Math.hypot(points[i].x - x, points[i].y - y) - r;
      s += e * e;
    }
    return s;
  }

  /** Solve a 3x3 linear system by Gaussian elimination with partial pivoting. */
  function solve3(A, b) {
    var m = [
      [A[0][0], A[0][1], A[0][2], b[0]],
      [A[1][0], A[1][1], A[1][2], b[1]],
      [A[2][0], A[2][1], A[2][2], b[2]]
    ];
    for (var col = 0; col < 3; col++) {
      var piv = col;
      for (var row = col + 1; row < 3; row++) {
        if (Math.abs(m[row][col]) > Math.abs(m[piv][col])) piv = row;
      }
      if (Math.abs(m[piv][col]) < 1e-14) return null;
      var tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
      for (var r = col + 1; r < 3; r++) {
        var f = m[r][col] / m[col][col];
        for (var c = col; c < 4; c++) m[r][c] -= f * m[col][c];
      }
    }
    var x = [0, 0, 0];
    for (var i = 2; i >= 0; i--) {
      var s = m[i][3];
      for (var k = i + 1; k < 3; k++) s -= m[i][k] * x[k];
      x[i] = s / m[i][i];
    }
    return x;
  }

  /**
   * Geometric least-squares circle fit: minimises Σ(dᵢ − r)², where dᵢ is the
   * distance from point i to the center. At the optimum r equals the mean of dᵢ,
   * i.e. the average distance from the located center.
   */
  function geometricFit(points, start) {
    var a = start.x, b = start.y;
    var r = meanDistance(points, a, b);
    var cost = fitCost(points, a, b, r);
    var lambda = 1e-3;
    for (var iter = 0; iter < 200; iter++) {
      var j00 = 0, j01 = 0, j02 = 0, j11 = 0, j12 = 0, j22 = 0, g0 = 0, g1 = 0, g2 = 0;
      for (var i = 0; i < points.length; i++) {
        var dx = a - points[i].x, dy = b - points[i].y;
        var d = Math.hypot(dx, dy);
        if (d < 1e-12) continue;
        var ja = dx / d, jb = dy / d, e = d - r; // ∂e/∂r = −1
        j00 += ja * ja; j01 += ja * jb; j02 -= ja;
        j11 += jb * jb; j12 -= jb; j22 += 1;
        g0 += ja * e; g1 += jb * e; g2 -= e;
      }
      var accepted = false, step = 0;
      while (lambda < 1e12) {
        var delta = solve3(
          [[j00 * (1 + lambda), j01, j02], [j01, j11 * (1 + lambda), j12], [j02, j12, j22 * (1 + lambda)]],
          [-g0, -g1, -g2]
        );
        if (delta) {
          var na = a + delta[0], nb = b + delta[1], nr = r + delta[2];
          var nc = fitCost(points, na, nb, nr);
          if (isFinite(nc) && nc <= cost) {
            step = Math.hypot(delta[0], delta[1], delta[2]);
            var gain = cost - nc;
            a = na; b = nb; r = nr; cost = nc;
            lambda = Math.max(lambda * 0.3, 1e-12);
            accepted = true;
            if (gain <= 1e-14 * (cost + 1e-300)) step = 0;
            break;
          }
        }
        lambda *= 10;
      }
      if (!accepted || step < 1e-10 * (1 + Math.abs(r))) break;
    }
    return { x: a, y: b, r: meanDistance(points, a, b) };
  }

  /** Locate the center of a stroke after it has been drawn. */
  function locateCenter(samples) {
    var start = kasaFit(samples) || areaCentroid(samples);
    var fit = geometricFit(samples, start);
    if (!isFinite(fit.x) || !isFinite(fit.y) || !isFinite(fit.r)) return null;
    return fit;
  }

  function pointSegmentDistance(px, py, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1) : 0;
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
  }

  /**
   * RMS distance from evenly spaced points on the circle (cx, cy, r) to the
   * nearest point of the stroke. Where the loop has a gap, the circle points
   * inside it are far from the stroke, so gaps count as error by themselves.
   */
  function circleToStrokeRms(samples, cx, cy, r, probes) {
    var n = samples.length, sum = 0;
    for (var k = 0; k < probes; k++) {
      var a = (k / probes) * TAU;
      var px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      var best = Infinity, bi = 0;
      for (var i = 0; i < n; i++) {
        var dx = samples[i].x - px, dy = samples[i].y - py, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bi = i; }
      }
      // Refine from the nearest sample to the nearest point on the segments either side of it.
      var d = Math.sqrt(best);
      if (bi > 0) d = Math.min(d, pointSegmentDistance(px, py, samples[bi - 1], samples[bi]));
      if (bi < n - 1) d = Math.min(d, pointSegmentDistance(px, py, samples[bi], samples[bi + 1]));
      sum += d * d;
    }
    return Math.sqrt(sum / probes);
  }

  /**
   * Bits of precision for a circle of radius r drawn with RMS error sigma:
   * ½·log₂(1 + r²/σ²), the Shannon–Hartley form, which is ≈ log₂(r/σ) for any
   * real circle and never negative. Infinite (capped at MAX_BITS) when σ = 0.
   */
  function precisionBits(radius, sigma) {
    if (!(sigma > 0)) return MAX_BITS;
    var ratio = radius / sigma;
    return Math.min(MAX_BITS, 0.5 * Math.log2(1 + ratio * ratio));
  }

  function segmentsCross(a, b, c, d) {
    var d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    var d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    var d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
    var d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  /**
   * How close the two ends of the stroke come to joining up, in px: 0 if the
   * end of the stroke crosses its beginning, otherwise the smaller of the
   * distances from each end point to the other half of the stroke.
   */
  function endGap(samples) {
    var n = samples.length;
    var half = Math.floor(n / 2);
    var third = Math.floor(n / 3);
    var i, j;
    for (i = 1; i <= third; i++) {
      for (j = n - third; j < n; j++) {
        if (j - i < 2) continue;
        if (segmentsCross(samples[i - 1], samples[i], samples[j - 1], samples[j])) return 0;
      }
    }
    var first = samples[0], last = samples[n - 1];
    var best = Infinity;
    for (i = 1; i <= half; i++) {
      best = Math.min(best, pointSegmentDistance(last.x, last.y, samples[i - 1], samples[i]));
    }
    for (j = half + 1; j < n; j++) {
      best = Math.min(best, pointSegmentDistance(first.x, first.y, samples[j - 1], samples[j]));
    }
    return best;
  }

  function wrapAngle(a) {
    while (a > Math.PI) a -= TAU;
    while (a <= -Math.PI) a += TAU;
    return a;
  }

  function failure(reason, message, extra) {
    var out = { ok: false, reason: reason, message: message };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  /**
   * Judge a stroke. `rawPoints` is an array of {x, y, t?} in drawing order.
   * Returns { ok: true, score, center, radius, ... } or { ok: false, reason, message }.
   */
  function analyze(rawPoints, options) {
    var opts = {};
    var key;
    for (key in DEFAULTS) opts[key] = DEFAULTS[key];
    if (options) for (key in options) opts[key] = options[key];

    var points = (rawPoints || []).filter(function (p) {
      return p && isFinite(p.x) && isFinite(p.y);
    });
    if (points.length < opts.minPoints) {
      return failure('short', 'Draw a full circle in one stroke.');
    }
    var length = pathLength(points);
    var n = clamp(Math.round(length / opts.sampleSpacing), 64, 1024);
    var samples = resample(points, n);

    var fit = locateCenter(samples);
    if (!fit) return failure('nofit', 'Couldn’t find a circle in that. Try again.');
    var cx = fit.x, cy = fit.y;

    // Average distance from the located center = the circle's radius.
    var dists = new Array(samples.length);
    var sum = 0, i;
    for (i = 0; i < samples.length; i++) {
      dists[i] = Math.hypot(samples[i].x - cx, samples[i].y - cy);
      sum += dists[i];
    }
    var radius = sum / samples.length;

    // How far around the center the stroke travels.
    var swept = 0;
    var prevAngle = Math.atan2(samples[0].y - cy, samples[0].x - cx);
    for (i = 1; i < samples.length; i++) {
      var ang = Math.atan2(samples[i].y - cy, samples[i].x - cx);
      swept += wrapAngle(ang - prevAngle);
      prevAngle = ang;
    }
    var turns = Math.abs(swept) / TAU;

    if (radius < opts.minRadius) {
      return failure('small', 'Too small — try a bigger circle.', { radius: radius });
    }
    if (turns < opts.minSweepTurns) {
      return failure('open',
        'Keep going — that only went ' + Math.round(turns * 360) + '° around. Close the loop.',
        { sweptDegrees: turns * 360 });
    }
    if (turns > opts.maxSweepTurns) {
      return failure('loops',
        'One lap only — that went around ' + turns.toFixed(1) + ' times.',
        { sweptDegrees: turns * 360 });
    }

    // Deviation of every sample from the average distance.
    var sq = 0, abs = 0, minR = Infinity, maxR = -Infinity, maxDev = 0, maxIdx = 0;
    for (i = 0; i < samples.length; i++) {
      var dev = dists[i] - radius;
      sq += dev * dev;
      abs += Math.abs(dev);
      if (dists[i] < minR) minR = dists[i];
      if (dists[i] > maxR) maxR = dists[i];
      if (Math.abs(dev) > Math.abs(maxDev)) { maxDev = dev; maxIdx = i; }
    }
    var rms = Math.sqrt(sq / samples.length);
    var meanAbs = abs / samples.length;
    var relRms = rms / radius;

    // Second harmonic of the radius profile = how oval (elliptical) it is.
    var c2 = 0, s2 = 0;
    for (i = 0; i < samples.length; i++) {
      var th = Math.atan2(samples[i].y - cy, samples[i].x - cx);
      var d2 = dists[i] - radius;
      c2 += d2 * Math.cos(2 * th);
      s2 += d2 * Math.sin(2 * th);
    }
    var ovalAmp = Math.min(2 * Math.hypot(c2, s2) / samples.length, radius * 0.95);
    var oval = {
      amplitude: ovalAmp,                                     // px
      aspect: (radius + ovalAmp) / (radius - ovalAmp),        // longest ÷ shortest
      axisAngle: Math.atan2(s2, c2) / 2,                      // direction of the long axis
      share: rms > 0 ? Math.min(1, (ovalAmp * ovalAmp / 2) / (rms * rms)) : 0
    };

    // Precision: RMS distance between stroke and circle, measured both ways.
    var circleRms = circleToStrokeRms(samples, cx, cy, radius, CIRCLE_PROBES);
    var sigma = Math.sqrt((rms * rms + circleRms * circleRms) / 2);
    var precision = {
      bits: precisionBits(radius, sigma),
      sigma: sigma,                      // px, two-way RMS distance
      strokeRms: rms,                    // px, stroke → circle (same as rms)
      circleRms: circleRms,              // px, circle → stroke
      ratio: sigma > 0 ? radius / sigma : Infinity // "accurate to 1 part in ratio"
    };

    var gapTurns = Math.max(0, 1 - turns);
    if (gapTurns * 360 < 0.5) gapTurns = 0; // ignore rounding-level gaps
    var roundness = 100 * (1 - opts.wobblePenalty * relRms);
    var score = clamp(roundness - opts.gapPenalty * gapTurns, 0, 100);

    var gapPx = endGap(samples);
    var connected = gapPx <= Math.max(opts.joinMinPx, opts.joinTolerance * radius);

    var first = points[0], last = points[points.length - 1];
    var duration = (isFinite(first.t) && isFinite(last.t)) ? Math.max(0, last.t - first.t) : null;

    return {
      ok: true,
      score: score,
      roundnessScore: clamp(roundness, 0, 100),
      center: { x: cx, y: cy },
      radius: radius,                    // average distance from the located center
      rms: rms,                          // RMS deviation from that average, px
      relativeRms: relRms,               // rms / radius
      meanAbsDeviation: meanAbs,         // px
      maxDeviation: maxDev,              // signed, px (+ outside, − inside)
      maxDeviationPoint: { x: samples[maxIdx].x, y: samples[maxIdx].y },
      minRadius: minR,
      maxRadius: maxR,
      peakToValley: maxR - minR,         // classic "out-of-roundness" figure, px
      oval: oval,
      precision: precision,
      sweptDegrees: turns * 360,
      direction: swept >= 0 ? 1 : -1,    // +1 clockwise on screen (y points down)
      startAngle: Math.atan2(first.y - cy, first.x - cx),
      closed: gapTurns === 0,
      gapDegrees: gapTurns * 360,
      endGap: gapPx,                     // px between the ends (0 if the stroke crosses itself)
      connected: connected,              // the two ends meet: a closed loop
      length: length,
      sampleCount: samples.length,
      duration: duration
    };
  }

  /**
   * Judge a stroke traced over a given guide circle `target` = {x, y, r}.
   *
   * Here the reference is known in advance, so everything is measured against
   * the guide: the same classic % and precision-bits formulas, with the guide's
   * center and radius in place of the located ones. The free-hand analysis of
   * the same stroke (center located after drawing) is returned as `fit`, so
   * the shape can be judged on its own too.
   *
   * The result's `center` and `radius` are the guide's, so relativeDeviation()
   * colors the stroke by distance from the guide.
   */
  function analyzeTrace(rawPoints, target, options) {
    var opts = {};
    var key;
    for (key in DEFAULTS) opts[key] = DEFAULTS[key];
    if (options) for (key in options) opts[key] = options[key];

    var points = (rawPoints || []).filter(function (p) {
      return p && isFinite(p.x) && isFinite(p.y);
    });
    if (!target || !(target.r > 0)) return failure('nofit', 'There is no guide circle to trace.');
    if (points.length < opts.minPoints) {
      return failure('short', 'Trace the whole guide in one stroke.');
    }
    var cx = target.x, cy = target.y, R = target.r;
    var length = pathLength(points);
    var n = clamp(Math.round(length / opts.sampleSpacing), 64, 1024);
    var samples = resample(points, n);

    // How far around the guide's center the stroke travels.
    var swept = 0, i;
    var prevAngle = Math.atan2(samples[0].y - cy, samples[0].x - cx);
    for (i = 1; i < samples.length; i++) {
      var ang = Math.atan2(samples[i].y - cy, samples[i].x - cx);
      swept += wrapAngle(ang - prevAngle);
      prevAngle = ang;
    }
    var turns = Math.abs(swept) / TAU;
    if (turns < opts.minSweepTurns) {
      return failure('open',
        'Keep going \u2014 follow the guide all the way around (that was ' + Math.round(turns * 360) + '\u00b0).',
        { sweptDegrees: turns * 360 });
    }
    if (turns > opts.maxSweepTurns) {
      return failure('loops', 'One lap only \u2014 that went around ' + turns.toFixed(1) + ' times.',
        { sweptDegrees: turns * 360 });
    }

    // Deviation of every sample from the guide.
    var sq = 0, abs = 0, sum = 0, minR = Infinity, maxR = -Infinity, maxDev = 0, maxIdx = 0;
    for (i = 0; i < samples.length; i++) {
      var d = Math.hypot(samples[i].x - cx, samples[i].y - cy);
      var dev = d - R;
      sum += d;
      sq += dev * dev;
      abs += Math.abs(dev);
      if (d < minR) minR = d;
      if (d > maxR) maxR = d;
      if (Math.abs(dev) > Math.abs(maxDev)) { maxDev = dev; maxIdx = i; }
    }
    var rms = Math.sqrt(sq / samples.length);
    var gapTurns = Math.max(0, 1 - turns);
    if (gapTurns * 360 < 0.5) gapTurns = 0;
    var score = clamp(100 * (1 - opts.wobblePenalty * rms / R) - opts.gapPenalty * gapTurns, 0, 100);

    var circleRms = circleToStrokeRms(samples, cx, cy, R, CIRCLE_PROBES);
    var sigma = Math.sqrt((rms * rms + circleRms * circleRms) / 2);

    var gapPx = endGap(samples);
    var first = points[0], last = points[points.length - 1];

    // The same stroke judged free-hand, around its own located center.
    var fit = analyze(points, options);
    var centerOffset = fit.ok ? { x: fit.center.x - cx, y: fit.center.y - cy } : null;

    return {
      ok: true,
      trace: true,
      score: score,
      target: { x: cx, y: cy, r: R },
      center: { x: cx, y: cy },          // the reference circle is the guide
      radius: R,
      rms: rms,                          // px, RMS distance from the guide (radially)
      relativeRms: rms / R,
      meanAbsDeviation: abs / samples.length,
      bias: sum / samples.length - R,    // px, + = drawn bigger than the guide on average
      maxDeviation: maxDev,
      maxDeviationPoint: { x: samples[maxIdx].x, y: samples[maxIdx].y },
      minRadius: minR,
      maxRadius: maxR,
      peakToValley: maxR - minR,
      precision: {
        bits: precisionBits(R, sigma),
        sigma: sigma,
        strokeRms: rms,
        circleRms: circleRms,
        ratio: sigma > 0 ? R / sigma : Infinity
      },
      fit: fit,                          // free-hand analysis (may be { ok: false })
      centerOffset: centerOffset,        // px, located center minus guide center
      oval: fit.ok ? fit.oval : null,
      sweptDegrees: turns * 360,
      direction: swept >= 0 ? 1 : -1,
      startAngle: Math.atan2(first.y - cy, first.x - cx),
      closed: gapTurns === 0,
      gapDegrees: gapTurns * 360,
      endGap: gapPx,
      connected: gapPx <= Math.max(opts.joinMinPx, opts.joinTolerance * R),
      length: length,
      sampleCount: samples.length,
      duration: (isFinite(first.t) && isFinite(last.t)) ? Math.max(0, last.t - first.t) : null
    };
  }

  /** Signed deviation of an arbitrary point, as a fraction of the radius. */
  function relativeDeviation(result, x, y) {
    return (Math.hypot(x - result.center.x, y - result.center.y) - result.radius) / result.radius;
  }

  return {
    analyze: analyze,
    analyzeTrace: analyzeTrace,
    relativeDeviation: relativeDeviation,
    precisionBits: precisionBits,
    MAX_BITS: MAX_BITS,
    locateCenter: locateCenter,
    resample: resample,
    kasaFit: kasaFit,
    geometricFit: geometricFit,
    pathLength: pathLength,
    DEFAULTS: DEFAULTS
  };
});
