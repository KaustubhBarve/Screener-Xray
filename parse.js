/**
 * Screener X-Ray — screener.in DOM parser.
 *
 * THE ONLY FILE IN THIS PROJECT PERMITTED TO TOUCH SCREENER.IN'S DOM.
 * Everything downstream (one-pager, charts, journal, PDF) consumes the object
 * returned by parseCompanyPage() and never reaches for the DOM itself.
 *
 * Takes any document-like object, so the same code runs against a live
 * screener.in tab and against a jsdom-parsed fixture in test/fixtures/.
 *
 * Missing data is always null — never 0, never "". See CLAUDE.md rule 4.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // primitives
  // ---------------------------------------------------------------------------

  // jsdom does not implement innerText, so textContent is the only safe reader.
  // Screener uses &nbsp; liberally inside row labels.
  function txt(el) {
    if (!el) return '';
    return el.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Parse one Screener cell into a number, or null if it holds no figure.
   *
   * Returns null for "", "-" and "%" — all of which Screener really emits:
   * Vodafone Idea's Inventory Days row is twelve empty strings, and its Return
   * on Equity buckets render as a bare "%". Neither of those is zero.
   *
   * Preserves real values that merely look falsy: "0", "-0%", "-73,132".
   * Handles Indian digit grouping ("2,38,893") and attached units
   * ("₹ 2,472", "52.63%", "1.11 %").
   */
  function num(text) {
    if (text == null) return null;
    var t = String(text).replace(/ /g, ' ').replace(/,/g, '').trim();
    if (t === '' || t === '-' || t === '--') return null;
    var m = /^[^\d+.-]*([-+]?\d*\.?\d+)/.exec(t);
    return m ? Number(m[1]) : null;
  }

  /** Case-insensitive lookup across a list of candidate keys. */
  function pick(obj, names) {
    if (!obj) return null;
    var lower = {}, k;
    for (k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) lower[k.toLowerCase()] = obj[k];
    }
    for (var i = 0; i < names.length; i++) {
      var v = lower[names[i].toLowerCase()];
      if (v !== undefined) return v;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // table reading
  // ---------------------------------------------------------------------------

  /**
   * Identify a row.
   *
   * Screener gives expandable rows a canonical machine key inside the onclick
   * handler: Company.showSchedule('Sales', 'profit-loss', this). That key is
   * stable and immune to the trailing "+" affordance, &nbsp; and whitespace, so
   * prefer it. Non-expandable rows (OPM %, Debtor Days, ROCE %, Promoters) have
   * no such handler and fall back to their normalised label text.
   *
   * Either way the lookup is by name, not by position — so reordering a table
   * cannot silently hand us the wrong row.
   */
  function rowKey(cell) {
    var btn = cell.querySelector('button[onclick*="showSchedule"]');
    if (btn) {
      var m = /showSchedule\(\s*'([^']+)'/.exec(btn.getAttribute('onclick') || '');
      if (m) return m[1];
    }
    return txt(cell).replace(/\s*\+\s*$/, '').trim();
  }

  /**
   * Read a Screener financial table into { periods, dateKeys, rows }.
   *
   * Column count is read from <thead>, never assumed: Profit & Loss carries an
   * extra trailing "TTM" column that Balance Sheet and Ratios do not, and the
   * number of year columns varies by company.
   */
  function readTable(table) {
    if (!table) return null;
    var head = table.querySelectorAll('thead th');
    var periods = [], dateKeys = [], i;
    for (i = 1; i < head.length; i++) {            // column 0 is the row-label column
      periods.push(txt(head[i]));
      dateKeys.push(head[i].getAttribute('data-date-key') || null);
    }
    var rows = {}, trs = table.querySelectorAll('tbody tr');
    for (i = 0; i < trs.length; i++) {
      var cells = trs[i].children;
      if (!cells.length) continue;
      var key = rowKey(cells[0]);
      if (!key) continue;
      var vals = [];
      for (var c = 1; c < cells.length; c++) vals.push(num(txt(cells[c])));
      rows[key] = vals;
    }
    return { periods: periods, dateKeys: dateKeys, rows: rows };
  }

  function sectionTable(doc, id) {
    var s = doc.querySelector('section#' + id);
    return s ? readTable(s.querySelector('table')) : null;
  }

  /**
   * A named row as an aligned series, or null if the row is not in the table.
   *
   * A row that exists but holds no figures still returns a series — with every
   * value null. "Screener has no such row" and "Screener reports nothing here"
   * are different facts and the one-pager should be able to tell them apart.
   */
  function series(table, names) {
    if (!table) return null;
    var vals = pick(table.rows, names);
    if (!vals) return null;
    return { periods: table.periods, dateKeys: table.dateKeys, values: vals };
  }

  /** Like series(), but reports which alias actually matched. */
  function labelledSeries(table, names) {
    if (!table) return null;
    for (var i = 0; i < names.length; i++) {
      var vals = pick(table.rows, [names[i]]);
      if (vals) {
        return {
          label: names[i],
          periods: table.periods,
          dateKeys: table.dateKeys,
          values: vals
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // non-tabular sections
  // ---------------------------------------------------------------------------

  /**
   * The small tables under Profit & Loss: Compounded Sales Growth, Compounded
   * Profit Growth, Stock Price CAGR, Return on Equity — each a set of 10y/5y/3y
   * buckets rather than a per-year series.
   */
  function rangesTables(doc) {
    var out = {}, tables = doc.querySelectorAll('section#profit-loss table.ranges-table');
    for (var i = 0; i < tables.length; i++) {
      var th = tables[i].querySelector('th');
      if (!th) continue;
      var bucket = {}, trs = tables[i].querySelectorAll('tr');
      for (var r = 0; r < trs.length; r++) {
        var c = trs[r].children;
        if (c.length < 2) continue;
        bucket[txt(c[0]).replace(/:$/, '')] = num(txt(c[1]));
      }
      out[txt(th)] = bucket;
    }
    return out;
  }

  /**
   * ul#top-ratios, as a label -> number map.
   *
   * This list is USER-CONFIGURABLE. A logged-out visitor sees 9 entries; a user
   * with a customised ratio set sees 20+, and the same account may show "Face
   * Value" twice in different casing. Read by label, never by position, and
   * treat a missing label as ordinary rather than as breakage.
   */
  function topRatios(doc) {
    var out = {}, lis = doc.querySelectorAll('ul#top-ratios li');
    for (var i = 0; i < lis.length; i++) {
      var name = lis[i].querySelector('.name');
      if (!name) continue;
      var numEl = lis[i].querySelector('.value .number') || lis[i].querySelector('.number');
      out[txt(name)] = numEl ? num(txt(numEl)) : null;
    }
    return out;
  }

  /**
   * The same list as displayed, label -> full text.
   *
   * Some ratios are not a single number: "High / Low" renders as
   * "₹ 2,986 / 2,115" and collapsing it to one figure would silently drop the
   * low. The numeric map above stays for arithmetic; this one is for showing.
   */
  function topRatiosText(doc) {
    var out = {}, lis = doc.querySelectorAll('ul#top-ratios li');
    for (var i = 0; i < lis.length; i++) {
      var name = lis[i].querySelector('.name');
      var value = lis[i].querySelector('.value');
      if (!name) continue;
      out[txt(name)] = value ? txt(value) : null;
    }
    return out;
  }

  /** The company description and key-points commentary Screener publishes. */
  function profile(doc) {
    var about = doc.querySelector('.company-profile .about');
    var points = doc.querySelector('.company-profile .commentary');
    // Screener marks the company's own site with a link glyph. Taking "the
    // first external anchor" instead picks up whatever else sits nearby — on
    // HDFC Bank that is a Wikipedia article, not the company's website.
    var site = null;
    var glyphs = doc.querySelectorAll('i.icon-link');
    for (var i = 0; i < glyphs.length; i++) {
      var a = glyphs[i].closest('a');
      var href = a && a.getAttribute('href');
      if (href && /^https?:\/\//.test(href) && !/screener\.in/.test(href)) {
        site = href;
        break;
      }
    }
    return {
      about: about && txt(about) ? txt(about) : null,
      keyPoints: points && txt(points) ? txt(points) : null,
      website: site
    };
  }

  /**
   * Filing links in the Documents section: annual reports, credit ratings and
   * concall material. Each is its own card, keyed by a stable class.
   */
  function documents(doc) {
    var cards = { annualReports: 'annual-reports', creditRatings: 'credit-ratings', concalls: 'concalls' };
    var out = {}, any = false;

    Object.keys(cards).forEach(function (key) {
      var card = doc.querySelector('.documents.' + cards[key]);
      if (!card) { out[key] = null; return; }
      var items = [], lis = card.querySelectorAll('ul.list-links li');
      for (var i = 0; i < lis.length; i++) {
        var a = lis[i].querySelector('a');
        if (!a) continue;
        var note = a.querySelector('div');
        var title = '';
        for (var n = 0; n < a.childNodes.length; n++) {
          if (a.childNodes[n].nodeType === 3) title += a.childNodes[n].textContent;
        }
        title = title.replace(/\s+/g, ' ').trim();
        if (!title) title = txt(a);
        items.push({ title: title, note: note ? txt(note) : null, url: a.getAttribute('href') || null });
      }
      out[key] = items.length ? items : null;
      if (items.length) any = true;
    });

    return any ? out : null;
  }

  /**
   * Recent company announcements.
   *
   * Screener has NO auditor-change field. This list is the only governance
   * signal genuinely present in the markup, so it is extracted structurally and
   * left uninterpreted — no keyword matching here. The "Recent" tab is
   * server-rendered; the Important and Search tabs are AJAX and will be absent
   * from any saved page.
   */
  function announcements(doc) {
    var lis = doc.querySelectorAll('#company-announcements-tab ul.list-links li');
    var out = [];
    for (var i = 0; i < lis.length; i++) {
      var a = lis[i].querySelector('a');
      if (!a) continue;
      // The title is the anchor's own text; the nested <div> holds date + blurb.
      var title = '';
      for (var n = 0; n < a.childNodes.length; n++) {
        if (a.childNodes[n].nodeType === 3) title += a.childNodes[n].textContent;
      }
      title = title.replace(/\s+/g, ' ').trim();
      var time = a.querySelector('time');
      out.push({
        title: title || txt(a),
        date: time ? time.getAttribute('datetime') : null,
        url: a.getAttribute('href') || null
      });
    }
    return out.length ? out : null;
  }

  /**
   * Which basis this page reports on.
   *
   * The default URL serves standalone figures and /consolidated/ is a separate
   * page with materially different numbers (Asian Paints FY26 sales: 30,769
   * standalone vs 35,584 consolidated). Screener advertises whichever view you
   * are NOT currently on, which makes this detectable from the DOM alone — no
   * URL needed, so it behaves identically on a live tab and on a saved fixture.
   */
  function detectBasis(doc) {
    // Screener states it outright on an otherwise empty marker div. Prefer that
    // over reading link text; fall back to the links when the div is absent.
    var marker = doc.querySelector('#company-info[data-consolidated]');
    if (marker) {
      return marker.getAttribute('data-consolidated') === 'true' ? 'consolidated' : 'standalone';
    }

    var as = doc.querySelectorAll('a'), toConsolidated = false, toStandalone = false;
    for (var i = 0; i < as.length; i++) {
      var t = txt(as[i]);
      if (t === 'View Consolidated') toConsolidated = true;
      else if (t === 'View Standalone') toStandalone = true;
    }
    if (toStandalone) return 'consolidated';
    if (toConsolidated) return 'standalone';
    return null;                                  // only one basis exists for this company
  }

  function detectTicker(doc) {
    var nse = doc.querySelector('a[href*="nseindia.com"]');
    if (nse) {
      var m = /symbol=([A-Za-z0-9&_-]+)/.exec(nse.getAttribute('href') || '');
      if (m) return m[1];
    }
    var bse = doc.querySelector('a[href*="bseindia.com"]');
    if (bse) {
      var b = /\/(\d{6})\//.exec(bse.getAttribute('href') || '');
      if (b) return b[1];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // entry point
  // ---------------------------------------------------------------------------

  /**
   * Parse a screener.in company page.
   *
   * @param {Document} doc  a live document or a jsdom-parsed fixture
   * @returns {object} absent sections and absent fields come back as null;
   *                   an unrecognised page yields nulls rather than throwing.
   */
  function parseCompanyPage(doc) {
    if (!doc || typeof doc.querySelector !== 'function') {
      throw new TypeError('parseCompanyPage expects a document-like object');
    }

    var shpSection = doc.querySelector('section#shareholding');
    var sections = {
      profitLoss:   sectionTable(doc, 'profit-loss'),
      balanceSheet: sectionTable(doc, 'balance-sheet'),
      cashFlow:     sectionTable(doc, 'cash-flow'),
      ratios:       sectionTable(doc, 'ratios'),
      quarters:     sectionTable(doc, 'quarters'),
      shareholding: shpSection ? {
        quarterly: readTable(shpSection.querySelector('#quarterly-shp table')),
        yearly:    readTable(shpSection.querySelector('#yearly-shp table'))
      } : null
    };

    var pl = sections.profitLoss,
        bs = sections.balanceSheet,
        cf = sections.cashFlow,
        ra = sections.ratios,
        shpQ = sections.shareholding && sections.shareholding.quarterly,
        top = topRatios(doc),
        ranges = rangesTables(doc),
        h1 = doc.querySelector('h1'),
        info = doc.querySelector('#company-info'),
        prof = profile(doc);

    return {
      meta: {
        name: h1 ? txt(h1) : null,
        ticker: detectTicker(doc),
        basis: detectBasis(doc),
        companyId: info ? info.getAttribute('data-company-id') : null,
        about: prof.about,
        keyPoints: prof.keyPoints,
        website: prof.website,
        sectionsFound: Object.keys(sections).filter(function (k) { return !!sections[k]; })
      },

      // Filing links: annual reports, credit ratings, concall material.
      documents: documents(doc),

      // Raw, label-keyed, every row Screener rendered. Downstream phases derive
      // from this — DuPont needs Total Assets, Equity Capital and Reserves —
      // without parse.js growing a named field per chart.
      sections: sections,

      // The stable contract for the one-pager and the charts.
      fields: {
        revenue:       series(pl, ['Sales', 'Revenue', 'Income']),

        // Strictly the OPM % row. Lenders report Financing Margin %, which is a
        // different metric — aliasing the two would mislabel a real figure, so
        // banks and NBFCs get null here by design.
        opm:           series(pl, ['OPM %']),

        // The margin row this company actually reports, carrying its own label,
        // so the one-pager can describe a lender honestly instead of blankly.
        margin:        labelledSeries(pl, ['OPM %', 'Financing Margin %']),

        pat:           series(pl, ['Net Profit']),
        cfo:           series(cf, ['Cash from Operating Activity']),
        totalDebt:     series(bs, ['Borrowings', 'Borrowing']),
        totalAssets:   series(bs, ['Total Assets']),
        equityCapital: series(bs, ['Equity Capital']),
        reserves:      series(bs, ['Reserves']),

        // Absent wholesale from the lending layout — banks have no such rows.
        debtorDays:    series(ra, ['Debtor Days']),
        inventoryDays: series(ra, ['Inventory Days']),

        // Three shapes in three places, and lenders carry more of it than
        // manufacturers do: a point-in-time figure in top-ratios, 10y/5y/3y
        // buckets under Profit & Loss, and — lending layout only — a full
        // year-by-year row in #ratios.
        roe: {
          current: pick(top, ['ROE']),
          buckets: ranges['Return on Equity'] || null,
          series:  series(ra, ['ROE %'])
        },

        promoterHolding: series(shpQ, ['Promoters']),

        // Not in Screener's default markup for anyone. "Pledged percentage" is
        // an optional ratio a user may add to their own top-ratios list, so this
        // is read opportunistically and is null for most pages.
        promoterPledge: pick(top, ['Pledged percentage']),

        announcements: announcements(doc)
      },

      // The compounded-growth tables Screener prints under Profit & Loss:
      // Compounded Sales Growth, Compounded Profit Growth, Stock Price CAGR and
      // Return on Equity, each as 10y/5y/3y buckets.
      ranges: ranges,

      topRatios: top,
      topRatiosText: topRatiosText(doc)
    };
  }

  // ---------------------------------------------------------------------------
  // breakage detection
  //
  // Screener has no API and no contract with us. When its markup changes, this
  // parser goes quiet rather than loud — nulls everywhere and a report that
  // looks merely uneventful. That is the failure mode worth catching early, so
  // the things this file depends on are written down once, here, and used by
  // both the in-page notice and the CI canary. Add a selector above, add it
  // here.
  // ---------------------------------------------------------------------------

  var EXPECTATIONS = [
    // Without these the page cannot be described at all.
    { id: 'section#profit-loss', label: 'Profit & loss section', required: true },
    { id: 'section#balance-sheet', label: 'Balance sheet section', required: true },
    { id: 'section#cash-flow', label: 'Cash flow section', required: true },
    { id: 'section#shareholding', label: 'Shareholding section', required: true },
    { row: ['profit-loss', ['Sales', 'Revenue', 'Income']], label: 'Revenue row', required: true },
    { row: ['profit-loss', ['Net Profit']], label: 'Net profit row', required: true },
    { row: ['balance-sheet', ['Total Assets']], label: 'Total assets row', required: true },
    { row: ['cash-flow', ['Cash from Operating Activity']], label: 'Operating cash row', required: true },
    { id: 'section#profit-loss thead th[data-date-key]', label: 'Machine-readable period keys', required: true },

    // These degrade to "not reported" rather than breaking the page.
    { id: 'section#ratios', label: 'Ratios section', required: false },
    { id: 'section#quarters', label: 'Quarterly results section', required: false },
    { id: 'section#documents', label: 'Documents section', required: false },
    { id: 'ul#top-ratios li .name', label: 'Top ratio strip', required: false },
    { id: 'section#profit-loss table.ranges-table', label: 'Compounded growth tables', required: false },
    { id: 'button[onclick*="showSchedule"]', label: 'Canonical row keys', required: false },
    { id: '#company-info[data-consolidated]', label: 'Consolidated/standalone marker', required: false },
    { id: '.company-profile .about', label: 'Company description', required: false },
    { id: '.documents.annual-reports', label: 'Annual report links', required: false },
    { id: '#company-announcements-tab ul.list-links li', label: 'Announcements', required: false },
    { id: '#quarterly-shp table', label: 'Quarterly shareholding', required: false }
  ];

  function hasRow(doc, sectionId, names) {
    var table = sectionTable(doc, sectionId);
    if (!table) return false;
    return pick(table.rows, names) !== null;
  }

  /**
   * Check a page against everything parse.js relies on.
   *
   * Returns { ok, checks, missingRequired, missingOptional }. `ok` is false only
   * when a required expectation fails — an optional miss is normal (a bank has
   * no ratios worth the name, a logged-out visitor has a shorter ratio strip).
   */
  function checkPage(doc) {
    var checks = EXPECTATIONS.map(function (e) {
      var found;
      if (e.row) found = hasRow(doc, e.row[0], e.row[1]);
      else found = !!doc.querySelector(e.id);
      return {
        label: e.label,
        selector: e.id || ('row ' + e.row[1][0] + ' in #' + e.row[0]),
        required: !!e.required,
        found: found
      };
    });

    var missingRequired = checks.filter(function (c) { return c.required && !c.found; });
    var missingOptional = checks.filter(function (c) { return !c.required && !c.found; });

    return {
      ok: missingRequired.length === 0,
      checks: checks,
      missingRequired: missingRequired,
      missingOptional: missingOptional
    };
  }

  var api = {
    parseCompanyPage: parseCompanyPage,
    num: num,
    checkPage: checkPage,
    EXPECTATIONS: EXPECTATIONS
  };

  if (typeof module === 'object' && module.exports) module.exports = api;  // node --test
  else root.ScreenerXRay = api;                                           // content script
})(typeof globalThis !== 'undefined' ? globalThis : this);
