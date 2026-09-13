# Running Screener X-Ray on your own machine

For testing it before it goes anywhere near the Chrome Web Store. Nothing here
publishes anything or makes it visible to anyone else.

---

## 1. Build the folder Chrome will load

In the project folder:

```bash
node tools/package.js
```

That creates `dist/` — the extension and nothing else. Nine code files plus the
manifest, four icons, no tests, no tooling, no `node_modules`. It refuses to build if the
permissions have drifted or a network call has crept into a shipped file, so a
successful build is also a check.

## 2. Load it into Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** — the toggle is at the top right
3. Click **Load unpacked**
4. Select the **`dist`** folder (not the project folder — `dist` itself)

Screener X-Ray appears in the list with its icon. Pin it to the toolbar if you
like, though you never need to click the toolbar icon — the extension works from
a button on the page.

## 3. Use it

Open any company on screener.in, for example:

```
https://www.screener.in/company/ASIANPAINT/consolidated/
```

An **X-Ray** button sits next to the company name. Click it and the report opens
in a new tab.

Use the `/consolidated/` form of the URL. The plain `/company/ASIANPAINT/` page
shows *standalone* figures, which are different numbers — the report says which
basis it read, at the top.

---

## What to check while you are testing

Worth going through deliberately, because each of these is something that can
only really be judged by a person:

**Does the button appear, and in a sensible place?** It should sit beside the
company name. Screener's header changes on narrow windows — try resizing.

**Does the report read correctly for a company you know well?** This is the one
thing that cannot be tested automatically. If a sentence describes a company
wrongly, that is the most important bug in the project.

**Try all three kinds of company.** They behave differently on purpose:

| Try | URL | What should happen |
|---|---|---|
| A manufacturer | `/company/ASIANPAINT/consolidated/` | Everything populated |
| A bank | `/company/HDFCBANK/consolidated/` | "Financing Margin %" instead of OPM; debtor and inventory days read *not reported*; no working-capital chart |
| A loss-maker | `/company/IDEA/consolidated/` | Leverage and ROE blank, with negative book equity printed beneath |
| An NBFC | `/company/BAJFINANCE/consolidated/` | Same lending layout as the bank |
| Insurance | `/company/HDFCLIFE/consolidated/` | Standard layout, despite being a financial |

**Write a thesis note.** Type in the box, close the tab, reopen the report from
the same company. Your note should be there. Click **Save dated entry** and it
should appear in the list below with today's date.

**Print it.** Click **Print / Save as PDF**, choose "Save as PDF" as the printer.
The buttons should disappear from the printed version, your note should print in
full rather than being cut off at the box's height, and no table or chart should
break across two pages.

**Download the CSV.** Open it in Excel or Google Sheets. Check that a figure
Screener does not report comes through as an **empty cell**, not a zero.

---

## Making changes while it is loaded

Edit the files in the project folder, then:

```bash
node tools/package.js
```

Then go back to `chrome://extensions` and click the **reload** arrow on the
Screener X-Ray card. Refresh the screener.in page. Chrome does not pick up
changes on its own.

## If something looks wrong

Right-click the report page → **Inspect** → **Console**. Anything the extension
could not do logs there, prefixed `[Screener X-Ray]`.

If the report is full of blanks, check whether it is showing the breakage
notice at the top. If it is, Screener has changed its page layout — run:

```bash
npm run canary
```

which checks the live site against everything the parser expects, and names
whatever has moved.

## Removing it

`chrome://extensions` → **Remove**. That deletes the extension and every note it
stored. There is nothing left behind and nothing held anywhere else.
