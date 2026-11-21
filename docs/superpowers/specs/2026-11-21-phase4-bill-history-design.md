# Phase 4: bill history from InvoMax's data, our own backups, and suggested prices — design

**Date:** 2026-11-21. **Status:** approved by the owner 2026-11-21.
**Replaces:** the "Customer history (phase 4)" section of `specs/2026-11-18-typescript-shop-server-design.md` wherever the two disagree (the on-screen final-bill read, "observe and record only", supplies "a multiple of $20"). The backups part of that section stands, with the additions below.
**Evidence:** the spike written up in `HANDOFF.md` → "InvoMax backup spike (2026-11-21)"; throwaway decoder `probe/ibk-spike/tools/inv.py` (git-ignored, reference only).

## 1. Why

- **InvoMax is getting more expensive** and the owner will replace it with our own web app. InvoMax stays paid for **one or two more months at most** (from 2026-11-21).
- Until then (and as a fallback if the replacement takes long) the shop still bills in InvoMax, so our side needs InvoMax's **final bills**: what was really charged, with supplies, tax and invoice number.
- **Past bills live only in InvoMax.** Moving them out is part of replacing it, and they are the shop's customer history.
- The owner wants the new app to **suggest prices from the shop's own history** for each job on each kind of vehicle, with the admin free to change them.
- The owner's career goal: this is built in the job stack (TypeScript, Express, React, Nx), as the rest of the TS server.

## 2. What we learned (spike, owner-checked)

