/**
 * Screener X-Ray — reads Screener's "Export to Excel" workbook, on this device.
 *
 * The company page shows one Expenses line and one Other Assets line. Screener's
 * export carries the lines behind them — raw material, employee cost, power and
 * fuel; receivables, inventory, cash — and tax in rupees. The reader downloads
 * the export from Screener themselves and chooses the file in the report. It is
 * read here with the browser's own inflater (DecompressionStream): no library
 * (rule 1), no request of any kind (rule 2).
 *
 * An .xlsx is a ZIP of XML files. Four matter: the workbook (sheet names), its
 * relationships (which file each sheet is), the shared strings (text cells point
 * into them) and the "Data Sheet", where Screener writes every number — the other
 * sheets are formulas over it.
 *
 * Like parse.js, this is a scrape of a format Screener does not document, so it
 * is the one place to fix when that format changes.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // zip
  // ---------------------------------------------------------------------------

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** The central directory: name -> { method, size (compressed), offset }. */
  function directory(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.');
    var count = u16(bytes, eocd + 10);
    var p = u32(bytes, eocd + 16);
    var dec = new TextDecoder();
    var out = {};
    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('The file is damaged.');
      var nameLen = u16(bytes, p + 28);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      out[name] = { method: u16(bytes, p + 10), size: u32(bytes, p + 20), offset: u32(bytes, p + 42) };
      p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    }
    return out;
  }

  function readEntry(bytes, dir, name) {
    var e = dir[name];
    if (!e) return Promise.resolve(null);
    var o = e.offset;
    if (u32(bytes, o) !== 0x04034b50) return Promise.reject(new Error('The file is damaged.'));
    // sizes come from the central directory: the local header may leave them zero
    var start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    var data = bytes.subarray(start, start + e.size);
    var raw;
    if (e.method === 0) raw = Promise.resolve(data);
    else if (e.method === 8) {
      raw = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')))
        .arrayBuffer().then(function (b) { return new Uint8Array(b); });
    } else return Promise.reject(new Error('The file uses a compression this reader does not support.'));
    return raw.then(function (b) { return new TextDecoder().decode(b); });
  }

  // ---------------------------------------------------------------------------
  // spreadsheet xml
  // ---------------------------------------------------------------------------

  var ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

  function unescapeXml(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, function (m, k) {
      if (k.charAt(0) !== '#') return ENTITIES[k];
      return String.fromCodePoint(k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    });
  }

  function sharedStrings(xml) {
    if (!xml) return [];
    return (xml.match(/<si>[\s\S]*?<\/si>/g) || []).map(function (si) {
      var runs = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [];
      return unescapeXml(runs.map(function (t) { return t.replace(/^<t[^>]*>|<\/t>$/g, ''); }).join(''));
    });
  }

  /** A sheet as { A1: value }: numbers as numbers, text as text, blanks absent. */
  function cells(xml, strings) {
    var out = {};
    var re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var m;
    while ((m = re.exec(xml))) {
      var ref = /\br="([A-Z]+\d+)"/.exec(m[1]);
      if (!ref || !m[2]) continue;
      var type = (/\bt="(\w+)"/.exec(m[1]) || [])[1];
      if (type === 'inlineStr') {
        var t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[2]);
        if (t) out[ref[1]] = unescapeXml(t[1]);
        continue;
      }
      var v = /<v>([\s\S]*?)<\/v>/.exec(m[2]);
      if (!v) continue;
      if (type === 's') out[ref[1]] = strings[Number(v[1])];
      else if (type === 'str' || type === 'e') out[ref[1]] = unescapeXml(v[1]);
      else if (type !== 'b' && v[1] !== '' && Number.isFinite(Number(v[1]))) out[ref[1]] = Number(v[1]);
    }
    return out;
  }

  function attr(tag, name) {
    var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
    return m ? unescapeXml(m[1]) : null;
  }

  function sheetPath(workbook, rels, wanted) {
    var id = null;
    (workbook.match(/<sheet\b[^>]*>/g) || []).forEach(function (tag) {
      if (attr(tag, 'name') === wanted) id = attr(tag, 'r:id');
    });
    if (!id) return null;
    var target = null;
    (rels.match(/<Relationship\b[^>]*>/g) || []).forEach(function (tag) {
      if (attr(tag, 'Id') === id) target = attr(tag, 'Target');
    });
    if (!target) return null;
    return target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
  }

  // ---------------------------------------------------------------------------
  // Screener's Data Sheet
  // ---------------------------------------------------------------------------

  var BLOCKS = {
    'PROFIT & LOSS': 'profitLoss', 'QUARTERS': 'quarters',
    'BALANCE SHEET': 'balanceSheet', 'CASH FLOW:': 'cashFlow', 'CASH FLOW': 'cashFlow'
  };
  var COLUMNS = 'BCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['AA', 'AB', 'AC', 'AD']);

  /** Excel stores a date as days since 1899-12-30. Returned as the page's ISO key. */
  function dateKey(v) {
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    return null;
  }

  /**
   * Blocks of rows under a heading in column A ("PROFIT & LOSS", "Quarters", …),
   * each opened by a "Report Date" row whose columns date every row below it.
   * Row labels are kept exactly as Screener writes them.
   */
  function dataSheet(c) {
    var out = { company: c.A1 === 'COMPANY NAME' ? c.B1 || null : null, meta: {}, sections: {}, price: null };
    var last = 0;
    Object.keys(c).forEach(function (ref) { last = Math.max(last, Number(ref.replace(/^[A-Z]+/, ''))); });

    var block = null;
    for (var r = 1; r <= last; r++) {
      var label = typeof c['A' + r] === 'string' ? c['A' + r].trim() : null;
      if (!label) continue;
      var key = label.toUpperCase();
      var values = COLUMNS.map(function (col) { return c[col + r]; });

      if (BLOCKS[key]) {
        block = { dateKeys: [], rows: {} };
        out.sections[BLOCKS[key]] = block;
      } else if (key === 'PRICE:') {
        var annual = out.sections.profitLoss ? out.sections.profitLoss.dateKeys : [];
        out.price = { dateKeys: annual.slice(), values: annual.map(function (_, i) {
          return typeof values[i] === 'number' ? values[i] : null;
        }) };
        block = null;
      } else if (key === 'META' || key === 'DERIVED:') {
        block = null;
      } else if (!block) {
        if (typeof values[0] === 'number') out.meta[label] = values[0];
      } else if (key === 'REPORT DATE') {
        block.dateKeys = values.map(dateKey).filter(Boolean);
      } else {
        var name = label;
        for (var n = 2; block.rows[name]; n++) name = label + ' (' + n + ')';
        block.rows[name] = block.dateKeys.map(function (_, i) {
          return typeof values[i] === 'number' ? values[i] : null;
        });
      }
    }
    return out;
  }

  /** Read a Screener export from the file's bytes. Rejects with a message fit to show. */
  function readScreenerExport(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dir;
    try { dir = directory(bytes); } catch (err) { return Promise.reject(err); }
    return Promise.all(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']
      .map(function (n) { return readEntry(bytes, dir, n); }))
      .then(function (parts) {
        if (!parts[0] || !parts[1]) throw new Error('This is not an Excel workbook.');
        var path = sheetPath(parts[0], parts[1], 'Data Sheet');
        if (!path) throw new Error('It has no "Data Sheet", so it is not Screener’s Excel export.');
        return readEntry(bytes, dir, path).then(function (xml) {
          var exp = dataSheet(cells(xml || '', sharedStrings(parts[2])));
          var pl = exp.sections.profitLoss;
          if (!pl || !pl.dateKeys.length || !(pl.rows.Sales || pl.rows.Revenue)) {
            throw new Error('Its Data Sheet has no profit and loss block, so it is not Screener’s Excel export.');
          }
          return exp;
        });
      });
  }

  /**
   * Whether an export belongs to the report beside it: same company, and the
   * same revenue in every year both carry. The second check catches the easy
   * mistake — a standalone export against a consolidated report.
   */
  function matchesPage(exp, data) {
    var norm = function (s) {
      return String(s || '').toUpperCase().replace(/\bLIMITED\b/g, 'LTD').replace(/[^A-Z0-9]/g, '');
    };
    var name = data && data.meta && data.meta.name;
    if (exp.company && name && norm(exp.company) !== norm(name)) {
      return { ok: false, reason: 'This export is for ' + exp.company + ', but the report is for ' + name + '.' };
    }
    var pl = data && data.sections && data.sections.profitLoss;
    var xs = exp.sections && exp.sections.profitLoss;
    var page = pl && (pl.rows.Sales || pl.rows.Revenue || pl.rows.Income);
    var mine = xs && (xs.rows.Sales || xs.rows.Revenue);
    var compared = 0;
    if (page && mine && pl.dateKeys) {
      for (var i = 0; i < xs.dateKeys.length; i++) {
        var j = pl.dateKeys.indexOf(xs.dateKeys[i]);
        if (j < 0 || !Number.isFinite(page[j]) || !Number.isFinite(mine[i])) continue;
        if (Math.abs(page[j] - mine[i]) > Math.max(1, Math.abs(page[j]) * 0.005)) {
          return { ok: false, reason: 'Its revenue does not match this report. It may hold standalone figures '
            + 'where the report is consolidated, or the other way round — export again from the same page.' };
        }
        compared++;
      }
    }
    if (!compared) return { ok: false, reason: 'None of its years line up with this report.' };
    return { ok: true, reason: null };
  }

  var api = { readScreenerExport: readScreenerExport, matchesPage: matchesPage, dateKey: dateKey };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScreenerXRayXlsx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
