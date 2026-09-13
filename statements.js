/**
 * Screener X-Ray — financial statements in the Indian reporting arrangement.
 *
 * Screener prints its tables in its own order, with its own labels. Indian
 * companies file in prescribed formats, and which format depends on the kind
 * of company:
 *
 *   companies   Companies Act 2013, Schedule III, Division II (Ind AS)
 *               Balance sheet opens with ASSETS, then EQUITY AND LIABILITIES.
 *               Profit and loss runs I Revenue from operations, II Other income,
 *               III Total income, IV Expenses, then profit before tax, tax and
 *               profit for the period.
 *   banks       Banking Regulation Act 1949, Third Schedule — Form A (balance
 *               sheet: capital and liabilities, then assets) and Form B (profit
 *               and loss: income, expenditure, profit).
 *   NBFCs       Schedule III, Division III.
 *
 * Source: ICAI Guidance Note on Division II, Annexure F (illustrative
 * statements), and the Third Schedule to the Banking Regulation Act.
 *
 * WHAT THIS DOES NOT DO
 *   It does not invent line items. Screener publishes a condensed set — one
 *   expenses line, no split between current and non-current — and the formats
 *   ask for more. Every line here is either a Screener row exactly as published
 *   ('figure') or arithmetic on Screener rows ('derived'), and the places where
 *   Screener combines what the format separates are marked and footnoted. A
 *   line the format requires but Screener does not publish is left out, never
 *   filled with zero.
 *
 *   Where Screener's totals do not add up from its own lines — rounding apart —
 *   the difference is printed as its own line rather than absorbed, so the
 *   statement always ties and never hides a gap.
 *
 * Pure: consumes parse.js output, returns data. report.js draws it.
 */
