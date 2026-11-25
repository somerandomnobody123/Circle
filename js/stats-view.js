/*
 * stats-view.js — the "Your circle stats" panel: headline numbers, a score
 * trend, accuracy averages, score spread, breakdowns, recent circles and a
 * table of every saved circle. Charts are plain SVG, styled by CSS variables
 * so they follow light and dark mode.
 */
(function (root) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var TREND_MAX = 100;   // circles shown in the trend chart
  var THUMBS_MAX = 24;
  var TABLE_MAX = 100;

  var INPUT_SHORT = { pen: 'Pencil', touch: 'Finger', mouse: 'Mouse', other: 'Other' };

  // How each scoring metric is labelled and formatted.
  var METRIC = {
    score: {
      noun: 'score',
      Noun: 'Score',
      fmt: function (v) { return v.toFixed(1) + '%'; },
      diff: function (v) { return v.toFixed(1); },
      spread: function (v) { return '\u00b1' + v.toFixed(1); },
      histTitle: 'How your scores spread',
      histSub: 'Number of circles in each 5-point band',
      range: function (b) {
        if (!isFinite(b.from)) return 'Under ' + b.to;
        if (!isFinite(b.to)) return b.from + '\u2013100';
        return b.from + '\u2013' + b.to;
      },
      scale: function () { return 100; }
    },
    bits: {
      noun: 'precision',
      Noun: 'Precision',
      fmt: function (v) { return v.toFixed(2) + ' bits'; },
      diff: function (v) { return v.toFixed(2) + ' bits'; },
      spread: function (v) { return '\u00b1' + v.toFixed(2) + ' bits'; },
      histTitle: 'How your precision spreads',
      histSub: 'Number of circles in each half-bit band',
      range: function (b) {
        if (!isFinite(b.from)) return 'Under ' + b.to + ' bits';
        if (!isFinite(b.to)) return b.from + ' bits or more';
        return b.from + '\u2013' + b.to + ' bits';
      },
      // Meter bars run from 0 to 10 bits (1 part in 1,024), or further if needed.
      scale: function (values) { return Math.max(10, Math.ceil(Math.max.apply(null, values))); }
    }
  };
  var GROUP_TITLES = { input: 'Drawn with', dir: 'Direction', size: 'Size' };

  // ---------- Small helpers ----------

  function svg(name, attrs, parent) {
    var node = document.createElementNS(SVGNS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(name, className, text, parent) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function pct(v) { return v == null || !isFinite(v) ? '—' : v.toFixed(1) + '%'; }
  function plural(n, word) { return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's'); }

  function shortDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function dateTime(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function ago(ms, now) {
    var s = Math.max(0, (now - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return shortDate(ms);
  }

  function niceStep(span, maxTicks) {
    var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= maxTicks) return steps[i];
    return Math.ceil(span / maxTicks);
  }

  /** Column path: 4px rounded data end, square at the baseline. */
  function columnPath(x, top, w, base) {
    var r = Math.min(4, w / 2, base - top);
    return 'M' + x + ',' + base + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + top + ' ' + (x + w) + ',' + (top + r) + 'V' + base + 'Z';
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- Tooltip ----------

  function makeTip(container) {
    var tip = html('div', 'chart-tip', null, container);
    tip.setAttribute('role', 'presentation');
    return {
      show: function (title, rows, x, y) {
        tip.textContent = '';
        html('div', 'tip-title', title, tip);
        rows.forEach(function (row) {
          var line = html('div', 'tip-row', null, tip);
          html('i', 'tip-key ' + row.key, null, line);
          html('strong', null, row.value, line);
          html('span', null, row.label, line);
        });
        tip.classList.add('is-visible');
        var cw = container.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
        var left = x + 14;
        if (left + tw > cw - 4) left = x - tw - 14;
        tip.style.left = Math.max(4, left) + 'px';
        tip.style.top = Math.max(0, y - th / 2) + 'px';
      },
      hide: function () { tip.classList.remove('is-visible'); }
    };
  }

  // ---------- Charts ----------

  /** Each circle's score as a gray dot, with the rolling average as the accent line. */
  function renderTrend(container, summary, M) {
    container.textContent = '';
    var series = summary.series.slice(-TREND_MAX);
    if (!series.length) return;
    var width = Math.max(260, container.clientWidth);
    var height = 220;
    var m = { top: 14, right: 74, bottom: 30, left: 34 };
    var w = width - m.left - m.right, h = height - m.top - m.bottom;

    var low = 100;
    var high = -Infinity;
    series.forEach(function (p) {
      low = Math.min(low, p.value, p.rolling);
      high = Math.max(high, p.value, p.rolling);
    });
    var lo, hi, yStep;
    if (summary.metric === 'bits') {
      lo = Math.max(0, Math.floor(low - 0.25));
      hi = Math.max(lo + 2, Math.ceil(high + 0.25));
      yStep = niceStep(hi - lo, 5);
      hi = lo + Math.ceil((hi - lo) / yStep) * yStep;
    } else {
      lo = Math.max(0, Math.floor((low - 2) / 10) * 10);
      if (100 - lo < 20) lo = 80;
      hi = 100;
      yStep = hi - lo > 50 ? 20 : 10;
    }
    var x = function (i) { return m.left + (series.length === 1 ? w / 2 : (i / (series.length - 1)) * w); };
    var y = function (v) { return m.top + h - ((Math.min(v, hi) - lo) / (hi - lo)) * h; };

    var root = svg('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, class: 'chart-svg' }, container);
    root.setAttribute('tabindex', '0');
    var last = series[series.length - 1];
    root.setAttribute('aria-label', M.Noun + ' per circle for the last ' + plural(series.length, 'circle') +
      '. Latest ' + summary.rollingWindow + '-circle average ' + M.fmt(last.rolling) + '. Use the arrow keys to read each circle.');

    // Gridlines + y ticks.
    for (var t = lo; t <= hi + 1e-9; t += yStep) {
      svg('line', { x1: m.left, x2: m.left + w, y1: y(t), y2: y(t), class: t === lo ? 'axis-line' : 'grid-line' }, root);
      svg('text', { x: m.left - 8, y: y(t), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, root).textContent = t;
    }
    // X ticks: circle numbers.
    var firstN = series[0].n, lastN = last.n;
    var xStep = niceStep(Math.max(1, lastN - firstN), Math.max(2, Math.floor(w / 70)));
    for (var n = Math.ceil(firstN / xStep) * xStep; n <= lastN; n += xStep) {
      svg('text', { x: x(n - firstN), y: m.top + h + 18, class: 'tick', 'text-anchor': 'middle' }, root).textContent = '#' + n;
    }

    // Each circle: de-emphasised dots with a surface ring.
    var dots = svg('g', { class: 'dots' }, root);
    series.forEach(function (p, i) {
      svg('circle', { cx: x(i), cy: y(p.value), r: 4, class: 'dot-muted' }, dots);
    });

    // Rolling average: the accent line, with an end dot and a direct label.
    if (series.length > 1) {
      var d = series.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.rolling).toFixed(1); }).join('');
      svg('path', { d: d, class: 'line-accent' }, root);
    }
    var ex = x(series.length - 1), ey = y(last.rolling);
    svg('circle', { cx: ex, cy: ey, r: 4.5, class: 'dot-accent' }, root);
    svg('text', { x: ex + 10, y: ey - 7, class: 'end-label' }, root).textContent = M.fmt(last.rolling);
    svg('text', { x: ex + 10, y: ey + 9, class: 'end-sub' }, root).textContent = 'average';

    // Hover / focus layer: a crosshair that snaps to the nearest circle.
    var cross = svg('line', { y1: m.top, y2: m.top + h, class: 'crosshair' }, root);
    var hilite = svg('circle', { r: 5, class: 'dot-hover' }, root);
    var tip = makeTip(container);
    var active = -1;
    function show(i) {
      active = i;
      var p = series[i], cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.classList.add('is-visible');
      hilite.setAttribute('cx', cx); hilite.setAttribute('cy', y(p.value));
      hilite.classList.add('is-visible');
      tip.show('Circle #' + p.n + ' · ' + shortDate(p.at), [
        { key: 'key-dot', value: M.fmt(p.value), label: M.noun },
        { key: 'key-line', value: M.fmt(p.rolling), label: summary.rollingWindow + '-circle average' }
      ], cx, y(p.value));
    }
    function hide() {
      active = -1;
      cross.classList.remove('is-visible');
      hilite.classList.remove('is-visible');
      tip.hide();
    }
    var hit = svg('rect', { x: m.left - 8, y: 0, width: w + 16, height: height, class: 'hit' }, root);
    function fromPointer(e) {
      var rect = root.getBoundingClientRect();
      var px = e.clientX - rect.left;
      var i = series.length === 1 ? 0 : Math.round(((px - m.left) / w) * (series.length - 1));
      show(Math.max(0, Math.min(series.length - 1, i)));
    }
    hit.addEventListener('pointermove', fromPointer);
    hit.addEventListener('pointerdown', fromPointer);
    hit.addEventListener('pointerleave', hide);
    root.addEventListener('blur', hide);
    root.addEventListener('focus', function () { show(series.length - 1); });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        var next = (active < 0 ? series.length - 1 : active) + (e.key === 'ArrowLeft' ? -1 : 1);
        show(Math.max(0, Math.min(series.length - 1, next)));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        show(e.key === 'Home' ? 0 : series.length - 1);
      }
    });
  }

  /** Histogram of scores: one hue, counts on the caps. */
  function renderHistogram(container, summary, M) {
    container.textContent = '';
    var bins = summary.histogram;
    var total = bins.reduce(function (s, b) { return s + b.count; }, 0);
    var width = Math.max(240, container.clientWidth);
    var height = 190;
    var m = { top: 22, right: 4, bottom: 28, left: 4 };
    var w = width - m.left - m.right, h = height - m.top - m.bottom;
    var slot = w / bins.length;
    var barW = Math.min(24, slot - 4);
    var maxCount = Math.max.apply(null, bins.map(function (b) { return b.count; })) || 1;
    var base = m.top + h;

    var root = svg('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, class: 'chart-svg' }, container);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', M.Noun + ' spread: ' + bins.filter(function (b) { return b.count; }).map(function (b) {
      return plural(b.count, 'circle') + ': ' + M.range(b);
    }).join(', ') + '.');

    var tip = makeTip(container);
    bins.forEach(function (b, i) {
      var cx = m.left + slot * i + slot / 2;
      if (b.count > 0) {
        var top = base - Math.max(2, (b.count / maxCount) * h);
        svg('path', { d: columnPath(cx - barW / 2, top, barW, base), class: 'bar' }, root);
        svg('text', { x: cx, y: top - 6, class: 'cap-label', 'text-anchor': 'middle' }, root).textContent = b.count;
      }
      svg('text', { x: cx, y: base + 18, class: 'tick', 'text-anchor': 'middle' }, root).textContent = b.label;
      var hit = svg('rect', { x: m.left + slot * i, y: 0, width: slot, height: height, class: 'hit' }, root);
      var range = M.range(b);
      var share = total ? Math.round((b.count / total) * 100) : 0;
      var showTip = function () {
        tip.show(range, [{ key: 'key-bar', value: plural(b.count, 'circle'), label: share + '% of saved' }], cx, base - h / 2);
      };
      hit.addEventListener('pointermove', showTip);
      hit.addEventListener('pointerdown', showTip);
      hit.addEventListener('pointerleave', tip.hide);
    });
    svg('line', { x1: m.left, x2: m.left + w, y1: base, y2: base, class: 'axis-line' }, root);
  }

  function renderBreakdowns(container, summary, M) {
    container.textContent = '';
    var all = [];
    ['input', 'dir', 'size'].forEach(function (kind) {
      summary.groups[kind].forEach(function (g) { all.push(g.average); });
    });
    var scale = M.scale(all);
    ['input', 'dir', 'size'].forEach(function (kind) {
      var rows = summary.groups[kind];
      if (!rows.length) return;
      var group = html('div', 'meter-group', null, container);
      html('h4', null, GROUP_TITLES[kind], group);
      var list = html('ul', 'meters', null, group);
      rows.forEach(function (row) {
        var li = html('li', 'meter', null, list);
        html('span', 'meter-name', row.label, li);
        var track = html('span', 'meter-track', null, li);
        track.setAttribute('role', 'meter');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(scale));
        track.setAttribute('aria-valuenow', row.average.toFixed(2));
        track.setAttribute('aria-label', row.label + ' average ' + M.noun);
        var fill = html('span', 'meter-fill', null, track);
        fill.style.width = Math.max(0, Math.min(100, (row.average / scale) * 100)) + '%';
        var fig = html('span', 'meter-figure', null, li);
        html('strong', null, M.fmt(row.average), fig);
        html('small', null, plural(row.count, 'circle') + ' · best ' + M.fmt(row.best), fig);
      });
    });
  }

  function renderAccuracy(container, summary) {
    container.textContent = '';
    var tiles = [
      ['Wobble (RMS)', pct(summary.wobble), 'off the average radius'],
      ['Biggest miss', pct(summary.miss), 'worst spot per circle'],
      ['Widest − narrowest', pct(summary.spread), 'out-of-round'],
      ['Oval', pct(summary.oval), 'longer one way'],
      ['Time', summary.duration == null ? '—' : (summary.duration / 1000).toFixed(1) + ' s', 'per circle']
    ];
    tiles.forEach(function (t) {
      var tile = html('div', 'kpi', null, container);
      html('span', 'kpi-label', t[0], tile);
      html('span', 'kpi-value', t[1], tile);
      html('span', 'kpi-note', t[2], tile);
    });
  }

  function renderThumbs(container, records, summary, now, M) {
    container.textContent = '';
    var withShapes = [];
    for (var i = records.length - 1; i >= 0 && withShapes.length < THUMBS_MAX; i--) {
      if (records[i].shape) withShapes.push({ rec: records[i], n: summary.archived + i + 1 });
    }
    withShapes.forEach(function (item) {
      var rec = item.rec;
      var li = html('li', 'thumb', null, container);
      li.title = 'Circle #' + item.n + ', ' + dateTime(rec.at);
      var s = svg('svg', { viewBox: '-125 -125 250 250', class: 'thumb-svg', 'aria-hidden': 'true' }, li);
      svg('circle', { cx: 0, cy: 0, r: 100, class: 'thumb-ref' }, s);
      var pts = rec.shape, d = '';
      for (var k = 0; k < pts.length; k += 2) d += (k ? 'L' : 'M') + pts[k] + ',' + pts[k + 1];
      svg('path', { d: d, class: 'thumb-path' }, s);
      html('span', 'thumb-score', M.fmt(CircleStats.metricOf(rec, summary.metric)), li);
      html('span', 'thumb-meta', INPUT_SHORT[rec.input] + ' · ' + ago(rec.at, now), li);
    });
  }

  function renderTable(table, note, records, summary) {
    table.textContent = '';
    var head = html('thead', null, null, table);
    var hr = html('tr', null, null, head);
    ['#', 'When', 'Score', 'Precision', 'Wobble', 'Biggest miss', 'Oval', 'Radius', 'Time', 'Drawn with', 'Direction'].forEach(function (h) {
      var th = html('th', null, h, hr);
      th.scope = 'col';
    });
    var body = html('tbody', null, null, table);
    var start = Math.max(0, records.length - TABLE_MAX);
    for (var i = records.length - 1; i >= start; i--) {
      var r = records[i];
      var tr = html('tr', null, null, body);
      [
        summary.archived + i + 1,
        dateTime(r.at),
        r.score.toFixed(1) + '%',
        CircleStats.metricOf(r, 'bits').toFixed(2) + ' bits',
        r.wobble.toFixed(1) + '%',
        r.miss.toFixed(1) + '%',
        r.oval.toFixed(1) + '%',
        Math.round(r.radius) + ' px',
        r.duration == null ? '—' : (r.duration / 1000).toFixed(1) + ' s',
        INPUT_SHORT[r.input],
        r.dir === 'cw' ? 'Clockwise' : 'Counter-clockwise'
      ].forEach(function (v) { html('td', null, String(v), tr); });
    }
    note.textContent = records.length > TABLE_MAX
      ? 'Showing the latest ' + TABLE_MAX + ' of ' + records.length.toLocaleString() + '. Export to get them all.'
      : '';
  }

  // ---------- Panel ----------

  function create(options) {
    var store = options.store;
    var getMetric = options.getMetric || function () { return 'score'; };
    var dialog = options.dialog;
    var onChange = options.onChange || function () {};
    var $ = function (id) { return document.getElementById(id); };
    var clearArmed = 0;
    var resizeQueued = false;

    function setKpi(id, value, noteId, note, tone) {
      $(id).textContent = value;
      var n = $(noteId);
      n.textContent = note || '';
      n.className = 'kpi-note' + (tone ? ' ' + tone : '');
    }

    function refresh() {
      var now = Date.now();
      var metric = getMetric();
      var M = METRIC[metric];
      var s = store.summary({ metric: metric, now: now });
      var empty = !s.count;
      $('statsEmpty').hidden = !empty;
      $('statsBody').hidden = empty;
      $('statsSub').textContent = empty
        ? 'Closed circles you draw are saved on this device.'
        : plural(s.count, 'closed circle') + ' saved on this device since ' + shortDate(s.firstAt) + '.';
      disarmClear();
      if (empty) return;

      $('kpiAverageLabel').textContent = 'Average ' + M.noun;
      setKpi('kpiAverage', M.fmt(s.average), 'kpiAverageNote', 'typical spread ' + M.spread(s.stdev));
      setKpi('kpiCount', s.count.toLocaleString(), 'kpiCountNote', s.today.count ? s.today.count + ' today' : 'none today');
      setKpi('kpiBest', M.fmt(s.best), 'kpiBestNote', s.bestAt == null ? '' : shortDate(s.bestAt));
      $('kpiRecentLabel').textContent = s.last10.count < 10 ? 'Last ' + plural(s.last10.count, 'circle') : 'Last 10 circles';
      if (s.count > s.last10.count) {
        var delta = s.last10.average - s.average;
        var up = delta >= 0;
        setKpi('kpiRecent', M.fmt(s.last10.average), 'kpiRecentNote',
          (up ? '▲ +' : '▼ −') + M.diff(Math.abs(delta)) + ' vs all-time',
          Math.abs(delta) < 0.005 ? '' : up ? 'is-up' : 'is-down');
      } else {
        setKpi('kpiRecent', M.fmt(s.last10.average), 'kpiRecentNote', 'trend shows after 10 circles');
      }

      $('trendTitle').textContent = M.Noun + ' per circle' + (s.series.length > TREND_MAX ? ' (last ' + TREND_MAX + ')' : '');
      $('histTitle').textContent = M.histTitle;
      $('histSub').textContent = M.histSub;
      $('breakdownTitle').textContent = 'Average ' + M.noun + ' by…';
      $('rollingLabel').textContent = s.rollingWindow + '-circle average';
      renderTrend($('trendChart'), s, M);
      renderAccuracy($('accuracy'), s);
      renderHistogram($('histChart'), s, M);
      renderBreakdowns($('breakdowns'), s, M);
      var records = store.records();
      renderThumbs($('thumbs'), records, s, now, M);
      renderTable($('dataTable'), $('tableNote'), records, s);

      var notes = [];
      if (!store.isPersistent()) notes.push('This browser isn’t letting the page save data, so these stats will be lost when you close it.');
      if (s.archived) notes.push(plural(s.archived, 'older circle') + ' are counted in the averages but no longer listed individually.');
      $('storageNote').textContent = notes.join(' ');
      $('storageNote').hidden = !notes.length;
    }

    function disarmClear() {
      clearTimeout(clearArmed);
      clearArmed = 0;
      $('clearStats').textContent = 'Clear stats';
      $('clearStats').classList.remove('is-armed');
    }

    $('clearStats').addEventListener('click', function () {
      if (!clearArmed) {
        var btn = $('clearStats');
        btn.textContent = 'Delete all ' + plural(store.count(), 'circle') + '?';
        btn.classList.add('is-armed');
        clearArmed = setTimeout(disarmClear, 4000);
        return;
      }
      store.clear();
      refresh();
      onChange();
    });

    var stamp = function () { return new Date().toISOString().slice(0, 10); };
    $('exportCsv').addEventListener('click', function () {
      download('circle-stats-' + stamp() + '.csv', store.toCSV(), 'text/csv');
    });
    $('exportJson').addEventListener('click', function () {
      download('circle-stats-' + stamp() + '.json', store.toJSON(), 'application/json');
    });

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog && typeof dialog.close === 'function') dialog.close(); // backdrop
    });
    dialog.addEventListener('close', disarmClear);

    window.addEventListener('resize', function () {
      if (!dialog.open || resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () {
        resizeQueued = false;
        if (dialog.open) refresh();
      });
    });

    return {
      open: function () {
        store.reload();
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        dialog.scrollTop = 0;
        refresh(); // after opening, so charts can measure their width
      },
      refresh: refresh,
      isOpen: function () { return !!dialog.open; }
    };
  }

  root.StatsView = { create: create };
})(typeof self !== 'undefined' ? self : this);
