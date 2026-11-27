# Printed Bill Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reprint our bills in the approved "classic, cleaned up" layout: 24 aligned line rows on page 1, a logo spot, a real signature box, phones as `(703) 522-3100`, and no printed time.

**Architecture:** This is a print-only change in the React admin app (`apps/admin-app/src/print/`), plus one small admin-only API route that serves an optional logo file from the shop root. The labor and parts columns become one table of paired rows, so a wrapped description makes both sides taller together. Pagination counts pairs: each pair weighs as much as its taller side. Nothing about money, numbers, snapshots or revisions changes.

**Tech Stack:** React 19 + Vite (admin-app), Express (api), Vitest/RTL, Jest (api), Playwright (pages-e2e), Nx.

**Spec:** `docs/superpowers/specs/2026-11-27-bill-print-design.md`. Approved look: `docs/superpowers/specs/2026-11-27-bill-print-mockup.html` (open it in a browser; its `.A` CSS has the measured values).

## Global Constraints
- Letter paper, `@page` margin 0.4in. **Two copies** per print. Every sheet starts a new paper page, as today.
- **24 one-line rows** per side must fit page 1 for a typical header (the e2e PDF test proves it). Never fewer than today's 20.
- No type under 7pt. Fonts are system fonts only (Times New Roman / Arial): no web fonts, no CDN.
- Row height is 0.2in. Rows alternate white / `#e9e9e9`, starting with the 2nd line, through the empty rows to the bottom of the line box.
- `print-color-adjust: exact` stays on `.bill-print`.
- Nothing clipped, shortened or overflowing. The full `LIABILITY` and `AUTHORIZATION` texts from `billText.ts` always print.
- **Removed from paper:** the time and the signature date line. `BillSnapshot.time` stays in the data, untouched.
- Wording stays as in `billText.ts`, except the new labels: `TEL`, `HOURS`, `Name`, `Phone`, `Year / Make / Model`, `License`, `Mechanic`, `Odometer`, `VIN`, `Page N of M`.
- No customer data in tests: use JANE DOE, (555) 010-0000, XKS-4827, invoices 9000001+.
- Run the checks from `shop-web/` with `NX_DAEMON=false`.

## Review Focus
1. **A description wrapped on only one side:** labor row 3 takes 3 lines and parts row 3 takes 1. Expect row 4 level on both sides (pair-paired tests in Task 2 and Task 3).
2. **Header values at their caps** (80-character name, 5 address lines, 80-character hours): expect the page budget to drop below 24 and the PDF to stay one paper page per sheet (Task 4 keeps the cap tests).
3. **Phone typed oddly**, like `703.522.3100`, `1-703-522-3100`, `5220` or empty: expect the first two as `(703) 522-3100` and the others printed as typed (Task 2).
4. **No logo file, or an unreadable one:** expect a blank space of the same size, no broken-image icon, and printing that doesn't wait on it (Task 1 route test, Task 3 component test).
5. **An SVG logo opened directly in a tab:** it must not run script. Serve it with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff` (Task 1).

---

### Task 1: The logo route

**Files:**
- Modify: `apps/api/src/routes/app.ts` (add the route in `appRoutes()`)
- Test: `apps/api/test/app-route.spec.ts`

**Interfaces:**
- Produces: `GET /shop-logo`. For a signed-in admin, it serves the first of `logo.png`, `logo.jpg`, `logo.jpeg`, `logo.svg` found in `config.root`, with its type, `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, plus the CSP above for SVG. It returns 404 `{error:'not found'}` when none exists, and 303 to `/admin` for anyone not an admin (same as `appPage`).

- [ ] **Step 1: Write the failing tests** in a new `describe('/shop-logo')`:
  - `'404 when the shop has no logo'`
  - `'serves logo.png to an admin as image/png'` (write 8 bytes; expect status 200, the bytes, `content-type` image/png, `x-content-type-options` nosniff)
  - `'logo.svg gets a no-script CSP'` (expect `content-security-policy` to contain `default-src 'none'`)
  - `'not signed in or a mechanic: 303 to /admin'`
  - `'png wins over svg when both exist'`
- [ ] **Step 2: Run** `npx nx test api -- app-route`. Expected: the new tests FAIL with 404 or route-not-found.
- [ ] **Step 3: Implement** `const shopLogo: RequestHandler` in `app.ts`. Read the file fresh with `readFile` (no realpath tricks needed: fixed names in `config.root`). Register it with `r.get('/shop-logo', shopLogo)`.
- [ ] **Step 4: Run** `npx nx test api -- app-route`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): /shop-logo serves the shop's optional logo to admins`

### Task 2: Phone text and paired pagination