(function (root) {
  'use strict';

  // Screener rounds to whole crores, so a sum of five rounded lines can miss a
  // rounded total by up to ~2.5. A gap is printed only beyond that.
  var TOLERANCE = 3;

  var DAGGER_COMBINED = 'Screener publishes this as one line; the prescribed format itemises it.';
  var DAGGER_CURRENT = 'Screener does not separate current from non-current items.';
  var EXPORT_NOTE = 'From Screener’s Excel export, added to this report.';
  var ITEMS_NOTE = 'The indented lines above are from Screener’s Excel export. They add up to this '
    + 'figure, which is on the company page.';
  var SPLIT_NOTE = 'The indented lines above are from Screener’s Excel export, with the remainder worked '
    + 'out here. Together they make up this figure, which is on the company page.';
  var TAX_NOTE = 'Profit before tax less profit for the period. Screener publishes a tax rate, not an '
    + 'amount, so in consolidated figures this also nets off any share of associates and joint ventures.';
  var ASSOC_NOTE = 'Profit for the period, as Screener publishes it, less profit after tax. Screener does '
    + 'not itemise it; in consolidated figures it holds the share of profit of associates and joint ventures.';

  function rowOf(table, names) {
    if (!table) return null;
    for (var i = 0; i < names.length; i++) {
      if (table.rows[names[i]]) {
        return table.rows[names[i]].map(function (v) { return Number.isFinite(v) ? v : null; });
      }
    }
    return null;
  }

  /** Row lookup that remembers which of Screener's rows a statement consumed. */
  function reader(table) {
    var used = {};
    var g = function (names) {
      for (var i = 0; i < names.length; i++) {
        if (table.rows[names[i]]) { used[names[i]] = true; break; }
      }
      return rowOf(table, names);
    };
    g.used = used;
    return g;
  }

  /**
   * Rows Screener publishes that the format has no place for are kept, not
   * dropped: row sets differ by sector, and an allow-list would quietly lose
   * whatever it had not been told about.
   */
  function leftovers(L, table, g) {
    var rest = Object.keys(table.rows).filter(function (k) { return !g.used[k] && k !== 'Raw PDF'; });
    if (!rest.length) return;
    L.memo('Also published by Screener');
    rest.forEach(function (k) {
      L.figure(k, rowOf(table, [k]), { memo: true, unit: /%$/.test(k) ? 'pct' : /^EPS/.test(k) ? 'rupee' : 'inr' });
    });
  }

  /**
   * Element-wise sum of the rows Screener published; null in any column where a
   * published row is blank. An absent row has no line above the total, so it is
   * left out of the sum too — and any shortfall against Screener's own total
   * then prints as a gap line.
   */
  function sumOf(arrays) {
    arrays = arrays.filter(Boolean);
    if (!arrays.length) return null;
    return arrays[0].map(function (_, i) {
      var total = 0;
      for (var k = 0; k < arrays.length; k++) {
        if (arrays[k][i] === null) return null;
        total += arrays[k][i];
      }
      return total;
    });
  }

  function diffOf(a, b) {
    if (!a || !b) return null;
    return a.map(function (v, i) { return v === null || b[i] === null ? null : v - b[i]; });
  }

  function anyGap(gap, scaleRow) {
    if (!gap) return false;
    return gap.some(function (v, i) {
      if (v === null) return false;
      var scale = scaleRow && scaleRow[i] !== null ? Math.abs(scaleRow[i]) * 0.005 : 0;
      return Math.abs(v) >= Math.max(TOLERANCE, scale);
    });
  }

  /**
   * The kind of company, which decides the format.
   *
   * Screener's lending layout marks lenders. Among lenders, a Deposits row marks
   * a bank; NBFCs on Screener show Borrowing without one.
   */
  function layoutOf(data) {
    var pl = data.sections && data.sections.profitLoss;
    var bs = data.sections && data.sections.balanceSheet;
    if (!(pl && pl.rows['Financing Profit'])) return 'company';
    return bs && bs.rows.Deposits ? 'bank' : 'nbfc';
  }

  var FORMAT = {
    company: 'Companies Act 2013, Schedule III, Division II (Ind AS)',
    bank: 'Banking Regulation Act 1949, Third Schedule',
    nbfc: 'Companies Act 2013, Schedule III, Division III (NBFC)'
  };

  // ---------------------------------------------------------------------------
  // Screener's Excel export (xlsx.js), when the reader has added it
  //
  // Nothing from the export is shown unless it agrees with the page: its lines
  // must add up to the page's own total, and its profit before tax must be the
  // page's. An export that disagrees is a different basis or a different
  // company, and mixing it in would print a statement that belongs to neither.
  // ---------------------------------------------------------------------------

  /** An export row lined up with the page's columns by date; null where it has no column. */
  function exportRows(data, key, table) {
    var sec = data.export && data.export.sections && data.export.sections[key];
    return function (name) {
      var row = sec && table.dateKeys && sec.rows[name];
      if (!row) return null;
      var out = table.dateKeys.map(function (dk) {
        var i = sec.dateKeys.indexOf(dk);
        return i < 0 || !Number.isFinite(row[i]) ? null : row[i];
      });
      return out.some(function (v) { return v !== null; }) ? out : null;
    };
  }

  /** Two rows agree where both have a figure, within the page's whole-crore rounding. */
  function agrees(a, b) {
    if (!a || !b) return false;
    var compared = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] === null || b[i] === null) continue;
      if (Math.abs(a[i] - b[i]) > Math.max(1, Math.abs(b[i]) * 0.005)) return false;
      compared++;
    }
    return compared > 0;
  }

  // [format label, export row, sign]. Screener's own template subtracts the
  // change in inventory when it totals expenses.
  var EXPENSE_ITEMS = [
    ['Cost of materials consumed', 'Raw Material Cost', 1],
    ['Changes in inventories', 'Change in Inventory', -1],
    ['Employee benefits expense', 'Employee Cost', 1],
    ['Power and fuel', 'Power and Fuel', 1],
    ['Other manufacturing expenses', 'Other Mfr. Exp', 1],
    ['Selling and administration expenses', 'Selling and admin', 1],
    ['Other expenses', 'Other Expenses', 1]
  ];

  function expenseItems(x, expenses) {
    if (!expenses) return null;
    var items = EXPENSE_ITEMS.map(function (it) {
      var row = x(it[1]);
      return row && { label: it[0], values: row.map(function (v) { return v === null ? null : v * it[2]; }) };
    }).filter(Boolean);
    if (!items.length) return null;
    var compared = 0;
    for (var i = 0; i < expenses.length; i++) {
      if (expenses[i] === null || items.every(function (it) { return it.values[i] === null; })) continue;
      // a blank item in a year the others cover is checked as nothing spent;
      // it is still shown as a blank
      var sum = items.reduce(function (t, it) { return t + (it.values[i] || 0); }, 0);
      if (Math.abs(sum - expenses[i]) > Math.max(TOLERANCE, Math.abs(expenses[i]) * 0.005)) return null;
      compared++;
    }
    return compared ? items : null;
  }

  function otherAssetsSplit(x, otherA) {
    if (!otherA || !agrees(x('Other Assets'), otherA)) return null;
    var parts = [['Inventories', x('Inventory')], ['Trade receivables', x('Receivables')],
      ['Cash and bank balances', x('Cash & Bank')]].filter(function (p) { return p[1]; });
    if (!parts.length) return null;
    var rest = otherA.map(function (v, i) {
      if (v === null || parts.every(function (p) { return p[1][i] === null; })) return null;
      return v - parts.reduce(function (t, p) { return t + (p[1][i] || 0); }, 0);
    });
    // the parts must fit inside the page's figure in every year, or none is shown
    if (rest.some(function (v) { return v !== null && v < -TOLERANCE; })) return null;
    return { parts: parts, rest: rest };
  }

  // ---------------------------------------------------------------------------
  // line builders
  // ---------------------------------------------------------------------------

  function Lines() { this.list = []; }

  Lines.prototype.heading = function (label, roman) {
    this.list.push({ type: 'heading', label: label, roman: roman || null });
    return this;
  };

  /** A Screener row as published. Skipped entirely when the row is absent. */
  Lines.prototype.figure = function (label, values, opts) {
    if (!values) return this;
    opts = opts || {};
    this.list.push({ type: 'line', kind: 'figure', label: label, values: values,
      roman: opts.roman || null, level: opts.level || 0, total: !!opts.total,
      unit: opts.unit || 'inr', note: opts.note || null, memo: !!opts.memo });
    return this;
  };

  /** Arithmetic on Screener rows. Skipped when it cannot be computed at all. */
  Lines.prototype.derived = function (label, values, opts) {
    if (!values || values.every(function (v) { return v === null; })) return this;
    opts = opts || {};
    this.list.push({ type: 'line', kind: 'derived', label: label, values: values,
      roman: opts.roman || null, level: opts.level || 0, total: !!opts.total,
      unit: opts.unit || 'inr', note: opts.note || null, memo: !!opts.memo });
    return this;
  };

  Lines.prototype.memo = function (label) {
    this.list.push({ type: 'heading', label: label, roman: null, memo: true });
    return this;
  };

  function notesFor(lines) {
    var seen = [];
    lines.forEach(function (l) { if (l.note && seen.indexOf(l.note) === -1) seen.push(l.note); });
    return seen;
  }

  function statement(id, title, layout, table, lines, base, baseLabel) {
    // a heading with nothing under it (its rows absent on this page) goes
    var list = lines.list.filter(function (l, i, all) {
      if (l.type !== 'heading') return true;
      var next = all[i + 1];
      return !!next && next.type === 'line';
    });
    return {
      id: id, title: title, format: FORMAT[layout], layout: layout,
      periods: table.periods.slice(), dateKeys: (table.dateKeys || []).slice(),
      lines: list, notes: notesFor(list),
      base: base, baseLabel: baseLabel
    };
  }

  // ---------------------------------------------------------------------------
  // statement of profit and loss
  // ---------------------------------------------------------------------------

  function incomeStatement(data, table, id, title) {
    if (!table) return null;
    var layout = layoutOf(data);
    var g = reader(table);

    var revenue = g(['Sales', 'Revenue', 'Income']);
    var other = g(['Other Income']);
    var expenses = g(['Expenses']);
    var interest = g(['Interest']);
    var dep = g(['Depreciation']);
    var pbt = g(['Profit before tax']);
    var profit = g(['Net Profit']);
    if (!revenue || !pbt) return null;

    var totalIncome = sumOf([revenue, other]);
    var totalExpenses = sumOf([expenses, interest, dep]);
    var gap = diffOf(pbt, diffOf(totalIncome, totalExpenses));
    var showGap = anyGap(gap, totalIncome);
    var taxAndOther = diffOf(pbt, profit);

    var x = exportRows(data, id === 'quarters' ? 'quarters' : 'profitLoss', table);
    var items = layout === 'company' ? expenseItems(x, expenses) : null;
    var xTax = agrees(x('Profit before tax'), pbt) ? x('Tax') : null;
    var xOwners = xTax ? x('Net profit') : null;

    var L = new Lines();

    if (layout === 'bank') {
      L.heading('Income', 'I')
        .figure('Interest earned', revenue, { level: 1 })
        .figure('Other income', other, { level: 1 })
        .derived('Total income', totalIncome, { level: 1, total: true })
        .heading('Expenditure', 'II')
        .figure('Interest expended', interest, { level: 1 })
        .figure('Operating expenses and provisions', expenses, { level: 1, note: DAGGER_COMBINED })
        .figure('Depreciation', dep, { level: 1 })
        .derived('Total expenditure', totalExpenses, { level: 1, total: true });
    } else {
      L.figure('Revenue from operations', revenue, { roman: 'I' })
        .figure('Other income', other, { roman: 'II' })
        .derived('Total income (I + II)', totalIncome, { roman: 'III', total: true })
        .heading('Expenses', 'IV');
      if (layout === 'nbfc') {
        L.figure('Finance costs', interest, { level: 1 })
          .figure('Operating expenses, including impairment', expenses, { level: 1, note: DAGGER_COMBINED });
      } else if (items) {
        items.forEach(function (it) { L.figure(it.label, it.values, { level: 2 }); });
        L.figure('Operating expenses', expenses, { level: 1, note: ITEMS_NOTE })
          .figure('Finance costs', interest, { level: 1 });
      } else {
        L.figure('Operating expenses', expenses, { level: 1, note: DAGGER_COMBINED })
          .figure('Finance costs', interest, { level: 1 });
      }
      L.figure('Depreciation and amortisation expense', dep, { level: 1 })
        .derived('Total expenses (IV)', totalExpenses, { level: 1, total: true });
    }

    if (showGap) {
      L.derived('Other items not broken out on Screener', gap, { level: 0 });
    }

    var roman = layout === 'bank' ? ['III', null, 'IV'] : ['V', 'VI', 'VII'];
    L.figure(layout === 'bank' ? 'Profit before tax (I − II)' : 'Profit before tax (III − IV)', pbt,
        { roman: roman[0], total: true });
    if (xTax) {
      var pat = diffOf(pbt, xTax);
      var assoc = diffOf(profit, pat);
      L.figure('Tax expense', xTax, { roman: roman[1], note: EXPORT_NOTE })
        .derived('Profit after tax', pat);
      if (anyGap(assoc, profit)) {
        L.derived('Share of associates, joint ventures and other items', assoc, { note: ASSOC_NOTE });
      }
    } else {
      L.derived('Tax expense and other items', taxAndOther, { roman: roman[1], note: TAX_NOTE });
    }
    L.figure(layout === 'bank' ? 'Net profit for the period' : 'Profit for the period', profit,
      { roman: roman[2], total: true });
    var nci = xOwners ? diffOf(profit, xOwners) : null;
    if (anyGap(nci, profit)) {
      L.figure('Attributable to owners of the company', xOwners, { level: 1, note: EXPORT_NOTE })
        .derived('Attributable to non-controlling interests', nci, { level: 1 });
    }
    L
      .figure('Earnings per equity share (₹)', g(['EPS in Rs']), { unit: 'rupee' });

    L.memo('As published by Screener');
    if (layout === 'company') {
      L.figure('Operating profit (EBITDA)', g(['Operating Profit']), { memo: true })
        .figure('Operating profit margin', g(['OPM %']), { memo: true, unit: 'pct' });
    } else {
      L.figure('Financing profit', g(['Financing Profit']), { memo: true })
        .figure('Financing margin', g(['Financing Margin %']), { memo: true, unit: 'pct' });
    }
    L.figure('Effective tax rate', g(['Tax %']), { memo: true, unit: 'pct' })
      .figure('Dividend payout', g(['Dividend Payout %']), { memo: true, unit: 'pct' });

    // Quarterly results for lenders carry asset quality; the format keeps it.
    var gnpa = g(['Gross NPA %']);
    if (gnpa) {
      L.memo('Asset quality')
        .figure('Gross NPA', gnpa, { memo: true, unit: 'pct' })
        .figure('Net NPA', g(['Net NPA %']), { memo: true, unit: 'pct' });
    }

    leftovers(L, table, g);
    var out = statement(id, title, layout, table, L, revenue,
      layout === 'bank' ? '% of interest earned' : '% of revenue from operations');
    out.export = !!(items || xTax);
    return out;
  }

  function profitAndLoss(data) {
    return incomeStatement(data, data.sections && data.sections.profitLoss, 'pl', 'Statement of profit and loss');
  }

  /** Quarterly results, in the arrangement listed companies file under SEBI LODR Regulation 33. */
  function quarterlyResults(data) {
    var s = incomeStatement(data, data.sections && data.sections.quarters, 'quarters', 'Quarterly results');
    if (s) s.format = 'SEBI (LODR) Regulation 33, in the ' + FORMAT[s.layout] + ' arrangement';
    return s;
  }

  // ---------------------------------------------------------------------------
  // balance sheet
  // ---------------------------------------------------------------------------

  function balanceSheet(data) {
    var t = data.sections && data.sections.balanceSheet;
    if (!t) return null;
    var layout = layoutOf(data);
    var g = reader(t);

    var cap = g(['Equity Capital']), res = g(['Reserves']);
    var debt = g(['Borrowings', 'Borrowing']), deposits = g(['Deposits']), otherL = g(['Other Liabilities']);
    var totalLE = g(['Total Liabilities']);
    var fixed = g(['Fixed Assets']), cwip = g(['CWIP']), inv = g(['Investments']), otherA = g(['Other Assets']);
    var totalA = g(['Total Assets']);

    var equity = sumOf([cap, res]);
    var assetsGap = diffOf(totalA, sumOf([fixed, cwip, inv, otherA]));
    var L = new Lines();

    // Screener labels the funding side "Total Liabilities", but the figure
    // includes equity. It is relabelled for what it is.
    var TOTAL_NOTE = 'Screener labels this "Total Liabilities"; the figure includes equity.';

    if (layout === 'bank') {
      var capGap = diffOf(totalLE, sumOf([cap, res, deposits, debt, otherL]));
      L.heading('Capital and liabilities')
        .figure('Capital', cap, { level: 1 })
        .figure('Reserves and surplus', res, { level: 1 })
        .figure('Deposits', deposits, { level: 1 })
        .figure('Borrowings', debt, { level: 1 })
        .figure('Other liabilities and provisions', otherL, { level: 1 });
      if (anyGap(capGap, totalLE)) L.derived('Other items not broken out on Screener', capGap, { level: 1 });
      L.figure('Total', totalLE, { total: true, note: TOTAL_NOTE })
        .heading('Assets')
        .figure('Investments', inv, { level: 1 })
        .figure('Advances, cash, bank balances and other assets', otherA,
          { level: 1, note: 'Screener combines advances, cash, balances with the RBI and other banks, '
            + 'and other assets into one line; Form A lists them separately.' })
        .figure('Fixed assets', fixed, { level: 1 })
        .figure('Capital work-in-progress', cwip, { level: 1 });
      if (anyGap(assetsGap, totalA)) L.derived('Other items not broken out on Screener', assetsGap, { level: 1 });
      L.figure('Total', totalA, { total: true });
      leftovers(L, t, g);
      return statement('bs', 'Balance sheet', layout, t, L, totalA, '% of total assets');
    }

    var liabilities = sumOf([debt, otherL]);
    var leGap = diffOf(totalLE, sumOf([equity, liabilities]));

    L.heading('Assets');
    if (layout === 'nbfc') {
      L.figure('Loans, cash and other assets', otherA, { level: 1,
        note: 'Screener combines loans, cash, receivables and other financial and non-financial assets into one line.' })
        .figure('Investments', inv, { level: 1 })
        .figure('Property, plant and equipment', fixed, { level: 1 })
        .figure('Capital work-in-progress', cwip, { level: 1 });
    } else {
      L.figure('Property, plant and equipment and intangibles (net block)', fixed, { level: 1 })
        .figure('Capital work-in-progress', cwip, { level: 1 })
        .figure('Investments', inv, { level: 1, note: DAGGER_CURRENT });
      var split = otherAssetsSplit(exportRows(data, 'balanceSheet', t), otherA);
      if (split) {
        split.parts.forEach(function (p) { L.figure(p[0], p[1], { level: 2 }); });
        L.derived('Remaining other assets', split.rest, { level: 2 })
          .figure('Other assets', otherA, { level: 1, note: SPLIT_NOTE });
      } else {
        L.figure('Other assets', otherA, { level: 1, note: DAGGER_CURRENT });
      }
    }
    if (anyGap(assetsGap, totalA)) L.derived('Other items not broken out on Screener', assetsGap, { level: 1 });
    L.figure('Total assets', totalA, { total: true });

    if (layout === 'nbfc') {
      L.heading('Liabilities and equity')
        .figure('Borrowings', debt, { level: 1 })
        .figure('Other liabilities', otherL, { level: 1, note: DAGGER_CURRENT })
        .derived('Total liabilities', liabilities, { level: 1, total: true })
        .figure('Equity share capital', cap, { level: 1 })
        .figure('Other equity', res, { level: 1 })
        .derived('Total equity', equity, { level: 1, total: true });
    } else {
      L.heading('Equity and liabilities')
        .figure('Equity share capital', cap, { level: 1 })
        .figure('Other equity', res, { level: 1 })
        .derived('Total equity', equity, { level: 1, total: true })
        .figure('Borrowings', debt, { level: 1, note: DAGGER_CURRENT })
        .figure('Other liabilities', otherL, { level: 1, note: DAGGER_CURRENT })
        .derived('Total liabilities', liabilities, { level: 1, total: true });
    }
    if (anyGap(leGap, totalLE)) L.derived('Other items not broken out on Screener', leGap, { level: 1 });
    L.figure(layout === 'nbfc' ? 'Total liabilities and equity' : 'Total equity and liabilities', totalLE,
      { total: true, note: TOTAL_NOTE });

    leftovers(L, t, g);
    var out = statement('bs', 'Balance sheet', layout, t, L, totalA, '% of total assets');
    out.export = !!split;
    return out;
  }

  // ---------------------------------------------------------------------------
  // cash flow statement
  // ---------------------------------------------------------------------------

  /** Ind AS 7 (AS 3 for banks): operating, investing and financing, lettered A to C. */
  function cashFlow(data) {
    var t = data.sections && data.sections.cashFlow;
    if (!t) return null;
    var layout = layoutOf(data);
    var g = reader(t);
    var a = g(['Cash from Operating Activity']), b = g(['Cash from Investing Activity']);
    var c = g(['Cash from Financing Activity']), net = g(['Net Cash Flow']);
    if (!a) return null;
    var gap = diffOf(net, sumOf([a, b, c]));

    var L = new Lines()
      .figure('Net cash from operating activities', a, { roman: 'A' })
      .figure('Net cash used in / from investing activities', b, { roman: 'B' })
      .figure('Net cash used in / from financing activities', c, { roman: 'C' });
    if (anyGap(gap, a)) L.derived('Other items not broken out on Screener', gap);
    L.figure('Net increase / (decrease) in cash and cash equivalents (A + B + C)', net, { total: true })
      .memo('Screener’s own measures — not Ind AS line items')
      .figure('Free cash flow', g(['Free Cash Flow']), { memo: true })
      .figure('Cash from operations as a share of operating profit', g(['CFO/OP']), { memo: true, unit: 'pct' });

    leftovers(L, t, g);
    var s = statement('cf', 'Cash flow statement', layout, t, L, null, null);
    s.format = layout === 'bank'
      ? 'AS 3 / Ind AS 7 — operating, investing and financing activities'
      : 'Ind AS 7 — operating, investing and financing activities';
    s.notes.push('Screener publishes the three totals; the indirect-method reconciliation from profit '
      + 'before tax is in the company’s annual report.');
    return s;
  }

  var api = {
    layoutOf: layoutOf,
    profitAndLoss: profitAndLoss,
    balanceSheet: balanceSheet,
    cashFlow: cashFlow,
    quarterlyResults: quarterlyResults,
    TOLERANCE: TOLERANCE
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScreenerXRayStatements = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
