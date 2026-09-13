/**
 * Screener X-Ray — build a standalone render of the report for store assets.
 *
 * Dev/CI tooling. Renders report.html against a saved fixture using the real
 * chart.js and report.js, then writes a self-contained HTML file with the CSS
 * inlined and the scripts stripped — so what the Chrome Web Store screenshots
 * show is genuinely what the extension produces, not a mockup of it.
 *
 * The companion python script drives headless Chrome over this file and crops
 * the results to the sizes the store wants.
 *
 * Usage:  node tools/make-screenshots.js [fixture] [outfile]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { parseCompanyPage, checkPage } = require('../parse.js');

const ROOT = path.join(__dirname, '..');
const fixture = process.argv[2] || 'manufacturer-ASIANPAINT.html';
const outFile = process.argv[3] || path.join(ROOT, 'store', '_report.html');

// A plausible, specific note. Store screenshots showing an empty textarea sell
// the feature poorly; showing someone's real portfolio would be worse.
const DEMO_NOTE =
  'Margin recovery looks like mix rather than price — gross margin up while ' +
  'realisations are flat. Watching debtor days against sales growth; ' +
  'receivables have drifted out four quarters running. Re-check after Q2.';

const DEMO_ENTRIES = [
  {
    savedAt: '2026-06-02T09:00:00.000Z',
    text: 'Initial read. Cash conversion above 100% for three years running, which is the thing that first made this worth a second look.'
  },
  {
    savedAt: '2026-09-01T09:00:00.000Z',
    text: 'Working-capital days still widening. Not a thesis-breaker yet, but it is the number I would want to see turn.'
  }
];

function build() {
  const html = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', fixture), 'utf8');
  const doc = new JSDOM(html).window.document;

  const data = parseCompanyPage(doc);
  data.meta.health = checkPage(doc);
  data.meta.url = 'https://www.screener.in/company/' + (data.meta.ticker || 'X') + '/consolidated/';
  data.meta.capturedAt = new Date().toISOString();

  const journalKey = 'xray:journal:' + (data.meta.ticker || 'X');
  const store = {
    'xray:last': data,
    [journalKey]: { draft: DEMO_NOTE, entries: DEMO_ENTRIES }
  };

  const css = fs.readFileSync(path.join(ROOT, 'report.css'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'report.html'), 'utf8');

  return new Promise((resolve) => {
    const dom = new JSDOM(shell, {
      url: pathToFileURL(path.join(ROOT, 'report.html')).href,
      runScripts: 'dangerously',
      resources: 'usable',
      beforeParse(w) {
        w.chrome = {
          storage: {
            local: {
              get: (k) => Promise.resolve(k in store ? { [k]: store[k] } : {}),
              set: () => Promise.resolve()
            }
          }
        };
      }
    });

    dom.window.addEventListener('load', () => {
      setTimeout(() => {
        const d = dom.window.document;
        // A textarea's JS-assigned value is not part of innerHTML; mirror it in
        // so the static capture shows the note.
        d.querySelectorAll('textarea').forEach((t) => { t.textContent = t.value; });
        d.querySelectorAll('link[rel=stylesheet], script').forEach((n) => n.remove());

        const page =
          '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
          '<title>' + d.title + '</title><style>' + css +
          // The store wants a fixed frame; the sheet keeps its own width.
          'html,body{margin:0}body{padding:28px 20px}</style></head><body>' +
          d.body.innerHTML + '</body></html>';

        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, page, 'utf8');
        console.log('wrote', outFile, fs.statSync(outFile).size, 'bytes');
        resolve();
      }, 150);
    });
  });
}

build();
