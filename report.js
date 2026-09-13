/**
 * Screener X-Ray — report page.
 *
 * Consumes parse.js output only. Never touches screener.in's DOM (CLAUDE.md
 * rule 3) and never fetches anything (rule 2).
 *
 * Everything above the `module.exports` line is pure and unit-tested in
 * test/report.test.js; everything below it is DOM rendering.
 *
 * Layout follows the institutional equity-research convention: masthead, title
 * block, a wide narrative column beside a narrow data rail, dense tables with
 * horizontal rules only, and a source line under every table and chart.
 *
 * It deliberately omits that format's verdict furniture — no rating, no price
 * target, no upside/downside scenario, no recommendation (rule 5). Where a
 * broker note puts RATING / PRICE TARGET, this page puts reported figures.
 *
 * Three numeral treatments carry meaning, following the same convention those
 * notes use for estimates:
 *   reported     — black. Read from screener.in exactly as published.
 *   derived      — blue.  Calculated here (CAGR, point changes).
 *   not reported — grey italic. Screener published nothing. Never shown as 0.
 */
(function (root) {
  'use strict';

  var NOT_REPORTED = 'not reported';

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------

  /** Trim trailing zeros so 21.80 reads "21.8" and 19.00 reads "19". */
  function trimNum(v, dp) {
    return String(Number(v.toFixed(dp)));
  }

  function inr(v) {
    // Below ₹100 Cr keep two decimals. Rounding a real ₹0.43 Cr of share capital
    // to "₹0 Cr" prints a zero Screener never reported — rule 4 broken inside
    // the formatter rather than the parser.
    var digits = Math.abs(v) < 100 && v !== Math.round(v) ? 2 : 0;
    var magnitude = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
    return (v < 0 ? '−₹' : '₹') + magnitude + ' Cr';
  }

  function pct(v) {
    return trimNum(v, 2) + '%';
  }

  function days(v) {
    var d = Math.round(v);
    return d + (Math.abs(d) === 1 ? ' day' : ' days');
  }

  function format(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return NOT_REPORTED;
    if (unit === 'inr') return inr(v);
    if (unit === 'pct') return pct(v);
    if (unit === 'days') return days(v);
    // Per-share amounts are rupees, not crores — printing EPS as "₹44 Cr"
    // would overstate it by eight orders of magnitude.
    if (unit === 'rupee') return '₹' + trimNum(v, 2);
    if (unit === 'count') return v.toLocaleString('en-IN');
    return String(v);
  }

  // ---------------------------------------------------------------------------
  // series maths
  // ---------------------------------------------------------------------------

  /**
   * The reported points of a series, in order, dropping cells Screener left
   * blank. A series whose every cell is blank yields [] — which is how
   * "Screener showed this row but filled in nothing" stays distinct from a
   * value of zero.
   */
  function points(series) {
    if (!series || !Array.isArray(series.values)) return [];
    var out = [];
    for (var i = 0; i < series.values.length; i++) {
      if (series.values[i] === null) continue;
      out.push({
        value: series.values[i],
        period: series.periods[i],
        dateKey: series.dateKeys ? series.dateKeys[i] : null
      });
    }
    return out;
  }

  /**
   * Whether a column's date key is an actual date.
   *
   * Screener stamps the Profit & Loss TTM column with data-date-key="TTM" — the
   * literal string, not a date and not an empty attribute. parse.js reports that
   * faithfully, so the check here has to be "does this parse as a date", not
   * "is this truthy", or TTM slips into every date calculation.
   */
  function isDated(key) {
    return !!key && !Number.isNaN(Date.parse(key));
  }

  /** Whole years between two ISO date keys, or null if either is missing. */
  function yearsBetween(fromKey, toKey) {
    if (!fromKey || !toKey) return null;
    var a = Date.parse(fromKey), b = Date.parse(toKey);
    if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
    return (b - a) / (365.2425 * 24 * 60 * 60 * 1000);
  }

  /**
   * Compound annual growth rate, as a percentage.
   *
   * Returns null whenever the figure would be meaningless rather than
   * returning a misleading number: a loss-making company whose profit ran from
   * negative to positive has no CAGR, and neither does a span under a year.
   */
  function cagr(startValue, endValue, years) {
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
    if (!Number.isFinite(years) || years < 1) return null;
    if (startValue <= 0 || endValue <= 0) return null;
    return (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
  }

  /**
   * How much a metric moved, expressed the way that metric actually moves.
   *
   * A margin going 18% -> 19% gained one percentage point, not 5.6%. Debtor days
   * going 32 -> 46 lengthened by 14 days; compounding a day-count would be a
   * meaningless number dressed up as a growth rate. Only absolute quantities —
   * money — get a CAGR, and only then via cagr()'s own guards.
   */
  function changeSuffix(from, to, unit) {
    var delta;
    if (unit === 'pct') {
      delta = to - from;
      return delta === 0 ? null
        : (delta > 0 ? '+' : '−') + trimNum(Math.abs(delta), 2) + ' pp';
    }
    if (unit === 'days') {
      delta = Math.round(to) - Math.round(from);
      return delta === 0 ? null
        : (delta > 0 ? '+' : '−') + Math.abs(delta) +
          (Math.abs(delta) === 1 ? ' day' : ' days');
    }
    return null;                                  // money falls through to CAGR
  }

  /**
   * One descriptive line for a metric.
   *
   * Returns { available, headline, detail, derived }. `derived` holds the part
   * this page calculated rather than read — it is rendered in blue so a reader
   * can always tell our arithmetic from Screener's figures.
   *
   * `available:false` means Screener reported nothing — either the row was
   * absent from the page entirely, or it was present with every cell blank.
   * Both read "not reported"; neither is 0.
   */
  function summarise(series, unit) {
    var pts = points(series);
    if (!pts.length) {
      return { available: false, headline: NOT_REPORTED, detail: null, derived: null };
    }

    var last = pts[pts.length - 1];
    var headline = format(last.value, unit) + ' (' + last.period + ')';

    if (pts.length === 1) {
      return { available: true, headline: headline, detail: null, derived: null };
    }

    // Measure the change across dated columns. Profit & Loss ends in a TTM
    // column that carries no date, so compounding up to it would be measuring an
    // unknown span — the headline still shows TTM, the comparison does not use it.
    var dated = pts.filter(function (p) { return isDated(p.dateKey); });
    var span = dated.length >= 2 ? dated : pts;
    var from = span[0], to = span[span.length - 1];

    if (from.value === to.value) {
      return {
        available: true,
        headline: headline,
        detail: 'Unchanged at ' + format(to.value, unit) + ' since ' + from.period,
        derived: null
      };
    }

    // The headline already gives the latest figure. When the comparison ends
    // on that same figure — which it does whenever the newest column is also a
    // dated one — naming it again puts the identical number twice in one
    // sentence. Say where it came FROM, and only say where it went when that is
    // somewhere the reader has not just been told about.
    var repeatsHeadline = to.period === last.period;
    var detail = (to.value > from.value ? 'Rose from ' : 'Fell from ') +
      format(from.value, unit) + ' (' + from.period + ')' +
      (repeatsHeadline ? '' :
        ' to ' + format(to.value, unit) + ' (' + to.period + ')');

    var derived = changeSuffix(from.value, to.value, unit);
    if (!derived && unit === 'inr') {
      // Compounding is only meaningful if the quantity stayed positive the
      // whole way. Vodafone Idea's profit runs +3,193 (2015) to +34,552 (2026)
      // and would yield a tidy-looking CAGR — across four years of roughly
      // 30,000 crore annual losses in between. Endpoint growth on a series that
      // crosses zero describes something that never happened.
      var unbroken = span.every(function (p) { return p.value > 0; });
      var g = unbroken
        ? cagr(from.value, to.value, yearsBetween(from.dateKey, to.dateKey))
        : null;
      if (g !== null) derived = trimNum(g, 1) + '% CAGR';
    }

    return { available: true, headline: headline, detail: detail, derived: derived };
  }

  // ---------------------------------------------------------------------------
  // derived measures
  //
  // Everything below is OUR arithmetic on Screener's figures, not Screener's own
  // output, and the page renders all of it in the blue "derived" treatment.
  // Each one is a division, so each one has a way of producing a confident,
  // meaningless number — the guards are the substance here, not the formulas.
  // ---------------------------------------------------------------------------

  /** Pull a row out of `table` aligned to another table's period labels. */
  function alignTo(periods, table, names) {
    var out = periods.map(function () { return null; });
    if (!table) return out;
    var key = null, k;
    for (k in table.rows) {
      if (!Object.prototype.hasOwnProperty.call(table.rows, k)) continue;
      for (var i = 0; i < names.length; i++) {
        if (k.toLowerCase() === names[i].toLowerCase()) { key = k; break; }
      }
      if (key) break;
    }
    if (!key) return out;
    periods.forEach(function (p, idx) {
      var at = table.periods.indexOf(p);
      if (at !== -1) out[idx] = table.rows[key][at];
    });
    return out;
  }

  /**
   * DuPont decomposition: ROE = net margin x asset turnover x leverage.
   *
   * Balance-sheet periods are the base, because that is the shorter column set —
   * Profit & Loss carries an extra TTM column with no balance sheet behind it.
   *
   * Every component returns null rather than a number whenever the arithmetic
   * would be misleading:
   *  - sales <= 0    : margin and turnover are undefined, not zero.
   *  - assets <= 0   : likewise.
   *  - equity <= 0   : the important one. Vodafone Idea's reserves are deeply
   *                    negative, so its book equity is negative. Assets/equity
   *                    then returns a large NEGATIVE leverage, which multiplied
   *                    by a negative margin yields a healthy-looking POSITIVE
   *                    ROE for a company that has destroyed its entire net
   *                    worth. That number is worse than no number.
   */
  function dupont(data) {
    var bs = data.sections && data.sections.balanceSheet;
    var pl = data.sections && data.sections.profitLoss;
    if (!bs || !pl) return null;

    var periods = bs.periods;
    var assets = alignTo(periods, bs, ['Total Assets']);
    var capital = alignTo(periods, bs, ['Equity Capital']);
    var reserves = alignTo(periods, bs, ['Reserves']);
    var sales = alignTo(periods, pl, ['Sales', 'Revenue', 'Income']);
    var pat = alignTo(periods, pl, ['Net Profit']);

    var rows = {
      netMargin: [], assetTurnover: [], leverage: [], roe: [], equity: []
    };

    periods.forEach(function (p, i) {
      var a = assets[i], s = sales[i], profit = pat[i];
      var eq = (capital[i] === null || reserves[i] === null)
        ? null : capital[i] + reserves[i];

      var margin = (profit === null || s === null || s <= 0) ? null : (profit / s) * 100;
      var turn = (s === null || a === null || a <= 0) ? null : s / a;
      var lev = (a === null || eq === null || eq <= 0) ? null : a / eq;

      rows.equity.push(eq);
      rows.netMargin.push(margin);
      rows.assetTurnover.push(turn);
      rows.leverage.push(lev);
      rows.roe.push(
        (margin === null || turn === null || lev === null)
          ? null
          : (margin / 100) * turn * lev * 100
      );
    });

    return {
      periods: periods,
      dateKeys: bs.dateKeys,
      netMargin: rows.netMargin,
      assetTurnover: rows.assetTurnover,
      leverage: rows.leverage,
      roe: rows.roe,
      equity: rows.equity
    };
  }

  /**
   * Cash conversion: cash from operations as a percentage of profit after tax.
   *
   * Undefined when PAT is zero or negative — dividing by a loss flips the sign,
   * so a company with strong operating cash and a bottom-line loss would show a
   * large negative "conversion" that reads as the opposite of what happened.
   *
   * Screener publishes a CFO/OP row, but that is against OPERATING profit. This
   * is against PAT, which is the comparison the one-pager describes.
   */
  function cashConversion(data) {
    var cf = data.sections && data.sections.cashFlow;
    var pl = data.sections && data.sections.profitLoss;
    if (!cf || !pl) return null;

    var periods = cf.periods;
    var cfo = alignTo(periods, cf, ['Cash from Operating Activity']);
    var pat = alignTo(periods, pl, ['Net Profit']);

    var values = periods.map(function (p, i) {
      if (cfo[i] === null || pat[i] === null || pat[i] <= 0) return null;
      return (cfo[i] / pat[i]) * 100;
    });

    return { periods: periods, dateKeys: cf.dateKeys, cfo: cfo, pat: pat, values: values };
  }

  /**
   * One number inside an X-Ray finding.
   *
   * insights.js returns raw values and a unit; formatting happens here so every
   * number on the page is formatted in one place. Derived percentages carry one
   * decimal (a computed 17.93% claims more precision than the inputs have);
   * reported ones keep Screener's own precision.
   */
  function formatPart(p) {
    if (!p || !Number.isFinite(p.v)) return NOT_REPORTED;
    var sign = function (v) { return v < 0 ? '−' : ''; };
    if (p.unit === 'x') return sign(p.v) + trimNum(Math.abs(p.v), 2) + 'x';
    if (p.unit === 'pp') return (p.v > 0 ? '+' : sign(p.v)) + trimNum(Math.abs(p.v), 1) + ' pp';
    if (p.unit === 'pct' && p.kind === 'derived') return sign(p.v) + trimNum(Math.abs(p.v), 1) + '%';
    return format(p.v, p.unit);
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------

  /**
   * The whole report as a spreadsheet.
   *
   * A blank cell stays blank. Writing 0 for a figure Screener never published
   * would be the same falsehood in a spreadsheet that it would be on the page,
   * and a spreadsheet is more likely to be summed without looking.
   */
  function toCsv(data) {
    var rows = [];
    var esc = function (v) {
      var t = (v === null || v === undefined) ? '' : String(v);
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };

    rows.push(['Screener X-Ray export']);
    rows.push(['Company', data.meta.name || '']);
    rows.push(['Ticker', data.meta.ticker || '']);
    rows.push(['Basis', data.meta.basis || '']);
    rows.push(['Source', data.meta.url || '']);
    rows.push(['Read at', data.meta.capturedAt || '']);
    rows.push(['Note', 'Figures as published on screener.in. An empty cell means '
      + 'Screener did not report that figure. It does not mean zero.']);
    rows.push([]);

    var table = function (title, t) {
      if (!t) return;
      rows.push([title]);
      rows.push([''].concat(t.periods));
      Object.keys(t.rows).forEach(function (key) {
        rows.push([key].concat(t.rows[key].map(function (v) {
          return Number.isFinite(v) ? v : '';
        })));
      });
      rows.push([]);
    };

    table('Profit & loss', data.sections.profitLoss);
    table('Balance sheet', data.sections.balanceSheet);
    table('Cash flow', data.sections.cashFlow);
    table('Ratios', data.sections.ratios);
    table('Quarterly results', data.sections.quarters);
    if (data.sections.shareholding) {
      table('Shareholding (quarterly)', data.sections.shareholding.quarterly);
      table('Shareholding (yearly)', data.sections.shareholding.yearly);
    }

    // Ours, not Screener's — labelled so nobody mistakes one for the other.
    var dp = dupont(data);
    if (dp) {
      rows.push(['Derived by Screener X-Ray — DuPont decomposition']);
      rows.push([''].concat(dp.periods));
      [['Net margin %', dp.netMargin], ['Asset turnover x', dp.assetTurnover],
       ['Leverage x', dp.leverage], ['Return on equity %', dp.roe],
       ['Book equity', dp.equity]].forEach(function (r) {
        rows.push([r[0]].concat(r[1].map(function (v) {
          return Number.isFinite(v) ? Number(v.toFixed(4)) : '';
        })));
      });
      rows.push([]);
    }

    var cc = cashConversion(data);
    if (cc) {
      rows.push(['Derived by Screener X-Ray — cash conversion']);
      rows.push([''].concat(cc.periods));
      rows.push(['CFO as % of PAT'].concat(cc.values.map(function (v) {
        return Number.isFinite(v) ? Number(v.toFixed(2)) : '';
      })));
      rows.push([]);
    }

    return rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
  }

  var api = {
    NOT_REPORTED: NOT_REPORTED,
    format: format, points: points, cagr: cagr, changeSuffix: changeSuffix,
    yearsBetween: yearsBetween, isDated: isDated, summarise: summarise,
    alignTo: alignTo, dupont: dupont, cashConversion: cashConversion, toCsv: toCsv,
    formatPart: formatPart
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;                                   // node --test stops here
  }


  // ===========================================================================
  // rendering
  // ===========================================================================

  var STORAGE_KEY = 'xray:last';
  var JOURNAL_PREFIX = 'xray:journal:';
  var CHARTS = root.ScreenerXRayChart;
  var INSIGHTS = root.ScreenerXRayInsights;
  var STMT = root.ScreenerXRayStatements;
  var XLSX = root.ScreenerXRayXlsx;

  /** Headline metrics, described in prose and listed in the rail. */
  var METRICS = [
    { key: 'revenue', label: 'Revenue', unit: 'inr' },
    { key: 'margin', label: 'Operating margin', unit: 'pct', useLabel: true },
    { key: 'pat', label: 'Profit after tax', unit: 'inr' },
    { key: 'cfo', label: 'Cash from operations', unit: 'inr' },
    { key: 'totalDebt', label: 'Borrowings', unit: 'inr' },
    { key: 'debtorDays', label: 'Debtor days', unit: 'days' },
    { key: 'inventoryDays', label: 'Inventory days', unit: 'days' },
    { key: 'promoterHolding', label: 'Promoter holding', unit: 'pct' },
    // Screener does not publish this unless the reader has added it to their
    // own ratio strip, so it usually reads "not reported". It is named anyway:
    // silence about a pledge is not the same as knowing there is none.
    { key: 'promoterPledge', label: 'Promoter pledge', unit: 'pct', scalar: true }
  ];

  /**
   * The full statements, printed row for row.
   *
   * Rather than naming the rows we want, every row Screener rendered is shown.
   * That is both less code and more correct: the row set differs by layout —
   * lenders have Deposits and no Inventory Days — so an allow-list would
   * quietly drop whatever it had not been told about.
   */
  // In the order an Indian annual report files them: balance sheet, profit and
  // loss, cash flow. `formatted` names the arrangement in statements.js.
  var STATEMENTS = [
    { key: 'balanceSheet', title: 'Balance sheet', units: 'money', formatted: 'balanceSheet' },
    { key: 'profitLoss', title: 'Profit & loss', units: 'money', formatted: 'profitAndLoss' },
    { key: 'cashFlow', title: 'Cash flow', units: 'money', formatted: 'cashFlow' },
    { key: 'quarters', title: 'Quarterly results', units: 'money', formatted: 'quarterlyResults' },
    { key: 'ratios', title: 'Ratios', units: 'days' }
  ];

  /** Rows Screener renders but that carry no figures worth tabulating. */
  var SKIP_ROWS = { 'Raw PDF': true };

  /**
   * What a table is denominated in, when its rows do not say for themselves.
   *
   * This is not cosmetic. The shareholding tables hold percentages, and
   * defaulting them to rupees printed "52.63" under a heading reading "₹ Cr" —
   * a promoter holding of 52.63% rendered as 52.63 crore rupees. Units belong
   * to the table as much as to the row.
   */
  var TABLE_UNITS = {
    money: { fallback: 'inr', note: '₹ Cr unless the row says otherwise' },
    percent: { fallback: 'pct', note: '% of shares outstanding' },
    days: { fallback: 'days', note: 'days unless the row says otherwise' }
  };

  /**
   * What kind of quantity a row holds, inferred from its own label.
   *
   * Screener's labels are self-describing — anything ending in "%" is a ratio,
   * anything counting days says so — which keeps this working for row sets we
   * have never seen on sectors we have not sampled.
   */
  function unitForRow(label, fallback) {
    if (/%$/.test(label) || label === 'CFO/OP') return 'pct';
    if (/\bDays\b|Cycle$/.test(label)) return 'days';
    if (/^EPS/.test(label)) return 'rupee';
    if (/^No\. of/.test(label)) return 'count';
    return fallback || 'inr';
  }

  function el(tag, className, txt) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (txt !== undefined && txt !== null) node.textContent = txt;
    return node;
  }

  function block(title) {
    var section = el('section', 'rail-block');
    section.appendChild(el('h3', 'rail-head', title));
    return section;
  }

  function sourceLine(extra) {
    return el('p', 'source-line', 'Source: screener.in' + (extra ? ' · ' + extra : ''));
  }

  function promoterHoldingYearly(data) {
    var y = data.sections.shareholding && data.sections.shareholding.yearly;
    if (!y || !y.rows.Promoters) return null;
    return { periods: y.periods, dateKeys: y.dateKeys, values: y.rows.Promoters };
  }

  /**
   * Promoter holding for the snapshot: the quarterly series where Screener has
   * one, otherwise the yearly.
   *
   * HDFC Bank needs the fallback. Post-merger its promoter holding is a genuine
   * 0%, and Screener drops the row from the quarterly table while keeping it in
   * the yearly one. Reading only the quarterly table would print "not reported"
   * beside a table cell showing 0% — hiding a real reported figure behind the
   * wording reserved for missing ones.
   */
  function fieldFor(data, key) {
    if (key === 'promoterHolding') {
      return data.fields.promoterHolding || promoterHoldingYearly(data);
    }
    return data.fields[key];
  }

  function metricLabel(metric, field) {
    return (metric.useLabel && field && field.label) ? field.label : metric.label;
  }

  /**
   * Breakage banner.
   *
   * content.js records what parse.js could not find. If a required expectation
   * failed, say so at the top of the report — a page of blanks that does not
   * explain itself reads as "this company reports nothing", which is a false
   * statement about a real company.
   */
  function renderHealth(data, mount) {
    var health = data.meta.health;
    if (!health || health.ok) return;

    var box = el('section', 'breakage');
    box.appendChild(el('h2', null, 'Some figures could not be read'));
    box.appendChild(el('p', null,
      'Screener’s page layout has changed since this extension was last updated, ' +
      'so parts of this report are missing rather than empty. Blanks below may ' +
      'reflect that change rather than anything about the company — check the ' +
      'Screener page itself before relying on them.'));

    var ul = el('ul');
    health.missingRequired.forEach(function (c) {
      ul.appendChild(el('li', null, c.label + ' (' + c.selector + ')'));
    });
    box.appendChild(ul);
    mount.appendChild(box);
  }

  /**
   * Attribution line, shown on screen and in print.
   *
   * The exported page is the one artefact that travels — posted to a forum,
   * mailed to a friend — so it names what produced it and which company and
   * basis it describes. Without the basis, a printed page of standalone figures
   * is indistinguishable from consolidated ones once it leaves the browser.
   *
   * Add the store listing URL here once the extension is published; a dead or
   * placeholder link is worse than no link.
   */
  function renderAttribution(data) {
    var slot = document.getElementById('attribution-meta');
    if (!slot) return;
    var m = data.meta;
    var bits = [];
    if (m.name) bits.push(m.name + (m.ticker ? ' (' + m.ticker + ')' : ''));
    if (m.basis) bits.push(m.basis);
    if (m.capturedAt) {
      bits.push('read ' + new Date(m.capturedAt)
        .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
    }
    slot.textContent = bits.join(' · ');
  }

  // --- X-Ray findings ---------------------------------------------------------

  /**
   * The findings block: what the page shows when its sections are read against
   * each other. It sits at the top because it is the one thing on this page a
   * reader could not get by scrolling Screener — everything below it is the
   * same data laid out better; this is what the data says in combination.
   */
  function renderFindings(data, mount) {
    if (!INSIGHTS || typeof INSIGHTS.findings !== 'function') return;
    var list = INSIGHTS.findings(data);
    if (!list.length) return;

    var section = el('section', 'findings');
    section.appendChild(el('h2', 'findings-head', 'X-Ray findings'));
    section.appendChild(el('p', 'findings-note',
      'What this page shows when its sections are read against each other. Each line ' +
      'states a relationship and its numbers — none of them is a verdict on the company.'));

    var ul = el('ul', 'findings-list');
    list.forEach(function (f) {
      var li = el('li', 'finding');
      li.appendChild(el('strong', 'finding-title', f.title + '. '));
      f.parts.forEach(function (p) {
        li.appendChild(p.t !== undefined
          ? document.createTextNode(p.t)
          : el('span', p.kind === 'derived' ? 'derived' : 'figure', formatPart(p)));
      });
      li.appendChild(el('span', 'finding-src', f.sources.join(' · ')));
      ul.appendChild(li);
    });
    section.appendChild(ul);
    mount.appendChild(section);
  }

  // --- masthead and title ----------------------------------------------------

  function renderTitle(data, mount) {
    var m = data.meta;

    var subject = document.getElementById('masthead-subject');
    if (subject) {
      subject.textContent = (m.name || 'Company') + (m.ticker ? ' (' + m.ticker + ')' : '');
    }

    var head = el('div', 'titleblock');
    head.appendChild(el('h1', null, m.name || 'Unknown company'));
    head.appendChild(el('p', 'standfirst',
      (m.basis === 'consolidated' ? 'Consolidated' :
        m.basis === 'standalone' ? 'Standalone' : 'Reported') +
      ' figures as published on screener.in — described, not rated.'));

    var line = el('div', 'dateline');
    if (m.capturedAt) {
      line.appendChild(el('span', null, 'Read ' + new Date(m.capturedAt)
        .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
    }
    if (m.ticker) line.appendChild(el('span', null, 'NSE: ' + m.ticker));
    if (m.website) {
      var w = el('a', null, m.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
      w.href = m.website;
      w.target = '_blank';
      w.rel = 'noreferrer noopener';
      line.appendChild(w);
    }
    if (m.url) {
      var a = el('a', null, m.url.replace(/^https?:\/\/(www\.)?/, ''));
      a.href = m.url;
      a.rel = 'noreferrer';
      line.appendChild(a);
    }
    head.appendChild(line);
    mount.appendChild(head);
  }

  // --- about -----------------------------------------------------------------

  function renderAbout(data, mount) {
    var m = data.meta;
    if (!m.about && !m.keyPoints) return;

    mount.appendChild(el('h2', null, 'About the company'));
    if (m.about) mount.appendChild(el('p', 'about-text', m.about));
    if (m.keyPoints) {
      // Screener keeps most of this block behind a "show more" fetch, so on some
      // companies all that is server-rendered is a dangling heading ("Business
      // Segments - FY26:"). Print it only when there is a real sentence there.
      var points = m.keyPoints.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
      if (points.length > 40) mount.appendChild(el('p', 'keypoints', points));
    }
    mount.appendChild(sourceLine('company profile'));
  }

  // --- narrative -------------------------------------------------------------

  function renderNarrative(data, mount) {
    mount.appendChild(el('h2', 'accent', 'What the figures show'));
    var wrap = el('div', 'narrative');

    METRICS.forEach(function (metric) {
      var field = fieldFor(data, metric.key);
      var s = metric.scalar
        ? { available: Number.isFinite(field), headline: format(field, metric.unit),
            detail: null, derived: null }
        : summarise(field, metric.unit);

      var p = el('p');
      p.appendChild(el('strong', null, metricLabel(metric, field) + '. '));

      if (!s.available) {
        p.appendChild(el('span', 'absent', 'Not reported on this page.'));
        wrap.appendChild(p);
        return;
      }

      p.appendChild(el('span', 'figure', s.headline));
      if (s.detail) {
        p.appendChild(document.createTextNode('. ' + s.detail));
        if (s.derived) {
          p.appendChild(document.createTextNode(', '));
          p.appendChild(el('span', 'derived', s.derived));
        }
      }
      p.appendChild(document.createTextNode('.'));
      wrap.appendChild(p);
    });

    mount.appendChild(wrap);
  }

  // --- journal (thesis) ------------------------------------------------------

  function journalKey(data) {
    var m = data.meta;
    return JOURNAL_PREFIX + (m.ticker || m.companyId || m.name || 'unknown');
  }

  /** Grow the box to fit its text, so printing never clips what was written. */
  function autoGrow(area) {
    area.style.height = 'auto';
    area.style.height = Math.max(96, area.scrollHeight) + 'px';
  }

  function renderEntries(list, entries) {
    list.textContent = '';
    if (!entries || !entries.length) {
      list.appendChild(el('p', 'absent entries-empty', 'No saved entries yet.'));
      return;
    }
    entries.slice().reverse().forEach(function (entry) {
      var item = el('li', 'entry');
      item.appendChild(el('div', 'entry-date', new Date(entry.savedAt)
        .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
      item.appendChild(el('div', 'entry-text', entry.text));
      list.appendChild(item);
    });
  }

  /**
   * The thesis box and its dated history.
   *
   * Everything lives in chrome.storage.local under this company's own key, so
   * notes stay on this device and accumulate across visits (CLAUDE.md rule 2).
   */
  function renderJournal(data, mount) {
    var key = journalKey(data);

    mount.appendChild(el('h2', 'accent', 'Your thesis'));
    mount.appendChild(el('p', 'hint no-print',
      'Saved on this device only, against ' + (data.meta.ticker || 'this company') +
      '. Re-opening this page brings it back.'));

    var area = el('textarea', 'thesis');
    area.id = 'thesis';
    area.setAttribute('placeholder',
      'What do you make of the figures above? What would change your mind?');
    mount.appendChild(area);

    var bar = el('div', 'journal-actions no-print');
    var status = el('span', 'journal-status', '');
    var save = el('button', 'btn', 'Save dated entry');
    var print = el('button', 'btn btn-quiet', 'Print / Save as PDF');
    var csv = el('button', 'btn btn-quiet', 'Download data (CSV)');
    save.type = 'button';
    print.type = 'button';
    csv.type = 'button';
    bar.appendChild(status);
    bar.appendChild(csv);
    bar.appendChild(save);
    bar.appendChild(print);
    mount.appendChild(bar);

    var list = el('ol', 'entries');
    mount.appendChild(list);

    var state = { draft: '', entries: [] };

    function persist(note) {
      var payload = {};
      payload[key] = state;
      return chrome.storage.local.set(payload).then(function () {
        status.textContent = note || 'Saved';
        status.className = 'journal-status saved';
      }).catch(function (err) {
        console.error('[Screener X-Ray] could not save thesis', err);
        status.textContent = 'Could not save';
        status.className = 'journal-status failed';
      });
    }

    chrome.storage.local.get(key).then(function (stored) {
      var found = stored[key];
      if (found) {
        state.draft = found.draft || '';
        state.entries = Array.isArray(found.entries) ? found.entries : [];
      }
      area.value = state.draft;
      autoGrow(area);
      renderEntries(list, state.entries);
    }).catch(function (err) {
      console.error('[Screener X-Ray] could not read thesis', err);
      renderEntries(list, []);
    });

    var timer = null;
    area.addEventListener('input', function () {
      autoGrow(area);
      state.draft = area.value;
      status.textContent = 'Saving…';
      status.className = 'journal-status';
      clearTimeout(timer);
      timer = setTimeout(function () { persist(); }, 400);
    });

    save.addEventListener('click', function () {
      var text = area.value.trim();
      if (!text) {
        status.textContent = 'Nothing to save yet';
        status.className = 'journal-status';
        return;
      }
      state.entries.push({ savedAt: new Date().toISOString(), text: text });
      renderEntries(list, state.entries);
      persist('Entry saved');
    });

    print.addEventListener('click', function () { window.print(); });

    csv.addEventListener('click', function () {
      try {
        downloadCsv(data);
        status.textContent = 'CSV downloaded';
        status.className = 'journal-status saved';
      } catch (err) {
        console.error('[Screener X-Ray] CSV export failed', err);
        status.textContent = 'Could not build the CSV';
        status.className = 'journal-status failed';
      }
    });
  }

  // --- statements ------------------------------------------------------------

  /**
   * One parsed section, every row, most recent periods last.
   *
   * Columns come from the table's own header, so a section with a TTM column
   * gets one and a section without does not.
   */
  /**
   * A statement cell.
   *
   * Unlike the prose, these carry no "₹" and no " Cr" — the unit is stated once
   * in the heading instead. Repeating it in every cell pushed the wider tables
   * (a bank's revenue runs to ₹3,51,819 Cr) past the page, which clips in print.
   * Research tables label the unit once for exactly this reason.
   */
  function cellText(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (unit === 'pct') return trimNum(v, 2) + '%';
    if (unit === 'rupee') return trimNum(v, 2);
    if (unit === 'days' || unit === 'count') return v.toLocaleString('en-IN');
    // same rule as inr(): a real value under 100 keeps its decimals
    return v.toLocaleString('en-IN',
      { maximumFractionDigits: Math.abs(v) < 100 && v !== Math.round(v) ? 2 : 0 });
  }

  function renderStatement(title, table, mount, maxCols, units) {
    if (!table) return;
    var denom = TABLE_UNITS[units || 'money'];
    var keys = Object.keys(table.rows).filter(function (k) { return !SKIP_ROWS[k]; });
    if (!keys.length) return;

    var total = table.periods.length;
    var start = Math.max(0, total - (maxCols || 12));
    var idx = [];
    for (var i = start; i < total; i++) idx.push(i);

    var wrap = el('div', 'statement');
    var heading = el('h3', 'statement-head', title);
    heading.appendChild(el('span', 'unit-note', denom.note));
    wrap.appendChild(heading);

    var scroll = el('div', 'table-wrap');
    var t = el('table', 'figures');

    var thead = el('thead'), hrow = el('tr');
    hrow.appendChild(el('th', 'rowlabel', ''));
    idx.forEach(function (i) { hrow.appendChild(el('th', null, table.periods[i])); });
    thead.appendChild(hrow);
    t.appendChild(thead);

    var tbody = el('tbody');
    keys.forEach(function (rowKey) {
      var unit = unitForRow(rowKey, denom.fallback);
      var values = table.rows[rowKey];
      var tr = el('tr');
      tr.appendChild(el('th', 'rowlabel', rowKey));
      idx.forEach(function (i) {
        var v = values[i];
        // A blank cell is shown as a dash in the muted "absent" treatment —
        // never as 0, which in a financial table is a different claim.
        var missing = v === null || v === undefined || !Number.isFinite(v);
        tr.appendChild(el('td', missing ? 'absent' : 'figure', cellText(v, unit)));
      });
      tbody.appendChild(tr);
    });

    t.appendChild(tbody);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    mount.appendChild(wrap);
  }

  /**
   * A statement in the Indian arrangement (statements.js).
   *
   * Carries the common-size view analysts build in their own models: each rupee
   * line as a share of revenue, or of total assets. That is a division, so it is
   * blue, and a base that is missing or not positive leaves a blank rather than
   * a share of nothing.
   */
  function renderFormatted(s, mount, maxCols) {
    var total = s.periods.length;
    var idx = [];
    for (var i = Math.max(0, total - maxCols); i < total; i++) idx.push(i);

    var wrap = el('div', 'statement formatted');
    var heading = el('h3', 'statement-head', s.title);
    var unit = el('span', 'unit-note', '₹ Cr unless the line says otherwise');
    heading.appendChild(unit);
    wrap.appendChild(heading);

    var bar = el('div', 'format-line');
    bar.appendChild(el('span', null, 'Set out as ' + s.format +
      (s.export ? ' · with lines from Screener’s Excel export' : '')));
    var common = false;
    var toggle = null;
    if (s.base) {
      toggle = el('button', 'btn btn-quiet btn-small', 'Show as ' + s.baseLabel);
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', 'false');
      bar.appendChild(toggle);
    }
    wrap.appendChild(bar);

    var scroll = el('div', 'table-wrap');
    var t = el('table', 'figures statement-table');
    var thead = el('thead'), hrow = el('tr');
    hrow.appendChild(el('th', 'rowlabel', ''));
    idx.forEach(function (i) { hrow.appendChild(el('th', null, s.periods[i])); });
    thead.appendChild(hrow);
    t.appendChild(thead);
    var tbody = el('tbody');
    t.appendChild(tbody);

    function label(line) {
      var th = el('th', 'rowlabel');
      if (line.roman) th.appendChild(el('span', 'roman', line.roman));
      // in the percent view the unit note changes; a line left in rupees says so
      th.appendChild(document.createTextNode(line.label +
        (common && line.memo && line.unit === 'inr' ? ' (₹ Cr)' : '')));
      if (line.note) th.appendChild(el('sup', 'note-mark', 'abcdefghij'.charAt(s.notes.indexOf(line.note))));
      return th;
    }

    function fill() {
      tbody.textContent = '';
      s.lines.forEach(function (line) {
        if (line.type === 'heading') {
          var hr = el('tr', 'stmt-heading' + (line.memo ? ' memo' : ''));
          var th = label(line);
          th.colSpan = idx.length + 1;
          hr.appendChild(th);
          tbody.appendChild(hr);
          return;
        }
        var cls = [line.total ? 'total' : '', line.level ? 'level-' + line.level : '', line.memo ? 'memo' : '']
          .filter(Boolean).join(' ');
        var tr = el('tr', cls || null);
        tr.appendChild(label(line));
        // memo lines stay in rupees: operating profit as a share of revenue is
        // the margin printed on the line below it
        var asShare = common && line.unit === 'inr' && !line.memo;
        // One precision per line. The export carries decimals the page rounds
        // away, and "80.44" beside "101" reads as two different kinds of number.
        // A line holding a small figure keeps its decimals (see inr()).
        var whole = line.unit === 'inr' && line.values.every(function (v) {
          return v === null || v === 0 || Math.abs(v) >= 10;
        });
        idx.forEach(function (i) {
          var v = line.values[i];
          var b = s.base ? s.base[i] : null;
          if (v === null || !Number.isFinite(v) || (asShare && !(b > 0))) {
            tr.appendChild(el('td', 'absent', '—'));
          } else if (asShare) {
            // fixed to one decimal so the column lines up: 9.0% under 9.2%, not 9%
            tr.appendChild(el('td', 'derived', (v / b * 100).toFixed(1) + '%'));
          } else {
            tr.appendChild(el('td', line.kind === 'derived' ? 'derived' : 'figure',
              cellText(whole ? Math.round(v) : v, line.unit)));
          }
        });
        tbody.appendChild(tr);
      });
    }
    fill();

    if (toggle) {
      toggle.addEventListener('click', function () {
        common = !common;
        toggle.setAttribute('aria-pressed', String(common));
        toggle.textContent = common ? 'Show in ₹ Cr' : 'Show as ' + s.baseLabel;
        unit.textContent = (common ? s.baseLabel : '₹ Cr') + ' unless the line says otherwise';
        fill();
      });
    }

    scroll.appendChild(t);
    wrap.appendChild(scroll);
    if (s.notes.length) {
      var notes = el('ol', 'stmt-notes');
      s.notes.forEach(function (n) { notes.appendChild(el('li', null, n)); });
      wrap.appendChild(notes);
    }
    mount.appendChild(wrap);
  }

  function exportKey(data) {
    return 'xray:export:' + (data.meta.companyId || data.meta.ticker || data.meta.name);
  }

  /**
   * Screener's Excel export, added by the reader.
   *
   * The page shows one Expenses line; the export itemises it. The reader
   * downloads the file from Screener and chooses it here. It is read on this
   * device and kept beside the report in local storage — nothing is fetched and
   * nothing is sent (rule 2).
   */
  function renderExportDrop(data, mount) {
    var box = el('div', 'export-drop');
    var status = el('p', 'hint');

    if (data.export) {
      status.textContent = 'Using Screener’s Excel export for ' + (data.export.company || 'this company') +
        '. Its lines are added below wherever they agree with the page, each marked with a note.';
      var remove = el('button', 'btn btn-quiet btn-small', 'Remove export');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        chrome.storage.local.remove(exportKey(data)).catch(function () {}).then(function () {
          delete data.export;
          render(data);
        });
      });
      box.appendChild(status);
      box.appendChild(remove);
      mount.appendChild(box);
      return;
    }

    var pick = el('label', 'btn btn-quiet btn-small', 'Add Screener’s Excel export');
    var input = el('input', 'visually-hidden');
    input.type = 'file';
    input.accept = '.xlsx';
    pick.appendChild(input);
    status.textContent = 'Optional. On the company page choose Export to Excel, then pick that file here to ' +
      'itemise expenses and other assets. The file is read on this device and never uploaded.';

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      status.className = 'hint';
      if (file.size > 5e6) {
        status.textContent = 'That file is too large to be Screener’s export.';
        status.className = 'hint export-error';
        return;
      }
      status.textContent = 'Reading ' + file.name + '…';
      file.arrayBuffer().then(XLSX.readScreenerExport).then(function (exp) {
        var check = XLSX.matchesPage(exp, data);
        if (!check.ok) throw new Error(check.reason);
        data.export = exp;
        var payload = {};
        payload[exportKey(data)] = exp;
        // shown even if it cannot be kept for next time
        return chrome.storage.local.set(payload).catch(function () {}).then(function () { render(data); });
      }).catch(function (err) {
        status.textContent = 'Could not use that file. ' + ((err && err.message) || String(err));
        status.className = 'hint export-error';
        input.value = '';
      });
    });

    box.appendChild(pick);
    box.appendChild(status);
    mount.appendChild(box);
  }

  function renderStatements(data, mount) {
    mount.appendChild(el('h2', null, 'Financial statements'));
    mount.appendChild(el('p', 'hint',
      'Screener’s figures, set out in the order Indian companies file them. Blue lines are ' +
      'worked out here from Screener’s own lines; a letter marks a note on where Screener’s ' +
      'condensed figures differ from the prescribed format.'));
    renderExportDrop(data, mount);
    STATEMENTS.forEach(function (s) {
      var maxCols = s.key === 'quarters' ? 10 : 12;
      var formatted = s.formatted && STMT ? STMT[s.formatted](data) : null;
      // The arrangement needs revenue and profit before tax. Without them the
      // table is shown exactly as Screener publishes it — never dropped.
      if (formatted) renderFormatted(formatted, mount, maxCols);
      else renderStatement(s.title, data.sections[s.key], mount, maxCols, s.units);
    });

    // One shareholding table, not two. The quarterly and yearly tables carry the
    // same rows at different granularity; printing both restated every holding.
    // The recent detail goes here and the long view is in the Ownership chart.
    var shp = data.sections.shareholding;
    if (shp) {
      // percent, not rupees — see TABLE_UNITS
      renderStatement('Shareholding pattern', shp.quarterly || shp.yearly, mount, 12, 'percent');
    }
    mount.appendChild(sourceLine(data.meta.basis || 'as published'));
  }

  // --- announcements and filings ---------------------------------------------

  function linkList(items, className) {
    var ul = el('ul', className || 'announcements');
    items.forEach(function (a) {
      var li = el('li');
      if (a.date) {
        li.appendChild(el('span', 'when', new Date(a.date)
          .toLocaleDateString(undefined, { day: '2-digit', month: 'short' })));
      }
      if (a.url) {
        var link = el('a', null, a.title);
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        li.appendChild(link);
      } else {
        li.appendChild(document.createTextNode(a.title));
      }
      if (a.note) li.appendChild(el('span', 'note', a.note));
      ul.appendChild(li);
    });
    return ul;
  }

  function renderAnnouncements(data, mount) {
    var list = data.fields.announcements;
    mount.appendChild(el('h2', null, 'Recent announcements'));
    if (!list || !list.length) {
      mount.appendChild(el('p', 'absent', NOT_REPORTED));
      return;
    }
    mount.appendChild(linkList(list));
    mount.appendChild(sourceLine(
      'listed as published, in Screener’s order, not filtered or interpreted'));
  }

  function renderFilings(data, mount) {
    var docs = data.documents;
    if (!docs) return;
    var groups = [
      ['annualReports', 'Annual reports'],
      ['creditRatings', 'Credit ratings'],
      ['concalls', 'Concalls']
    ];
    var any = groups.some(function (g) { return docs[g[0]] && docs[g[0]].length; });
    if (!any) return;

    var section = block('Filings');
    groups.forEach(function (g) {
      var items = docs[g[0]];
      if (!items || !items.length) return;
      section.appendChild(el('p', 'filing-head', g[1] + ' (' + items.length + ')'));
      section.appendChild(linkList(items.slice(0, 4), 'filings'));
    });
    mount.appendChild(section);
  }

  // --- rail ------------------------------------------------------------------

  function kvRow(table, label, value, className) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    tr.appendChild(el('td', className || 'figure', value));
    table.appendChild(tr);
  }

  /**
   * Screener's own ratio strip, exactly as the user has it configured.
   *
   * That list is per-account: a logged-out visitor sees nine entries, a user
   * with a customised set sees twenty or more. Rendering whatever is present
   * means a reader's own ratios carry through to the page.
   */
  function renderGlance(data, mount) {
    var ratios = data.topRatiosText || {};
    var names = Object.keys(ratios);
    if (!names.length) return;

    var section = block('Screener ratios');
    var table = el('table', 'kv');
    var seen = {};
    names.forEach(function (name) {
      var norm = name.toLowerCase();
      if (seen[norm]) return;                  // the strip can repeat a label
      seen[norm] = true;
      var value = ratios[name];
      kvRow(table, name, value || NOT_REPORTED, value ? 'figure' : 'absent');
    });
    section.appendChild(table);
    mount.appendChild(section);
  }

  function renderRanges(data, mount) {
    var ranges = data.ranges || {};
    var names = Object.keys(ranges);
    if (!names.length) return;

    names.forEach(function (name) {
      var buckets = ranges[name];
      var keys = Object.keys(buckets);
      if (!keys.length) return;
      var section = block(name);
      var table = el('table', 'kv');
      keys.forEach(function (k) {
        var v = buckets[k];
        kvRow(table, k, format(v, 'pct'), Number.isFinite(v) ? 'figure' : 'absent');
      });
      section.appendChild(table);
      mount.appendChild(section);
    });
  }

  function tail(series, n) {
    if (!series) return null;
    var start = Math.max(0, series.values.length - n);
    return { periods: series.periods.slice(start), values: series.values.slice(start) };
  }

  /**
   * Year-on-year growth of a series, as a percentage.
   *
   * null wherever the comparison would be meaningless: no prior period, a
   * missing figure at either end, or a base that is zero or negative — growth
   * measured from a loss or from nothing is not a percentage.
   */
  function yoyGrowth(series) {
    if (!series) return null;
    var out = series.values.map(function (v, i) {
      var prev = i > 0 ? series.values[i - 1] : null;
      if (v === null || prev === null || !Number.isFinite(v) || !Number.isFinite(prev)) return null;
      if (prev <= 0) return null;
      return ((v - prev) / prev) * 100;
    });
    return { periods: series.periods, dateKeys: series.dateKeys, values: out };
  }

  /**
   * The shareholding pattern as a stack: who owns the company, over time.
   *
   * A single promoter-holding line answers less than the mix does — promoters
   * selling into institutions and promoters selling into retail are different
   * events, and only the stack shows which happened.
   */
  function shareholdingSeries(data) {
    var shp = data.sections.shareholding;
    var table = (shp && shp.yearly) || (shp && shp.quarterly);
    if (!table) return null;

    var order = ['Promoters', 'FIIs', 'DIIs', 'Government', 'Public', 'Others'];
    var series = [];
    order.forEach(function (name) {
      var values = table.rows[name];
      if (!values) return;                       // a company with no promoter has no row
      if (!values.some(function (v) { return Number.isFinite(v) && v !== 0; })) return;
      series.push({ label: name, values: values, type: 'bar' });
    });
    if (!series.length) return null;
    return { periods: table.periods, series: series };
  }

  /**
   * The profit bridge: how revenue becomes profit after tax, line by line.
   *
   * Two step lists, because the two Screener layouts describe genuinely
   * different businesses. A lender's costs run Interest then Expenses to a
   * Financing Profit; a manufacturer's run Expenses to an Operating Profit.
   * Forcing one shape onto both would mislabel a real figure.
   *
   * Tax is the one derived step — Screener publishes a rate, not an amount, so
   * it is taken as profit before tax less profit after tax.
   */
  function profitBridge(data) {
    var pl = data.sections.profitLoss;
    if (!pl) return null;

    // The most recent COMPLETED year carrying a revenue figure.
    //
    // Not TTM, even though it is the newest column. A bridge describes a
    // reporting period, and the trailing-twelve-month column is a rolling
    // window that does not correspond to any set of accounts the company filed.
    // It also leaves several rows blank, which would refuse the chart anyway.
    var revenueKey = ['Sales', 'Revenue', 'Income'].filter(function (k) { return pl.rows[k]; })[0];
    if (!revenueKey) return null;

    var idx = -1;
    for (var i = pl.rows[revenueKey].length - 1; i >= 0; i--) {
      if (!Number.isFinite(pl.rows[revenueKey][i])) continue;
      if (!isDated(pl.dateKeys && pl.dateKeys[i])) continue;
      idx = i;
      break;
    }
    if (idx === -1) return null;

    var at = function (key) {
      var row = pl.rows[key];
      var v = row ? row[idx] : null;
      return Number.isFinite(v) ? v : null;
    };

    var lending = !!pl.rows['Financing Profit'];
    var operating = lending ? 'Financing Profit' : 'Operating Profit';

    var steps = [{ label: revenueKey, value: at(revenueKey), kind: 'start' }];
    if (lending && at('Interest') !== null) {
      steps.push({ label: 'Interest', value: -at('Interest'), kind: 'delta' });
    }
    steps.push({ label: 'Expenses', value: at('Expenses') === null ? null : -at('Expenses'), kind: 'delta' });
    steps.push({ label: operating, value: at(operating), kind: 'subtotal' });
    steps.push({ label: 'Other income', value: at('Other Income'), kind: 'delta' });
    if (!lending) {
      steps.push({ label: 'Interest', value: at('Interest') === null ? null : -at('Interest'), kind: 'delta' });
    }
    steps.push({ label: 'Depreciation', value: at('Depreciation') === null ? null : -at('Depreciation'), kind: 'delta' });
    steps.push({ label: 'Profit before tax', value: at('Profit before tax'), kind: 'subtotal' });

    var pbt = at('Profit before tax'), pat = at('Net Profit');
    steps.push({
      label: 'Tax',
      value: (pbt === null || pat === null) ? null : -(pbt - pat),
      kind: 'delta'
    });
    steps.push({ label: 'Net Profit', value: pat, kind: 'subtotal' });

    return { period: pl.periods[idx], steps: steps };
  }

  /**
   * Hand the CSV to the browser as a download.
   *
   * A Blob URL rather than a data: URI — a large company's export runs past
   * what some browsers accept in a URL. The object URL is revoked afterwards so
   * the tab does not hold the whole export in memory for the rest of its life.
   */
  function downloadCsv(data) {
    var name = (data.meta.ticker || data.meta.name || 'company')
      .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    var stamp = new Date().toISOString().slice(0, 10);

    // The BOM is what makes Excel open this as UTF-8 rather than mangling any
    // non-ASCII in a company name.
    var blob = new Blob(['﻿' + toCsv(data)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'screener-xray-' + name + '-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /**
   * Plain-English notes on how to read the derived measures.
   *
   * The diligence behind this project ranked an education layer fourth among
   * its applications, on the grounds that cash conversion and DuPont are
   * CFA-curriculum ideas most retail investors have never been taught to read
   * visually — and warned, in the same document, that auto-generated analysis
   * risks producing "faster, more numerous confident-feeling decisions ...
   * without necessarily deepening the underlying literacy of the investor
   * making them". A chart nobody can read is not neutral; it is worse than no
   * chart, because it looks like understanding.
   *
   * These say what a measure IS and what moves it. They never say what a
   * reading means about a company, never name a threshold, and never suggest an
   * action — that is rule 5, and it is also the difference between explaining a
   * tool and using it on the reader's behalf.
   */
  var EXPLAINERS = {
    'Quarterly revenue and margin':
      'Thirteen quarters of revenue, with the margin on the right scale. Quarterly '
      + 'figures are seasonal, so a quarter says more against the same quarter a year '
      + 'earlier than against the one just before it.',

    'Asset quality':
      'Gross NPA is the share of a lender’s loans on which repayment has stopped; net '
      + 'NPA is what is left after the provisions set aside against them. The distance '
      + 'between the two lines is the part already provided for.',

    'Funding mix':
      'Where a bank’s money comes from: deposits placed by customers, or borrowings from '
      + 'other lenders and the market. The two cost different amounts and behave '
      + 'differently when conditions change.',

    'Where the cash went':
      'Operating is cash the business generated; investing is cash spent on, or received '
      + 'from, assets and investments; financing is cash raised from, or returned to, '
      + 'lenders and shareholders. In each year the three add up to the change in cash.',

    'Interest cover':
      'Earnings before interest — operating profit plus other income, less depreciation — '
      + 'divided by the interest bill: how many times that year’s interest the earnings '
      + 'would have paid. Years with negative earnings are left as gaps, not drawn below zero.',

    'Return on capital employed':
      'Profit before interest and tax as a share of all the capital used to earn it, '
      + 'equity and debt together, as Screener publishes it. Unlike return on equity, it '
      + 'is not raised by borrowing more.',

    'Return on equity':
      'Profit as a share of shareholders’ equity, as Screener publishes it year by year for '
      + 'lenders. Equity is a thin slice of a lender’s balance sheet, so modest changes in '
      + 'profit move this line visibly.',

    'Earnings per share and payout':
      'Bars are earnings per share in rupees; the line is the share of profit paid out as '
      + 'dividends. A dividend can rise through higher earnings or a higher payout, and '
      + 'this chart shows which.',

    'Other income and profit before tax':
      'Other income is earned outside the main business — interest on cash, dividends, '
      + 'gains on selling investments or assets. Beside profit before tax it shows how '
      + 'much of the pre-tax result came from outside operations.',

    'Fixed assets and work in progress':
      'Fixed assets are the plant, property and equipment in use; work in progress is '
      + 'capacity still being built and not yet earning. The upper slice is money already '
      + 'spent whose revenue has not arrived.',

    'Cash conversion':
      'Profit is an opinion about timing; cash is a fact. This compares the cash '
      + 'a business actually collected from its operations against the profit it '
      + 'reported over the same years. The two differ whenever profit is '
      + 'recognised in a different period from the cash behind it — sales made on '
      + 'credit, stock bought ahead of demand, costs capitalised rather than '
      + 'expensed. The gap is not a verdict; it is a question about where the '
      + 'difference came from.',

    'ROE decomposition (DuPont)':
      'Return on equity is three things multiplied together: how much profit each '
      + 'rupee of sales leaves (margin), how much sales each rupee of assets '
      + 'produces (turnover), and how many rupees of assets sit on each rupee of '
      + 'the owners\u2019 money (leverage). Two companies can report the same ROE '
      + 'and have arrived at it in completely different ways — one on margin, '
      + 'another on borrowing. Splitting it shows which.',

    'Operating leverage':
      'Each dot is one year: revenue growth along the bottom, operating margin up '
      + 'the side. Dots rising as they move right describe years where margin '
      + 'widened as the business grew — the usual sign of fixed costs being spread '
      + 'over more sales. Flat or falling dots describe growth that did not leave '
      + 'more behind. Lighter dots are earlier years, darker ones more recent.',

    'Working capital days':
      'How long the company\u2019s money sits still. Debtor days are how long '
      + 'customers take to pay; inventory days are how long stock waits before it '
      + 'sells. Both are cash the business has already spent but not yet got back, '
      + 'so a lengthening stack means growth is absorbing cash rather than '
      + 'releasing it. Lenders have neither row — they have no stock, and their '
      + 'receivables are the business itself.',

    'Ownership':
      'Who holds the shares, over time. What matters is usually not the level but '
      + 'the direction and the counterparty: promoters selling into institutions '
      + 'and promoters selling into retail are different events, and a single '
      + 'promoter-holding line cannot tell them apart.',

    'Revenue and margin':
      'Bars are revenue on the left scale; the line is operating margin on the '
      + 'right. Kept together because the pair answers a question neither answers '
      + 'alone — whether growth is being bought with margin.'
  };

  var BRIDGE_EXPLAINER =
    'Every rupee of revenue, and where it went. Each step takes something off or '
    + 'adds something back, and the checkpoints in between are figures the company '
    + 'reported: operating profit, profit before tax, profit after tax. It shows '
    + 'which line item does the most to the bottom line — for many businesses the '
    + 'answer is not the one that gets discussed.';

  /**
   * A collapsed explainer. Native <details> — no script, keyboard-accessible for
   * free, and if a reader opens it before printing it prints open.
   */
  function explainer(body) {
    if (!body) return null;
    var d = document.createElement('details');
    d.className = 'explainer';
    var sum = document.createElement('summary');
    sum.textContent = 'How to read this';
    d.appendChild(sum);
    d.appendChild(el('p', null, body));
    return d;
  }

  /** Attach the explainer belonging to a chart, if there is one. */
  function withExplainer(figure, title) {
    if (!figure) return figure;
    var key = String(title).split(' \u00b7 ')[0];
    var note = explainer(EXPLAINERS[key] || (/becomes profit/.test(key) ? BRIDGE_EXPLAINER : null));
    if (note) figure.appendChild(note);
    return figure;
  }

  // --- chart catalogue -------------------------------------------------------

  /**
   * How many charts each part of the page carries.
   *
   * Ten in all. Charts are chosen per company from a catalogue rather than
   * hard-wired, because the right set differs by business: a bank has no
   * inventory days but does have NPAs and a deposit base; a manufacturer is the
   * reverse. A fixed set left RBL Bank with a half-empty chart row. Only charts
   * with data are ever placed, so a slot is never filled by an empty frame.
   */
  var CHART_TARGET = { wide: 2, body: 4, rail: 4 };

  /** Trim a derived table's parallel arrays to the last n periods. */
  function tailDerived(d, keys, n) {
    if (!d) return null;
    var start = Math.max(0, d.periods.length - n);
    var out = { periods: d.periods.slice(start) };
    keys.forEach(function (k) { out[k] = d[k].slice(start); });
    return out;
  }

  /** The last n cells of the first matching row, or null with fewer than three reported. */
  function lastOf(table, keys, n) {
    if (!table) return null;
    var key = keys.filter(function (k) { return table.rows[k]; })[0];
    if (!key) return null;
    var start = Math.max(0, table.periods.length - n);
    var values = table.rows[key].slice(start);
    if (values.filter(Number.isFinite).length < 3) return null;
    return { key: key, periods: table.periods.slice(start), values: values };
  }

  function enough(values) {
    return !!values && values.filter(Number.isFinite).length >= 3;
  }

  /**
   * Every chart this report knows how to draw, each deciding for itself whether
   * this company's page supports it. `make` returns a figure, or null to mean
   * "not for this company" — never an empty chart.
   */
  function chartCandidates(data, c) {
    var s = data.sections, pl = s.profitLoss, bs = s.balanceSheet, cf = s.cashFlow, q = s.quarters, ra = s.ratios;
    var lending = INSIGHTS && INSIGHTS.isLending ? INSIGHTS.isLending(data) : !!(pl && pl.rows['Financing Profit']);
    // Cash-flow charts are refused for any company whose cash flows behave like
    // a lender's, on the same test the findings use (rule 4b).
    var cashLike = INSIGHTS && INSIGHTS.lenderLikeCash ? INSIGHTS.lenderLikeCash(data) : lending;
    var list = [];
    var add = function (slot, title, make) { list.push({ slot: slot, title: title, make: make }); };

    // ---- wide -----------------------------------------------------------------

    add('wide', 'How revenue becomes profit', function () {
      var bridge = profitBridge(data);
      if (!bridge || bridge.steps.some(function (st) { return !Number.isFinite(st.value); })) return null;
      return CHARTS.drawWaterfall({
        title: 'How revenue becomes profit · ' + bridge.period, unit: '₹ Cr',
        source: 'Source: screener.in P&L · tax taken as profit before tax less profit after tax',
        steps: bridge.steps, width: 690
      });
    });

    add('wide', 'Quarterly revenue and margin', function () {
      var rev = lastOf(q, ['Sales', 'Revenue'], 13);
      if (!rev) return null;
      var mKey = q.rows['OPM %'] ? 'OPM %' : q.rows['Financing Margin %'] ? 'Financing Margin %' : null;
      var m = mKey ? alignTo(rev.periods, q, [mKey]) : null;
      return CHARTS.draw({
        title: 'Quarterly revenue and margin', unit: '₹ Cr · margin %',
        source: 'Source: screener.in quarterly results',
        periods: rev.periods, width: 690, height: 165, labelFormat: 'quarter', rightUnit: '%',
        series: [{ label: 'Revenue', values: rev.values, type: 'bar' }].concat(enough(m) ? [{
          label: mKey.replace(' %', '') + ' (rhs)', values: m, type: 'line', axis: 'right', color: c.deep
        }] : [])
      });
    });

    // ---- body (paired) --------------------------------------------------------

    if (!cashLike) add('body', 'Cash conversion', function () {
      var cc = tailDerived(cashConversion(data), ['cfo', 'pat', 'values'], 10);
      if (!cc || !enough(cc.cfo) || !enough(cc.pat)) return null;
      return CHARTS.draw({
        title: 'Cash conversion', unit: '₹ Cr · ratio %',
        source: 'Source: screener.in cash flow and P&L · ratio calculated here',
        periods: cc.periods, width: 330, rightUnit: '%',
        series: [
          { label: 'CFO', values: cc.cfo, type: 'bar' },
          { label: 'PAT', values: cc.pat, type: 'bar', color: c.secondary }
        ].concat(enough(cc.values) ? [{
          label: 'CFO/PAT (rhs)', values: cc.values, type: 'line', axis: 'right', color: c.derived
        }] : [])
      });
    });

    add('body', 'ROE decomposition (DuPont)', function () {
      var dp = tailDerived(dupont(data), ['roe', 'netMargin'], 10);
      if (!dp || !enough(dp.roe)) return null;
      return CHARTS.draw({
        title: 'ROE decomposition (DuPont)', unit: '%',
        source: 'Source: screener.in P&L and balance sheet · decomposition calculated here',
        periods: dp.periods, width: 330,
        series: [
          { label: 'ROE', values: dp.roe, type: 'bar', color: c.derived },
          // Not `primary`: steel over derived-blue bars is two shades of one
          // blue and the line disappears into them.
          { label: 'Net margin', values: dp.netMargin, type: 'line', color: c.deep }
        ]
      });
    });

    add('body', 'Operating leverage', function () {
      var growth = yoyGrowth(data.fields.revenue);
      var margin = data.fields.margin;
      if (!growth || !margin) return null;
      var pts = growth.periods.map(function (p, i) {
        // Skip TTM: a rolling window overlapping the year before it is not a
        // year-on-year step.
        if (!isDated(growth.dateKeys && growth.dateKeys[i])) return { x: null, y: null };
        var at = margin.periods.indexOf(p);
        return { x: growth.values[i], y: at === -1 ? null : margin.values[at], label: p };
      });
      if (pts.filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); }).length < 3) return null;
      return CHARTS.drawScatter({
        title: 'Operating leverage', unit: '%',
        source: 'Source: screener.in P&L · growth calculated here',
        points: pts, xLabel: 'Revenue growth, % year on year', yLabel: margin.label || 'Margin', width: 330
      });
    });

    if (!lending) add('body', 'Working capital days', function () {
      var dd = tail(data.fields.debtorDays, 10), inv = tail(data.fields.inventoryDays, 10);
      var okD = dd && enough(dd.values), okI = inv && enough(inv.values);
      if (!okD && !okI) return null;
      var base = okD ? dd : inv;
      return CHARTS.draw({
        title: 'Working capital days', unit: 'days', source: 'Source: screener.in ratios',
        periods: base.periods, width: 330, stacked: true,
        series: [okD ? { label: 'Debtor days', values: dd.values, type: 'bar' } : null,
                 okI ? { label: 'Inventory days', values: inv.values, type: 'bar' } : null].filter(Boolean)
      });
    });

    add('body', 'Asset quality', function () {
      var g = lastOf(q, ['Gross NPA %'], 13);
      if (!g) return null;
      var n = alignTo(g.periods, q, ['Net NPA %']);
      return CHARTS.draw({
        title: 'Asset quality', unit: '% of advances', source: 'Source: screener.in quarterly results',
        periods: g.periods, width: 330, labelFormat: 'quarter',
        series: [{ label: 'Gross NPA', values: g.values, type: 'line', color: c.primary }]
          .concat(enough(n) ? [{ label: 'Net NPA', values: n, type: 'line', color: c.deep }] : [])
      });
    });

    add('body', 'Funding mix', function () {
      var d = lastOf(bs, ['Deposits'], 10);
      if (!d) return null;
      var b = alignTo(d.periods, bs, ['Borrowing', 'Borrowings']);
      return CHARTS.draw({
        title: 'Funding mix', unit: '₹ Cr', source: 'Source: screener.in balance sheet',
        periods: d.periods, width: 330, stacked: true,
        series: [{ label: 'Deposits', values: d.values, type: 'bar' }]
          .concat(enough(b) ? [{ label: 'Borrowings', values: b, type: 'bar', color: c.secondary }] : [])
      });
    });

    if (!cashLike) add('body', 'Where the cash went', function () {
      var o = lastOf(cf, ['Cash from Operating Activity'], 8);
      if (!o) return null;
      var inv = alignTo(o.periods, cf, ['Cash from Investing Activity']);
      var fin = alignTo(o.periods, cf, ['Cash from Financing Activity']);
      if (!enough(inv) || !enough(fin)) return null;
      return CHARTS.draw({
        title: 'Where the cash went', unit: '₹ Cr', source: 'Source: screener.in cash flow',
        periods: o.periods, width: 330,
        series: [
          { label: 'Operating', values: o.values, type: 'bar' },
          { label: 'Investing', values: inv, type: 'bar', color: c.secondary },
          { label: 'Financing', values: fin, type: 'bar', color: c.deep }
        ]
      });
    });

    if (!cashLike) add('body', 'Interest cover', function () {
      var op = lastOf(pl, ['Operating Profit'], 12);
      if (!op) return null;
      var oi = alignTo(op.periods, pl, ['Other Income']);
      var dep = alignTo(op.periods, pl, ['Depreciation']);
      var it = alignTo(op.periods, pl, ['Interest']);
      // A year of negative earnings has no cover to draw; it is left as a gap,
      // never plotted as a negative multiple.
      var cover = op.values.map(function (v, i) {
        if (!Number.isFinite(v) || oi[i] === null || dep[i] === null || it[i] === null || it[i] <= 0) return null;
        var x = (v + oi[i] - dep[i]) / it[i];
        return x > 0 ? x : null;
      });
      if (!enough(cover)) return null;
      return CHARTS.draw({
        title: 'Interest cover', unit: 'times', source: 'Source: screener.in P&L · cover calculated here',
        periods: op.periods, width: 330,
        series: [{ label: 'Earnings before interest ÷ interest', values: cover, type: 'line', color: c.derived }]
      });
    });

    add('body', lending ? 'Return on equity' : 'Return on capital employed', function () {
      var r = lastOf(ra, [lending ? 'ROE %' : 'ROCE %'], 12);
      if (!r) return null;
      return CHARTS.draw({
        title: lending ? 'Return on equity' : 'Return on capital employed', unit: '%',
        source: 'Source: screener.in ratios', periods: r.periods, width: 330,
        series: [{ label: lending ? 'ROE' : 'ROCE', values: r.values, type: 'area', color: c.primary }]
      });
    });

    // ---- rail -----------------------------------------------------------------

    add('rail', 'Revenue and margin', function () {
      var revenue = tail(data.fields.revenue, 10), margin = tail(data.fields.margin, 10);
      if (!revenue || !enough(revenue.values)) return null;
      return CHARTS.draw({
        title: 'Revenue and margin', unit: '₹ Cr · margin %', source: 'Source: screener.in',
        periods: revenue.periods, rightUnit: '%',
        series: [{ label: 'Revenue', values: revenue.values, type: 'bar' }].concat(margin && enough(margin.values) ? [{
          label: (data.fields.margin.label || 'Margin') + ' (rhs)', values: margin.values, type: 'line', axis: 'right'
        }] : [])
      });
    });

    add('rail', 'Ownership', function () {
      var shp = shareholdingSeries(data);
      if (!shp) return null;
      var keep = Math.max(0, shp.periods.length - 10);
      return CHARTS.draw({
        title: 'Ownership', unit: '% of shares', source: 'Source: screener.in shareholding pattern',
        periods: shp.periods.slice(keep), stacked: true, height: 165,
        series: shp.series.map(function (sr) { return { label: sr.label, values: sr.values.slice(keep), type: 'bar' }; })
      });
    });

    add('rail', 'Earnings per share and payout', function () {
      var e = lastOf(pl, ['EPS in Rs'], 10);
      if (!e) return null;
      var pay = alignTo(e.periods, pl, ['Dividend Payout %']);
      return CHARTS.draw({
        title: 'Earnings per share and payout', unit: '₹ per share · payout %',
        source: 'Source: screener.in P&L', periods: e.periods, rightUnit: '%',
        series: [{ label: 'EPS', values: e.values, type: 'bar' }].concat(enough(pay) ? [{
          label: 'Payout (rhs)', values: pay, type: 'line', axis: 'right', color: c.deep
        }] : [])
      });
    });

    add('rail', 'Other income and profit before tax', function () {
      var o = lastOf(pl, ['Other Income'], 10);
      if (!o) return null;
      var p = alignTo(o.periods, pl, ['Profit before tax']);
      if (!enough(p)) return null;
      return CHARTS.draw({
        title: 'Other income and profit before tax', unit: '₹ Cr', source: 'Source: screener.in P&L',
        periods: o.periods,
        series: [
          { label: 'Other income', values: o.values, type: 'bar', color: c.secondary },
          { label: 'Profit before tax', values: p, type: 'bar' }
        ]
      });
    });

    add('rail', 'Borrowings', function () {
      if (bs && bs.rows.Deposits) return null;        // a bank's borrowings sit in Funding mix
      var d = lastOf(bs, ['Borrowings', 'Borrowing'], 10);
      if (!d) return null;
      return CHARTS.draw({
        title: 'Borrowings', unit: '₹ Cr', source: 'Source: screener.in balance sheet',
        periods: d.periods, series: [{ label: 'Borrowings', values: d.values, type: 'area', color: c.primary }]
      });
    });

    if (!lending) add('rail', 'Fixed assets and work in progress', function () {
      var fa = lastOf(bs, ['Fixed Assets'], 10);
      if (!fa) return null;
      var cw = alignTo(fa.periods, bs, ['CWIP']);
      return CHARTS.draw({
        title: 'Fixed assets and work in progress', unit: '₹ Cr', source: 'Source: screener.in balance sheet',
        periods: fa.periods, stacked: true,
        series: [{ label: 'Fixed assets', values: fa.values, type: 'bar' }]
          .concat(enough(cw) ? [{ label: 'Work in progress', values: cw, type: 'bar', color: c.secondary }] : [])
      });
    });

    return list;
  }

  /**
   * Choose which charts go where, for this company.
   *
   * Body charts sit in pairs, and a pair must be full: an odd count is evened
   * out from the spares, or the last one moves to the rail. That is the rule
   * that removes the half-empty row RBL Bank showed.
   */
  function planCharts(data) {
    var plan = { wide: [], body: [], rail: [] };
    if (!CHARTS || typeof CHARTS.draw !== 'function') return plan;
    var colours = CHARTS.palette ? CHARTS.palette() : CHARTS.PALETTE;

    var built = { wide: [], body: [], rail: [] };
    chartCandidates(data, colours).forEach(function (cand) {
      var fig = null;
      try {
        fig = cand.make();
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[Screener X-Ray] chart skipped:', cand.title, err);
      }
      if (fig) built[cand.slot].push(withExplainer(fig, cand.title));
    });

    plan.wide = built.wide.slice(0, CHART_TARGET.wide);
    plan.rail = built.rail.slice(0, CHART_TARGET.rail);
    plan.body = built.body.slice(0, CHART_TARGET.body);
    var spareBody = built.body.slice(CHART_TARGET.body);
    var spareRail = built.rail.slice(CHART_TARGET.rail);

    if (plan.body.length % 2) {
      if (spareBody.length) plan.body.push(spareBody.shift());
      else if (spareRail.length) plan.body.push(spareRail.shift());
      else plan.rail.push(plan.body.pop());
    }
    return plan;
  }

  function placeBodyCharts(plan, mount) {
    for (var i = 0; i < plan.body.length; i += 2) {
      var pair = el('div', 'chart-pair');
      pair.appendChild(plan.body[i]);
      if (plan.body[i + 1]) pair.appendChild(plan.body[i + 1]);
      mount.appendChild(pair);
    }
    plan.wide.forEach(function (fig) {
      fig.classList.add('chart-wide');
      mount.appendChild(fig);
    });
  }

  function placeRailCharts(plan, mount) {
    plan.rail.forEach(function (fig) { mount.appendChild(fig); });
  }

  /**
   * The derived measures, written out in full.
   *
   * Every figure here is ours, so the whole block is in the derived treatment
   * and carries a note saying what it is and why the computed ROE will not tie
   * exactly to the one Screener publishes.
   */
  function renderDerived(data, mount) {
    var dp = dupont(data);
    var cc = cashConversion(data);
    if (!dp && !cc) return;

    mount.appendChild(el('h2', 'accent', 'Derived measures'));
    mount.appendChild(el('p', 'hint',
      'Calculated on this page from the figures above — not published by Screener. ' +
      'Return on equity here uses year-end equity capital plus reserves, so it ' +
      'will not tie exactly to Screener’s own ROE, which uses a different basis. ' +
      'A blank means the arithmetic would not have been meaningful.'));

    if (dp) {
      renderDerivedTable('DuPont decomposition', dp.periods, [
        ['Net margin', dp.netMargin, 'pct'],
        ['Asset turnover', dp.assetTurnover, 'x'],
        ['Leverage (assets / equity)', dp.leverage, 'x'],
        ['Return on equity', dp.roe, 'pct'],
        ['Book equity', dp.equity, 'inr']
      ], mount);
    }

    if (cc) {
      // Cash from operations is in the cash-flow statement below and is not
      // repeated. Profit after tax stays, because it is what voids the ratio in
      // a loss-making year — the same reason book equity sits in the DuPont
      // table: the blank has to explain itself.
      renderDerivedTable('Cash conversion', cc.periods, [
        ['Profit after tax', cc.pat, 'inr'],
        ['CFO as % of PAT', cc.values, 'pct']
      ], mount);
    }
  }

  function renderDerivedTable(title, periods, rows, mount) {
    var COLS = 12;
    var start = Math.max(0, periods.length - COLS);
    var idx = [];
    for (var i = start; i < periods.length; i++) idx.push(i);

    var wrap = el('div', 'statement');
    var heading = el('h3', 'statement-head', title);
    heading.appendChild(el('span', 'unit-note', '₹ Cr unless the row says otherwise'));
    wrap.appendChild(heading);

    var scroll = el('div', 'table-wrap');
    var t = el('table', 'figures derived-table');

    var thead = el('thead'), hrow = el('tr');
    hrow.appendChild(el('th', 'rowlabel', ''));
    idx.forEach(function (i) { hrow.appendChild(el('th', null, periods[i])); });
    thead.appendChild(hrow);
    t.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('th', 'rowlabel', row[0]));
      idx.forEach(function (i) {
        var v = row[1][i];
        var missing = v === null || v === undefined || !Number.isFinite(v);
        // Book equity is Screener's own figures added together; everything else
        // is a ratio we computed, so only the ratios take the derived colour.
        var cls = missing ? 'absent' : (row[2] === 'inr' ? 'figure' : 'derived');
        var txt;
        if (missing) txt = '—';
        else if (row[2] === 'x') txt = trimNum(v, 2) + 'x';
        else txt = cellText(v, row[2]);
        tr.appendChild(el('td', cls, txt));
      });
      tbody.appendChild(tr);
    });

    t.appendChild(tbody);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    mount.appendChild(wrap);
  }

  function renderKey(mount) {
    var section = block('Reading this page');
    var ul = el('ul', 'key-list');

    var reported = el('li');
    reported.appendChild(el('span', 'swatch figure', '1,234'));
    reported.appendChild(document.createTextNode(' as published on screener.in'));
    ul.appendChild(reported);

    var derived = el('li');
    derived.appendChild(el('span', 'swatch derived', '9.1% CAGR'));
    derived.appendChild(document.createTextNode(' calculated on this page'));
    ul.appendChild(derived);

    var absent = el('li');
    absent.appendChild(el('span', 'swatch absent', NOT_REPORTED));
    absent.appendChild(document.createTextNode(
      ' — Screener published no figure. Never shown as zero.'));
    ul.appendChild(absent);

    section.appendChild(ul);
    mount.appendChild(section);
  }

  // --- assembly --------------------------------------------------------------

  function render(data) {
    var mount = document.getElementById('report');
    mount.textContent = '';

    if (!data) {
      mount.appendChild(el('h1', null, 'Nothing to show yet'));
      mount.appendChild(el('p', 'absent',
        'Open a company page on screener.in and click the X-Ray button beside the company name.'));
      return;
    }

    document.title = (data.meta.name || 'Company') + ' — Screener X-Ray';
    renderTitle(data, mount);
    renderAttribution(data);
    renderHealth(data, mount);
    renderFindings(data, mount);

    var plan = planCharts(data);
    var columns = el('div', 'columns');
    var main = el('main', 'col-main');
    var rail = el('aside', 'col-rail');

    renderAbout(data, main);
    renderNarrative(data, main);
    renderJournal(data, main);
    placeBodyCharts(plan, main);
    renderAnnouncements(data, main);

    // "Key metrics" and "Return on equity" used to live here. Both restated
    // figures that appear verbatim a few centimetres away — the narrative says
    // the same eight metrics in better form, and ROE is already in Screener's
    // own ratio strip and in the compounded-growth tables. A figure earns one
    // place on the page.
    renderGlance(data, rail);
    placeRailCharts(plan, rail);
    renderFilings(data, rail);
    renderKey(rail);

    columns.appendChild(main);
    columns.appendChild(rail);
    mount.appendChild(columns);

    // Growth buckets and filing links sit in a full-width strip rather than the
    // rail: in the rail they ran the column far past the narrative beside it and
    // left the page half empty.
    var strip = el('section', 'strip');
    renderRanges(data, strip);
    if (strip.children.length) mount.appendChild(strip);

    var wide = el('section', 'wide');
    renderDerived(data, wide);
    renderStatements(data, wide);
    mount.appendChild(wide);

    mount.removeAttribute('aria-busy');
    // Click to finished report, against the three-second budget. Recorded on the
    // element so it can be checked without opening devtools.
    if (data.meta.clickedAt) {
      var ms = Date.now() - data.meta.clickedAt;
      mount.setAttribute('data-click-to-report-ms', String(ms));
      if (typeof console !== 'undefined') console.info('[Screener X-Ray] click to report: ' + ms + ' ms');
      data.meta.clickedAt = null;   // a later re-render, such as adding the export, is not a click
    }
  }

  function boot() {
    chrome.storage.local.get(STORAGE_KEY).then(function (stored) {
      var data = stored[STORAGE_KEY] || null;
      if (!data) return render(null);
      // an export added on an earlier visit, if it still matches this page
      var key = exportKey(data);
      return chrome.storage.local.get(key).then(function (saved) {
        if (saved[key] && XLSX && XLSX.matchesPage(saved[key], data).ok) data.export = saved[key];
      }, function () {}).then(function () { render(data); });
    }).catch(function (err) {
      console.error('[Screener X-Ray] could not read stored report', err);
      render(null);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.ScreenerXRayReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
