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

  var DEFAULTS = {
    minRadius: 20,          // px; smaller strokes are rejected as too small
    minPoints: 8,           // raw input points needed before judging
    minSweepTurns: 0.75,    // must go at least 270° around the located center
    maxSweepTurns: 1.5,     // more than one and a half laps is not "a circle"
    wobblePenalty: 5,       // score loses 5 points per 1% RMS deviation
    gapPenalty: 100,        // score loses 100 points per full turn left open
    sampleSpacing: 2        // px between resampled points
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

    var gapTurns = Math.max(0, 1 - turns);
    if (gapTurns * 360 < 0.5) gapTurns = 0; // ignore rounding-level gaps
    var roundness = 100 * (1 - opts.wobblePenalty * relRms);
    var score = clamp(roundness - opts.gapPenalty * gapTurns, 0, 100);

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
      sweptDegrees: turns * 360,
      direction: swept >= 0 ? 1 : -1,    // +1 clockwise on screen (y points down)
      startAngle: Math.atan2(first.y - cy, first.x - cx),
      closed: gapTurns === 0,
      gapDegrees: gapTurns * 360,
      length: length,
      sampleCount: samples.length,
      duration: duration
    };
  }

  /** Signed deviation of an arbitrary point, as a fraction of the radius. */
  function relativeDeviation(result, x, y) {
    return (Math.hypot(x - result.center.x, y - result.center.y) - result.radius) / result.radius;
  }

  return {
    analyze: analyze,
    relativeDeviation: relativeDeviation,
    locateCenter: locateCenter,
    resample: resample,
    kasaFit: kasaFit,
    geometricFit: geometricFit,
    pathLength: pathLength,
    DEFAULTS: DEFAULTS
  };
});
