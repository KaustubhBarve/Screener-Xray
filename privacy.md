# Privacy policy — Screener X-Ray

**Last updated: 13 September 2026**

> The published version of this policy is [`docs/index.html`](docs/index.html) —
> that is the URL given to the Chrome Web Store. Edit both together; this file is
> the readable source, that one is what people actually load.

## The short version

Screener X-Ray collects nothing, transmits nothing, and has no server. Everything
it does happens inside your own browser, on your own device.

There is no account, no sign-in, no analytics, no telemetry, no crash reporting,
no advertising, and no third-party code of any kind.

## What the extension does

When you open a company page on `screener.in` and click the **X-Ray** button, the
extension reads the figures already displayed on that page, rearranges them into
a one-pager, and shows it in a new tab. It also lets you type notes about the
company and keeps them for the next time you visit.

If you choose to, you can also add Screener's own Excel export for a company — a
file you download from Screener yourself and pick from your computer. The report
reads it inside that tab to itemise expenses and assets. The file is never
uploaded, and the extension cannot fetch it on its own.

All of that happens locally. The figures never leave your browser.

## What is stored, and where

The extension uses `chrome.storage.local`, which is browser storage on your own
computer. Three things are kept there:

| What | Where | Why |
|---|---|---|
| The most recent company report | `xray:last` | So the report tab can display it |
| Your notes, per company | `xray:journal:<ticker>` | So your thesis is there when you return |
| Screener's Excel export, only if you add one | `xray:export:<company id>` | So the itemised lines are there when you return |

Your notes include whatever you choose to type. Nothing analyses them, indexes
them, or reads them other than the extension displaying them back to you.

This data is **not** synced to a Google account, not backed up anywhere, and not
accessible to us — we have no way to see it, because there is nowhere for it to
go.

## What is NOT collected

To be explicit, the extension does not collect, store or transmit:

- personally identifiable information, names or email addresses
- your Screener account details, credentials or cookies
- your browsing history, or which companies you look at
- location, device identifiers or IP addresses
- usage analytics, click tracking, timing or performance data

## Network activity

**The extension makes no network requests.** It does not contact any server,
including ours — we do not operate one. It loads no remote scripts, fonts,
stylesheets or images. Every file it runs is inside the extension package,
reviewable in the Chrome Web Store listing and in the public source.

The only links in the report point to screener.in, BSE and company filings. Those
are ordinary links: nothing is fetched unless you click one, and clicking one is
an ordinary visit to that site, governed by that site's own privacy policy.

## Permissions

The extension requests exactly one permission:

- **`storage`** — to keep your notes, the last report and any export you add on
  your device. This
  permission cannot read your browsing data; it is private storage belonging to
  the extension.

It runs its content script only on `https://screener.in/company/*`. It has no
access to any other website, and it requests no host permissions.

## Deleting your data

Removing the extension from Chrome deletes everything it stored. You can also
clear it at any time without uninstalling, from `chrome://extensions` → Screener
X-Ray → **Site settings** → clear data.

There is nothing to request from us and nothing for us to delete, because we
never receive any of it.

## Children

The extension is intended for adults researching listed companies. It is not
directed at children and collects no data from anyone.

## About the data shown

Figures come from screener.in and are not independently verified. This extension
is **not affiliated with, endorsed by, or connected to** screener.in or its
operators.

The report is a descriptive statistical summary. It contains no scores, grades,
ratings, price targets or buy/sell/hold recommendations, and is **not investment
advice**. Verify against a company's own filings before acting on anything.

## Changes

If this policy ever changes, the date at the top changes with it, and the change
will appear in the extension's version history. A version that collected data
would be a different product, not an update to this one.

## Contact

Questions about this policy: kaustubhbarve2105@gmail.com
