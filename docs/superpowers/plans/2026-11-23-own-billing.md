# Own Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin presses **Approve & print** and our app numbers, saves and prints the bill (2 copies), so nothing is typed into InvoMax.

**Architecture:**
- **Money rules** are a pure function in `@shop/domain`.
- **The API** (Express, `tickets.db`) issues the number. It stores the bill as an `invoice_finals` row with the new source `ours`, plus an immutable snapshot per revision in `own_bill_revisions`. The nightly auto-link already skips tickets that have an `invoice_finals` row.
- **The React admin app** gets a print page `/bills/<no>/print` that renders only the stored snapshot.
- **`web/admin.html`** gets the buttons.
- A setting, `ownBilling`, keeps all of it hidden until the owner's go-live day.

**Tech Stack:** Node 26 `node:sqlite`, Express 5, OpenAPI + Orval, React 19 (function components, hooks), Jest, Testing Library, Playwright. Nx (always `NX_DAEMON=false`).

**Spec:** `docs/superpowers/specs/2026-11-23-own-billing-design.md` (approved 2026-11-23). Read it before any task.

## Global Constraints
- Money is integer cents inside the domain and the database; dollars (2 decimals) in JSON, as the existing bill API.
- Supplies = min(2000, round_half_up(5% × (parts + labor))). Tax = round_half_up(6% × (parts + supplies)). Total = parts + labor + supplies + tax. Balance = total − deposits. Sublet, Haz. Disposal, Gasoline and Disc. Applied print 0.00. No discount, no tax-free option.
- A reprint, original or revised, prints exactly the snapshot it shows: same date and time as the original and no "revised" mark on paper. "Revised" shows only in the app.
- An invoice number is never issued twice and never at or below a number InvoMax or a typed final used.
- No customer data in git, tests or logs. Use JANE DOE, (555)010-0000, XKS-4827; test invoice numbers 9000001+.
- Never write in `C:\hunni` or InvoMax's folder.
- `shop.py` / `tickets.py` are not changed (the parity guard stays green). `shop.py` won't offer billing.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One implementer and two reviewers (spec/correctness, security/robustness) per task. Never push.
- Each task ends green: `NX_DAEMON=false npx nx run-many -t test lint typecheck` in `shop-web/`; tasks that touch pages also `NX_DAEMON=false npx nx e2e pages-e2e`.

## Review Focus
1. **Two Approve & print clicks at once** (two devices, or a double tap) must give one bill and one number. The second gets a 409 with the existing bill's number. *Test in Task 3.*
2. **A failure after the number is taken** (the ticket was changed on another device: Stale) leaves no bill, no used number and the ticket unfilled. *Test in Task 3.*
3. **InvoMax bills made on go-live morning**, not yet imported, must not be reused. The first-number step runs an import first and refuses a number at or below the highest seen. *Test in Task 3.*
4. **A long bill** (40 lines) prints on more pages, with the header repeated, totals only on the last page and correct "Page N". *Test in Task 5.*
5. **A fix after the ticket's customer or vehicle changed** prints the new details under the same number and date. An earlier revision's snapshot is never changed. *Test in Task 3.*

---

### Task 1: The money rules and the bill's lines (`@shop/domain`)