- InvoMax keeps its data in Btrieve files in `C:\hunni\files\` (`INVOICE.btv` bills, `DETAIL.btv` lines, `CUSTOMERw.btv` customers). Its backup (`IVBACK.IBK`) is a plain ZIP of them.
- **The live files can be copied while InvoMax runs** (opened read-only, sharing read/write); the copy decoded the same as the day's backup.
- `INVOICE.btv`: 1536-byte pages; records run-length compressed (u16 literal count + bytes, u16 repeat count + byte), each unpacking to **498 bytes**. Money is Turbo Pascal 6-byte `Real48`. Offsets: invoice no. (shortstring) @5, date `MMDDYYYY` @23, last-name/key @14, total @136, balance due @142, tax @172, discount @204, labor @272, tax rate @372, deposit @409, parts @415, supplies @445. Invoice numbers are 6 digits before ~2024 and 7 digits since (`8003161`).
- **The owner checked three decoded bills against InvoMax's screen: all match** (including discount 10.00, deposit 250.00 and balance 181.25 on #8003056).
- `DETAIL.btv` (1024-byte pages) holds one record per line: invoice no., code, vehicle text (`2019 Honda HR-V EX`), kind (`M` part / `L` labor), quantity, price, description. Its full layout is not mapped yet.
- The spike decoder is incomplete: it finds ~30,000 bills (back to 1999), roughly two thirds of the file; records split across pages are missed.
- **The shop's rules**, from 6,884 bills of 2022–2026 (owner confirmed the supplies rule):
  - supplies = 5% of (parts + labor − discount), at most $20;
  - tax = 6% of (parts + supplies); labor is not taxed;
  - total = parts + labor + supplies + tax; deposits only lower the balance due.
  - ~2% of bills break a rule unexplained (tax-exempt? hand changes? unmapped fields). Not needed here; the replacement project looks at them.
- InvoMax line codes are messy: 757 different codes on 17,777 recent lines, 354 used once; **~48% of lines are a generic `LABOR` or `INSTALL-`**, with the job only in the description. Only 18 of our 47 `parts.csv` codes appear, on 6% of lines.

## 3. Goals

1. **Import InvoMax's bills and lines** into our own database: all history once, then new bills every night at 2:00 and on demand.
2. **Link each filled ticket to its InvoMax bill** (before = our ticket, after = InvoMax's bill), automatically where sure, with the admin confirming the rest.
3. **Bill history** in the admin, as specified before (search by tag, name, phone, VIN, dates; before/after detail), now including every InvoMax bill and its lines, back to 1999.
4. **Our own backups** (nightly, kept, restorable, copyable to the USB drive), now also covering the imported history.
5. **Suggested prices** on the admin's invoice entry: picking a job on a line fills its part and labor prices from what the shop charged for that job on similar vehicles; the admin can change them.
6. **A job mapping** from InvoMax's codes and descriptions to our job list, made mostly automatically and reviewed by the owner.

## 4. Non-goals

- No change to how staff use InvoMax, and **no on-screen reading of InvoMax** (the `shopwin.py` final-bill read and the watch-window mapping session are dropped). "Mark filled" in `shopwin.py` stays as it is.
- No writing to InvoMax's files or folder, ever.
- The web app still **does not compute tax or supplies** on our tickets in this phase; the rules above are recorded for the replacement project.
- No InvoMax replacement screens (final bill, printing, invoice numbers) — that's its own project.
- No suggestions on the mechanic's phone (`/tech`); the admin prices the invoice (owner, 2026-11-16).
- No cloud, ever (owner, 2026-11-18).
- The remote fill and print project is not started; it likely goes away with InvoMax.

## 5. Anti-goals (would be a failure even if it works)

- Anything that could change, lock or corrupt InvoMax's data, or slow InvoMax down during the day.
- Customer data in git (tests, fixtures, logs committed) or leaving the PC except to the owner's USB drive.
- A suggested price silently overwriting a price the admin typed.
- A wrong automatic bill-to-ticket link that nobody can see or undo.

## 6. Constraints

- Runs in the **TypeScript server only** (`shop-web/apps/api`). The owner's switch from `shop.py` to the TS server must happen before this goes live (it's on the owner's list; checklist in `HANDOFF.md`).
- Same single shop PC (Windows 10, one disk, C: has ~72 GB free), same `tickets.db`, the shared-schema rule with Python (`tickets.py` must not wipe new tables: new data goes in new tables).
- **Timing:** the import must be working within about **four weeks**, so the line decoding and the job mapping can be checked against InvoMax's screen while it's still paid for.
- Two reviewers per task (spec/correctness and security/robustness), one writer at a time; push only when the owner says so.
- Test data must be **synthetic**: Btrieve test files are generated by a test helper, never cut from the real files.

## 7. Approaches considered

**Getting InvoMax's final bills** (owner chose A, 2026-11-21):
- **A. Automatic copy of InvoMax's live tables, nightly and on demand** — chosen. No one has to remember anything; proven by the spike. Risk: a copy taken mid-write; handled by checking and retrying (8.1).
- B. Read the backup staff make at closing from the USB drive. InvoMax's own consistent copy, but depends on someone clicking every day.
- C. Staff type the finals at "Mark filled". Simple, error-prone, no history. Kept only as the admin's correction path.
- (Dropped earlier:) reading InvoMax's final-bill screen. The totals bar is drawn, likely unreadable, and never mapped.

**Job codes for suggestions** (owner chose "keep ours, map", 2026-11-21):
- **Keep our `parts.csv` job list and map InvoMax's history onto it** — chosen. One clean code per job, each pairing a part and a labor price; labor lines map by description. Costs a one-time mapping the owner reviews (top 100 InvoMax codes cover 92% of lines).
- Adopt InvoMax's codes. No mapping, but half the lines are a bare `LABOR`, so labor (the most useful suggestion) would mostly get none, and 757 messy codes would move into the new app.

**Order of work** (my call): two stages in one plan. **4a** import + linking + Bill history + backups (it's what the time limit is about); **4b** job mapping + suggested prices (needs 4a's lines).

## 8. Design

### 8.1 InvoMax import (4a)

- **Reader library** `libs/invomax` (TypeScript, no native modules): Btrieve page walker (page size from the file header), the record decompressor, `Real48`, shortstrings, and typed record layouts for `INVOICE` (offsets above) and `DETAIL` (to be mapped by the builder the same way: decode, find fields, confirm with the owner on screen). It must find **every** record: walk the file's own structures (data pages and continuation/variable pages) rather than the spike's pattern search, and **the decoded count must equal the record count in the file header**; a mismatch fails the import loudly.
- **Copy step:** open `C:\hunni\files\{INVOICE,DETAIL}.btv` (and `CUSTOMERw.btv` if 8.1's VIN question needs it) read-only with read/write sharing, copy to `invomax-import/` (git-ignored, next to `tickets.db`), then decode the copy. If decoding fails or the count doesn't match the header, wait 1 minute and retry, up to 3 times; then log and show the failure on the admin page. Keep only the last good copy. The InvoMax folder path is a config value.
- **Store:** a separate SQLite file **`invomax.db`** (git-ignored), not `tickets.db`: it is large (tens of MB), and while InvoMax runs it can be rebuilt from InvoMax. Tables: `im_invoices` (invoice_no PK, date, name/key, phone digits, plate, address, parts, labor, supplies, discount, deposit, tax, tax_rate, total, balance, raw record hash), `im_lines` (invoice_no, line no., code, description, kind part/labor/other, qty, unit price, amount, vehicle text, parsed year/make/model), `im_imports` (when, counts, result). Each import is an upsert by invoice_no (InvoMax may edit a bill after printing; the newest wins; a changed bill is logged).
- **A command first (my call):** the reader and import ship first as a standalone command, `node main.js import-invomax` (like `admin <name>`), which writes `invomax.db` with nothing else live. That lets the `DETAIL` check and the first-import spot-check (section 10) happen on schedule **even if the switch to the TS server slips**. The schedule and the button below come after, in the server.
- **Schedule:** nightly at 2:00, right after our own backup; plus a **"Check InvoMax now"** admin button. Only one import runs at a time. The first run imports all history (minutes, not hours; done at night or on the button).
- **Catch-up on start (my call):** the shop PC may be off or signed out at 2:00 (the Startup shortcut runs at sign-in, not power-on). So when the server starts, and every hour after, it runs the backup and the import if the last good one is over 24 hours old. Plain timers, like the purge.
- **Customer and vehicle keys:** phone digits (as before); plate normalised (upper case, no spaces or dashes); vehicle text parsed into year/make/model with `vehicles.json`'s lists; trim kept as text. VIN: the builder finds whether InvoMax stores it (likely `CUSTOMERw.btv` or the vehicle table); if it does, import it; if not, VIN search covers our tickets only, and that's stated in the UI.

### 8.2 Linking tickets to InvoMax bills (4a)

- `invoice_finals` (in `tickets.db`, as the old spec) becomes the link: `ticket_id`, `invoice_no`, `linked_at`, `linked_by` (`auto` or the admin's user id), `source` (`invomax` or `typed`), plus the typed numbers when `source = typed`.
- **Automatic link** when exactly one InvoMax bill has the same normalised plate and a date from the ticket's filled date −1 to +3 days, and no other ticket already claims it. Otherwise the ticket goes to a **"Needs a bill"** list on the admin page with the likely candidates (same plate, or same phone, nearby dates, closest total first); the admin picks one, or "none". Links can be undone.
- Totals are not required to match (prices change in InvoMax), but a difference between our subtotal and InvoMax's parts + labor is shown on the bill.
- Tickets filled before this phase are linked the same way on the first import.
- `POST /api/invoices/:id/final` stays as the admin's typed correction for a bill InvoMax doesn't have.

### 8.3 Bill history (4a)

- As in the old spec (filters tag, name, phone, VIN, from/to; newest first, paged; `GET /api/invoices`, `GET /api/invoices/:id`, `GET /api/customers/:phone`; admin only; OpenAPI), now over **every InvoMax bill** plus our filled tickets. A bill shows before (our ticket, if linked) and after (InvoMax's numbers and lines). An InvoMax bill with no ticket shows after only; a filled ticket with no bill shows "no InvoMax bill yet".
- First React page, **Bill history** (React 19, function components and hooks, Orval/TanStack Query, Testing Library + Playwright + axe), as phase 5 planned.
- Must stay fast over ~50,000 bills and ~250,000 lines (indexes on date, plate, phone digits, name).

### 8.4 Backups (4a)

- As in the old spec (nightly 2:00 online backup of `tickets.db` into `backups/`, keep 90; `restore <file>`; `copy-backups <drive>` and its admin button; config `targets`; "Last backup" line, red after 2 days; "No copy off this PC yet" note). The USB drive now exists (D:, 32 GB).
- **`invomax.db` is backed up too**, but kept fewer: the last 14 nightly copies plus the first copy of each month for 24 months (it's tens of MB). Once InvoMax is gone it's the only copy of the history, so this matters more later, not less.
- The InvoMax copy in `invomax-import/` is not a backup and is not kept.

### 8.5 Job mapping (4b)

- Our job list stays `parts.csv` (code, description, aliases, sided, part_price, labor_price). The owner may add jobs the history shows we lack (e.g. coolant flush, cabin filter); adding one is editing `parts.csv`, as today.
- **Mapping rules**, stored in `tickets.db` (new table `job_map`; it's the owner's work, so it's backed up nightly): match on InvoMax code, and for generic codes (`LABOR`, `INSTALL-`, etc.) on words in the description, → our code, or "ignore" (notes, deposits, sublet).
- An automatic first pass proposes rules from code and description words against our codes, descriptions and aliases.
- **"Job mapping" admin page:** InvoMax code/description groups not yet mapped, biggest first (line count), each with the proposed job, a few sample descriptions, and Accept / Change / Ignore. It shows how much of the history is mapped (lines and dollars). Target: the top groups covering ~90% of lines, about an hour of the owner's time.
- A line's job is recomputed whenever rules change (it's a view over `im_lines` + `job_map`, not stored per line).

### 8.6 Suggested prices (4b)

- **Samples:** every mapped InvoMax line (unit price, part or labor, vehicle, date), plus lines of our own filled tickets **not** linked to an InvoMax bill (so nothing counts twice; once InvoMax is gone, our tickets are the source).
- **Choosing the price**, for a job and a vehicle (year, make, model from the ticket):
  1. same make + model, year within ±2;
  2. same make + model, any year;
  3. same make;
  4. all vehicles.
  Take the first level with at least **3 samples in the last 24 months** (if none, the same levels over all time). Suggest the **median**; also give the count, the middle-half range and the level used. Part and labor are chosen separately. No history → `parts.csv`'s price, labelled as such.
- **Quantity (my call):** every sample is reduced to a **per-unit price** (line amount ÷ quantity, quantity < 1 or missing counted as 1). Our admin line multiplies only the part price by quantity and keeps labor as one amount per line, so the **part box gets the per-unit price** and the **labor box gets per-unit labor × the line's quantity** (four tires, both sides of a sided job).
- **Discounts (my call):** prices are taken **before** the bill's discount. InvoMax records a discount for the whole bill, not per line, and the admin applies discounts separately.
- **API:** `GET /api/price-suggestions?code=&year=&make=&model=&qty=` (qty defaults to 1) → `{part, labor}`, each `{price, count, low, high, basis}` or null; `labor.price` already multiplied by qty. Admin only, OpenAPI.
- **Admin invoice entry** (`/admin` New ticket and ticket edit): when a line's job is picked (the existing `parts.csv` hints), its empty part and labor price boxes fill with the suggestions, with a small grey line under them, e.g. `from 14 jobs · 2017–2021 Honda HR-V · last 2 yrs: $45–$55`. **The admin can type any price**; a price the admin typed or changed is never overwritten. If the vehicle changes after prices were filled, nothing changes by itself; an "Update suggested prices" link appears on lines still holding an untouched suggestion.
- The page stays on the current `admin.html` until phase 5 moves it to React.

## 9. Left to the builder

- `DETAIL.btv`'s full layout, the Btrieve page/record structures needed for complete decoding, and where (if anywhere) InvoMax keeps VINs.
- The synthetic Btrieve fixture generator.
- Exact schemas, indexes, paging size, config names, and the matching of InvoMax's vehicle text to `vehicles.json`.
- How the first full import reports progress.
- The first-pass mapping heuristics.

## 10. Owner checks along the way

- After the `DETAIL` layout is decoded: compare 2–3 bills' lines with InvoMax's screen (as done for totals).
- After the first full import: the decoded count matches the file header, and spot-check a few old bills (2000s) on InvoMax's screen.
- The job mapping review (8.5).
- A few suggested prices on real recent jobs: do they look right to the owner?
