/**
 * Screener X-Ray — findings.
 *
 * The X-ray itself. Screener shows each statement on its own; a reader sees one
 * table at a time. Every detector here reads ACROSS sections — profit against
 * cash, other income against profit before tax, borrowings against equity,
 * who sold shares to whom — and reports a relationship no single table shows.
 *
 * Consumes parse.js output only (CLAUDE.md rule 3). No DOM, no network.
 *
 * WHAT A FINDING MAY SAY (rule 5, and rule 7)
 *   A finding states a relationship and its numbers. It never says what the
 *   relationship means for the company: no "good", "poor", "concern", "risk",
 *   "red flag", no score, no action. The diligence behind this project put it
 *   plainly — state the raw comparison and let the reader draw the conclusion.
 *
 *   Detectors do CHOOSE what to surface, by size: the largest movements and the
 *   widest gaps. That weight orders the list and is never shown.
 *
 * WHAT A FINDING MAY NOT DO (rule 4 and 4b)
 *   A detector with missing inputs emits nothing. A detector whose arithmetic
 *   would mislead — cash conversion for a bank, growth from a loss — emits
 *   nothing. Silence is always safer than a confident wrong sentence.
 *
 * Output: [{ id, title, parts, sources, weight }]
 *   parts: { t: 'text' } | { v: number, unit: 'inr'|'pct'|'pp'|'x'|'days', kind: 'figure'|'derived' }
 *   report.js does the formatting, so every number on the page is formatted once,
 *   in one place.
 */
