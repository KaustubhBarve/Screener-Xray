/**
 * Screener X-Ray — inline SVG charts.
 *
 * Hand-rolled, zero dependencies (CLAUDE.md rule 1). Modelled on the chart
 * language used in institutional equity research: flat two-tone fills, a title
 * with a rule beneath it, horizontal gridlines only, no plot border, the legend
 * below the plot, and a source line under that.
 *
 * Null handling is the part that matters. A period Screener did not report
 * draws NOTHING — no bar, and a break in the line. It is never plotted as zero,
 * because a zero bar and an absent bar say different things about a company.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  // Defaults, overridden at draw time by the page's own custom properties so
  // the charts and the prose are coloured from a single source. Change the
  // palette in report.css and the charts follow.
  var PALETTE = {
    primary: '#4782B5',     // reported series
    secondary: '#A8DBF0',   // supporting series
    derived: '#548CD4',     // series we calculated rather than read
    deep: '#0D4070',        // a line that must read over blue bars
    ink: '#333333',
    muted: '#7F807F',
    grid: '#D9D9D9',
    rule: '#BABDC2'
  };

  var CSS_VARS = {
    primary: '--steel', secondary: '--sky', derived: '--blue',
    deep: '--navy-mid', ink: '--ink', muted: '--muted',
    grid: '--rule-soft', rule: '--rule'
  };

  /** Resolve the live palette from the stylesheet, falling back to the above. */
  function palette() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
      return PALETTE;
    }
    var style = getComputedStyle(document.documentElement);
    var out = {}, k;
    for (k in CSS_VARS) {
      if (!Object.prototype.hasOwnProperty.call(CSS_VARS, k)) continue;
      var v = style.getPropertyValue(CSS_VARS[k]);
      out[k] = (v && v.trim()) || PALETTE[k];
    }
    return out;
  }

  /** Enough distinct fills for a stack; ordered dark to light so it reads. */
  function STACK_COLOURS(p) {
    return [p.primary, p.secondary, p.deep, p.derived, p.grid];
  }

  /**
   * A chart's caption, carrying its unit.
   *
   * Charts inherited the same fault the tables had: an axis of bare numbers
   * with nothing saying whether they are rupees, percent or days.
   */
  function caption(title, unit) {
    var cap = document.createElement('figcaption');
    cap.className = 'chart-title';
    cap.appendChild(document.createTextNode(title));
    if (unit) {
      var note = document.createElement('span');
      note.className = 'unit-note';
      note.textContent = unit;
      cap.appendChild(note);
    }
    return cap;
  }

  function el(tag, className, txt) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (txt !== undefined && txt !== null) node.textContent = txt;
    return node;
  }

  function svgEl(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  function text(x, y, str, attrs) {
    var t = svgEl('text', attrs || {});
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.textContent = str;
    return t;
  }

  // ---------------------------------------------------------------------------
  // scales
  // ---------------------------------------------------------------------------

  /**
   * Axis ticks at human-readable intervals (1, 2, 5 x 10^n) spanning the data.
   *
   * The domain always includes zero: these are financial magnitudes, and a bar
   * chart whose baseline floats somewhere above zero exaggerates every
   * difference on it.
   */
  function niceTicks(min, max, target) {
    var lo = Math.min(0, min);
    var hi = Math.max(0, max);
    if (lo === hi) hi = lo + 1;

    var raw = (hi - lo) / (target || 4);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;

    var start = Math.floor(lo / step) * step;
    var end = Math.ceil(hi / step) * step;
    var ticks = [];
    for (var v = start; v <= end + step * 1e-9; v += step) {
      ticks.push(Number(v.toPrecision(12)));
    }
    return ticks;
  }

  /**
   * An x-axis label. Annual periods drop their month ("Mar 2026" -> "2026").
   * Quarters keep it ("Jun 2026" -> "Jun '26"): stripping the month from a
   * quarterly axis prints the same year four times.
   */
  function xLabel(p, format) {
    var s = String(p);
    if (format === 'quarter') {
      var m = /^([A-Za-z]{3}) \d{2}(\d{2})$/.exec(s);
      return m ? m[1] + " '" + m[2] : s;
    }
    return s.replace(/^([A-Za-z]{3}) /, '');
  }

  /** Compact axis labels: 35584 -> "35.6k", 351819 -> "3.5L" (Indian lakh). */
  function compact(v) {
    var abs = Math.abs(v);
    if (abs >= 1e7) return (v / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
    if (abs >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
    if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (abs > 0 && abs < 1) return String(Number(v.toFixed(2)));
    return String(Math.round(v));
  }

  /**
   * Every reported value across the plotted series. Nulls are not values.
   *
   * When bars are stacked the axis has to cover each column's TOTAL, not its
   * tallest single component, or the stack runs off the top of the plot.
   */
  function extent(series, stacked) {
    var vals = [];
    if (stacked) {
      var n = 0;
      series.forEach(function (s) { n = Math.max(n, s.values.length); });
      for (var i = 0; i < n; i++) {
        var pos = 0, neg = 0, seen = false;
        series.forEach(function (s) {
          var v = s.values[i];
          if (v === null || !Number.isFinite(v)) return;
          seen = true;
          if (v >= 0) pos += v; else neg += v;
        });
        if (seen) { vals.push(pos); vals.push(neg); }
      }
    } else {
      series.forEach(function (s) {
        s.values.forEach(function (v) { if (v !== null && Number.isFinite(v)) vals.push(v); });
      });
    }
    if (!vals.length) return null;
    return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  var api = {
    PALETTE: PALETTE,
    palette: palette,
    niceTicks: niceTicks,
    compact: compact,
    xLabel: xLabel,
    extent: extent
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;                                    // node --test stops here
  }

  /**
   * Draw a chart.
   *
   * opts = {
   *   title, source, periods: [...],
   *   series: [{ label, values, type: 'bar'|'line', color, derived }],
   *   width, height, format
   * }
   *
   * Returns a <figure>, or a "not reported" note when nothing is plottable.
   */
  function draw(opts) {
    var PALETTE = palette();               // live, from report.css
    var fig = document.createElement('figure');
    fig.className = 'chart';

    fig.appendChild(caption(opts.title, opts.unit));

    var leftSeries = opts.series.filter(function (s) { return s.axis !== 'right'; });
    var rightSeries = opts.series.filter(function (s) { return s.axis === 'right'; });

    var stacked = !!opts.stacked;
    var span = extent(leftSeries.length ? leftSeries : opts.series, stacked);
    if (!span) {
      var none = document.createElement('p');
      none.className = 'absent chart-empty';
      none.textContent = 'not reported';
      fig.appendChild(none);
      return fig;
    }

    var rightSpan = rightSeries.length ? extent(rightSeries) : null;

    var W = opts.width || 330;
    var H = opts.height || 150;
    var PAD = { top: 8, right: rightSpan ? 30 : 6, bottom: 34, left: 34 };
    var plotW = W - PAD.left - PAD.right;
    var plotH = H - PAD.top - PAD.bottom;

    function scaleFor(sp) {
      var t = niceTicks(sp.min, sp.max, 4);
      var lo = t[0], hi = t[t.length - 1];
      return {
        ticks: t,
        y: function (v) { return PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH; }
      };
    }

    var left = scaleFor(span);
    var right = rightSpan ? scaleFor(rightSpan) : null;
    var ticks = left.ticks;
    var y = left.y;

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      width: '100%',
      role: 'img',
      'aria-label': opts.title
    });

    // gridlines and y labels — horizontal only, no plot border
    ticks.forEach(function (t) {
      svg.appendChild(svgEl('line', {
        x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t),
        stroke: t === 0 ? PALETTE.rule : PALETTE.grid, 'stroke-width': t === 0 ? 1 : 0.5
      }));
      svg.appendChild(text(PAD.left - 4, y(t) + 3, compact(t), {
        'text-anchor': 'end', 'font-size': '7.5', fill: PALETTE.muted
      }));
    });

    // right-hand axis labels, when a second scale is in play
    if (right) {
      right.ticks.forEach(function (t) {
        svg.appendChild(text(W - PAD.right + 4, right.y(t) + 3,
          compact(t) + (opts.rightUnit || ''), {
            'text-anchor': 'start', 'font-size': '7.5', fill: PALETTE.muted
          }));
      });
    }

    var n = opts.periods.length;
    var slot = plotW / n;
    // An area is a line that also fills; it belongs with the strokes, not the
    // bars, or it would be drawn as a column and the fill would never appear.
    var isStroke = function (s) { return s.type === 'line' || s.type === 'area'; };
    var bars = opts.series.filter(function (s) { return !isStroke(s); });
    var lines = opts.series.filter(isStroke);
    var yFor = function (s) { return s.axis === 'right' && right ? right.y : y; };

    // Bars: grouped side by side, or stacked into one column per period.
    var groupW = slot * 0.68;
    var barW = (stacked || !bars.length) ? groupW : groupW / bars.length;
    var tops = [];            // running stack height per column, in value space

    bars.forEach(function (s, si) {
      s.values.forEach(function (v, i) {
        if (v === null || !Number.isFinite(v)) return;      // absent draws nothing

        var x = PAD.left + i * slot + (slot - groupW) / 2 + (stacked ? 0 : si * barW);
        var from = 0, to = v;
        if (stacked) {
          from = tops[i] || 0;
          to = from + v;
          tops[i] = to;
        }

        var top = Math.min(y(to), y(from));
        var h = Math.abs(y(to) - y(from));

        // A company reporting exactly zero would otherwise draw a bar of no
        // height — pixel-identical to a period Screener never reported. HDFC
        // Bank's post-merger promoter holding is a real 0%, and the reader has
        // to be able to tell that from a gap, so zero keeps a visible stub
        // sitting on the baseline. In a stack a zero slice is genuinely nothing
        // to show, so it is left out rather than nudging the slices above it.
        var isZeroStub = v === 0 && !stacked;

        svg.appendChild(svgEl('rect', {
          x: x, y: isZeroStub ? y(0) - 1.5 : top,
          width: Math.max(1, barW - (stacked ? 0 : 1)),
          height: isZeroStub ? 1.5 : Math.max(stacked ? 0 : 1, h),
          fill: s.color || STACK_COLOURS(PALETTE)[si % 5]
        }));
      });
    });

    // line overlays — a null breaks the path rather than interpolating over it
    lines.forEach(function (s) {
      var d = '', pen = false, ys = yFor(s);
      s.values.forEach(function (v, i) {
        if (v === null || !Number.isFinite(v)) { pen = false; return; }
        var x = PAD.left + i * slot + slot / 2;
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + ys(v).toFixed(1) + ' ';
        pen = true;
      });
      if (d) {
        // An area is the same path closed down to the baseline. Because a null
        // breaks the path, a gap in the data is a gap in the fill too — the
        // shape never spans a period that was not reported.
        if (s.type === 'area') {
          var segs = d.trim().split('M').filter(Boolean);
          segs.forEach(function (seg) {
            var pts = ('M' + seg).trim().match(/[-\d.]+ [-\d.]+/g) || [];
            if (pts.length < 2) return;
            var first = pts[0].split(' ')[0], lastPt = pts[pts.length - 1].split(' ')[0];
            svg.appendChild(svgEl('path', {
              d: 'M' + first + ' ' + y(0).toFixed(1) + ' L' + pts.join(' L') +
                 ' L' + lastPt + ' ' + y(0).toFixed(1) + ' Z',
              fill: s.color || PALETTE.primary, 'fill-opacity': 0.22, stroke: 'none'
            }));
          });
        }
        svg.appendChild(svgEl('path', {
          d: d.trim(), fill: 'none',
          stroke: s.color || PALETTE.derived, 'stroke-width': 1.5,
          'stroke-linejoin': 'round'
        }));
      }
    });

    // x labels — thinned to what the plot width can hold, so they never
    // collide. The last period is always labelled; if it would crowd the label
    // before it, that earlier label gives way. (The old rule — every sixth, plus
    // the last — put "2025" and "2026" on top of each other on a ten-year chart.)
    var maxLabels = Math.max(2, Math.floor(plotW / 44));
    var every = Math.ceil(n / maxLabels);
    var shown = [];
    for (var li = 0; li < n; li += every) shown.push(li);
    if (shown[shown.length - 1] !== n - 1) {
      if (n - 1 - shown[shown.length - 1] < every && shown.length > 1) shown.pop();
      shown.push(n - 1);
    }
    shown.forEach(function (i) {
      svg.appendChild(text(PAD.left + i * slot + slot / 2, H - PAD.bottom + 11,
        xLabel(opts.periods[i], opts.labelFormat), {
          'text-anchor': 'middle', 'font-size': '7.5', fill: PALETTE.muted
        }));
    });

    // Legend below the plot, wrapping onto a second row rather than running off
    // the edge — series labels carry units ("Revenue (₹ Cr)") and two of them
    // overflow a rail-width chart on their own.
    var lx = PAD.left;
    var ly = H - 8;
    opts.series.forEach(function (s) {
      var colour = s.color || (s.type === 'line' ? PALETTE.derived : PALETTE.primary);
      var width = 12 + s.label.length * 4.1 + 10;
      if (lx > PAD.left && lx + width > W) {       // wrap
        lx = PAD.left;
        ly += 10;
      }
      if (s.type === 'line') {
        svg.appendChild(svgEl('line', {
          x1: lx, x2: lx + 9, y1: ly - 3, y2: ly - 3, stroke: colour, 'stroke-width': 1.5
        }));
      } else {
        svg.appendChild(svgEl('rect', {
          x: lx, y: ly - 6, width: 7, height: 7, fill: colour
        }));
      }
      svg.appendChild(text(lx + 12, ly, s.label, { 'font-size': '7.5', fill: PALETTE.ink }));
      lx += width;
    });

    // grow the canvas if the legend wrapped, so nothing is clipped
    if (ly > H - 8) {
      var grown = H + (ly - (H - 8));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + grown);
    }

    fig.appendChild(svg);

    if (opts.source) {
      var src = document.createElement('p');
      src.className = 'chart-source';
      src.textContent = opts.source;
      fig.appendChild(src);
    }
    return fig;
  }

  // ---------------------------------------------------------------------------
  // waterfall
  // ---------------------------------------------------------------------------

  /**
   * A bridge chart: how one figure becomes another, step by step.
   *
   * opts = { title, source, steps: [{ label, value, kind }], width, height }
   *   kind 'start'    bar from zero, the opening figure
   *   kind 'delta'    floating bar, added to or taken off the running total
   *   kind 'subtotal' bar from zero at the running total, a checkpoint
   *
   * A step whose value is null makes the whole bridge unsound — the running
   * total after it would be wrong, and a bridge that silently skips a step
   * misstates how the company got from one number to the other. So a missing
   * step refuses the chart rather than drawing a plausible-looking lie.
   */
  function drawWaterfall(opts) {
    var PALETTE = palette();
    var fig = document.createElement('figure');
    fig.className = 'chart';
    fig.appendChild(caption(opts.title, opts.unit));

    var steps = opts.steps || [];
    var missing = steps.filter(function (st) {
      return st.value === null || !Number.isFinite(st.value);
    });
    if (!steps.length || missing.length) {
      fig.appendChild(el('p', 'absent chart-empty',
        missing.length
          ? 'not reported — ' + missing[0].label + ' is missing, so the bridge cannot be drawn'
          : 'not reported'));
      return fig;
    }

    // Walk the steps once to find where each bar starts and ends.
    var running = 0, bars = [], lo = 0, hi = 0;
    steps.forEach(function (st) {
      var from, to;
      if (st.kind === 'delta') { from = running; to = running + st.value; running = to; }
      else { from = 0; to = st.value; running = st.value; }
      bars.push({ label: st.label, from: from, to: to, kind: st.kind, value: st.value });
      lo = Math.min(lo, from, to);
      hi = Math.max(hi, from, to);
    });

    var W = opts.width || 690;
    var H = opts.height || 215;
    var PAD = { top: 12, right: 8, bottom: 52, left: 40 };
    var plotW = W - PAD.left - PAD.right;
    var plotH = H - PAD.top - PAD.bottom;

    var ticks = niceTicks(lo, hi, 4);
    var tlo = ticks[0], thi = ticks[ticks.length - 1];
    var y = function (v) { return PAD.top + plotH - ((v - tlo) / (thi - tlo)) * plotH; };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': opts.title
    });

    ticks.forEach(function (t) {
      svg.appendChild(svgEl('line', {
        x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t),
        stroke: t === 0 ? PALETTE.rule : PALETTE.grid, 'stroke-width': t === 0 ? 1 : 0.5
      }));
      svg.appendChild(text(PAD.left - 4, y(t) + 3, compact(t), {
        'text-anchor': 'end', 'font-size': '7.5', fill: PALETTE.muted
      }));
    });

    var slot = plotW / bars.length;
    var barW = Math.min(46, slot * 0.62);

    bars.forEach(function (b, i) {
      var x = PAD.left + i * slot + (slot - barW) / 2;
      var top = Math.min(y(b.from), y(b.to));
      var h = Math.max(1, Math.abs(y(b.to) - y(b.from)));

      // Checkpoints are figures the company reported; the floating steps between
      // them are the moves. Colouring them apart keeps that distinction readable.
      var fill = b.kind === 'delta'
        ? (b.value >= 0 ? PALETTE.secondary : PALETTE.grid)
        : PALETTE.primary;

      svg.appendChild(svgEl('rect', { x: x, y: top, width: barW, height: h, fill: fill }));

      // connector to the next bar, so the eye follows the running total
      if (i < bars.length - 1) {
        svg.appendChild(svgEl('line', {
          x1: x + barW, x2: PAD.left + (i + 1) * slot + (slot - barW) / 2,
          y1: y(b.to), y2: y(b.to),
          stroke: PALETTE.rule, 'stroke-width': 0.5, 'stroke-dasharray': '2 2'
        }));
      }

      svg.appendChild(text(x + barW / 2, top - 3, compact(b.value), {
        'text-anchor': 'middle', 'font-size': '7.5',
        fill: b.kind === 'delta' ? PALETTE.muted : PALETTE.ink
      }));

      // Labels are angled; a bridge has more steps than a plot has room for.
      var label = text(0, 0, b.label, {
        'text-anchor': 'end', 'font-size': '7.5', fill: PALETTE.muted,
        transform: 'translate(' + (x + barW / 2 + 3) + ',' + (H - PAD.bottom + 13) + ') rotate(-40)'
      });
      label.removeAttribute('x');
      label.removeAttribute('y');
      svg.appendChild(label);
    });

    fig.appendChild(svg);
    if (opts.source) fig.appendChild(el('p', 'chart-source', opts.source));
    return fig;
  }

  // ---------------------------------------------------------------------------
  // scatter
  // ---------------------------------------------------------------------------

  /**
   * Two measures plotted against each other rather than against time.
   *
   * opts = { title, source, points: [{x, y, label}], xLabel, yLabel }
   *
   * This is the one chart shape here that answers a relationship question —
   * does margin widen when growth accelerates — which two time series sitting
   * next to each other only hint at. Points missing either coordinate are
   * dropped, never placed at zero.
   */
  function drawScatter(opts) {
    var PALETTE = palette();
    var fig = document.createElement('figure');
    fig.className = 'chart';
    fig.appendChild(caption(opts.title, opts.unit));

    var pts = (opts.points || []).filter(function (p) {
      return Number.isFinite(p.x) && Number.isFinite(p.y);
    });
    if (pts.length < 3) {
      fig.appendChild(el('p', 'absent chart-empty',
        'not reported — needs at least three periods with both figures'));
      return fig;
    }

    var W = opts.width || 330;
    var H = opts.height || 195;
    var PAD = { top: 10, right: 10, bottom: 42, left: 36 };
    var plotW = W - PAD.left - PAD.right;
    var plotH = H - PAD.top - PAD.bottom;

    var xs = pts.map(function (p) { return p.x; });
    var ys = pts.map(function (p) { return p.y; });
    var xt = niceTicks(Math.min.apply(null, xs), Math.max.apply(null, xs), 4);
    var yt = niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 4);

    var X = function (v) {
      return PAD.left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0])) * plotW;
    };
    var Y = function (v) {
      return PAD.top + plotH - ((v - yt[0]) / (yt[yt.length - 1] - yt[0])) * plotH;
    };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': opts.title
    });

    yt.forEach(function (t) {
      svg.appendChild(svgEl('line', {
        x1: PAD.left, x2: W - PAD.right, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? PALETTE.rule : PALETTE.grid, 'stroke-width': t === 0 ? 1 : 0.5
      }));
      svg.appendChild(text(PAD.left - 4, Y(t) + 3, compact(t), {
        'text-anchor': 'end', 'font-size': '7.5', fill: PALETTE.muted
      }));
    });

    // The only vertical rule worth drawing is zero growth — left of it the
    // company shrank, right of it it grew.
    if (xt[0] < 0 && xt[xt.length - 1] > 0) {
      svg.appendChild(svgEl('line', {
        x1: X(0), x2: X(0), y1: PAD.top, y2: PAD.top + plotH,
        stroke: PALETTE.rule, 'stroke-width': 1
      }));
    }

    [xt[0], xt[xt.length - 1]].forEach(function (t, i) {
      svg.appendChild(text(i ? W - PAD.right : PAD.left, H - PAD.bottom + 12, compact(t), {
        'text-anchor': i ? 'end' : 'start', 'font-size': '7.5', fill: PALETTE.muted
      }));
    });

    // Later periods sit darker, so the path through time is readable without
    // joining the dots and implying a trajectory the data does not support.
    pts.forEach(function (p, i) {
      var t = pts.length > 1 ? i / (pts.length - 1) : 1;
      svg.appendChild(svgEl('circle', {
        cx: X(p.x), cy: Y(p.y), r: 3.2,
        fill: t > 0.66 ? PALETTE.deep : (t > 0.33 ? PALETTE.primary : PALETTE.secondary)
      }));
    });

    // Label only the first and last, or the plot turns into a word cloud. Each
    // label takes the first spot around its point that covers no dot, no other
    // label and nothing outside the plot. Fixed offsets (first below, last
    // above) once printed "Mar 2026" across a neighbouring dot.
    var placed = [];
    var overlaps = function (a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; };
    // Lower is better. Covering the other label is worst, leaving the plot next,
    // covering a dot least — when no spot is clear, the least bad one wins.
    var cost = function (b) {
      var c = placed.some(function (o) { return overlaps(o, b); }) ? 100 : 0;
      if (b.x0 < PAD.left || b.x1 > W - PAD.right || b.y0 < 0 || b.y1 > PAD.top + plotH) c += 10;
      pts.forEach(function (q) {
        var cx = X(q.x), cy = Y(q.y);
        if (overlaps(b, { x0: cx - 3.2, x1: cx + 3.2, y0: cy - 3.2, y1: cy + 3.2 })) c += 1;
      });
      return c;
    };
    [pts[0], pts[pts.length - 1]].forEach(function (p, i) {
      if (!p.label) return;
      var cx = X(p.x), cy = Y(p.y), w = p.label.length * 4 + 2;   // ~0.55em at 7px, padded
      var above = [cx, cy - 6, 'middle'], below = [cx, cy + 11, 'middle'];
      var spots = (i === 0 ? [below, above] : [above, below]).concat([
        [cx + 6, cy + 2.5, 'start'], [cx - 6, cy + 2.5, 'end'],
        [cx + 5, cy - 6, 'start'], [cx - 5, cy - 6, 'end'],
        [cx + 5, cy + 11, 'start'], [cx - 5, cy + 11, 'end'],
        [cx, cy - 15, 'middle'], [cx, cy + 20, 'middle']
      ]);
      var box = function (s) {
        var x0 = s[2] === 'middle' ? s[0] - w / 2 : (s[2] === 'start' ? s[0] : s[0] - w);
        return { x0: x0, x1: x0 + w, y0: s[1] - 7, y1: s[1] + 2 };
      };
      var spot = spots.reduce(function (best, s) { return cost(box(s)) < cost(box(best)) ? s : best; });
      placed.push(box(spot));
      svg.appendChild(text(spot[0], spot[1], p.label, {
        'text-anchor': spot[2], 'font-size': '7', fill: PALETTE.muted
      }));
    });

    svg.appendChild(text(PAD.left + plotW / 2, H - 13, opts.xLabel || '', {
      'text-anchor': 'middle', 'font-size': '7.5', fill: PALETTE.ink
    }));
    var yl = text(0, 0, opts.yLabel || '', {
      'text-anchor': 'middle', 'font-size': '7.5', fill: PALETTE.ink,
      transform: 'translate(9,' + (PAD.top + plotH / 2) + ') rotate(-90)'
    });
    yl.removeAttribute('x');
    yl.removeAttribute('y');
    svg.appendChild(yl);

    fig.appendChild(svg);
    if (opts.source) fig.appendChild(el('p', 'chart-source', opts.source));
    return fig;
  }

  api.draw = draw;
  api.drawWaterfall = drawWaterfall;
  api.drawScatter = drawScatter;
  root.ScreenerXRayChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
