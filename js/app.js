/*
 * app.js — drawing surface and result display for Circle Judge.
 * Input uses Pointer Events, so a mouse, trackpad, finger and Apple Pencil all work.
 */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var STROKE_WIDTH = 4;
  var SCORING_KEY = 'circle-judge:scoring';
  var TRACE_KEY = 'circle-judge:trace';
  var TRACE_MIN = 40; // smallest guide radius, px
  var COLOR_RANGE = 0.08; // deviation (fraction of radius) shown as fully "off"

  var GRADES = [
    [99, 'Flawless'],
    [97, 'Practically perfect'],
    [94, 'Superb'],
    [90, 'Excellent'],
    [85, 'Great circle'],
    [78, 'Good'],
    [70, 'Not bad'],
    [60, 'A bit wobbly'],
    [45, 'Wobbly'],
    [0, 'Is that a circle?']
  ];

  var TRACE_GRADES = [
    [97, 'Right on the line'],
    [92, 'Very close'],
    [85, 'Close'],
    [75, 'Near the line'],
    [60, 'Drifting off'],
    [0, 'Off the guide']
  ];

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('board');
  var ctx = canvas.getContext('2d');
  var hint = $('hint');
  var toast = $('toast');
  var card = $('card');
  var announce = $('announce');
  var help = $('help');
  var pencilChip = $('pencilChip');
  var statsDialog = $('statsDialog');
  var app = document.querySelector('.app');
  var topbar = document.querySelector('.topbar');
  var traceBtn = $('traceBtn');
  var traceBar = $('traceBar');
  var traceSize = $('traceSize');
  var traceHide = $('traceHide');

  // Every connected (closed) circle is saved here; see js/stats.js.
  var store = CircleStats.createStore();
  var statsView = StatsView.create({
    store: store,
    dialog: statsDialog,
    onChange: updateBestChip,
    getMetric: function () { return SCORING[state.scoring].metric; }
  });

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  var state = {
    mode: 'idle',          // idle | drawing | result | error
    points: [],
    pointerId: null,
    pointerType: null,
    originX: 0,
    originY: 0,
    result: null,
    pieceColors: null,
    anim: 1,
    animToken: 0,
    renderQueued: false,
    penSeen: false,
    pencilOnly: false,
    width: 0,
    height: 0,
    colors: null,
    scoring: loadScoring(), // 'classic' (%) or 'precision' (bits)
    saved: null,            // outcome of saving the current result to the stats
    trace: loadTrace(),     // trace practice: { on, radius, hide }
    attemptTarget: null,    // guide circle the current stroke is traced against
    practice: []            // this session's traces: { score, bits }
  };

  // ---------- Utilities ----------

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function parseHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [128, 128, 128];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (name) { return cs.getPropertyValue(name).trim(); };
    state.colors = {
      ink: v('--ink'),
      inkMuted: v('--ink-muted'),
      accent: v('--accent'),
      text: v('--text'),
      surface: v('--surface-solid'),
      good: parseHex(v('--good')),
      mid: parseHex(v('--mid')),
      bad: parseHex(v('--bad'))
    };
  }

  /** Color for a deviation (fraction of radius): green on the line, amber, then red. */
  function deviationColor(dev) {
    var c = state.colors;
    var t = clamp(Math.abs(dev) / COLOR_RANGE, 0, 1);
    var rgb = t < 0.45 ? mix(c.good, c.mid, t / 0.45) : mix(c.mid, c.bad, (t - 0.45) / 0.55);
    return 'rgb(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ')';
  }

  // ---------- Canvas sizing ----------

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateTraceUI();
    render();
    if (state.mode === 'result') placeCard();
  }

  // ---------- Trace practice ----------

  function loadTrace() {
    var t = { on: false, radius: 150, hide: false };
    try {
      var saved = JSON.parse(window.localStorage.getItem(TRACE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        t.on = saved.on === true;
        if (isFinite(saved.radius) && saved.radius >= TRACE_MIN) t.radius = Math.round(saved.radius);
        t.hide = saved.hide === true;
      }
    } catch (e) { /* defaults */ }
    return t;
  }

  function saveTrace() {
    try { window.localStorage.setItem(TRACE_KEY, JSON.stringify(state.trace)); } catch (e) { /* per-device nicety only */ }
  }

  /**
   * Where the guide sits, in the space between the top bar and the trace bar:
   * centered, except on tall portrait screens, where the result card goes
   * above or below the drawing; there it sits a little high, leaving room for
   * the card underneath.
   */
  function traceGeometry() {
    var top = topbar.getBoundingClientRect().bottom;
    var bottom = traceBar.hidden ? state.height : traceBar.getBoundingClientRect().top;
    var portrait = state.width < 900 && state.height > state.width;
    var y = top + (bottom - top) * (portrait ? 0.4 : 0.5);
    var maxR = Math.floor(Math.min(state.width / 2, y - top, bottom - y) - 16);
    return { x: state.width / 2, y: y, maxR: Math.max(TRACE_MIN, maxR) };
  }

  function currentTarget() {
    var g = traceGeometry();
    return { x: g.x, y: g.y, r: clamp(state.trace.radius, TRACE_MIN, g.maxR) };
  }

  function updateHint() {
    var tracing = state.trace.on;
    $('hintTitle').textContent = tracing ? 'Trace the circle' : 'Draw a circle';
    $('hintSub').textContent = tracing
      ? 'Follow the dashed guide in one stroke. Practice only: traces aren\u2019t saved to your stats.'
      : 'One stroke, any size, anywhere. Lift to be judged.';
    hint.classList.toggle('is-trace', tracing);
  }

  function updateTraceUI() {
    var on = state.trace.on;
    traceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    traceBar.hidden = !on;
    app.classList.toggle('is-tracing', on);
    app.style.setProperty('--tracebar-h', (on ? traceBar.offsetHeight : 0) + 'px');
    traceHide.checked = state.trace.hide;
    if (on && state.width) {
      var g = traceGeometry();
      traceSize.max = String(g.maxR);
      var r = clamp(state.trace.radius, TRACE_MIN, g.maxR);
      traceSize.value = String(r);
      $('traceSizeValue').textContent = r + ' px';
    }
    updateHint();
  }

  function setTraceMode(on) {
    state.trace.on = !!on;
    saveTrace();
    clearBoard();
    updateTraceUI();
    render();
    if (!on) showToast('Free drawing: closed circles are saved to your stats.');
  }

  function setTraceRadius(r) {
    var g = traceGeometry();
    state.trace.radius = Math.round(clamp(r, TRACE_MIN, g.maxR));
    saveTrace();
    if (state.mode === 'result' || state.mode === 'error') clearBoard();
    updateTraceUI();
    render();
  }

  function randomTraceRadius() {
    var g = traceGeometry();
    var current = clamp(state.trace.radius, TRACE_MIN, g.maxR), r = current;
    // Pick a size that is noticeably different from the current one.
    for (var i = 0; i < 20 && Math.abs(r - current) < (g.maxR - TRACE_MIN) * 0.15; i++) {
      r = TRACE_MIN + Math.random() * (g.maxR - TRACE_MIN);
    }
    setTraceRadius(r);
  }

  function drawTraceGuide(target) {
    var c = state.colors;
    ctx.save();
    setStrokeStyle(2.5);
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = c.inkMuted;
    ctx.beginPath();
    ctx.arc(target.x, target.y, target.r, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = c.inkMuted;
    ctx.beginPath();
    ctx.arc(target.x, target.y, 3, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Rendering ----------

  function requestRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    window.requestAnimationFrame(function () {
      state.renderQueued = false;
      render();
    });
  }

  function render() {
    ctx.clearRect(0, 0, state.width, state.height);
    if (state.trace.on && state.mode !== 'result' && !(state.mode === 'drawing' && state.trace.hide)) {
      drawTraceGuide(state.mode === 'idle' || !state.attemptTarget ? currentTarget() : state.attemptTarget);
    }
    if (!state.points.length) return;
    if (state.mode === 'result' && state.result) {
      drawColoredStroke();
      drawGuides(state.result, state.anim);
    } else {
      drawInkStroke(state.mode === 'error' ? state.colors.inkMuted : state.colors.ink);
    }
  }

  function setStrokeStyle(width) {
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
  }

  // The stroke is drawn as quadratic curves through the midpoints between input
  // points, which looks smooth even when input events are sparse (fast mouse).
  function drawInkStroke(color) {
    var p = state.points, n = p.length;
    setStrokeStyle(STROKE_WIDTH);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(p[0].x, p[0].y, STROKE_WIDTH / 2, 0, TAU);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (var i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    }
    ctx.lineTo(p[n - 1].x, p[n - 1].y);
    ctx.stroke();
  }

  function drawColoredStroke() {
    var p = state.points, n = p.length, colors = state.pieceColors;
    if (n < 2) return;
    setStrokeStyle(STROKE_WIDTH);
    var prevX = p[0].x, prevY = p[0].y;
    for (var i = 1; i < n; i++) {
      var endX, endY;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      if (i < n - 1) {
        endX = (p[i].x + p[i + 1].x) / 2;
        endY = (p[i].y + p[i + 1].y) / 2;
        ctx.quadraticCurveTo(p[i].x, p[i].y, endX, endY);
      } else {
        endX = p[i].x;
        endY = p[i].y;
        ctx.lineTo(endX, endY);
      }
      ctx.strokeStyle = colors[i];
      ctx.stroke();
      prevX = endX;
      prevY = endY;
    }
  }

  function pill(x, y, text) {
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    var w = ctx.measureText(text).width + 16, h = 24;
    ctx.fillStyle = state.colors.surface;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    else ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = state.colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  /** Reference circle (average radius around the located center), center mark, radius and biggest miss. */
  function drawGuides(res, progress) {
    var c = state.colors;
    var cx = res.center.x, cy = res.center.y, r = res.radius;

    // Reference circle, traced in the same direction the user drew.
    ctx.save();
    setStrokeStyle(2);
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    var start = res.startAngle;
    // A trace's guide was already on screen, so it is drawn whole rather than traced in.
    var sweep = res.trace ? 1 : progress;
    ctx.arc(cx, cy, r, start, start + res.direction * TAU * sweep, res.direction < 0);
    ctx.stroke();
    ctx.restore();

    // Radius line + label.
    var labelAlpha = clamp((progress - 0.45) / 0.4, 0, 1);
    if (labelAlpha > 0) {
      var ang = -Math.PI / 4;
      var ex = cx + Math.cos(ang) * r, ey = cy + Math.sin(ang) * r;
      ctx.save();
      ctx.globalAlpha = labelAlpha;
      setStrokeStyle(1.5);
      ctx.strokeStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (r >= 90) pill((cx + ex) / 2, (cy + ey) / 2, (res.trace ? 'guide r ' : 'avg r ') + Math.round(r) + ' px');
      ctx.restore();
    }

    // Center marker.
    var markAlpha = clamp(progress / 0.3, 0, 1);
    ctx.save();
    ctx.globalAlpha = markAlpha;
    setStrokeStyle(1.5);
    ctx.strokeStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(cx - 11, cy); ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 11, cy);
    ctx.moveTo(cx, cy - 11); ctx.lineTo(cx, cy - 5);
    ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + 11);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, TAU);
    ctx.fill();

    // Trace: where your own circle's center landed, joined to the guide's.
    if (res.trace && res.fit && res.fit.ok) {
      var fx = res.fit.center.x, fy = res.fit.center.y;
      ctx.strokeStyle = c.text;
      if (Math.hypot(fx - cx, fy - cy) > 2) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(fx, fy);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    // Biggest miss.
    var missAlpha = clamp((progress - 0.7) / 0.3, 0, 1);
    if (missAlpha > 0) {
      var m = res.maxDeviationPoint;
      ctx.save();
      ctx.globalAlpha = missAlpha;
      setStrokeStyle(2);
      ctx.strokeStyle = c.text;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- UI state ----------

  var toastTimer = 0;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 3200);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    toast.classList.remove('is-visible');
  }

  function hideCard() {
    card.classList.remove('is-visible');
  }

  function clearBoard() {
    state.animToken++;
    state.mode = 'idle';
    state.points = [];
    state.result = null;
    state.pieceColors = null;
    hideCard();
    hideToast();
    updateHint();
    hint.classList.remove('is-hidden');
    render();
  }

  // ---------- Scoring modes ----------

  // Classic: the 0–100% score. Precision: bits = ½·log₂(1 + r̄²/σ²), no ceiling,
  // infinite slope as the circle approaches perfect (see js/circle-fit.js).
  var SCORING = {
    classic: {
      metric: 'score',
      value: function (res) { return res.score; },
      text: function (v) { return v.toFixed(1); },
      unit: '%',
      full: function (v) { return v.toFixed(1) + '%'; },
      diff: function (v) { return v.toFixed(1) + ' points'; },
      same: 0.05,
      grade: function (res) { return gradeFor(res); },
      color: function (res) { return scoreColorVar(res.score); },
      speak: function (res) { return 'Score ' + res.score.toFixed(1) + ' percent. ' + gradeFor(res) + '.'; }
    },
    precision: {
      metric: 'bits',
      value: function (res) { return res.precision.bits; },
      text: function (v) { return v.toFixed(2); },
      unit: 'bits',
      full: function (v) { return v.toFixed(2) + ' bits'; },
      diff: function (v) { return v.toFixed(2) + ' bits'; },
      same: 0.005,
      grade: function (res) { return partsIn(res.precision.ratio); },
      color: function () { return 'var(--text)'; },
      speak: function (res) {
        return 'Precision ' + res.precision.bits.toFixed(2) + ' bits. ' + partsIn(res.precision.ratio) + '.';
      }
    }
  };

  function loadScoring() {
    try {
      var v = window.localStorage.getItem(SCORING_KEY);
      return v === 'precision' ? 'precision' : 'classic';
    } catch (e) { return 'classic'; }
  }

  /** "1 part in N": the two-way RMS error is 1/N of the average radius. */
  function partsIn(ratio) {
    if (!isFinite(ratio) || ratio >= 1e6) return 'Better than 1 part in a million';
    return '1 part in ' + Math.round(ratio).toLocaleString();
  }

  function setScoring(mode) {
    state.scoring = SCORING[mode] ? mode : 'classic';
    try { window.localStorage.setItem(SCORING_KEY, state.scoring); } catch (e) { /* per-device nicety only */ }
    var buttons = document.querySelectorAll('[data-scoring]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-scoring') === state.scoring ? 'true' : 'false');
    }
    updateBestChip();
    if (state.mode === 'result' && state.result) {
      fillCard(state.result);
      renderScoreText(state.result, state.anim);
      placeCard();
    }
    if (statsView.isOpen()) statsView.refresh();
  }

  function updateBestChip() {
    var S = SCORING[state.scoring];
    var s = store.summary({ metric: S.metric });
    var btn = $('statsBtn');
    if (s.count) {
      $('bestLabel').textContent = 'Best';
      $('bestValue').textContent = S.full(s.best);
      btn.setAttribute('aria-label', 'Your stats: best ' + S.full(s.best) + ', average ' +
        S.full(s.average) + ' over ' + s.count + (s.count === 1 ? ' circle' : ' circles'));
    } else {
      $('bestLabel').textContent = 'Stats';
      $('bestValue').textContent = '';
      btn.setAttribute('aria-label', 'Your stats');
    }
  }

  function gradeFor(res) {
    var table = res.trace ? TRACE_GRADES : GRADES;
    for (var i = 0; i < table.length; i++) if (res.score >= table[i][0]) return table[i][1];
    return table[table.length - 1][1];
  }

  function scoreColorVar(score) {
    return score >= 85 ? 'var(--good-text)' : score >= 60 ? 'var(--mid-text)' : 'var(--bad-text)';
  }

  function directionWords(dx, dy) {
    var len = Math.hypot(dx, dy) || 1;
    var parts = [];
    if (Math.abs(dy) > 0.38 * len) parts.push(dy < 0 ? 'above' : 'below');
    if (Math.abs(dx) > 0.38 * len) parts.push('to the ' + (dx > 0 ? 'right' : 'left'));
    return parts.join(' and ');
  }

  function tipFor(res) {
    if (res.trace && res.connected) {
      var R = res.radius;
      var off = res.centerOffset ? Math.hypot(res.centerOffset.x, res.centerOffset.y) : 0;
      if (Math.abs(res.bias) / R >= 0.02 && Math.abs(res.bias) >= off) {
        return 'You ran ' + Math.round(Math.abs(res.bias)) + ' px ' + (res.bias > 0 ? 'outside' : 'inside') +
          ' the guide on average: ' + pct(Math.abs(res.bias) / R) + (res.bias > 0 ? ' too big.' : ' too small.');
      }
      if (off / R >= 0.02) {
        return 'Your circle sat ' + Math.round(off) + ' px ' + directionWords(res.centerOffset.x, res.centerOffset.y) + ' of the guide.';
      }
      if (!res.oval) return res.score < 88 ? 'Lumpy in places. A steady speed and a relaxed wrist help.' : null;
    }
    if (!res.connected) {
      return res.gapDegrees >= 2
        ? 'Close the loop: there’s a ' + Math.round(res.gapDegrees) + '° gap between your start and finish.'
        : 'Close the loop: your finish is ' + Math.round(res.endGap) + ' px from the line you started on.';
    }
    var oval = res.oval;
    if (res.score < 97 && oval.share > 0.5 && oval.aspect > 1.03) {
      var deg = ((oval.axisAngle * 180 / Math.PI) % 180 + 180) % 180; // 0 = horizontal
      var where = deg < 25 || deg > 155 ? 'side to side' : deg > 65 && deg < 115 ? 'top to bottom' : 'along a diagonal';
      return 'A little oval: about ' + Math.round((oval.aspect - 1) * 100) + '% longer ' + where + '.';
    }
    if (res.score < 88) return 'Lumpy in places. A steady speed and a relaxed wrist help.';
    return null;
  }

  /** Fill the card's stat tiles from [label, value, sub, { miss: true }] rows. */
  function setTiles(rows) {
    var dl = $('stats');
    dl.textContent = '';
    rows.forEach(function (row) {
      var tile = document.createElement('div');
      tile.className = 'stat';
      var dt = document.createElement('dt');
      if (row[3] && row[3].miss) {
        var dot = document.createElement('span');
        dot.className = 'miss-dot';
        dot.setAttribute('aria-hidden', 'true');
        dt.appendChild(dot);
      }
      dt.appendChild(document.createTextNode(row[0]));
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      if (row[2]) {
        var small = document.createElement('small');
        small.textContent = ' ' + row[2];
        dd.appendChild(small);
      }
      tile.appendChild(dt);
      tile.appendChild(dd);
      dl.appendChild(tile);
    });
  }

  function loopTile(res) {
    if (res.connected) {
      var extra = res.sweptDegrees - 360;
      return ['Loop', 'Closed', extra >= 5 ? '+' + Math.round(extra) + '\u00b0' : null];
    }
    if (res.gapDegrees >= 2) return ['Loop', 'Gap', Math.round(res.gapDegrees) + '\u00b0'];
    return ['Loop', 'Open', Math.round(res.endGap) + ' px apart'];
  }

  function missTile(res) {
    return ['Biggest miss', fmt(Math.abs(res.maxDeviation)) + ' px',
      pct(Math.abs(res.maxDeviation) / res.radius) + (res.maxDeviation >= 0 ? ' out' : ' in'), { miss: true }];
  }

  function freehandTiles(res) {
    return [
      ['Average radius', fmt(res.radius) + ' px'],
      ['Wobble (RMS)', '\u00b1' + fmt(res.rms) + ' px', pct(res.relativeRms)],
      missTile(res),
      ['Widest \u2212 narrowest', fmt(res.peakToValley) + ' px', pct(res.peakToValley / res.radius)],
      loopTile(res),
      ['Time', res.duration == null ? '\u2014' : (res.duration / 1000).toFixed(1) + ' s']
    ];
  }

  function traceTiles(res) {
    var R = res.radius, fit = res.fit;
    var size = Math.abs(res.bias) < 0.05
      ? ['Size vs guide', 'Spot on']
      : ['Size vs guide', (res.bias > 0 ? '+' : '\u2212') + fmt(Math.abs(res.bias)) + ' px', pct(Math.abs(res.bias) / R)];
    var off = res.centerOffset ? Math.hypot(res.centerOffset.x, res.centerOffset.y) : null;
    return [
      ['Off the guide (RMS)', '\u00b1' + fmt(res.rms) + ' px', pct(res.relativeRms)],
      missTile(res),
      size,
      ['Center offset', off == null ? '\u2014' : fmt(off) + ' px', off == null ? null : pct(off / R)],
      ['Own wobble (RMS)', fit.ok ? '\u00b1' + fmt(fit.rms) + ' px' : '\u2014', fit.ok ? pct(fit.relativeRms) : null],
      loopTile(res)
    ];
  }

  function fmt(v) { return v >= 100 ? v.toFixed(0) : v.toFixed(1); }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  function setUnit(id, S) {
    $(id).textContent = S.unit;
    $(id).classList.toggle('is-word', S.unit.length > 1);
  }

  /** The headline number(s), scaled by k for the count-up animation. */
  function renderScoreText(res, k) {
    var S = SCORING[state.scoring];
    if (res.trace) {
      $('guideValue').textContent = S.text(S.value(res) * k);
      $('fitValue').textContent = res.fit.ok ? S.text(S.value(res.fit) * k) : '\u2014';
    } else {
      $('scoreValue').textContent = S.text(S.value(res) * k);
    }
  }

  function fillCard(res) {
    var S = SCORING[state.scoring];
    var outcome = res.trace ? practiceOutcome(state.scoring) : saveOutcome(res, state.saved, state.scoring);
    $('singleHead').hidden = !!res.trace;
    $('dualHead').hidden = !res.trace;
    if (res.trace) {
      // Two grades: against the guide, and as a circle judged like free drawing.
      $('guideGrade').textContent = S.grade(res);
      $('guideScore').style.setProperty('--score-color', S.color(res));
      setUnit('guideUnit', S);
      $('traceBest').hidden = !outcome.isBest;
      var fit = res.fit;
      $('fitGrade').textContent = fit.ok ? S.grade(fit) : 'Not judged';
      $('fitScore').style.setProperty('--score-color', fit.ok ? S.color(fit) : 'var(--muted)');
      $('fitUnit').hidden = !fit.ok;
      setUnit('fitUnit', S);
    } else {
      $('grade').textContent = S.grade(res);
      $('score').style.setProperty('--score-color', S.color(res));
      setUnit('scoreUnit', S);
      $('newBest').hidden = !outcome.isBest;
    }
    $('savedNote').textContent = outcome.note;
    $('savedNote').classList.toggle('is-unsaved', !res.trace && !state.saved.saved);
    $('savedNote').classList.toggle('is-practice', !!res.trace);

    var tip = tipFor(res);
    $('tip').hidden = !tip;
    $('tip').textContent = tip || '';

    setTiles(res.trace ? traceTiles(res) : freehandTiles(res));
  }

  function overlapArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** Put the result card where it covers as little of the drawing as possible. */
  function placeCard() {
    var res = state.result;
    if (!res) return;
    var pad = 18;
    var box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    state.points.forEach(function (p) {
      box.left = Math.min(box.left, p.x); box.right = Math.max(box.right, p.x);
      box.top = Math.min(box.top, p.y); box.bottom = Math.max(box.bottom, p.y);
    });
    if (res.trace) {
      box.left = Math.min(box.left, res.center.x - res.radius); box.right = Math.max(box.right, res.center.x + res.radius);
      box.top = Math.min(box.top, res.center.y - res.radius); box.bottom = Math.max(box.bottom, res.center.y + res.radius);
    }
    box.left -= pad; box.top -= pad; box.right += pad; box.bottom += pad;

    var options = state.width >= 900 ? ['right', 'left', 'bottom', 'top'] : ['bottom', 'top'];
    var best = options[0], bestOverlap = Infinity;
    for (var i = 0; i < options.length; i++) {
      card.dataset.place = options[i];
      var ov = overlapArea(card.getBoundingClientRect(), box);
      if (ov < bestOverlap - 1) { bestOverlap = ov; best = options[i]; }
    }
    card.dataset.place = best;
  }

  /** Save the circle if its ends meet, remembering the stats as they were before it. */
  function recordCircle(res, input) {
    var before = { score: store.summary({ metric: 'score' }), bits: store.summary({ metric: 'bits' }) };
    var rec = store.add(res, state.points, { input: input });
    if (rec) updateBestChip();
    return { saved: !!rec, before: before };
  }

  /** How this circle compares with the saved stats, in the given scoring mode. */
  function saveOutcome(res, saved, mode) {
    var S = SCORING[mode];
    if (!saved.saved) return { isBest: false, note: 'Not saved to your stats: only closed circles count.' };
    var before = saved.before[S.metric];
    if (!before.count) return { isBest: true, note: 'Saved: your first circle in your stats.' };
    var value = S.value(res), diff = value - before.average;
    var how = Math.abs(diff) < S.same ? 'right on' : S.diff(Math.abs(diff)) + (diff > 0 ? ' above' : ' below');
    return {
      isBest: value > before.best,
      note: 'Saved: ' + how + ' your average of ' + S.full(before.average) + ' (' + (before.count + 1) + ' circles now).'
    };
  }

  function average(list) {
    return list.length ? list.reduce(function (a, b) { return a + b; }, 0) / list.length : null;
  }

  /** Session tally for trace practice (traces are not saved to the stats). */
  function practiceOutcome(mode) {
    var S = SCORING[mode];
    var guide = state.practice.map(function (p) { return p.guide[S.metric]; });
    var circle = state.practice.filter(function (p) { return p.circle; }).map(function (p) { return p.circle[S.metric]; });
    var n = guide.length;
    var current = guide[n - 1];
    var previousBest = n > 1 ? Math.max.apply(null, guide.slice(0, -1)) : null;
    var note = 'Practice, not saved to your stats. ';
    if (n === 1) {
      note += 'First trace this session.';
    } else {
      note += n + ' traces this session, averaging ' + S.full(average(guide)) + ' against the guide' +
        (circle.length ? ' and ' + S.full(average(circle)) + ' as a circle.' : '.');
    }
    return { isBest: n > 1 && current > previousBest, note: note };
  }

  function showResult(res, input) {
    state.result = res;
    state.mode = 'result';
    state.pieceColors = state.points.map(function (p) {
      return deviationColor(CircleFit.relativeDeviation(res, p.x, p.y));
    });

    if (res.trace) {
      state.saved = null;
      state.practice.push({
        guide: { score: res.score, bits: res.precision.bits },
        circle: res.fit.ok ? { score: res.fit.score, bits: res.fit.precision.bits } : null
      });
    } else {
      state.saved = recordCircle(res, input);
    }
    fillCard(res);
    card.hidden = false;
    placeCard();
    void card.offsetWidth; // let the entrance transition run
    card.classList.add('is-visible');
    announce.textContent = res.trace
      ? 'Against the guide: ' + SCORING[state.scoring].speak(res) +
        (res.fit.ok ? ' As a circle: ' + SCORING[state.scoring].speak(res.fit) : '')
      : SCORING[state.scoring].speak(res);

    var token = ++state.animToken;
    var duration = reduceMotion.matches ? 0 : 800;
    var startTime = null;
    function frame(now) {
      if (token !== state.animToken) return;
      if (startTime == null) startTime = now;
      var t = duration ? clamp((now - startTime) / duration, 0, 1) : 1;
      state.anim = easeOutCubic(t);
      renderScoreText(res, state.anim);
      render();
      if (t < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  // ---------- Input ----------

  function pointFrom(e) {
    return { x: e.clientX - state.originX, y: e.clientY - state.originY, t: e.timeStamp };
  }

  function addPoint(p) {
    var pts = state.points, last = pts[pts.length - 1];
    if (last && last.x === p.x && last.y === p.y) return;
    pts.push(p);
  }

  function setPencilOnly(on) {
    state.pencilOnly = on;
    pencilChip.setAttribute('aria-pressed', on ? 'true' : 'false');
    $('pencilLabel').textContent = on ? 'Pencil only' : 'Pencil + touch';
  }

  function notePen() {
    if (state.penSeen) return;
    state.penSeen = true;
    pencilChip.hidden = false;
    setPencilOnly(true); // palm rejection: ignore finger/hand touches from now on
  }

  function startStroke(e) {
    var rect = canvas.getBoundingClientRect();
    state.originX = rect.left;
    state.originY = rect.top;
    state.animToken++;
    state.mode = 'drawing';
    state.pointerId = e.pointerId;
    state.pointerType = e.pointerType;
    state.points = [];
    state.result = null;
    state.pieceColors = null;
    state.attemptTarget = state.trace.on ? currentTarget() : null;
    hideCard();
    hideToast();
    hint.classList.add('is-hidden');
    addPoint(pointFrom(e));
    requestRender();
  }

  function finishStroke() {
    if (state.pointerId == null) return;
    try { canvas.releasePointerCapture(state.pointerId); } catch (err) { /* already released */ }
    var input = state.pointerType;
    state.pointerId = null;
    state.pointerType = null;

    var pts = state.points;
    if (pts.length < 4 || CircleFit.pathLength(pts) < 12) {
      clearBoard(); // a tap or a tiny scribble just clears the board
      return;
    }
    var res = state.attemptTarget ? CircleFit.analyzeTrace(pts, state.attemptTarget) : CircleFit.analyze(pts);
    if (!res.ok) {
      state.mode = 'error';
      render();
      showToast(res.message);
      announce.textContent = res.message;
      return;
    }
    showResult(res, input);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen') notePen();
    if (e.pointerType === 'touch' && state.pencilOnly) return;

    if (state.pointerId != null) {
      // A palm can land just before the pencil does: let the pencil take over.
      if (!(e.pointerType === 'pen' && state.pointerType !== 'pen')) return;
      try { canvas.releasePointerCapture(state.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    startStroke(e);
  }

  function onPointerMove(e) {
    if (e.pointerId !== state.pointerId) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) { finishStroke(); return; }
    e.preventDefault();
    var events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (!events || !events.length) events = [e];
    for (var i = 0; i < events.length; i++) addPoint(pointFrom(events[i]));
    requestRender();
  }

  function onPointerUp(e) {
    if (e.pointerId !== state.pointerId) return;
    addPoint(pointFrom(e));
    finishStroke();
  }

  function onPointerCancel(e) {
    if (e.pointerId !== state.pointerId) return;
    finishStroke();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // iPad Safari: stop scrolling, zooming, the magnifier and Scribble from
  // hijacking a stroke. Pointer events still fire normally.
  ['touchstart', 'touchmove', 'touchend'].forEach(function (type) {
    canvas.addEventListener(type, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); });
  });

  window.addEventListener('blur', function () {
    if (state.pointerId != null) finishStroke();
  });

  // ---------- Controls ----------

  $('againBtn').addEventListener('click', clearBoard);

  traceBtn.addEventListener('click', function () { setTraceMode(!state.trace.on); });
  traceSize.addEventListener('input', function () { setTraceRadius(parseFloat(traceSize.value)); });
  $('traceRandom').addEventListener('click', randomTraceRadius);
  traceHide.addEventListener('change', function () {
    state.trace.hide = traceHide.checked;
    saveTrace();
  });

  pencilChip.addEventListener('click', function () {
    setPencilOnly(!state.pencilOnly);
    showToast(state.pencilOnly ? 'Pencil only: touches from your hand are ignored.' : 'Finger drawing is on.');
  });

  $('statsBtn').addEventListener('click', statsView.open);
  Array.prototype.forEach.call(document.querySelectorAll('[data-scoring]'), function (btn) {
    btn.addEventListener('click', function () { setScoring(btn.getAttribute('data-scoring')); });
  });
  $('cardStatsBtn').addEventListener('click', statsView.open);

  // Another tab saved a circle: pick it up.
  window.addEventListener('storage', function (e) {
    if (e.key !== CircleStats.STORAGE_KEY && e.key !== null) return;
    store.reload();
    updateBestChip();
    if (statsView.isOpen()) statsView.refresh();
  });

  $('helpBtn').addEventListener('click', function () {
    if (typeof help.showModal === 'function') help.showModal();
    else help.setAttribute('open', '');
  });
  help.addEventListener('click', function (e) {
    if (e.target === help && typeof help.close === 'function') help.close(); // click on backdrop
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !help.open && !statsDialog.open && state.mode !== 'drawing') clearBoard();
  });

  function onSchemeChange() {
    readColors();
    if (state.result) {
      state.pieceColors = state.points.map(function (p) {
        return deviationColor(CircleFit.relativeDeviation(state.result, p.x, p.y));
      });
    }
    render();
  }
  if (darkScheme.addEventListener) darkScheme.addEventListener('change', onSchemeChange);
  else if (darkScheme.addListener) darkScheme.addListener(onSchemeChange);

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener('resize', resize);
  }
  window.addEventListener('orientationchange', function () { window.setTimeout(resize, 250); });

  readColors();
  setScoring(state.scoring);
  resize();
})();
