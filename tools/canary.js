/**
 * Screener X-Ray — DOM canary.
 *
 * Fetches live screener.in company pages and checks them against the selector
 * contract declared in parse.js (EXPECTATIONS). Exits non-zero when a REQUIRED
 * expectation fails, so a scheduled CI job can raise the alarm the day Screener
 * changes its markup — rather than the week a user notices blank figures.
 *
 * This is dev/CI tooling. It makes network calls; the extension never does.
 * It is not part of the shipped bundle — see tools/package.js.
 *
 * Usage:
 *   node tools/canary.js                # the three reference companies
 *   node tools/canary.js TCS BAJFINANCE # any tickers you like
 */
'use strict';

const { JSDOM } = require('jsdom');
const { checkPage } = require('../parse.js');

// One from each layout family plus the awkward case: a manufacturer, a bank,
// and a company whose rows exist but report nothing.
const DEFAULT_TICKERS = ['ASIANPAINT', 'HDFCBANK', 'IDEA'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchPage(ticker) {
  const url = `https://www.screener.in/company/${ticker}/consolidated/`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  if (html.length < 20000) throw new Error(`suspiciously short page for ${ticker}`);
  return { url, html };
}

function line(check) {
  return `${check.found ? '  ok  ' : '  --  '}${check.label.padEnd(34)}${check.selector}`;
}

async function main() {
  const tickers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TICKERS;
  let drifted = false;      // markup no longer matches the contract
  let unreachable = false;  // could not look at all — not the same thing
  const summary = [];

  for (const ticker of tickers) {
    console.log(`\n=== ${ticker}`);
    let page;
    try {
      page = await fetchPage(ticker);
    } catch (err) {
      // A network blip is not markup drift. Say which it is, and still fail —
      // a canary that cannot see the mine is not reporting good air.
      console.log(`  FETCH FAILED: ${err.message}`);
      summary.push(`${ticker}: unreachable`);
      unreachable = true;
      continue;
    }

    const doc = new JSDOM(page.html).window.document;
    const health = checkPage(doc);

    for (const check of health.checks) {
      if (!check.found || process.env.CANARY_VERBOSE) console.log(line(check));
    }

    if (health.ok && !health.missingOptional.length) {
      console.log('  all expectations met');
      summary.push(`${ticker}: ok`);
    } else if (health.ok) {
      // Optional misses are a warning, not a failure: a bank legitimately has
      // fewer rows than a manufacturer. But they are worth printing, because a
      // drift usually shows up here first.
      console.log(`  ok, with ${health.missingOptional.length} optional expectation(s) unmet`);
      summary.push(`${ticker}: ok (${health.missingOptional.length} optional unmet)`);
    } else {
      console.log(`  REQUIRED EXPECTATIONS FAILED: ${health.missingRequired.length}`);
      summary.push(`${ticker}: BROKEN — ${health.missingRequired.map((c) => c.label).join(', ')}`);
      drifted = true;
    }
  }

  console.log('\n--- summary ---');
  summary.forEach((s) => console.log('  ' + s));

  if (drifted) {
    console.log('\nparse.js is out of date with screener.in. Re-save the fixtures in');
    console.log('test/fixtures/ from the live site, then fix parse.js until the tests');
    console.log('pass against them again.');
  } else if (unreachable) {
    console.log('\nCould not reach screener.in. This is a fetch failure, not markup');
    console.log('drift — check the network, or whether that ticker exists, before');
    console.log('touching parse.js.');
  } else {
    console.log('\nscreener.in markup still matches what parse.js expects.');
  }

  // Set the code rather than calling process.exit(): exiting while a fetch
  // socket is still closing trips a libuv assertion on Windows and can swallow
  // the exit code entirely. Letting the event loop drain reports it reliably.
  if (drifted || unreachable) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
