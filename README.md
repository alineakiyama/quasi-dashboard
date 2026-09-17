# Quasi — Support Dashboard

https://alineakiyama.github.io/quasi-dashboard/ (login required)

Only real data:

- **Reports** — live from the Commslayer API, the same numbers as the Commslayer portal.
- **Refunds, Subscriptions, Reshipments, Supplier issues, Order lookup, Data check** — from the
  "Quasi — Master Tracking Spreadsheet", synced by `tools/apps-script/QuasiPortal.gs`.

## How it fits together

- Static site (GitHub Pages, no build step): `index.html`, `assets/`.
- Supabase: login, `reports` function (Commslayer cache), `sheets-sync` function (receives the
  spreadsheet), tables and report functions in `supabase/migrations/`.
- Apps Script in the spreadsheet: sends a tab about 1 minute after an edit and every tab every
  30 minutes; stamps today's date in the new `Date` column when a row gets its order number or email.

## Rules applied to the spreadsheet data

- Refunds: each row is one refund. Refund dates typed with day and month swapped are corrected
  and listed in Data check.
- Subscriptions, reshipments, supplier issues: the newest row (lowest in the sheet) wins for the
  same email or order.
- Rows from before Sep 17, 2026 had no date. They are spread evenly from Jul 8 to Sep 16, 2026 in
  sheet order and marked as **estimated** on screen; the spreadsheet is not changed.

## Publish

```
powershell -ExecutionPolicy Bypass -File publicar.ps1 "what changed"
```