(function (root) {
  'use strict';

  var MAX_FINDINGS = 8;

  // ---------------------------------------------------------------------------
  // reading helpers
  // ---------------------------------------------------------------------------

  function isDated(key) {
    return !!key && !Number.isNaN(Date.parse(key));
  }

  function rowOf(table, names) {
    if (!table) return null;
    for (var i = 0; i < names.length; i++) {
      if (table.rows[names[i]]) return table.rows[names[i]];
    }
    return null;
  }

  /** Values of `names` in `table`, aligned to `periods` by label. */
  function aligned(periods, table, names) {
    var row = rowOf(table, names);
    return periods.map(function (p) {
      if (!row) return null;
      var at = table.periods.indexOf(p);
      var v = at === -1 ? null : row[at];
      return Number.isFinite(v) ? v : null;
    });
  }

  /** The dated periods of a table (drops TTM). */
  function datedPeriods(table) {
    if (!table) return [];
    return table.periods.filter(function (p, i) { return isDated(table.dateKeys[i]); });
  }

  function isLending(data) {
    var pl = data.sections && data.sections.profitLoss;
    return !!(pl && pl.rows['Financing Profit']);
  }

  /**
   * Whether this company's cash flows behave like a lender's, whatever layout
   * Screener gives it.
   *
   * Bajaj Finserv is shown on the standard layout, but its consolidated
   * accounts contain a lending business: loans made count as operating cash
   * out, so operating cash is negative in almost every profitable year. On such
   * a company cash conversion, dividends against free cash flow, debt to equity
   * and interest cover are each arithmetically true and each misleading, so
   * they are refused (rule 4b) exactly as they are for a bank.
   */
  function lenderLikeCash(data) {
    if (isLending(data)) return true;
    var cf = data.sections.cashFlow, pl = data.sections.profitLoss;
    var periods = datedPeriods(cf);
    var cfo = aligned(periods, cf, ['Cash from Operating Activity']);
    var pat = aligned(periods, pl, ['Net Profit']);
    var profitable = 0, negative = 0;
    periods.forEach(function (p, i) {
      if (pat[i] === null || cfo[i] === null || pat[i] <= 0) return;
      profitable++;
      if (cfo[i] < 0) negative++;
    });
    return profitable >= 4 && negative / profitable >= 0.5;
  }

  var text = function (t) { return { t: t }; };
  var fig = function (v, unit) { return { v: v, unit: unit, kind: 'figure' }; };
  var der = function (v, unit) { return { v: v, unit: unit, kind: 'derived' }; };

  function sum(a) { return a.reduce(function (s, v) { return s + v; }, 0); }

  // ---------------------------------------------------------------------------
  // detectors
  // ---------------------------------------------------------------------------

  /**
   * Profit against cash, cumulatively. The single most basic X-ray: whether the
   * profit a company reports turned into cash over the whole period shown.
   * Lenders are excluded — their operating cash is dominated by deposit and
   * loan flows, and the ratio would mean nothing (rule 4b).
   */
  function profitVsCash(data) {
    if (lenderLikeCash(data)) return null;
    var cf = data.sections.cashFlow, pl = data.sections.profitLoss;
    var periods = datedPeriods(cf);
    var cfo = aligned(periods, cf, ['Cash from Operating Activity']);
    var pat = aligned(periods, pl, ['Net Profit']);
    var both = periods.filter(function (p, i) { return cfo[i] !== null && pat[i] !== null; });
    if (both.length < 5) return null;
    var c = [], n = [];
    periods.forEach(function (p, i) { if (cfo[i] !== null && pat[i] !== null) { c.push(cfo[i]); n.push(pat[i]); } });
    var sumPat = sum(n), sumCfo = sum(c);
    // A ratio to a cumulative loss, or of a cumulative cash outflow, means nothing.
    if (sumPat <= 0 || sumCfo <= 0) return null;
    var ratio = sumCfo / sumPat;
    return {
      id: 'profit-vs-cash',
      title: 'Reported profit against cash from operations',
      parts: [
        text('Across the ' + both.length + ' years from ' + both[0] + ' to ' + both[both.length - 1] +
          ', profit after tax added up to '),
        fig(sumPat, 'inr'), text(' and cash from operations to '), fig(sumCfo, 'inr'),
        text(': cash was '), der(ratio, 'x'), text(' profit.')
      ],
      sources: ['P&L', 'Cash flow'],
      weight: 40 + Math.min(40, Math.abs(ratio - 1) * 60)
    };
  }

  /** Years in which profit was positive but operating cash flow was negative. */
  function profitWithoutCash(data) {
    if (isLending(data)) return null;
    var cf = data.sections.cashFlow, pl = data.sections.profitLoss;
    var periods = datedPeriods(cf);
    var cfo = aligned(periods, cf, ['Cash from Operating Activity']);
    var pat = aligned(periods, pl, ['Net Profit']);
    var shown = periods.filter(function (p, i) { return pat[i] !== null && cfo[i] !== null; }).length;
    var years = periods.filter(function (p, i) { return pat[i] !== null && cfo[i] !== null && pat[i] > 0 && cfo[i] < 0; });
    if (!years.length) return null;
    // Name the years when there are a few; count them when there are many.
    var when = years.length <= 3
      ? 'In ' + years.join(', ')
      : 'In ' + years.length + ' of the ' + shown + ' years shown, most recently ' + years[years.length - 1];
    return {
      id: 'profit-without-cash',
      title: 'Profit reported, operating cash negative',
      parts: [text(when + ', the company reported a profit while cash from operations was below zero.')],
      sources: ['P&L', 'Cash flow'],
      weight: 55 + Math.min(30, years.length * 6)
    };
  }

  /**
   * How much of profit before tax came from other income — and what the result
   * would have been without it. This is the finding a single table hides: a
   * company can move from loss to profit on a one-off gain while its operations
   * are unchanged.
   */
  function otherIncomeReliance(data) {
    // Not for lenders. A bank's other income is largely fees, commissions and
    // treasury gains - its business, not a windfall - and Screener's lending
    // layout already nets provisions into expenses. "Without other income, a
    // loss" would be arithmetic about a bank that does not exist.
    if (isLending(data)) return null;
    var pl = data.sections.profitLoss;
    var periods = datedPeriods(pl);
    var oi = aligned(periods, pl, ['Other Income']);
    var pbt = aligned(periods, pl, ['Profit before tax']);
    for (var i = periods.length - 1; i >= Math.max(0, periods.length - 5); i--) {
      if (oi[i] === null || pbt[i] === null || oi[i] <= 0) continue;
      var without = pbt[i] - oi[i];
      var share = pbt[i] > 0 ? oi[i] / pbt[i] : null;
      if (pbt[i] > 0 && without < 0) {
        return {
          id: 'other-income',
          title: 'Profit before tax, with and without other income',
          parts: [
            text('In ' + periods[i] + ', other income of '), fig(oi[i], 'inr'),
            text(' exceeded profit before tax of '), fig(pbt[i], 'inr'),
            text('. Without it, the pre-tax result would have been '), der(without, 'inr'), text('.')
          ],
          sources: ['P&L'],
          weight: 95
        };
      }
      if (share !== null && share >= 0.4) {
        return {
          id: 'other-income',
          title: 'Other income as a share of profit before tax',
          parts: [
            text('In ' + periods[i] + ', other income of '), fig(oi[i], 'inr'),
            text(' was '), der(share * 100, 'pct'), text(' of profit before tax ('), fig(pbt[i], 'inr'), text(').')
          ],
          sources: ['P&L'],
          weight: 50 + share * 40
        };
      }
    }
    return null;
  }

  /** Borrowings against the owners' money, start to end. */
  function debtBuild(data) {
    if (lenderLikeCash(data)) return null;              // debt is a lender's raw material
    var bs = data.sections.balanceSheet;
    var periods = datedPeriods(bs);
    var debt = aligned(periods, bs, ['Borrowings', 'Borrowing']);
    var cap = aligned(periods, bs, ['Equity Capital']);
    var res = aligned(periods, bs, ['Reserves']);
    var idx = periods.map(function (p, i) { return i; }).filter(function (i) {
      return debt[i] !== null && cap[i] !== null && res[i] !== null && cap[i] + res[i] > 0;
    });
    // If equity is not positive in the latest year, debt to equity has no
    // meaning there - and ending the comparison at the last positive year would
    // quietly hide that equity went negative after it.
    var li = periods.length - 1;
    if (cap[li] !== null && res[li] !== null && cap[li] + res[li] <= 0) return null;
    if (idx.length < 3) return null;
    var a = idx[0], b = idx[idx.length - 1];
    var deA = debt[a] / (cap[a] + res[a]), deB = debt[b] / (cap[b] + res[b]);
    if (Math.abs(deB - deA) < 0.25) return null;
    return {
      id: 'debt-build',
      title: 'Borrowings against equity',
      parts: [
        text('Borrowings went from '), fig(debt[a], 'inr'), text(' in ' + periods[a] + ' to '), fig(debt[b], 'inr'),
        text(' in ' + periods[b] + ', while equity went from '), der(cap[a] + res[a], 'inr'),
        text(' to '), der(cap[b] + res[b], 'inr'), text('. Debt to equity moved from '),
        der(deA, 'x'), text(' to '), der(deB, 'x'), text('.')
      ],
      sources: ['Balance sheet'],
      weight: 45 + Math.min(40, Math.abs(deB - deA) * 25)
    };
  }

  /** Years in which equity share capital changed — shares issued, or a split or bonus. */
  function equityChange(data) {
    var bs = data.sections.balanceSheet;
    var periods = datedPeriods(bs);
    var cap = aligned(periods, bs, ['Equity Capital']);
    var moves = [];
    for (var i = 1; i < periods.length; i++) {
      if (cap[i] === null || cap[i - 1] === null || cap[i - 1] <= 0) continue;
      var g = cap[i] / cap[i - 1] - 1;
      if (Math.abs(g) >= 0.1) moves.push({ p: periods[i], from: cap[i - 1], to: cap[i], g: g });
    }
    if (!moves.length) return null;
    var big = moves.reduce(function (m, x) { return Math.abs(x.g) > Math.abs(m.g) ? x : m; });
    var parts = [
      text('Equity share capital changed in ' + moves.map(function (m) { return m.p; }).join(', ') +
        '. The largest move was in ' + big.p + ', from '),
      fig(big.from, 'inr'), text(' to '), fig(big.to, 'inr'),
      text(' — new shares, a bonus issue or a change in face value; this page does not say which.')
    ];
    return { id: 'equity-change', title: 'Changes in share capital', parts: parts, sources: ['Balance sheet'],
      // Share capital changes are routine corporate actions: worth a line,
      // rarely the lead, and a tiny base must not make them one.
      weight: 30 + Math.min(25, Math.log(1 + Math.abs(big.g)) / Math.LN2 * 12) };
  }

  /** Operating profit plus other income, less depreciation, against interest. */
  function interestCover(data) {
    if (lenderLikeCash(data)) return null;
    var pl = data.sections.profitLoss;
    var periods = datedPeriods(pl);
    var op = aligned(periods, pl, ['Operating Profit']);
    var oi = aligned(periods, pl, ['Other Income']);
    var dep = aligned(periods, pl, ['Depreciation']);
    var int = aligned(periods, pl, ['Interest']);
    var cover = periods.map(function (p, i) {
      if (op[i] === null || oi[i] === null || dep[i] === null || int[i] === null || int[i] <= 0) return null;
      return (op[i] + oi[i] - dep[i]) / int[i];
    });
    // A year of negative earnings before interest has no cover to compare -
    // "14x against -1x" measures nothing - so only positive years qualify.
    var idx = cover.map(function (c, i) { return c === null || c <= 0 ? -1 : i; }).filter(function (i) { return i > -1; });
    if (idx.length < 3) return null;
    var b = idx[idx.length - 1], a = idx[Math.max(0, idx.length - 6)];
    var change = cover[a] !== 0 ? cover[b] / cover[a] : null;
    if (change !== null && change > 0.7 && change < 1.43) return null;   // under ~30% either way: not surfaced
    return {
      id: 'interest-cover',
      title: 'Earnings before interest against interest paid',
      parts: [
        text('Operating profit plus other income, less depreciation, covered interest '), der(cover[b], 'x'),
        text(' in ' + periods[b] + ', against '), der(cover[a], 'x'), text(' in ' + periods[a] + '.')
      ],
      sources: ['P&L'],
      weight: 40 + Math.min(40, Math.abs(Math.log(Math.max(0.01, change || 1))) * 30)
    };
  }

  /** Whether the latest margin sits at the top or bottom of its own history. */
  function marginRecord(data) {
    var margin = data.fields.margin;
    if (!margin) return null;
    var pts = margin.values.map(function (v, i) { return { v: v, p: margin.periods[i], d: margin.dateKeys[i] }; })
      .filter(function (x) { return Number.isFinite(x.v) && isDated(x.d); });
    if (pts.length < 6) return null;
    var last = pts[pts.length - 1];
    var others = pts.slice(0, -1).map(function (x) { return x.v; });
    var hi = Math.max.apply(null, others), lo = Math.min.apply(null, others);
    var at = last.v > hi ? 'highest' : last.v < lo ? 'lowest' : null;
    if (!at) return null;
    return {
      id: 'margin-record',
      title: margin.label + ' at the edge of its range',
      parts: [
        text(margin.label + ' in ' + last.p + ' was '), fig(last.v, 'pct'),
        text(', the ' + at + ' of the ' + pts.length + ' years shown (the range before it: '),
        fig(lo, 'pct'), text(' to '), fig(hi, 'pct'), text(').')
      ],
      sources: ['P&L'],
      weight: 50
    };
  }

  /** Effective tax rates outside the ordinary band: negative, or very high. */
  function taxAnomaly(data) {
    var pl = data.sections.profitLoss;
    var periods = datedPeriods(pl);
    var tax = aligned(periods, pl, ['Tax %']);
    var recent = periods.map(function (p, i) { return { p: p, v: tax[i] }; }).slice(-5)
      .filter(function (x) { return x.v !== null && (x.v < 0 || x.v > 45); });
    if (!recent.length) return null;
    return {
      id: 'tax-rate',
      title: 'Effective tax rate below zero or above 45%',
      parts: [text('The effective tax rate Screener reports was ')]
        .concat(recent.reduce(function (acc, x, i) {
          if (i) acc.push(text(i === recent.length - 1 ? ' and ' : ', '));
          acc.push(fig(x.v, 'pct'), text(' in ' + x.p));
          return acc;
        }, []))
        .concat([text('.')]),
      sources: ['P&L'],
      weight: 30 + recent.length * 6
    };
  }

  /** The largest ownership shift, and who took the other side of it. */
  function ownershipShift(data) {
    var shp = data.sections.shareholding;
    var t = shp && (shp.quarterly || shp.yearly);
    if (!t) return null;
    var cats = ['Promoters', 'FIIs', 'DIIs', 'Government', 'Public', 'Others'];
    var moves = [];
    cats.forEach(function (c) {
      var row = t.rows[c];
      if (!row) return;
      var idx = row.map(function (v, i) { return Number.isFinite(v) ? i : -1; }).filter(function (i) { return i > -1; });
      if (idx.length < 2) return;
      var a = idx[0], b = idx[idx.length - 1];
      moves.push({ c: c, from: row[a], to: row[b], d: row[b] - row[a], pa: t.periods[a], pb: t.periods[b] });
    });
    if (!moves.length) return null;
    moves.sort(function (x, y) { return Math.abs(y.d) - Math.abs(x.d); });
    var top = moves[0];
    if (Math.abs(top.d) < 3) return null;
    var other = moves.filter(function (m) { return m.c !== top.c && Math.sign(m.d) === -Math.sign(top.d) && Math.abs(m.d) >= 1; })[0];
    var parts = [
      text(top.c + ' went from '), fig(top.from, 'pct'), text(' to '), fig(top.to, 'pct'),
      text(' between ' + top.pa + ' and ' + top.pb + ' ('), der(top.d, 'pp'), text(')')
    ];
    if (other) parts.push(text('; over the same window ' + other.c + ' moved '), der(other.d, 'pp'));
    parts.push(text('.'));
    return { id: 'ownership', title: 'The largest change in who owns the shares', parts: parts,
      sources: ['Shareholding'], weight: 40 + Math.min(45, Math.abs(top.d) * 2) };
  }

  /** The latest quarter against the same quarter a year earlier. */
  function quarterYoY(data) {
    var q = data.sections.quarters;
    if (!q) return null;
    var rev = rowOf(q, ['Sales', 'Revenue']);
    if (!rev) return null;
    var n = rev.length;
    var b = -1;
    for (var i = n - 1; i >= 4; i--) { if (Number.isFinite(rev[i]) && Number.isFinite(rev[i - 4])) { b = i; break; } }
    if (b === -1 || rev[b - 4] <= 0) return null;
    var g = (rev[b] / rev[b - 4] - 1) * 100;
    var parts = [
      text('Revenue in the ' + q.periods[b] + ' quarter was '), fig(rev[b], 'inr'),
      text(g >= 0 ? ', up ' : ', down '), der(Math.abs(g), 'pct'),
      text(' on the ' + q.periods[b - 4] + ' quarter ('), fig(rev[b - 4], 'inr'), text(')')
    ];
    var mKey = q.rows['OPM %'] ? 'OPM %' : q.rows['Financing Margin %'] ? 'Financing Margin %' : null;
    var m = mKey ? q.rows[mKey] : null;
    if (m && Number.isFinite(m[b]) && Number.isFinite(m[b - 4])) {
      // name the margin for what it is - a lender's is not an operating margin
      parts.push(text(mKey === 'OPM %' ? '; operating margin ' : '; financing margin '), fig(m[b], 'pct'),
        text(' against '), fig(m[b - 4], 'pct'));
    }
    parts.push(text('.'));
    return { id: 'quarter-yoy', title: 'Latest quarter against the same quarter last year', parts: parts,
      sources: ['Quarterly results'], weight: 45 + Math.min(35, Math.abs(g) / 2) };
  }

  /** Dividends paid out of profit, against the free cash flow that funds them. */
  function dividendVsFcf(data) {
    if (lenderLikeCash(data)) return null;
    var pl = data.sections.profitLoss, cf = data.sections.cashFlow;
    var periods = datedPeriods(cf).slice(-5);
    var pat = aligned(periods, pl, ['Net Profit']);
    var pay = aligned(periods, pl, ['Dividend Payout %']);
    var fcf = aligned(periods, cf, ['Free Cash Flow']);
    var ok = periods.map(function (p, i) { return pat[i] !== null && pay[i] !== null && fcf[i] !== null; });
    if (ok.filter(Boolean).length < 4) return null;
    var div = 0, free = 0;
    periods.forEach(function (p, i) { if (ok[i]) { div += Math.max(0, pat[i]) * pay[i] / 100; free += fcf[i]; } });
    if (div <= 0) return null;
    if (free > 0 && div / free < 0.8) return null;
    return {
      id: 'dividend-vs-fcf',
      title: 'Dividends against free cash flow',
      parts: [
        text('Over ' + periods[0] + '–' + periods[periods.length - 1] + ', dividends implied by the payout ratio came to '),
        der(div, 'inr'), text(' against free cash flow of '), fig(free, 'inr'), text('.')
      ],
      sources: ['P&L', 'Cash flow'],
      weight: 60
    };
  }

  /** Capital work in progress building up relative to the fixed asset base. */
  function cwipBuild(data) {
    var bs = data.sections.balanceSheet;
    var periods = datedPeriods(bs).slice(-6);
    var cw = aligned(periods, bs, ['CWIP']);
    var fa = aligned(periods, bs, ['Fixed Assets']);
    var best = null;
    periods.forEach(function (p, i) {
      if (cw[i] === null || fa[i] === null || fa[i] <= 0) return;
      var r = cw[i] / fa[i];
      if (!best || r > best.r) best = { p: p, r: r, cw: cw[i], fa: fa[i] };
    });
    if (!best || best.r < 0.25) return null;
    return {
      id: 'cwip',
      title: 'Capital work in progress against fixed assets',
      parts: [
        text('Capital work in progress reached '), fig(best.cw, 'inr'), text(' in ' + best.p + ', '),
        der(best.r * 100, 'pct'), text(' of fixed assets ('), fig(best.fa, 'inr'), text(') — assets being built but not yet in use.')
      ],
      sources: ['Balance sheet'],
      weight: 40 + Math.min(35, best.r * 40)
    };
  }

  /** Gross and net NPA across the quarters shown. Lenders only. */
  function npaTrend(data) {
    var q = data.sections.quarters;
    if (!q || !q.rows['Gross NPA %']) return null;
    var g = q.rows['Gross NPA %'], n = q.rows['Net NPA %'];
    var idx = g.map(function (v, i) { return Number.isFinite(v) ? i : -1; }).filter(function (i) { return i > -1; });
    if (idx.length < 4) return null;
    var a = idx[0], b = idx[idx.length - 1];
    var parts = [text('Gross NPA went from '), fig(g[a], 'pct'), text(' in ' + q.periods[a] + ' to '), fig(g[b], 'pct'), text(' in ' + q.periods[b])];
    if (n && Number.isFinite(n[a]) && Number.isFinite(n[b])) {
      parts.push(text('; net NPA from '), fig(n[a], 'pct'), text(' to '), fig(n[b], 'pct'));
    }
    parts.push(text('.'));
    return { id: 'npa', title: 'Asset quality across the quarters shown', parts: parts,
      sources: ['Quarterly results'], weight: 70 + Math.min(20, Math.abs(g[b] - g[a]) * 8) };
  }

  /** Deposits as a share of a bank's funding. */
  function fundingMix(data) {
    var bs = data.sections.balanceSheet;
    if (!bs || !bs.rows.Deposits) return null;
    var periods = datedPeriods(bs);
    var dep = aligned(periods, bs, ['Deposits']);
    var bor = aligned(periods, bs, ['Borrowing', 'Borrowings']);
    var idx = periods.map(function (p, i) { return i; }).filter(function (i) { return dep[i] !== null && bor[i] !== null && dep[i] + bor[i] > 0; });
    if (idx.length < 3) return null;
    var a = idx[0], b = idx[idx.length - 1];
    var sa = dep[a] / (dep[a] + bor[a]) * 100, sb = dep[b] / (dep[b] + bor[b]) * 100;
    if (Math.abs(sb - sa) < 3) return null;
    return {
      id: 'funding',
      title: 'Deposits as a share of funding',
      parts: [text('Deposits made up '), der(sa, 'pct'), text(' of deposits plus borrowings in ' + periods[a] + ' and '),
        der(sb, 'pct'), text(' in ' + periods[b] + '.')],
      sources: ['Balance sheet'],
      weight: 45 + Math.min(30, Math.abs(sb - sa))
    };
  }

  /**
   * Net profit that does not follow from profit before tax less tax. Screener
   * publishes the rate, rounded to a whole percent, so a gap under 5% of PBT is
   * rounding and is ignored; above that, something sits between the two lines —
   * associates, minority interest, discontinued operations — that this page
   * does not break out.
   */
  function profitReconciliation(data) {
    var pl = data.sections.profitLoss;
    var periods = datedPeriods(pl);
    var pbt = aligned(periods, pl, ['Profit before tax']);
    var tax = aligned(periods, pl, ['Tax %']);
    var np = aligned(periods, pl, ['Net Profit']);
    for (var i = periods.length - 1; i >= Math.max(0, periods.length - 3); i--) {
      if (pbt[i] === null || tax[i] === null || np[i] === null || pbt[i] <= 0) continue;
      var expected = pbt[i] * (1 - tax[i] / 100);
      var gap = np[i] - expected;
      if (Math.abs(gap) < pbt[i] * 0.05) return null;
      return {
        id: 'reconciliation',
        title: 'Net profit that profit before tax does not explain',
        parts: [
          text('In ' + periods[i] + ', profit before tax of '), fig(pbt[i], 'inr'), text(' at a '), fig(tax[i], 'pct'),
          text(' tax rate implies about '), der(expected, 'inr'), text(' of profit; Screener reports '), fig(np[i], 'inr'),
          text('. The difference of '), der(gap, 'inr'), text(' is not broken out on this page.')
        ],
        sources: ['P&L'],
        weight: 55
      };
    }
    return null;
  }

  var DETECTORS = [
    otherIncomeReliance, npaTrend, profitVsCash, profitWithoutCash, dividendVsFcf, debtBuild,
    equityChange, interestCover, marginRecord, ownershipShift, quarterYoY, cwipBuild, fundingMix,
    profitReconciliation, taxAnomaly
  ];

  /**
   * Run every detector. One that throws is dropped rather than taking the
   * report down with it — a finding is additive, never load-bearing.
   */
  function findings(data, max) {
    if (!data || !data.sections) return [];
    var out = [];
    DETECTORS.forEach(function (d) {
      try {
        var f = d(data);
        if (f) out.push(f);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[Screener X-Ray] finding skipped:', d.name, err);
      }
    });
    out.sort(function (a, b) { return b.weight - a.weight; });
    return out.slice(0, max || MAX_FINDINGS);
  }

  // isLending and lenderLikeCash are shared with the chart catalogue, so the
  // report refuses the same misleading charts that the findings refuse.
  var api = { findings: findings, DETECTORS: DETECTORS, isLending: isLending, lenderLikeCash: lenderLikeCash };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScreenerXRayInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
