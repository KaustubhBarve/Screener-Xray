/**
 * Screener X-Ray — content script.
 *
 * Injects one button into screener.in's company header. On click it hands the
 * live document to parse.js, stashes the result in chrome.storage.local, and
 * opens report.html in a new tab.
 *
 * This file does NOT read screener.in's DOM for data — it only locates the spot
 * to hang a button on. All extraction lives in parse.js (CLAUDE.md rule 3).
 */
(function () {
  'use strict';

  var BUTTON_ID = 'screener-xray-button';
  var STORAGE_KEY = 'xray:last';

  if (document.getElementById(BUTTON_ID)) return;        // never inject twice

  /**
   * The company header.
   *
   * Screener renders two <h1>s: one in the sticky `.company-nav` strip and one
   * in the main card. We want the main card's — its parent is the flex row
   * holding the name and the live price, which puts our button directly beside
   * the company name on every layout tested.
   */
  function findHeader() {
    var h1s = document.querySelectorAll('h1');
    for (var i = 0; i < h1s.length; i++) {
      if (!h1s[i].closest('.company-nav')) return h1s[i];
    }
    return null;
  }

  function makeButton() {
    var btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';                                  // never submit a Screener form
    btn.textContent = 'X-Ray';
    btn.title = 'Open a descriptive one-pager for this company';
    // Inline styles only: injecting a stylesheet into screener.in risks
    // colliding with theirs, and this is a single element.
    btn.style.cssText = [
      'margin-left:12px', 'padding:4px 12px', 'font:inherit', 'font-size:13px',
      'font-weight:500', 'line-height:1.6', 'color:#3b5bdb', 'background:#fff',
      'border:1px solid #3b5bdb', 'border-radius:6px', 'cursor:pointer',
      'white-space:nowrap', 'flex-shrink:0'
    ].join(';');
    return btn;
  }

  function setState(btn, text, disabled) {
    btn.textContent = text;
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? '0.6' : '1';
    btn.removeAttribute('aria-busy');
  }

  /**
   * A small rotating ring.
   *
   * Drawn with inline styles and the Web Animations API rather than a
   * @keyframes rule, because a keyframes rule means injecting a stylesheet into
   * screener.in — and anything injected there can collide with Screener's own
   * CSS. One element, animated directly, touches nothing else on the page.
   */
  function spinner() {
    var ring = document.createElement('span');
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = [
      'display:inline-block', 'width:10px', 'height:10px', 'margin-right:6px',
      'vertical-align:-1px', 'box-sizing:border-box', 'border-radius:50%',
      'border:1.5px solid currentColor', 'border-right-color:transparent'
    ].join(';');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ring.animate) {
      ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: reduce ? 2400 : 700, iterations: Infinity });
    }
    return ring;
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.style.opacity = '1';
    btn.textContent = '';
    if (busy) {
      btn.setAttribute('aria-busy', 'true');
      btn.appendChild(spinner());
      btn.appendChild(document.createTextNode('Reading…'));
    } else {
      btn.removeAttribute('aria-busy');
      btn.textContent = 'X-Ray';
    }
  }

  function openReport(btn) {
    var parser = (typeof globalThis !== 'undefined' ? globalThis : window).ScreenerXRay;
    if (!parser || typeof parser.parseCompanyPage !== 'function') {
      setState(btn, 'X-Ray unavailable', true);
      return;
    }

    var data;
    try {
      data = parser.parseCompanyPage(document);
    } catch (err) {
      // parse.js is built to return nulls rather than throw, so reaching here
      // means screener.in changed something structural. Say so plainly instead
      // of opening an empty report.
      console.error('[Screener X-Ray] parse failed', err);
      setState(btn, 'Could not read this page', true);
      return;
    }

    data.meta.url = location.href;
    data.meta.capturedAt = new Date().toISOString();
    // Wall-clock time of the click, so the report tab can measure the whole
    // journey against the three-second budget. performance.now() would not do:
    // each tab has its own clock origin.
    data.meta.clickedAt = btn.__xrayClickedAt || Date.now();

    // Screener owes this extension no stability. When its markup moves the
    // parser goes quiet rather than loud, so record what could not be found and
    // let the report say so plainly instead of showing a page of blanks.
    try {
      data.meta.health = parser.checkPage(document);
    } catch (err) {
      data.meta.health = null;
    }

    var payload = {};
    payload[STORAGE_KEY] = data;

    // Chrome keeps transient user activation alive for ~5s, so opening the tab
    // after this short await is not treated as a popup.
    chrome.storage.local.set(payload).then(function () {
      window.open(chrome.runtime.getURL('report.html'), '_blank', 'noopener');
      setBusy(btn, false);
    }).catch(function (err) {
      console.error('[Screener X-Ray] could not save report data', err);
      setState(btn, 'Could not open report', true);
    });
  }

  var header = findHeader();
  if (!header || !header.parentElement) return;            // unrecognised layout

  var button = makeButton();
  button.addEventListener('click', function () {
    if (button.getAttribute('aria-busy')) return;          // no double-clicks
    button.__xrayClickedAt = Date.now();
    setBusy(button, true);
    // Reading the page is synchronous, and a synchronous task blocks the paint
    // that would show the spinner — so let one frame render first. Chrome keeps
    // the click's user activation alive for ~5s, so the tab still opens.
    requestAnimationFrame(function () {
      setTimeout(function () { openReport(button); }, 0);
    });
  });
  header.parentElement.appendChild(button);

  /**
   * In-page breakage notice.
   *
   * If Screener's layout has moved far enough that required data cannot be
   * read, say so here rather than letting someone open a report full of blanks
   * and conclude the company has no figures.
   */
  (function notifyIfBroken() {
    var parser = (typeof globalThis !== 'undefined' ? globalThis : window).ScreenerXRay;
    if (!parser || typeof parser.checkPage !== 'function') return;

    var health;
    try {
      health = parser.checkPage(document);
    } catch (err) {
      return;
    }
    if (!health || health.ok) return;

    button.style.color = '#B34A3A';
    button.style.borderColor = '#B34A3A';
    button.title = 'Screener’s page layout has changed; some figures cannot be read';

    var note = document.createElement('span');
    note.textContent = 'X-Ray: Screener’s layout changed — some figures unavailable';
    note.style.cssText = [
      'margin-left:8px', 'font:inherit', 'font-size:11px', 'color:#B34A3A',
      'white-space:nowrap', 'flex-shrink:0'
    ].join(';');
    button.insertAdjacentElement('afterend', note);
  })();
})();