**Files:**
- Modify: `apps/admin-app/src/print/paginate.ts`
- Create: `apps/admin-app/src/print/printPhone.ts`
- Test: `apps/admin-app/src/print/paginate.test.ts`, `apps/admin-app/src/print/printPhone.test.ts`

**Interfaces:**
- Produces:
  - `printPhone(text: string): string`. It takes the digits of `text`. With 10 digits, or 11 starting with `1` (the 1 dropped), it returns `(AAA) BBB-CCCC`. Otherwise it returns `text.trim()`.
  - `ROWS_PER_PAGE = 24`.
  - `LABOR_CPL` and `PARTS_CPL`, re-measured for the new column widths (labor description cell about 3.1in, parts description about 1.75in, 9pt Arial), with the same safety margin as today.
  - `pageBudget(title: string, header: HeaderText): number`, where `type HeaderText = { addressLine: string; contactLine: string; customer: string[]; vehicle: string[] }`. It is the same idea as today: fixed heights plus estimated wrapping of long values, with the result capped at `ROWS_PER_PAGE` and never below `MIN_ROWS`. The constants (`SHEET_IN`, `BOTTOM_IN`, head heights) are recalibrated so a typical header gives 24.
  - `paginatePairs(weights: number[], perPage: number): Slice[]`. Here `weights[i]` is `max(linesOf(labor[i]), linesOf(parts[i]))`. Same rules as today's `column()`: a pair that doesn't fit starts the next page, and a pair heavier than a page gets a page of its own. It returns at least one slice (`[[0,0]]` for an empty bill).
  - `chunks` and `linesOf` stay. `paginate`/`PageSlice` are removed once Task 3 no longer uses them (Task 3 deletes them).

- [ ] **Step 1: Write the failing tests:**
  - `printPhone('(703)522-3100') === '(703) 522-3100'`
  - `printPhone('703.522.3100') === '(703) 522-3100'`
  - `printPhone('1-703-522-3100') === '(703) 522-3100'`
  - `printPhone(' 5220 ') === '5220'`
  - `printPhone('') === ''`
  - `paginatePairs([], 24)` → `[[0,0]]`
  - 24 ones → `[[0,24]]`
  - 25 ones → `[[0,24],[24,25]]`
  - `[1,3,1]` with `perPage` 4 → `[[0,2],[2,3]]` (a wrapped pair counts its taller side)
  - `[30]` with 24 → `[[0,1]]`
  - `pageBudget` returns 24 for the typical JANE DOE header (the shop values from the spec), and a header at the caps (80-character values, 5 address lines) returns fewer than 24 but at least `MIN_ROWS`.