**Files:**
- Create: `shop-web/libs/domain/src/bill.ts`, `shop-web/libs/domain/src/bill.spec.ts`
- Modify: `shop-web/libs/domain/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `type BillAmounts = { parts: number; labor: number; supplies: number; tax: number; total: number; deposit: number; balance: number }` (cents)
  - `billAmounts(t: Pick<Ticket,'lines'|'deposits'>): BillAmounts`. It reuses `totals()` / `mulCents` / `dec` from `rules.ts` for parts, labor and deposits.
  - `type LaborRow = { desc: string; amount: number }`, `type PartRow = { desc: string; qty: number; price: number; total: number }` (money in cents)
  - `billRows(lines: Line[]): { labor: LaborRow[]; parts: PartRow[] }`. A line with `labor` gives a labor row: `Remove & Install: <desc>` when the line also has a `price`, else `<desc>`. A line with `price` gives a part row. Order follows the lines. A line with neither gives nothing.

- [ ] **Step 1: Write the failing tests** in `bill.spec.ts`. Use made-up descriptions, with the amounts of the 4 checked bills:
  - parts 322.00 + labor 195.00 → supplies 20.00 (capped), tax 20.52, total 557.52
  - parts 362.00 + labor 586.00 → supplies 20.00, tax 22.92, total 990.92
  - parts 147.93 (6 × 12.99 + 19.99 + 50.00) + labor 135.00 → supplies 14.15 (14.1465 rounds up), tax 9.72, total 306.80
  - parts 219.00 + labor 345.00 → supplies 20.00, tax 14.34, total 598.34
  - a deposit of 100.00 on the last one → deposit 100.00, balance 498.34
  - no lines → every amount 0
  - `billRows`: a part+labor line gives `Remove & Install: BRAKE PADS`; a labor-only `DIAGNOSTIC` gives `DIAGNOSTIC`; a part-only line gives no labor row; qty 6 × 12.99 gives a part total of 77.94.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx test domain`. Expect FAIL (no `bill.ts`).
- [ ] **Step 3:** Implement `bill.ts` with the rounding written in bigint cents: half-up as `(x * 5n + 50n) / 100n` for 5%, the same pattern for 6%.
- [ ] **Step 4:** Run `NX_DAEMON=false npx nx test domain`. Expect PASS.
- [ ] **Step 5:** Commit `feat(domain): bill amounts and rows for our own bills`.

### Task 2: Settings: `ownBilling` and the shop's details

**Files:**
- Modify: `shop-web/apps/api/src/config.ts`, `shop-web/apps/api/src/routes/upkeep.ts`, `shop-web/apps/api/openapi.yaml` (upkeep status schema)
- Test: `shop-web/apps/api/test/config.spec.ts` (create), `shop-web/apps/api/test/upkeep` cases in the existing upkeep tests

**Interfaces:**
- Produces:
  - `Config.ownBilling: boolean` (default `false`)
  - `Config.shopInfo: { name: string; address: string[]; phone: string; hours: string }`. The default is all empty strings and `address: []`. In `shop-settings.json` it's the key `"shop"`. A wrong shape gives the defaults and the one existing warning.
  - `GET /api/upkeep/status` gains `ownBilling: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `{"ownBilling": true, "shop": {"name":"TEST SHOP","address":["1 MAIN ST","ANYTOWN, VA 00000"],"phone":"(555)010-0001","hours":"M-F 8-5"}}` loads as given.
  - A missing file gives `ownBilling` false and the empty shop.
  - `"ownBilling": "yes"` gives the defaults plus the warning.
  - The upkeep status reports `ownBilling`.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx test api --testPathPattern "config|upkeep"`. Expect FAIL.
