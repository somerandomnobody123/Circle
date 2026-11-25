/*
 * app.js — drawing surface and result display for Circle Judge.
 * Input uses Pointer Events, so a mouse, trackpad, finger and Apple Pencil all work.
 */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var STROKE_WIDTH = 4;
  var BEST_KEY = 'circle-judge:best';
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

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('board');
  var ctx = canvas.getContext('2d');
  var hint = $('hint');
  var toast = $('toast');
  var card = $('card');
  var announce = $('announce');
  var help = $('help');
  var pencilChip = $('pencilChip');

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
    best: loadBest()
  };

  // ---------- Utilities ----------

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function loadBest() {
    try {
      var v = parseFloat(window.localStorage.getItem(BEST_KEY));
      return isFinite(v) ? v : null;
    } catch (e) { return null; }
  }

  function saveBest(v) {
    try { window.localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* storage unavailable */ }
  }

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
    render();
    if (state.mode === 'result') placeCard();
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
    ctx.arc(cx, cy, r, start, start + res.direction * TAU * progress, res.direction < 0);
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
      if (r >= 90) pill((cx + ex) / 2, (cy + ey) / 2, 'avg r ' + Math.round(r) + ' px');
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
    hint.classList.remove('is-hidden');
    render();
  }

  function updateBestChip() {
    $('bestValue').textContent = state.best == null ? '—' : state.best.toFixed(1) + '%';
  }

  function gradeFor(score) {
    for (var i = 0; i < GRADES.length; i++) if (score >= GRADES[i][0]) return GRADES[i][1];
    return GRADES[GRADES.length - 1][1];
  }

  function scoreColorVar(score) {
    return score >= 85 ? 'var(--good-text)' : score >= 60 ? 'var(--mid-text)' : 'var(--bad-text)';
  }

  function tipFor(res) {
    if (!res.closed && res.gapDegrees >= 8) {
      return 'Close the loop: there’s a ' + Math.round(res.gapDegrees) + '° gap between your start and finish.';
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

  function setStat(id, main, sub) {
    var el = $(id);
    el.textContent = main;
    if (sub) {
      var small = document.createElement('small');
      small.textContent = ' ' + sub;
      el.appendChild(small);
    }
  }

  function fmt(v) { return v >= 100 ? v.toFixed(0) : v.toFixed(1); }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  function fillCard(res, isBest) {
    $('grade').textContent = gradeFor(res.score);
    $('score').style.setProperty('--score-color', scoreColorVar(res.score));
    $('newBest').hidden = !isBest;

    var tip = tipFor(res);
    $('tip').hidden = !tip;
    $('tip').textContent = tip || '';

    setStat('statRadius', fmt(res.radius) + ' px');
    setStat('statRms', '±' + fmt(res.rms) + ' px', pct(res.relativeRms));
    setStat('statMax', fmt(Math.abs(res.maxDeviation)) + ' px',
      pct(Math.abs(res.maxDeviation) / res.radius) + (res.maxDeviation >= 0 ? ' out' : ' in'));
    setStat('statPtv', fmt(res.peakToValley) + ' px', pct(res.peakToValley / res.radius));
    if (res.closed) {
      var extra = res.sweptDegrees - 360;
      setStat('statLoop', 'Closed', extra >= 5 ? '+' + Math.round(extra) + '°' : null);
    } else {
      setStat('statLoop', 'Gap', Math.round(res.gapDegrees) + '°');
    }
    setStat('statTime', res.duration == null ? '—' : (res.duration / 1000).toFixed(1) + ' s');
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

  function showResult(res) {
    state.result = res;
    state.mode = 'result';
    state.pieceColors = state.points.map(function (p) {
      return deviationColor(CircleFit.relativeDeviation(res, p.x, p.y));
    });

    var isBest = state.best == null || res.score > state.best;
    if (isBest) {
      state.best = res.score;
      saveBest(res.score);
      updateBestChip();
    }

    fillCard(res, isBest);
    card.hidden = false;
    placeCard();
    void card.offsetWidth; // let the entrance transition run
    card.classList.add('is-visible');
    announce.textContent = 'Score ' + res.score.toFixed(1) + ' percent. ' + gradeFor(res.score) + '.';

    var token = ++state.animToken;
    var duration = reduceMotion.matches ? 0 : 800;
    var scoreEl = $('scoreValue');
    var startTime = null;
    function frame(now) {
      if (token !== state.animToken) return;
      if (startTime == null) startTime = now;
      var t = duration ? clamp((now - startTime) / duration, 0, 1) : 1;
      state.anim = easeOutCubic(t);
      scoreEl.textContent = (res.score * state.anim).toFixed(1);
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
    hideCard();
    hideToast();
    hint.classList.add('is-hidden');
    addPoint(pointFrom(e));
    requestRender();
  }

  function finishStroke() {
    if (state.pointerId == null) return;
    try { canvas.releasePointerCapture(state.pointerId); } catch (err) { /* already released */ }
    state.pointerId = null;
    state.pointerType = null;

    var pts = state.points;
    if (pts.length < 4 || CircleFit.pathLength(pts) < 12) {
      clearBoard(); // a tap or a tiny scribble just clears the board
      return;
    }
    var res = CircleFit.analyze(pts);
    if (!res.ok) {
      state.mode = 'error';
      render();
      showToast(res.message);
      announce.textContent = res.message;
      return;
    }
    showResult(res);
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

  pencilChip.addEventListener('click', function () {
    setPencilOnly(!state.pencilOnly);
    showToast(state.pencilOnly ? 'Pencil only: touches from your hand are ignored.' : 'Finger drawing is on.');
  });

  $('helpBtn').addEventListener('click', function () {
    if (typeof help.showModal === 'function') help.showModal();
    else help.setAttribute('open', '');
  });
  help.addEventListener('click', function (e) {
    if (e.target === help && typeof help.close === 'function') help.close(); // click on backdrop
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !help.open && state.mode !== 'drawing') clearBoard();
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
  updateBestChip();
  resize();
})();