- [ ] **Step 2: Run** `npx nx test admin-app -- paginate printPhone`. Expected: FAIL (not defined).
- [ ] **Step 3: Implement** `printPhone.ts` and `paginatePairs`, retune the constants, and change `pageBudget` to take `HeaderText`. Delete the paginate tests for the old two-column behavior that no longer applies, keeping the `chunks`/`linesOf` tests.
- [ ] **Step 4: Run** `npx nx test admin-app -- paginate printPhone`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(print): phone spacing and paired-row pagination (24 rows a page)`

### Task 3: The new bill layout

**Files:**
- Modify: `apps/admin-app/src/print/BillPrint.tsx`, `apps/admin-app/src/print/print.css`
- Test: `apps/admin-app/src/print/BillPrint.test.tsx`

**Interfaces:**
- Consumes: `printPhone`, `paginatePairs`, `pageBudget(title, HeaderText)`, `ROWS_PER_PAGE`, `LABOR_CPL`, `PARTS_CPL`, `chunks`, `linesOf` (Task 2); `GET /shop-logo` (Task 1).
- Produces: the DOM and classes Task 4 targets:
  - `.copy` > `.sheet` (one per page)
  - `.sheet .head`: `h1.title`, `.addr`, `.contact`, `.logo`
  - `.info`: `dl` pairs
  - `.bar`: `.invoice` holding `INVOICE : <no>`, and `.page` holding `Page N of M`
  - `table.lines`: one `thead` row with both halves' headings; `tbody` rows with the cells `td.ld` (labor desc), `td.lp` (labor price), `td.pd`, `td.pq`, `td.pp`, `td.pt`; then filler rows to the bottom of the box
  - `.bottom`: `.stack` (approval box, notes, `.sig` with `.sign-x` "X" and `.sign-line`), `.fine` (LIABILITY + initial blank, AUTHORIZATION), `table.totals`
  - `p.more` "Continued on the next page" on non-last sheets

- [ ] **Step 1: Update the tests to the new paper:**
  - Header shows `JANE DOE` beside `Name`, `(555) 010-0000` beside `Phone`, `2019 CADILLAC XT5` beside `Year / Make / Model`, `XKS-4827` beside `License`, `48215` beside `Odometer`, the VIN beside `VIN`, the mechanic beside `Mechanic`.
  - The contact line contains `(703) 522-3100` when the snapshot's shop phone is `(703)522-3100`.
  - `queryByText('02:22 pm')` is null.
  - `Page 1 of 1` shows on a short bill; a long bill shows `Page 1 of 2` and `Page 2 of 2`.
  - The signature box has an `X` and no `DATE` text inside `.sig`.
  - Every `billText` paragraph appears in full (keep that test).
  - Paired rows: with labor `[A (3 lines), B]` and parts `[C, D]`, `B` and `D` are in the same `tr`.
  - The logo `img` (`src="/shop-logo"`) has `alt=""`, is hidden until its load event, and is removed on error. The print still fires once with no logo.
  - The totals rows and amounts are unchanged (keep those tests).
- [ ] **Step 2: Run** `npx nx test admin-app -- BillPrint`. Expected: FAIL on the new header, paired-row and time assertions.
- [ ] **Step 3: Implement the layout**, matching the mockup's `.A` CSS and the spec's Layout 1–6:
  - Header grid `1fr 2.4in`. The logo box is `2.4in × 0.8in`, `object-fit: contain`, with no border on paper.
  - Info box `1fr 2.1fr`, plus the vehicle's two inner columns.
  - The bar.
  - One `table.lines`, `table-layout: fixed`, with a thick rule between the halves and filler rows to the bottom of the box (the sheet is a flex column; the lines box takes `flex: 1`). Shading uses `tbody tr:nth-child(even)`.
  - Bottom grid `1.2fr 1fr 0.92fr`. The signature box takes `flex: 1` of its column: "ACCEPTANCE SIGNATURE", the terms sentence, then a bold `X` and a rule about 2.5in wide, with about 0.7in of space above it.
  - BALANCE DUE row black with white text, `white-space: nowrap`.
  - Remove `printTime` and its use. Delete the old `paginate`/`PageSlice` from `paginate.ts`.
- [ ] **Step 4: Run** `npx nx test admin-app` and `npx nx run admin-app:lint admin-app:typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(print): the redesigned bill - aligned rows, logo spot, signature box, no time`

### Task 4: Proof on paper

**Files:**
- Modify: `apps/pages-e2e/src/print.spec.ts`, `apps/pages-e2e/src/ownbills.spec.ts` (only where it reads the time or "Page 1")

- [ ] **Step 1: Update the e2e tests:**
  - `'printed to PDF: a plain 24/24 bill is exactly 2 pages (one a copy)'` (24 labor + 24 parts one-line rows → `{sheets: 2, pdf: 2, copy: 1}`).
  - `'25 pairs take a second sheet'` → `copy: 2`, and `Page 2 of 2` visible.
  - Keep the caps and unbroken-W tests (`pdf === sheets`) and the far-too-long description test. Its selector becomes `.copy >> nth=0 >> td.ld`.
  - New: `'rows stay level: a 3-line labor description beside a 1-line part'`. The bounding-box `y` of labor row 2's cell equals parts row 2's cell.
  - New: `'nothing overflows'`. On a 24/24 bill and on the caps bill, no element inside `.sheet` has `scrollWidth > clientWidth + 1` or `scrollHeight > clientHeight + 1`.
  - Keep the `print-color-adjust` and axe tests.
- [ ] **Step 2: Run** `npx nx build api admin-app` and then `npx nx e2e pages-e2e`. Expected: all pass. If the 24/24 test makes 3+ PDF pages, retune Task 2's constants or Task 3's CSS. Never lower `ROWS_PER_PAGE`.
- [ ] **Step 3: Look at it.** Start a trial server (port 18082, `SHOP_ROOT` = `C:\Users\Owner\Downloads\shop-trial`), open `/bills/<a trial bill>/print?noprint=1` in the browser pane, and screenshot it. Compare it with the mockup. **Never trigger the print dialog** (owner): use `?noprint=1`.
- [ ] **Step 4: Run the full checks:** `npx nx run-many -t test lint typecheck` and `node tools/switch-check.mjs`. Expected: green.
- [ ] **Step 5: Commit** `test(e2e): the new bill fits 24 aligned rows a page, nothing overflows`

### After the tasks (the controller does this, not a subagent)
- Merge into `main` only with the owner's yes.
- To deploy: run `npx nx build api admin-app` on `main`, then restart with `start-shop.bat`. The restart also picks up the new hours and phone in `shop-settings.json`. It drops phones for a few seconds, so ask the owner when.
- Update HANDOFF: the new bill, and the logo file-drop (`logo.png`/`.jpg`/`.svg` in the repo root, wide about 3:1).