- [ ] **Step 3:** Extend `settings()` / `loadConfig()` and the upkeep route and its contract.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): ownBilling and shop settings`.

### Task 3: Our bills in the API: number, approve, fix, read

**Files:**
- Create: `shop-web/apps/api/src/billing/ownbills.ts`, `shop-web/apps/api/src/routes/ownbills.ts`, `shop-web/apps/api/test/ownbills.spec.ts`
- Modify:
  - `shop-web/apps/api/src/history/links.ts`: widen the `source` CHECK to `'invomax','typed','none','ours'`, migrating an existing table by rebuilding it in one transaction when its stored SQL lacks `'ours'`.
  - `shop-web/libs/domain/src/rules.ts`: `edit()` gains the option `{ billFix: true }`, which lets the desk edit a filled ticket.
  - `shop-web/apps/api/src/app.ts` (mount), `shop-web/apps/api/openapi.yaml`, then regenerate `libs/api-client` (Orval)

**Interfaces:**
- Consumes: `billAmounts`, `billRows` (Task 1); `Config.ownBilling`, `Config.shopInfo` (Task 2); the existing import (`/api/upkeep/import`'s function, called directly).
- Produces:
  - New table `own_bill_revisions (invoice_no TEXT, revision INTEGER, snapshot TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, PRIMARY KEY (invoice_no, revision))`. Rows are only ever inserted.
  - New table `own_bill_counter (id INTEGER PRIMARY KEY CHECK (id = 1), next_no INTEGER NOT NULL, confirmed_at TEXT NOT NULL, confirmed_by TEXT NOT NULL)`.
  - `type BillSnapshot = { invoice_no: string; revision: number; date: string /*YYYY-MM-DD*/; time: string /*HH:MM, 24h*/; customer: { first: string; last: string; phone: string }; vehicle: { year: string; make: string; model: string; plate: string; vin: string; odometer: string }; mechanic: string; labor: LaborRow[]; parts: PartRow[]; amounts: BillAmounts; shop: Config['shopInfo'] }`. In the JSON replies, money is in dollars.
  - `class OwnBills` (in `ownbills.ts`):
    - `firstNumber(): { confirmed: boolean; proposed: string }`
    - `confirmFirst(no: string, by: string): void`
    - `approve(ticketId: number, version: number, by: string, now: Date): BillSnapshot`
    - `fix(no: string, fields: Record<string, unknown>, version: number, by: string, now: Date): BillSnapshot`
    - `latest(no: string): { bill: BillSnapshot; revisions: { revision: number; at: string; by: string }[]; ticket_id: number } | null`
  - **Highest used number**:
    - InvoMax's numbers that are exactly 7 digits, from bills dated within the last 400 days;
    - every `invoice_finals.invoice_no` that is all digits (typed and ours);
    - the counter.

    The proposed first number is that + 1.
  - Routes, all `signedIn('admin')`, all 404 while `ownBilling` is off:
    - `GET /api/own-bills/first-number` → `{confirmed, proposed}`
    - `POST /api/own-bills/first-number` `{invoice_no}` → 204. It runs the InvoMax import first (when `importInvomax`) and recomputes. It answers 400 when the number is at or below the highest used, and 409 once already confirmed.
    - `POST /api/tickets/:id/bill` `{version}` → 201 `BillSnapshot`. It answers 409 `{invoice_no}` when the ticket already has a bill, 409 Stale as the ticket routes do, 400 when there's no mechanic or no line, and 428 when the first number isn't confirmed.
    - `GET /api/own-bills/:no` → `latest()`
    - `POST /api/own-bills/:no/fix` `{version, fields}` → 200 `BillSnapshot` (the new revision; same number; `date` and `time` kept from revision 1).

- [ ] **Step 1: Write the failing tests** in `ownbills.spec.ts`, on a temp root with made-up tickets and a small `invomax.db` holding 7-digit numbers 9000001–9000005 and one 8-digit 48888884:
  - `firstNumber().proposed === '9000006'` (the 8-digit one is ignored).
  - `confirmFirst('9000005')` throws; `confirmFirst('9000010')` works; a second confirm gives 409.
  - `approve` → invoice `9000010`, ticket `filled`, the `invoice_finals` row with source `ours` and cents, revision 1 stored, and the amounts equal to `billAmounts`.
  - The next approve → `9000011`.
  - **Two approves of the same ticket**, the second with the old version → one bill; the second gets 409 with `9000010`.
  - **A Stale ticket version** → no `invoice_finals` row, no revision, and the next approve still gets `9000010` (the number isn't used up).
  - **A typed final with number 9000020** after the confirm → the next number is `9000021`.
  - `fix('9000010', {first:'JOHN'}, v, …)` → revision 2: `first` is JOHN; `date` and `time` equal revision 1's; revision 1's stored snapshot is unchanged; `invoice_finals` amounts updated.
  - `autoLink` doesn't touch a ticket billed by us.
  - Routes: 404 with `ownBilling` off; 403 for a mechanic; 428 before the confirm; 400 without a mechanic.
  - The CHECK migration: an old-shape `invoice_finals` with a `typed` row keeps that row and accepts `ours`.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx test api --testPathPattern "ownbills|links"`. Expect FAIL.
- [ ] **Step 3:** Implement `OwnBills`. `approve` and `fix` each do all their work inside one `BEGIN IMMEDIATE` on the tickets.db connection, in this order:
  1. read the ticket and check the version;
  2. take the number;
  3. save the ticket;
  4. insert the `invoice_finals` row and the revision;
  5. move the counter.

  Nothing is written outside that transaction. `TicketStore.save` opens its own transaction, so give it an in-transaction variant (e.g. `saveTx`) rather than nesting. Snapshot `time` is local `HH:MM` from `now`.
