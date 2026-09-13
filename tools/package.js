/**
 * Screener X-Ray — build the store bundle.
 *
 * Copies only the files that actually ship into dist/. Everything else in this
 * repo — tests, fixtures, node_modules, tooling, the reference PDFs — stays out,
 * both to keep the upload small and because a Chrome Web Store review that finds
 * jsdom sitting in the bundle will reasonably ask why an extension advertising
 * zero dependencies is shipping one.
 *
 * Usage:  node tools/package.js
 * Then:   zip the contents of dist/ (or load dist/ unpacked to verify first).
 *
 * No zip is produced here on purpose: shelling out to a zip binary is not
 * portable and pulling in an archiver would add a dependency to a project whose
 * first rule is not having any. On Windows:
 *   Compress-Archive -Path dist\* -DestinationPath screener-xray.zip -Force
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// The bundle, in full. If a file is not on this list it does not ship.
const SHIPPED = [
  'manifest.json',
  'parse.js',
  'content.js',
  'chart.js',
  'insights.js',
  'xlsx.js',
  'statements.js',
  'report.html',
  'report.js',
  'report.css',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  let total = 0;
  for (const file of SHIPPED) {
    const from = path.join(ROOT, file);
    if (!fs.existsSync(from)) {
      console.error(`missing shipped file: ${file}`);
      process.exit(1);
    }
    const to = path.join(DIST, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const size = fs.statSync(from).size;
    total += size;
    console.log(`  ${file.padEnd(16)} ${String(size).padStart(7)} bytes`);
  }

  // Guard the rules that matter, at the only point where they become a shipped
  // artefact rather than an intention.
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const problems = [];

  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) {
    problems.push(`permissions must be exactly ["storage"], found ${JSON.stringify(manifest.permissions)}`);
  }
  if (manifest.host_permissions) problems.push('host_permissions must not be requested');

  // Chrome falls back to a grey placeholder when icons are missing, which looks
  // abandoned in the toolbar and on the store listing.
  for (const size of ['16', '48', '128']) {
    const declared = manifest.icons && manifest.icons[size];
    if (!declared) problems.push(`manifest declares no ${size}px icon`);
    else if (!fs.existsSync(path.join(DIST, declared))) problems.push(`${declared} is missing from the bundle`);
  }

  for (const file of SHIPPED.filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(DIST, file), 'utf8');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(src)) {
      problems.push(`${file} contains a network call`);
    }
    if (/\brequire\s*\(|^\s*import\s/m.test(src.replace(/typeof module[\s\S]{0,80}module\.exports/g, ''))) {
      problems.push(`${file} appears to import a module`);
    }
  }

  if (problems.length) {
    console.error('\nbundle rejected:');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  console.log(`\ndist/ built — ${SHIPPED.length} files, ${total} bytes, version ${manifest.version}`);
  console.log('permissions:', JSON.stringify(manifest.permissions), '· no host permissions · no network calls');
}

main();