- [ ] **Step 4:** Implement the routes and the contract, then run `NX_DAEMON=false npx nx run api-client:generate`.
- [ ] **Step 5:** Run `NX_DAEMON=false npx nx run-many -t test lint typecheck`. Expect PASS; the parity guard is unchanged.
- [ ] **Step 6:** Commit `feat(api): our own bills: first number, approve, fix`.

### Task 4: Bill history shows our bills

**Files:**
- Modify: `shop-web/apps/api/src/history/bills.ts`, `shop-web/apps/api/src/routes/bills.ts`, `shop-web/apps/api/openapi.yaml`, `shop-web/apps/admin-app/src/bills/BillHistory.tsx`, `shop-web/apps/admin-app/src/bills/BillDetail.tsx`
- Test: `shop-web/apps/api/test/bills.spec.ts`, `shop-web/apps/admin-app/src/bills/BillDetail.test.tsx`, `BillHistory.test.tsx`

**Interfaces:**
- Consumes: `OwnBills.latest()` (Task 3).
- Produces:
  - `Bill.after.source` gains `'ours'`. `Bill.after.lines` for ours are built from the snapshot.
  - New field `Bill.own: { invoice_no: string; revisions: number; revised_at: string | null; revised_by: string | null } | null`.
  - The row search finds our bills by tag, name, phone, VIN and date, like the others.

- [ ] **Step 1: Write the failing tests.**
  - API: a billed ticket's row has `invoice_no` 9000010 and the total. Its detail has `after.source === 'ours'` and `own.revisions === 1`; after a fix, `own.revisions === 2` with `revised_at` set.
  - React: `BillDetail` shows a "Revised <date> by <who>" note only when `revisions > 1`. It shows **Reprint** (a link to `/bills/9000010/print`) and **Fix bill** (a link to `/admin#fix=9000010`) for ours only.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx test api --testPathPattern bills` and `NX_DAEMON=false npx nx test admin-app`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same commands. Expect PASS.
- [ ] **Step 5:** Commit `feat(bills): our bills in Bill history, with Reprint and Fix bill`.

### Task 5: The print page

**Files:**
- Create:
  - `shop-web/apps/admin-app/src/print/BillPrint.tsx`
  - `shop-web/apps/admin-app/src/print/billText.ts` (the fixed wording, copied exactly from the spec's "fixed wording" list)
  - `shop-web/apps/admin-app/src/print/paginate.ts`
  - `shop-web/apps/admin-app/src/print/print.css`
  - tests `BillPrint.test.tsx`, `paginate.test.ts`
- Modify:
  - `shop-web/apps/admin-app/src/App.tsx`: the route `/bills/<no>/print` renders `BillPrint` **without** the app header (a bare page).
  - `shop-web/apps/api/src/routes/app.ts`: `APP_PAGES` also matches `/^\/bills\/\d{1,7}\/print$/`.
  - `shop-web/apps/api/test/app-route.spec.ts`

**Interfaces:**
- Consumes: `GET /api/own-bills/:no` through the Orval hook (Task 3).
- Produces: `paginate(labor: number, parts: number, perPage: number): { labor: [number, number]; parts: [number, number] }[]` returns each page's slice of rows. The first and middle pages hold `perPage` rows per column. Totals go on the last page only.

**Layout:**
- Follow the spec's sketch and "Look":
  - letter size, `@page { size: letter; margin: 0.4in }`;
  - the bill printed twice, as two copies with `break-before: page` between them;
  - each copy is 1+ pages.
- Every field in the spec's header, line and totals lists must be present. **Information over pixel-matching** (owner, 2026-11-23).
- The page calls `window.print()` once, after the data has loaded, unless `?noprint=1`.

- [ ] **Step 1: Write the failing tests.**
  - `paginate(3, 2, 22)` → one page; `paginate(40, 5, 22)` → two pages, the second holding labor rows 22–39.
  - `BillPrint` with a made-up snapshot shows:
    - `INVOICE : 9000010`, `JANE DOE`, `(555)010-0000`, `XKS-4827`, `MLG in/out 123456 / 123456`;
    - `Remove & Install: BRAKE PADS`;
    - SHOP SUPPLY `20.00`, Sales Tax, TOTAL, Deposit, BALANCE DUE;
    - `Disc. Applied 0.00`, `HAZ. DISPOSAL 0.00`, `Gasoline 0.00`, `Sublet 0.00`;
    - each `billText` paragraph;
    - exactly 2 copies;
    - no "revised" text even for a revision-2 snapshot;
    - "Page 1" and "Page 2" for 40 labor lines.
  - The route: `/bills/9000010/print` serves the app to an admin; `/bills/abc/print` gives 404.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx test admin-app` and `NX_DAEMON=false npx nx test api --testPathPattern app-route`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same commands. Expect PASS. Run axe in the component test as the other pages do.
- [ ] **Step 5:** Commit `feat(admin-app): print page for our bills (2 copies, letter)`.

### Task 6: Buttons on the admin page, and the whole flow end to end

**Files:**
- Modify: `web/admin.html`
- Create: `shop-web/apps/pages-e2e/src/ownbills.spec.ts`

**Interfaces:**
- Consumes: the upkeep `ownBilling` flag (Task 2) and all the Task 3 routes. The print page is opened at `/bills/<no>/print`.

**Behavior (only when `ownBilling` is true; otherwise the page is exactly as today):**
- **Approve & print** replaces Send to InvoMax on a ticket's invoice screen.
  1. It saves the ticket first, as Save ticket does.
  2. If the first number isn't confirmed, it shows "Checking InvoMax…" while it fetches `GET /api/own-bills/first-number` (after the import). Then it asks "First invoice number: N. Use it?", with a box that allows a higher number. Confirming posts it.
  3. It posts `/api/tickets/:id/bill`. On 201 it opens `/bills/<no>/print` in a new tab. On 409 with `invoice_no` it says "Already billed as #N" and offers Reprint.
- **Fix bill:** `/admin#fix=<no>` opens that bill's ticket in the invoice screen, editable, with **Save & reprint** in place of the other buttons. That posts `/api/own-bills/:no/fix` and opens the print page.
- Filled tickets that have our bill show **Reprint** and **Fix bill**.

- [ ] **Step 1: Write the failing e2e** `ownbills.spec.ts`, on a temp root with `ownBilling: true`, made-up shop details and an `invomax.db` holding 9000001–9000005. As admin:
  1. Create JANE DOE (one part line, one labor line, mechanic set).
  2. Approve & print: confirm the first number 9000006.
  3. The new tab's URL is `/bills/9000006/print?…`. Assert the page holds `INVOICE : 9000006` and the TOTAL.
  4. The ticket is filled.
  5. Fix bill: change the labor to 60.00. Save & reprint gives the same number and the new total.
  6. Bill history shows "Revised".

  Also: with `ownBilling` false, no Approve & print button shows. Stub `window.print` in the test.
- [ ] **Step 2:** Run `NX_DAEMON=false npx nx e2e pages-e2e`. Expect FAIL.
- [ ] **Step 3:** Implement in `admin.html`, using the existing `el()` / `$()` helpers, state `S` and upkeep loading.
- [ ] **Step 4:** Run `NX_DAEMON=false npx nx e2e pages-e2e` and `node tools/switch-check.mjs`. Expect all pass and `ready`.
- [ ] **Step 5:** Commit `feat(admin): Approve & print, Fix bill and Reprint`.

### Task 7: Trial and handoff (the controller does this, not a subagent)
- [ ] Rebuild the api and admin-app in the worktree.
- [ ] Add `"ownBilling": true` and the shop details from the photos to the trial's `shop-settings.json` (git-ignored, outside the repo).
- [ ] Restart the trial server.
- [ ] Run one made-up bill through it.
- [ ] Update HANDOFF:
  - what was built;
  - how to try it on the trial copy;
  - the go-live steps (switch first; then `"ownBilling": true` and the `shop` details in the live `shop-settings.json`; confirm the first number; stop using InvoMax for new bills).
- [ ] Ask the owner before merging into `main`.
