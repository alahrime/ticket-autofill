# Handoff — ticket-autofill

**Updated:** 2026-11-23. **Resume here: "Own billing — where it stands" just below.** This PC (Windows 10, user `Owner`) **is the shop PC**: InvoMax runs here with real customers. Live today: still `shop.py`; the switch to the TS server (checklist step 5) is the owner's call. Older notes follow further down.

## Own billing — where it stands (2026-11-23, for the next agent)
- **Branch `own-billing`** (pushed to GitHub; not merged into `main`). Worktree on this PC: `.claude/worktrees/own-billing`. Plan Tasks 1–6 are built, each reviewed by two reviewers and fixed (commits d68368a..cb58c23, then the final-review fixes below).
- **Final whole-branch review:** "ready with fixes". 0 Critical, 4 Important. Full report: `docs/superpowers/reviews/2026-11-23-own-billing-final-review.md`. Every ruling and deferred minor from the build, in order: `docs/superpowers/reviews/2026-11-23-own-billing-ledger.md`.
- **Final-review fixes: done, pushed** (fc36447, 815c732, e9bf09c on `own-billing`). Covered:
  - **I1:** a typed final at or above our counter is refused once the first number is confirmed (409). InvoMax numbers more than 10000 above the median of the last 400 days are ignored; on the trial data nothing is excluded and the proposed first number is the highest InvoMax number + 1. The first-number dialog names where the highest number came from.
  - **I2:** Bill history lists earlier revisions, and each one can be viewed or printed (`?rev=N`).
  - **I3:** a ticket with our bill can't be deleted.
  - **I4:** our bill's date in history is the bill day.
  - Also: the stray "null" text is gone, and the grey bands print.
  - Green: run-many test/lint/typecheck, pages-e2e and switch-check.
  - **Not done:** the scoped re-review of these 3 commits. Do it before merging. The api tests were seen red first; the admin-app/e2e tests were not.
  - Known gap: typed finals entered before go-live still raise the proposed first number. The admin can type a higher number but not a lower one.
- **Then (plan Task 7):**
  - Rebuild api and admin-app in the worktree.
  - Add `"ownBilling": true` and `"shop": {name, address[], phone, hours}` to `C:UsersOwnerDownloadsshop-trialshop-settings.json`. The values: JAPANESE AUTO SERVICE; 3413 WILSON BLVD / ARLINGTON, VA 22201; (703)522-3100; M-F 8.00 AM TO 7.00.
  - Restart the trial server from the own-billing worktree: `$env:SHOP_ROOT='C:UsersOwnerDownloadsshop-trial'; $env:SHOP_PORT='18082'; node appsapidistmain.js` from `shop-web`.
  - Run one made-up bill through it.
  - Write the go-live steps here: switch first; set `ownBilling` and `shop` in the live settings; confirm the first number; stop using InvoMax for new bills.
- **Tell the owner:**
  - The print page adds "Continued on the next page", which isn't InvoMax wording.
  - Sub Total = parts + labor + supplies; confirm it against a real bill.
  - The rest of the minors are in the review report.
- **Checks green at cb58c23:** `NX_DAEMON=false npx nx run-many -t test lint typecheck`, `NX_DAEMON=false npx nx e2e pages-e2e` (61 tests) and `node tools/switch-check.mjs`, all from `shop-web/`. One api test failure was seen once, in an overlapping run, and not reproduced. The reviewer blames the older free-port probes in `backup.spec.ts` and `http-core.spec.ts`.
- **Merging into `main`:** only on the owner's yes.
- **Standing rules:**
  - Never write in `C:hunni`.
  - No customer data in git, tests or logs. Use JANE DOE, (555)010-0000, XKS-4827 and invoices 9000001+.
  - `shop.py` and `tickets.py` stay unchanged.
  - No cloud and no CDN.
  - Push only when the owner says so.

## Own billing (2026-11-23): our app prints the bill, InvoMax is retired for new bills
- **Owner's decision:** no more typing into InvoMax, not even by tool. The phone-entered ticket goes straight onto our own printed bill. So the InvoMax auto-fill ("TODO: typing into InvoMax" below) is **dropped**.
- **Design approved:** `docs/superpowers/specs/2026-11-23-own-billing-design.md`.
  - Supplies are 5% of parts + labor, at most $20; tax is 6% of parts + supplies, always charged.
  - No discount box; no hours, engine, used-parts mark or address.
  - Deposits come off the balance due; payment stays with the shop's own terminal and register.
  - Invoice numbers continue after InvoMax's.
  - A fix is reprinted under the same number and looks exactly like the original on paper; only the app marks it "Revised".
  - The bill copies InvoMax's printout, with all the same information. Its look gets iterated later.
- **Plan:** `docs/superpowers/plans/2026-11-23-own-billing.md`, Tasks 1–7. Run it subagent-driven on a new branch `own-billing` in its own worktree: one implementer and two reviewers per task. **Status: plan approved and built; see "where it stands" above.**
- **Order:** the TS server switch comes first (built and checked 2026-11-23; the owner does it from step 5). Billing can be built and tried on the trial copy in the meantime.
- **Owner's photos** of 4 signed InvoMax bills (2026-11-23) hold customer data. They were used to transcribe the fixed wording and layout and are **not** kept in the repo.

## New direction from the owner (2026-11-21): replace InvoMax, and start testing
- **The owner wants to start testing.** The full-flow test on the made-up customer (see "Not yet done by the owner" below) and the switch to the TypeScript server (checklist below) are both still to do. Testing needs no new code.
- **The InvoMax provider is raising its prices**, so the owner wants to **replace InvoMax with our own in-house web application**. This is a new project and needs its own brainstorm and design. Nothing has been decided about how it works yet.
- **How this changes phase 4.** These are open questions for the next session; the owner has not answered them yet:
  - If our app writes the final bill itself (prices, supplies, tax, total, invoice number), then reading InvoMax's final-bill screen is only needed until InvoMax is gone. The "after" record becomes our own bill. Decide whether the InvoMax read in `shopwin.py` is still worth building, or whether staff should just type the finals until the switch.
  - Bill history, the `invoice_finals` table, `GET /api/invoices`, the React Bill history page and backups are still needed either way. Backups matter even more once InvoMax no longer holds a copy of the bills.
  - **Past bills live only in InvoMax.** Moving them out (export, or a read-only import) is part of replacing it. That has not been looked into yet.
  - What our app must do that InvoMax does today: supplies (5% of parts + labor, max $20: owner confirmed 2026-11-21), sales tax (6% of parts + supplies, from the backup spike), invoice numbers, printing, the customer and vehicle lists, and the "Vehicle Invoice History". Each needs the owner's rules, since today the app only records what InvoMax shows.
  - The remote fill and print project (below) is about driving InvoMax. It probably changes or goes away.

## Phase 4 build (started 2026-11-21, branch `phase4-bill-history`, worktree `.claude/worktrees/phase4-bill-history-2aa87d`)
- Design approved; plan `docs/superpowers/plans/2026-11-21-phase4-bill-history.md`. Ledger: `.superpowers/sdd/2026-11-21-phase4-bill-history/progress.md` in the worktree. It holds every ruling and deferred minor, kept for the final whole-branch review.
- **Stage 4a done (Tasks 1–9, 2026-11-21; not merged, not pushed).** Each task had one implementer and two reviewers, and was fixed until both approved.
  - **InvoMax import:** `@shop/invomax` decodes `INVOICE.btv`/`DETAIL.btv` (layout in `shop-web/libs/invomax/LAYOUT.md`). `import-invomax` copies them read-only into `invomax-import/` and fills `invomax.db`.
    - The real data took 7.6 s on first run: 53,447 bills and 245,602 lines.
    - An OS-held SQLite lock (`invomax-import/lock.db`) makes sure only one import runs at a time.
  - **Backups:**
    - `backups/tickets-YYYY-MM-DD.db` keeps 90.
    - `backups/invomax-YYYY-MM-DD.db` keeps 14 daily plus 24 monthly.
    - `restore <file>` refuses while the server is up. It checks the file, rolls back on failure, and sets the old file aside as `*.before-restore-*`.
    - `copy-backups D:` copies to the USB drive as `<drive>\shop-backups`. It accepts drive letters only, refuses the backups' own drive, and checks each copy by SHA-256. It writes `offsite.json` only when every file is there.
    - `start-shop.bat`'s daily `tickets-backup-*.db` stays as the rollback safety net.
  - **Linking (`invoice_finals`, `invoice_unlinked` in tickets.db):**
    - A filled ticket auto-links only when exactly one bill fits: same plate, filled−1 to +3 days, and no other ticket wants that bill.
    - Everything else goes to the "needs a bill" list, which offers Link, Link by bill number, None of these, and Type the final bill.
    - Each change is checked against a version number, so a stale screen can't overwrite it.
  - **Nightly run (TS server only):** at 02:00 local time it backs up, prunes and copies to each `backupTargets` drive that is present. It then imports InvoMax and auto-links. It catches up after the PC was off.
  - **Admin page:** an upkeep line shows the last tickets and bills backups (red after 2 days), "Copied off this PC: <date>" (red after 7 days or a failed copy), "InvoMax checked …", and "N tickets need a bill". It has **Check InvoMax now** and **Copy backups to USB** buttons, and a Bill history link. All of this is hidden under `shop.py`.
  - **Bill history** (`/bills`, the React app `shop-web/apps/admin-app`, admin only):
    - Search by tag, name, phone, VIN (our tickets only; InvoMax keeps no VIN) and date.
    - Our ticket and the InvoMax bill are shown side by side, with a line when the difference isn't zero.
  - **Settings:** `shop-settings.json` in the shop root holds `{ "invomaxDir": "C:\\hunni\\files", "backupTargets": ["D:"] }`. Defaults apply when it is missing or invalid; `INVOMAX_DIR` overrides it.
  - **What makes it live:** the owner's switch to the TS server (`start-shop.bat` → `run-shop.cmd`). Build it first: `npx nx build api` and `npx nx build admin-app`.
- **Owner checks:**
  - Done 2026-11-21: 3 recent bills' lines on screen, **all match**.
  - **Still open (owner couldn't check yet, 2026-11-21):** 3 bills from the 2000s against InvoMax's screen. Each is listed with the parts and labor the import found:
    - #208780 (2002-01-14): parts 30.03, labor 105.00, total 137.95.
    - #213793 (2005-01-18): parts 85.99, labor 25.00, total 121.12.
    - #221558 (2008-02-18): parts 225.02, labor 26.00, total 275.45.
  - **#221558 answered (owner, 2026-11-23): "safety inspection is labor".** The bill's labor (@403) was right; InvoMax had marked the line M.
    - Fix on branch `fix-labor-lines`: when a bill's part lines exceed its parts by exactly what its labor lines are short, the import relabels those lines as labor. That is either the one line of that amount, or the only set of lines that adds up to it.
    - On the real files it relabels 244 lines, and the bills whose lines add up to their totals go from 99.11% to 99.47%.
    - Bills already imported are corrected on the next import.
- **Running e2e:** use `NX_DAEMON=false npx nx e2e pages-e2e`. With the nx daemon on, it hung for 15 minutes on this PC.
- **Stage 4b done (Tasks 10–13, 2026-11-22; not merged, not pushed).**
  - **Job mapping** (`/jobs`, admin only):
    - The rules live in `job_map` in tickets.db and map InvoMax line codes and words to a `parts.csv` job, or to `ignore`.
    - The page lists unmapped groups biggest first, with a proposed job and Accept, Change and Ignore. It also shows coverage (lines and dollars) and a "Show mapped" list with Remove.
  - **Suggested prices:**
    - `GET /api/price-suggestions` gives the median price for the job, with its range (25th–75th percentile) and its basis. It looks first at the same model ±2 years, then the same model, then the same make, then all cars; it tries the last 24 months first, then all time. History comes from our own filled tickets plus the InvoMax lines.
    - Labor is multiplied by qty. With no history it falls back to the `parts.csv` price.
    - On the admin's invoice entry, each line shows the suggestion and its range. An empty box is filled in; a typed price is never changed.
    - When the car or qty changes, an "Update suggested prices" link appears.
- **Whole-branch review (2026-11-22):** 0 Critical and 5 Important issues, all fixed and re-reviewed as fixed:
  - Bills with odd invoice numbers now open.
  - Each backup file is made, retried after an hour and shown on its own.
  - The USB copy is pruned with the same retention as the PC.
  - The upkeep line reads "Copied off this PC: <date>" and turns red after 7 days or when the last copy failed.
  - A failing import backs off to 1h, 2h, 4h… and always runs again at 02:00. **Check InvoMax now** always runs.
  - **Retiring InvoMax:** set `"invomaxDir": null` in `shop-settings.json` to turn the import off. The upkeep line then says so.
  - Tests at the end: api has 326, pages-e2e has 48 passing, and switch-check prints `ready`.
- **Parked for after the merge** (small and rare; the details are in the ledger):
  - A bill with a *blank* invoice number shows in the list but can't be opened.
  - `.try` copies are renamed before the import's database write, so a failed write leaves the kept copy newer than the import.
  - "No copy off this PC yet" never turns red.
  - The import back-off resets when the server restarts.
  - A USB target *inside* `invomaxDir` is only refused because it is on the same drive. Add an explicit check before ever moving the shop root to another drive.
  - Some API-only edge cases: typed finals that reuse a real InvoMax number, and `markNone` over an InvoMax link not being recorded.
- **Trial server for the owner checks (set up 2026-11-23, live shop untouched):**
  - Phase 4 is merged into `main` but not live: the shop still runs `shop.py`. So the checks run on a **copy**: `C:\Users\Owner\Downloads\shop-trial\` (outside the repo; it holds customer data, never commit or copy it into git).
    - It holds a SQLite online-backup copy of `tickets.db` taken 2026-11-23 09:20, `parts.csv`, `vehicles.json`, `web/`, the built admin app, and `shop-settings.json` with `backupTargets: []` (no USB copy).
    - Its first run imported InvoMax read-only: 53,450 bills, 245,615 lines, 244 relabeled as labor.
  - Start it from the worktree's `shop-web` (its build is at `main` 9e80457):
    `$env:SHOP_ROOT = 'C:\Users\Owner\Downloads\shop-trial'; $env:SHOP_PORT = '18082'; node apps\api\dist\main.js`
  - Open `http://127.0.0.1:18082/admin` on the shop PC only (no tunnel). Sign in with the usual admin account; a password change there doesn't reach the live shop.
  - **Job mapping done on the trial lives only in the trial's `tickets.db` `job_map` table.** At the switch, copy those rows into the live `tickets.db` (server stopped), or the hour of mapping is lost.
  - The test ticket for the price check lives only in the trial copy, so the live board never sees it.
  - Import numbers for the 3 old bills (dollars; lines now add up on all three):
    - #208780: parts 30.03, labor 105.00, supplies 1.50, tax 1.42, total 137.95.
    - #213793: parts 85.99, labor 25.00, supplies 5.55, tax 4.58, total 121.12.
    - #221558: parts 225.02, labor 26.00, supplies 12.55, tax 11.88, total 275.45.
- **Owner checks still open (none approved yet):**
  1. The 3 bills from the 2000s listed above: compare their parts, labor and totals with InvoMax's screen. The #221558 labor question is answered.
  2. **Job mapping session (about 1 hour):** on `/jobs`, map the top groups until coverage reaches about 90% of lines. Note the coverage reached here.
  3. **Suggested prices check:** on a test ticket, enter 3–5 real jobs. See whether the suggestions and ranges look right, then delete the test ticket.

## InvoMax backup spike (2026-11-21, throwaway; owner said yes)
- **Owner decisions:** keep the InvoMax final-bill read (a fallback if the replacement takes long, and data for the new app's rules); InvoMax stays paid for 1–2 more months at most. InvoMax has no list of past bills the owner can find, but File → Make Backup Files works.
- **Where InvoMax keeps its data:** program `C:\hunni\invomax.exe`, live tables `C:\hunni\files\*.btv` (Btrieve, no `.DDF` schema). The backup `IVBACK.IBK` is a **plain ZIP** of those tables. Old backups `C:\hunni\files\2310xx.IBK` / `231122.IBK` (newest 2023-11-22; none on this PC since). Never write in `C:\hunni`.
- **Spike, on a copy of `231122.IBK`** (`probe/ibk-spike/`, git-ignored, holds customer data; decoder `probe/ibk-spike/tools/inv.py`):
  - `INVOICE.btv`: 1536-byte pages, records run-length compressed (u16 literal count + bytes, then u16 repeat count + byte), each unpacking to **498 bytes**. 25,404 decoded (the header says ~48k; records split across pages or with other openings are still missed). Bills go back to 1999, ~1,200–1,700 a year.
  - Field offsets (in the 498 bytes; money is Turbo Pascal 6-byte `Real48`): invoice no. shortstring @5, date `MMDDYYYY` @23, total @136 (@142 same, maybe paid/balance), tax @172, maybe discount @204, labor @272 (and @403), tax rate @372 (0.06), maybe deposit/sublet @409, parts @415, supplies @445. Names, plate, phone and address are shortstrings in between. Field names are inferred, not yet checked against a bill on screen.
  - **Rules, from 2,897 bills of 2022–2023:** tax = 6% of (parts + supplies), labor not taxed (98.7%); total = parts + labor + supplies + tax (98.6%); **supplies = 5% of (parts + labor), capped at $20** (98%). **Owner confirmed (2026-11-21): still 5%, max $20.** The earlier "always a multiple of $20" note was wrong.
  - Not looked at yet: `DETAIL.btv` (line items, 1024-byte pages), `CUSTOMERw.btv`, the ~2% of bills that break the rules (discounts? tax-exempt?).
- **Fresh backup (2026-11-21, `D:\IVBACK.IBK`, 58 MB, copy in `probe/ibk-2026/`):** invoice numbers are now 7 digits (`80031xx`), so the record pattern allows a 6- or 7-digit number. 29,986 bills decoded, newest dated 2026-11-21; 2024: 1,393, 2025: 1,129, 2026: 1,321. The tax, total and supplies rules hold every year 2022–2026 (96–98% of bills meet all three). Sent to the owner to check on screen: #8003159, #8003161 (supplies at the $20 cap) and #8003056 (breaks the total rule; has 10.00 @204, 250.00 @409, 181.25 @142: maybe discount, deposit, balance due). **Owner checked all three on InvoMax's screen (2026-11-21): all match.** Rule breaks, 2022–2026 (6,884 bills, 204 break a rule): deposits don't explain them (only 23 of the 204 have a deposit; 320 bills with deposits fit, since a deposit only lowers the balance due). **Discounts explain 77:** supplies = 5% of (parts + labor − discount), max $20. About 127 are unexplained (106 break the total rule, 102 the tax rule): maybe tax-exempt jobs, hand overrides, or fields not mapped yet (sublet, disposal). Look at a few with the owner during phase 4.
- **Next (was):** owner makes a fresh backup (File → Make Backup Files → USB → Backup → Test); rerun on it, check 2024–2026, and check 2–3 decoded bills against InvoMax's screen. Then decide in the phase 4 brainstorm whether reading the backup replaces the on-screen final-bill read.

## Phase 4 brainstorm so far (2026-11-21, not yet written up as a design or plan)
- **Scope (owner): option A, everything in the spec's phase 4.** That covers `invoice_finals` and "Record bill & mark filled", `GET /api/invoices` (search by tag, name, phone, VIN, from/to), `GET /api/invoices/:id` (before and after), `POST /api/invoices/:id/final` (admin correction), `GET /api/customers/:phone`, the **React Bill history page** (filter bar, results table, before/after detail), nightly backups (02:00, `backups/`, keep 90), the `restore <file>` command, `copy-backups <drive>` and its admin button, the config `targets` list, the "Last backup" line (red after 2 days without a good copy) and the "No copy off this PC yet" note. Optional: keep sign-in lockouts and create tokens across restarts (ledger M-2, M-7). The owner's 2026-11-21 direction may change this (above).
- **Found while reading the docs and code.**
  - Nightly backups run only in the TS server. The live server is still `shop.py`, so until the switch the safety net stays the once-a-day `tickets-backup-YYYY-MM-DD.db` that `start-shop.bat` saves.
  - `shopwin.py` `mark_filled` (around line 300) asks yes/no, then saves `tickets.move(fresh, "filled")` with a version check. The new dialog and the `invoice_finals` write go there, in the same transaction.
- **What the earlier InvoMax work already covers** (`probe/` in the real folder, git-ignored; it holds customer data, so never commit it):
  - The read-only driver (`invomax.py`, `CONTROLS`) and watch mode (`probe.bat`) are ready, so no new tool is needed to map a screen.
  - The logs (`watch-2026-10-27.log`, `watch-2026-11-03.log`, `trial-2026-11-03.log`, `map-20261027-124634.txt`) cover Customers, Customer Information, Vehicles, Parts & Labor, Parts Cost, Mileage, Vehicle Invoice History, the Yes/No pop-ups (`Tmsgs`, `Confirm`) and the `Tchoicebox` pickers. **Nothing after Done (the final-bill view) was ever logged.**
  - **Likely snag:** on the main invoice screen the totals bar (Discount, Supplies, Sublet, Disposal, Labor, Parts, Sub Total, Sales Tax, TOTAL, BAL DUE) is a single `TPanel#1` at rel (10, 965, 1916, 60) with no child controls. It is drawn, so `WM_GETTEXT` can't read it. If the final bill is that bar, the dialog stays typed-only. A later option is reading it from a picture that is never saved.
  - The `CONTROLS["date"]` entry (`TLMDMaskEdit#0` at (1506, 130)) may really be the Invoice Number box. The design lists "Date dropdown, START, Invoice Number" across the top, and the date is the `TDateTimePicker` at (238, 130). Check this in the mapping session.
- **Asked the owner, not yet answered:** is "the bill just before confirm" the main invoice screen with its totals bar, or a separate window after Done? Either way, mapping it means one ~5-minute read-only `probe.bat` run while the owner takes one real job to the final bill as usual.
- **Next steps:** settle the InvoMax-replacement questions above with the owner first, then finish the phase 4 brainstorm, write `specs/2026-11-2x-phase4-bill-history-design.md`, plan it with the writing-plans skill, then subagent-driven development (one implementer and two reviewers per task, never two writers at once) with the ledger under `.superpowers/sdd/<date>-phase4/`.

Read first:
- Design: `specs/2026-10-26-invomax-overlay-design.md`. This covers the side panel, the draft model, the step runner and every InvoMax recipe learned so far. It supersedes the overlay part of `specs/2026-10-14-invomax-autofill-design.md`.
- Refactor plan: `plans/2026-10-26-refactor-before-panel.md` (R1–R5 done).
- Shop tickets plans: `plans/2026-10-29-shop-tickets.md` (T1–T7), `plans/2026-10-29-shop-accounts-deploy.md` (A1–A4, then "Follow-up": B1 deposits, P1 Shop tickets window), `plans/2026-11-03-ticket-vin.md` and `plans/2026-11-16-admin-full-entry.md` (latest; its Review section lists what the two reviewers found and what was left).
- Working style the owner asked for: plan, then per task an implementer subagent plus **two senior reviewer subagents** (spec/correctness and security/robustness), fix until both approve, then commit. Push only when the owner says so.

## Where things are (2026-11-18)
**The admin enters the whole invoice** (owner, 2026-11-16: the mechanic does the repair, the admin does the paperwork; plan `plans/2026-11-16-admin-full-entry.md`, merged and pushed as `c4fa093`, VIN work `74f03c7` with it):
- `/admin` → **New ticket** is the full invoice screen: first/last name, phone, plate, VIN, year / make / model, odometer, mechanic (an active account), request, notes, and every part and labor line with prices (`parts.csv` hints bring code and prices). **Save ticket** (stays Waiting) or **Send to InvoMax** (→ `approved`, the shop PC's Ready for InvoMax list; needs a mechanic and a line). Send is also on waiting / working / review tickets. The desk edits any ticket until filled.
- `/tech` → **My invoices**: a mechanic sees and fixes their own sent invoices (lines, odometer, VIN, notes) until filled; can't zero one; a change sets `mech_edit`, shown on the desk's card and ticket until the desk saves. Accept / Finish job / Send back still work. A waiting ticket with a mechanic set shows only to that mechanic.
- New tickets carry a one-time token (a re-sent create is the same ticket); `shop.log` records `role#user id` per request.
- **"Send to InvoMax" does not type into InvoMax.** Staff type it by hand from `run.bat` → Shop tickets (entry sheet, Copy buttons), print from InvoMax, then **Mark filled**. Nothing reads InvoMax back: staff compare the ticket's Total (before tax) with InvoMax's subtotal before printing. Automatic typing = "Resume here" InvoMax steps below.

**Running it** (2026-11-18, before the switch; on `ts-shop-server` `start-shop.bat` starts the TypeScript server instead, see below, and `/checkin` is retired): `start-shop.bat` (re)starts the shop server (`shop.py`, 127.0.0.1:8081), the phone page + Cloudflare tunnel (`phone.py --tunnel`) and Ollama; it stops running copies first, so it is also the restart after any code change, password reset or lockout (pages in `web/` are read fresh; `.py` changes need the restart). A shortcut **"Shop tickets (start-shop)"** is in the Windows Startup folder (runs at sign-in, not at power-on; not yet tried on a real reboot). Servers own their port (`pinweb.OnlyServer`): on Windows each restart had left the old copy running alongside (3 `shop.py` and 2 tunnels were found). Links: `https://shop.japaneseautoservice1.com/admin`, `/tech`, `/checkin`. The admin password is reset at the PC with `python shop.py admin <username>` (after the switch: `node shop-web\apps\api\dist\main.js admin <username>`).

**Not yet done by the owner:** a full test of the new flow (admin entry → Ready list → typed into InvoMax by hand → totals compared → printed → Mark filled). A checklist was given in chat on 2026-11-18: made-up customer (JANE DOE, `(555)010-0000`, `XKS-4827`), one part + one labor line, check My invoices on a phone, the entry sheet on the shop PC, type, compare, print or cancel, Mark filled.

## TypeScript shop server (branch `ts-shop-server`, 2026-11-19)
A drop-in replacement for `shop.py` (same port 127.0.0.1:8081, URLs, JSON, `tickets.db`, accounts and cookies: nobody signs in again), plus delete / restore / purge and mechanic check-in, in the job's stack (Express 5, TypeScript, Nx, OpenAPI + Orval, Jest, Playwright).

**Where things are**
- Spec: `specs/2026-11-18-typescript-shop-server-design.md`. Plan: `plans/2026-11-18-ts-shop-server.md` (Tasks 1–11, phases 1–3 of the spec). Task briefs, reports and the review ledger (rulings R1–R14, every deferred minor): `.superpowers/sdd/2026-11-18-ts-shop-server/` in the worktree (git-ignored; `progress.md` is the ledger). **Tracked copy of the ledger:** `ledgers/2026-11-18-ts-shop-server-progress.md` (taken at the final polish round; it outlives the worktree).
- Worktree: `.claude/worktrees/ts-shop-server` (branch `ts-shop-server`). **Merged into `main` on 2026-11-20** in the real folder, as a fast-forward to `091916a`. The worktree can be removed once the owner no longer needs its git-ignored `.superpowers/` notes; the tracked ledger copy keeps the summary.
- `shop-web/` (Nx 24 workspace, Node 26.13.1): `apps/api` (the Express server; `src/main.ts` serves or runs `admin <name>`; `openapi.yaml` is the contract), `libs/domain` (`@shop/domain`, the ported `tickets.py` rules), `libs/api-client` (Orval-generated client for the React pages to come), `apps/pages-e2e` (Playwright on the built server, temp root, port 18081), `tools/parity-guard.mjs` + `PARITY` (CI fails if `shop.py` / `tickets.py` / `accounts.py` / `pinweb.py` change without the TS side), `tools/switch-check.mjs`, `tools/run-shop.cmd`.
- **The built server is `shop-web\apps\api\dist\main.js`** (webpack; not `shop-web\dist\apps\api\main.js` as the plan said: ruling R6). Build: `cd shop-web && npm ci && npx nx build api`.
- `start-shop.bat` now: refuses any argument but `python` (a message, nothing stopped); stops the restart loop (`cmd.exe /c` or `/k` running `shop-web\tools\run-shop.cmd`), then `python shop.py`/`phone.py`, `node` running **this folder's** `shop-web\apps\api\dist\main.js` (not an `admin` reset) and the tunnel; the first run on a day saves `tickets-backup-YYYY-MM-DD.db` with SQLite's online backup (Python `sqlite3`, source opened read-only, `quick_check`, written to `.tmp` and renamed only on success; a failure is logged and the shop still starts: ruling R14). There is a copy only on days `start-shop.bat` runs. Then it starts `shop-web\tools\run-shop.cmd` minimised (window "Shop server": `UV_THREADPOOL_SIZE=8`, then absolute `node.exe` on the absolute `main.js`). `start-shop.bat python` starts `pythonw shop.py` instead, after the same stop and copy. If `main.js` isn't built, it starts `shop.py` and logs why.
- **Crash and restart (ruling R13, replaces R7's keep-alive):** an uncaught exception logs `error <Class>` and the server exits 1; a stray rejected promise and a server `error` event (EMFILE) are only logged. A port already taken exits 3. `run-shop.cmd` logs every other exit (`run-shop: the server stopped (exit N) after S s; starting it again in W s`) and restarts after 5 s, doubling after each run under 60 s up to 300 s, back to 5 s after a longer run (PowerShell `Start-Sleep`, falling back to `ping`, so it never spins). On exit 3 it logs `the port is taken (try N of 3)` and tries again 10 s later; after the third it logs `already running on the port; this window stops` and the window closes (the count resets after a run over 60 s). Before starting, `start-shop.bat` waits up to ~10 s for nothing to listen on 8081 (`netstat`), so the old server's exclusive socket has gone. Each start writes `started 127.0.0.1:8081` in `shop.log`, so the `started` lines show any restart pattern. **A restart clears the in-memory sign-in lockouts and create tokens** (persisting them is for phase 4); the back-off caps how often that can happen.
- What's new for the shop: delete (everyone who can see a ticket), the admin's Deleted list + Restore, the 14-day purge (only deleted waiting / working / review tickets **with no deposit**; deposit, approved and filled tickets are never purged: R10; the newest row is kept so ids are never reused), mechanic **New customer** check-in on `/tech`, and the kiosk / iPad retired (`/checkin` → `/`, `/api/kiosk*` → 404, kiosk sessions deleted at start). `tickets.Ticket` gained `deleted_at`, `deleted_by`, `deleted_from` (shared-schema rule); Python lists hide deleted tickets and refuse to change them.
- Checked by `node tools/switch-check.mjs` (2026-11-19, this worktree: `ready`): the api build, `nx run-many -t test`, the parity guard, all 14 `tests/test_*.py`, the built `main.js` on a throwaway root and spare port answering `GET /` 200 and `/api/me` 401 (contract loaded), and with no `SHOP_ROOT` finding the repo root by itself. **One server per port, on this PC:** while the TS server listens, a second TS server exits with code 3 ("already running on this port") and Python's `OnlyServer` can't bind (even a plain Python server with `SO_REUSEADDR` couldn't); while Python's `OnlyServer` listens, the TS server exits 3. So `shop.py` and the TS server can never both answer 8081 (the purge and id safety rest on this).

### Switch-over checklist (the owner does it, at a quiet time; Python stays as the fallback)
**2026-11-23: steps 2–4 are done** in the real folder at `main` 5a51ab2: `npm ci`, `nx build api`, `nx build admin-app`, and `switch-check` printed `ready`. The owner goes on from step 5. Since `main.js` is now built, **any `start-shop.bat` run starts the TS server**, including the Startup shortcut at sign-in after a reboot; `start-shop.bat python` goes back. If job mapping was done on the trial server (see "Trial server" under Phase 4), copy the trial's `job_map` rows into the live `tickets.db` right after the switch.
1. Pick a quiet time (no job mid-repair on a phone, nobody typing at the desk), and plan to watch the first day.
2. In the real folder (`C:\Users\Owner\Downloads\ticket-autofill`): `git pull --ff-only`. The merge of `ts-shop-server` was **done on 2026-11-20**; the pull brings in any later commits, such as this handoff update.
3. `cd shop-web && npm ci && npx nx build api` (`npm ci` needs the internet, registry.npmjs.org, and installs the whole dev tree: Nx, Jest, Playwright, Orval).
4. `node tools/switch-check.mjs` → must end with `ready` (it never touches the live server, port 8081 or the real `tickets.db`). Anything else: stop here.
5. Close and reopen `shopwin.py` (`run.bat` → Shop tickets): it holds the old `tickets.py` `Ticket` class, without the three `deleted_*` fields.
6. Run `start-shop.bat`. It stops `shop.py`, saves today's `tickets-backup-YYYY-MM-DD.db` if there is none yet (check it's there, and no "copy of tickets.db failed" line in `shop.log`) and starts the new server in a minimised "Shop server" window.
7. Check: `/admin` on the desk PC (still signed in, board as before, Deleted button there); `/tech` on a phone (still signed in, jobs there, New customer); the Cloudflare link `https://shop.japaneseautoservice1.com` from outside the shop Wi-Fi. Within about 10 s of step 6, `shop.log` shows **exactly one** `started` line. Over the tunnel, in the browser's DevTools (Application → Cookies), the `sid` cookie shows **Secure** (cloudflared sends `X-Forwarded-Proto: https`); if it doesn't, roll back and look before anyone signs in again.
8. Watch `shop.log` for the day: requests come in as before; one `started` line is expected (up to ~30 s late if `the port is taken (try N of 3)` lines appear first — those are harmless while the old server lets go of the port); another `started`, any `error <Class>`, `run-shop: the server stopped` or `already running on the port` line means look closer (and maybe roll back).

### Rollback (one step)
- Run **`start-shop.bat python`**: the same stop and the day's copy (if none yet today), then `pythonw shop.py` instead of node. Plain `start-shop.bat` goes back to the TS server. Sessions and accounts are shared, so nobody signs in again either way.
- The Startup shortcut runs `start-shop.bat` with no argument, so a reboot goes back to the TS server: to stay on Python across reboots, add ` python` to the shortcut's target.
- **What's missing on `shop.py`:** deleted tickets stay hidden and can't be changed; there is no Deleted list or Restore; there is no purge; there is no mechanic check-in; the Delete button shows "Not available on this server." Nothing in `tickets.db` is lost: tickets deleted on the TS server keep their `deleted_*` fields and come back with Restore after switching back.

### Switch-day notes (known, accepted for now)
- A restart forgets the create tokens kept in memory, so a phone that retries a check-in or a new ticket across a restart can, rarely, make a duplicate ticket (delete the extra one).
- A restart also clears the sign-in lockouts (they are in memory, as on Python). Persisting them is for phase 4.
- Anyone can lock a mechanic's name for 24 hours with 20 wrong PINs, the same as on Python. An admin's PIN reset for that mechanic unlocks it.
- `npm ci` needs network access to registry.npmjs.org and installs the full dev tree (a few hundred MB in `shop-web\node_modules`).

### Remote fill and print (the next project after this one; owner's decisions, 2026-11-18)
- A button on the owner's own phone or iPad (not a shop device) starts InvoMax filling on the shop PC, **unattended**: the PC only needs to be on with InvoMax open, the tunnel running and the overlay present (the overlay starts with `start-shop.bat`).
- The owner **approves the fill remotely**, sees InvoMax's final numbers on the device, and can **trigger the print remotely**. This lifts "never click Print" for that one step.
- **Print comes last**: no automatic print until filling InvoMax's text fields is proven reliable. Print opens a modal; the shop almost always picks **"Save and print order"** (or similar). The owner will send a **screenshot** of that view when the work gets there.
- Remote control is for the owner only (the sole admin and bill recorder). Still to design: remote Stop (nobody at the PC to press Esc) and what the device shows while a fill runs.
- **Future: stronger sign-in (a second factor) for remote control.** Not built; consider it before remote fill / print goes live.

### Next: phases 4–5 (spec)
- **Phase 4, customer history:** bill history from InvoMax's final numbers (`shopwin.py` "Record bill & mark filled" reads the final bill read-only into a new `invoice_finals` table; the final-bill screen needs a watch-window mapping session with the owner first), `GET /api/invoices` search (tag, name, phone, VIN, dates), per-customer view by phone digits.
- **Phase 4, backups:** nightly at 2:00 with SQLite's online backup into `backups/` (git-ignored, keep 90), "Last backup" line on the admin page, a `restore <file>` command; later a `copy-backups <drive>` USB copy. No cloud, ever. Until then the `tickets-backup-YYYY-MM-DD.db` that `start-shop.bat` saves the first time it runs on a day is the safety net (single disk: no cover for a dead disk).
- **Phase 5, React pages:** React 19 + TypeScript, function components and hooks only, custom hooks (`useTicketList`, `useSaveTicket`, `useConfirm`, `useDraft`, `useCheckIn`), server state through the Orval-generated TanStack Query hooks; `/tech` first, then `/admin`; each with Testing Library, Playwright and axe; then drop `'unsafe-inline'` from `script-src`.
- Then the remote fill / print project above.

### Rulings on record (details in `ledgers/2026-11-18-ts-shop-server-progress.md`)
- **R1** the ported Task 5–7 status + message assertions win over validator defaults. **R2** Task 10 changed only kiosk / check-in assertions in `tests/test_shop.py`. **R3** Task 11 never runs `start-shop.bat`: the switch is the owner's. **R4** `money('1e400')` follows real Python. **R5** one commit trailer left as it was. **R6** the built server is `shop-web\apps\api\dist\main.js`. **R7** server `error` listener + process safety net (the `uncaughtException` half is replaced by R13). **R8** a check-in token replay for a ticket the caller can't see answers 404. **R9** a replayed create token for a deleted ticket answers as `GET /:id`, never recreates; tokens store `[id, created]`. **R10** (owner) a deleted ticket with any deposit is never purged. **R11** the tech delete pop-up says `The desk can restore it.` **R12** a save keeps a stored non-list `deposits` value verbatim unless the desk sends a validated list. **R13** an uncaught exception exits 1 and `run-shop.cmd` restarts with back-off; a port in use exits 3 and stops the loop. **R14** the day's copy uses SQLite's online backup to a `.tmp`, renamed on success.

### Deferred minors, by theme (for the final review; details per task in `ledgers/2026-11-18-ts-shop-server-progress.md`)
- **Robustness and security to triage:** reset / sign-out and the last-admin check aren't atomic (wrap in `BEGIN IMMEDIATE`; Python parity); the hasher wait queue is unbounded (cap ~64); login-eviction weakens the 24 h cap; mechanics can evict desk idempotency tokens from the shared 500-entry map, and check-in has no rate limit; no Host allowlist (DNS rebinding; Python parity); early 401/403/404 replies lack `Connection: close`; the sync SQLite driver can block the event loop up to 5 s on a busy lock; `openDb` leaks its handle on a DDL failure; deep nesting `RangeError` on save; `vehicles.json` with a BOM / UTF-16 silently reads as `{}`; `deleted_at` clock sanity (>= created); the `{active:false, secret}` two-write order; non-object `data` / line / deposit values not treated as corrupt (T3); non-object fields throw `TypeError` in the domain, so routes must answer 400 (T2); a literal PIN in an interop test's code string (T4); restarts clear in-memory lockouts (R13; persist in phase 4). Damaged stored deposits are settled by **R12** (a save keeps a non-list `deposits` value verbatim unless the desk sends a validated list), but R12 covers deposits only: a non-list `lines` is still normalised. Done since: the libuv pool for the 4 hashers is `UV_THREADPOOL_SIZE=8` (in `run-shop.cmd`); an uncaught exception now exits for a clean restart (R13).
- **Python parity deviations to list in parity notes:** mechanic 404 vs Python 403 on paths it can't use; duplicate `sid` first-wins vs last-wins; `version` 1.0 accepted / > 2^53 gives 400 not 409; one corrupt row 500s the whole list (parity), rows missing desc/amount load as undefined; decimal underscores, `repr()` control chars, `2019.0` floats, padding > 4x refused, `ß` → `SS` after the length check, years < 1000; `parts.csv` read as UTF-8 (Python cp1252), a short CSV row gives `[]` (Python 500); `NewUser.name` maxLength 80 (Python truncates); `isPrintable` accepts Unicode 16 letters; `clientIp` treats `::ffff:127.x` as loopback; cross-site refusal covers every non-GET/HEAD; a global Stale/Refused → 409 may hide a missing route catch; `%31` in a path decodes to `1` (T6); the purge counts 14 local calendar days, and `deleted_at` can differ from `updated` by 1 s (T9).
- **Tests:** timing asserts (100 ms, http-core 2 MB / 5 s) may flake on CI; cleanup gaps (kill child in `finally`, stderr unread, `db?.close`); missing cases (two-connection stale, past-5 s busy, chunked > 1 MB, `\\` before a closing quote, `__proto__` / status / id / created in bodies, store.save Stale race, catch-path 404, purge busy path vs Python's lock, token eviction cap, Line / Deposit / Totals reply schemas in the contract example, the bad-version contract case passes even without the validator (T8), `/api/users/abc` body); `localStorage` ExperimentalWarning noise.
- **Tooling and CI:** actions pinned by tag, not SHA; CI runs twice (push + PR: add `concurrency`); parity guard prints a raw stack if git or a file is missing; no `.gitattributes` eol for `*.py` (this task added CRLF for `*.bat` / `*.cmd` only); `@types/node` ^24 vs Node 26; the jest `moduleNameMapper` `.js` rule is broad (T1); `engines` (T1) is now set (`node >=26`); `@types/react` absent with `skipLibCheck` (pin now or in phase 5); nx.json copies the jest plugin's `TS_NODE_COMPILER_OPTIONS` and its `NODE_OPTIONS` replaces a user's own; `libs/domain` build and typecheck both write `dist`; orval's dev tree (+129 packages, esbuild install script unapproved); `playwright-core` pinned 1.64.1; no CI Chromium cache; `@shop/domain` not declared in `apps/api/package.json`; `specPath` stops at the first `@shop/api` package.json (an nx-pruned dist would lack `openapi.yaml`); `checkedIn` would recurse on a `$ref`-only cycle (none today); the root `.gitignore` line `shop-web/dist/` is stale (the build goes to `apps/api/dist`, ignored by `shop-web/.gitignore`).
- **Pages:** `autocomplete=off` on customer fields; no `aria-describedby` on field errors; a stale poll can re-add an accepted card as waiting (edge); the Deleted-list probe (`POST /api/tickets/0/restore`) leaves one 404 in `shop.log` per page load; `shopFetch` 304 → `data` undefined (phase 5).
- **Code tidiness:** `accounts.ts` ~700 lines (helpers could move to `pystr.ts` / `clientkey.ts`); `py-json.ts` / `errors.ts` extra files; `text` exported, `edit()`'s 5th arg `today`, `testing.ts`; `{log: config.log, ...opts}` undefined override; `exclusive: true` comment misleading; statements re-prepared per call; `parts.csv` read per request; the log actor set in fewer places than Python.
- **On the shop PC by hand:** try `node shop-web\apps\api\dist\main.js admin <name>` in cmd and PowerShell (hidden prompt; a pasted second line is dropped); CLI messages go to stdout, not stderr; check the Startup shortcut after a real reboot.

## State
| Area | Status |
|---|---|
| Photo → text → jobs (`ocr.py`, `read.py`) | Done (Qwen2.5-VL 7B on local Ollama; `read.read_photo`). Never checked against a real notebook page. |
| Pricing (`prices.py`) | Done; placeholder `parts.csv`. |
| Draft model (`draft.py`) | Done: `Value`, `Line` (part / labor / remark, qty, cost, covers, stable id), `Draft`, `from_job`, `needs`. Not done: `questions()`, `answer()`, `expected_totals()` (spec section 3). |
| Step runner (`recipes.py`) | Done; tested against the fake, and `customer_search` / `customer_by_plate` have now run live (see Trial results). Recipes: `customer_by_plate`, `customer_search`, `customer_new`, `customers_exit`, `vehicle_open`, `vehicles_cancel`, `vehicle_choose`, `phone_set`, `odometer`. Driver errors become failed checks / `StepFailed` with the steps done; refusals stop at once. |
| Real driver (`invomax.py`) | Built and reviewed 2026-11-02 (`invomax.Driver`, `8617496`): dry run by default, copy-back off by default; refuses unless the invoice is maximized 1936 × 1056; exact-foreground / top-dialog / no-menu / focused-box guards re-run right before every input; SendInput clicks checked against the control under the point; one key per safety check; never-click captions by word plus allow lists per window; stop latch; Esc or mouse in the top-left corner stops it. `python invomax.py check` only reads. Ran live 2026-11-03. Unmapped: `customers.exit`, `vehicles.engine`, `phone.text`; `phone` and `date` are read-only (place not confirmed / never typed). `fill()` (the Fill InvoMax button) still says "isn't set up yet". |
| Parts / labor / remark / note recipes | Steps known from the probe (spec 5.7); not written. They need pictures of the untitled choice boxes. |
| Side panel (`panel.py`), draft store, Wi-Fi page | Not started. |
| Probe (`probe.py`, `probe.bat`, `trial.bat`) | Done. Read-only watch with Start/Pause; logs to `probe/` and saves pictures of unreadable pop-ups to `probe/shots/` (git-ignored, customer data). Trial mode (`trial.bat`) runs one recipe at a time and has run live (see Trial results). Under `pythonw` the first Run once did nothing with no log; launched as `python probe.py trial` with stderr to a file it worked, cause not found. |
| Shop tickets (`tickets.py`, `accounts.py`, `shop.py`, `pinweb.py`, `web/admin.html`, `web/tech.html`, `web/checkin.html`, `start-shop.bat`; since 2026-11-16 the admin enters the whole invoice, see "Where things are") | Done 2026-10-29 (plans `plans/2026-10-29-shop-tickets.md`, `plans/2026-10-29-shop-accounts-deploy.md`): customer check-in kiosk → mechanic accounts (name + PIN) → admin review (username + password) → approved → `tickets.to_draft`, live at https://shop.japaneseautoservice1.com through the `inspection` tunnel. Year / make / model hints from `vehicles.json` (NHTSA). Since then (2026-11-02): **deposits** (admin only, any status until filled, sent to the draft as notes; mechanics never see them) and **totals before tax** (owner: InvoMax adds the 6% tax and supplies, so our totals are Parts, Labor, Total before tax, Deposits paid); `Store.save` is atomic across processes (`BEGIN IMMEDIATE`). On the shop PC, `run.bat` → **Shop tickets** lists approved tickets with an InvoMax entry sheet and Mark filled, and **Load into Ticket Autofill** (or double-click) fills the main window's fields, lines and notes in one click. The owner's admin account is made through `/setup` (code in `setup_code.txt`, valid 24 h from the server start). Not done: moving `phone.py` onto accounts (ask the owner: logs the phone out once), the Fill InvoMax button using the driver, checking InvoMax accepts a part line with a blank code, starting `shop.bat`/`phone.bat` at boot. |
| Inspection report (`inspection.py`, `report.py`, `phone.py`) | Added by another session in `6f73778`; separate from InvoMax filling. It adds the `python-docx` and `winocr` dependencies and a Cloudflare tunnel for the phone page. |

Tests: `python tests/test_<name>.py` for accounts, draft, invomax, ocr, phone, prices, probe, read, recipes, report, shop, shopwin, tickets and vehicles. All 14 print `ok` (checked 2026-11-18).

## What the probe taught us (details in spec section 4 and 5.x)
- InvoMax is a Delphi app. The invoice window has class `TINVOICESCREEN`, maximized at 1936 × 1056; its title blanks for a moment on redraws.
- **Readable:** the Name boxes (`TEdit#2` first, `TEdit#1` last), every box in Customer Information, the Vehicles dropdowns and button captions, the Parts & Labor captions, the Parts Cost / ACTUAL COST / Mileage boxes, and the grid cell being edited (`TInplaceEdit`).
- **Not readable:** the 15 `TLMDEdit` header boxes, which answer neither `WM_GETTEXT` nor UI Automation. These are Plate `#6`, VIN `#1`, Year Make `#8`, Eng Specs `#7`, Odometer in `#5` / out `#4`, mechanic `#2` and the phones. The drawn lists (Customers, Parts & Labor, item grid, `Tchoicebox`) aren't readable either. The plan: check `TLMDEdit` values by **copy-back** (select all, copy, read, restore the clipboard) and check list picks by their effect.
- **Caption-less buttons** are located by position in the invoice window. The button row is the panel `TPanel#3` at (10, 322)–(1926, 374). Known spots: Clear ≈ x 90–160, Labor ≈ x 440–500, vehicle history ≈ x 765–785, Done ≈ x 1280–1350, all at y 335–370. Inside dialogs: Add New ≈ (137, 475) in Customers, Save ≈ (273, 218) in Customer Information.
- The fastest customer lookup is to type the plate (with the hyphen, `ABC-1234`) in the Plate box and press Enter on an empty invoice. On an exact match InvoMax loads the customer; with no exact match it opens Customers with near matches and loads nobody (seen live 2026-11-03).

## Trial results (2026-11-03, owner watching, empty invoice)
- `python invomax.py check`: invoice 1936 × 1056 maximized, no dialog, name boxes read empty; the menu bar (182 items) has no keyboard shortcuts. The focused box on an empty invoice is the date box (`TLMDMaskEdit#0`, now mapped read only).
- `customer_search` live: Customers opened in 0.2 s, License ticked, the plate typed; step 3 can't be confirmed without copy-back (stopped, as designed).
- `customer_by_plate` live with a plate not in InvoMax: Plate focused in 0.02 s, typed, Enter → Customers with near matches, nothing loaded; trial mode now says so. Still to try: a plate that is in InvoMax, then `odometer` and the vehicle stages on that customer.
- Second session (same day): `check` clean again, but the focused box was Plate this time (left from the earlier trial). `customer_by_plate` live with a plate that **is** in InvoMax: Plate focused in 60 ms, typed + Enter, First Name filled in 0.66 s, no dialog left. `odometer` ran live (Dry run unticked by mistake): all three checks passed, but InvoMax had pre-filled Odometer In with the last visit's reading and the typed number was **appended** to it (the checks only see focus, not the text). Owner fixed the box by hand. A first fix pressed End, Shift+Home, Backspace before typing; re-run live (`8e7335d`), **Backspace in Odometer In cleared the whole invoice like Clear** (focus jumped to the parts grid; the guard refused before any typing; the saved customer was untouched, per the owner). The clear is removed and the driver now refuses Backspace and Delete in every send (`NEVER_KEYS`, `Driver._send`). **`odometer` is parked**: it still appends to the pre-filled reading. Options for the owner: End + Shift+Home then type over the selection (unproven live), or staff type the odometer. Note: twice the owner believed Dry run was ticked when the log shows a live run; read the log's `dry_run=` after every run.
- `vehicle_open` live (single click on Year Make, twice): nothing opened. The watch log (owner by hand) shows one click only focuses Year Make; a **double-click** opens Vehicles. Recipe changed to `double_click`. Also seen: after picking the Model, Vehicles closed and a **"Confirm" Yes/No** box opened (`TMessageForm`, question text not readable, **Yes focused by default**); the owner pressed No and focus went to Plate. `vehicle_choose` expects the engine step instead, so it must not run until the owner says what Confirm asks.
- `vehicle_open` live with the double-click: Vehicles opened in 80 ms. `vehicles_cancel` live: Cancel closed Vehicles in 80 ms and a **"Confirm" Yes/No** box asked to correct all past history; the owner answered No by hand. Owner: **always No** there. `vehicles_cancel` now presses Cancel, then No; the driver presses No only right after Cancel in Vehicles, in a `TMessageForm` with exactly Yes and No buttons (`_guard_confirm_no`), and never Yes. A second live `vehicles_cancel` (right after an earlier Cancel) got **no** Confirm: Vehicles just closed. So the No is optional: recipes now have `if_(check, step, grace)` (wait up to grace for the check, skip the step if it doesn't come) and `vehicles_cancel` = Cancel (expect no window or Confirm) then `if_(dialog("Confirm"), press("No"))`. The optional No hasn't run live yet.
- Owner (2026-11-03): the Confirm after picking a Model → **Yes** loads Year Make and Eng Specs (and Odometer "0000" when there's no past history). Odometer should **replace** the old reading. Tried End, Shift+Home then type (`7b6e3fe`): live, **End / Shift+Home alone cleared the whole invoice** too (focus to the parts grid ~0.5 s later, after the per-key guard had already passed; so the first clear was probably End/Home too, not only Backspace). The driver now sends **only** single plain characters, Enter, Tab and the copy-back Ctrl+A Ctrl+C (`SENDABLE`, `Driver._send`); no navigation or editing keys at all. Owner by hand (watch log): double-click Odometer In (selects the reading), Backspace, type, Enter, Enter → mechanic box. The recipe now does double-click → type over the selection → Enter → Enter (no Backspace: a selection is replaced by typing anyway). Each step also expects `name.first` still filled and re-checks after `settle` = 1.5 s (`Step.settle`), to catch a late clear before the next input. Live (owner watching): after the tool's double-click (one instant burst) the focus moved from Odometer In to the parts grid within 1.5 s, nothing typed or cleared (the settle check stopped it). The owner's double-click is two clicks ~0.2 s apart. The driver now sends a double-click as two guarded single clicks `DOUBLE_GAP` = 0.2 s apart (all checks re-run before the second, refused after 0.45 s); trial-only recipe `odometer_select` (double-click + 3 s watch) tests whether that fixes the jump, with the watch log running. Owner: **Odometer Out must equal Odometer In** (billing); with an old Out, Enter from In leaves Out as it was. Live with the paced double-click (`a0b3cf8`): focus stayed in Odometer In for 3 s and the old reading was **highlighted** (owner). The `odometer` recipe is now double-click In → type + Enter → double-click Out → type the same + Enter → mechanic box, each step checking focus + `name.first` after a 1.5 s settle. **Live OK (13:23, owner watching):** all 4 steps passed (1.7–2.0 s each with the settle), both boxes got the new reading, focus ended on the mechanic box, customer still loaded. Staff check the odometer before Done (nothing reads it back). Lesson: InvoMax's reaction to a key can lag the guard; a new key needs a watch-log test by hand first, never a live trial.
- Owner (2026-11-03): allow copy-back in a supervised trial. Trial-only recipe `copyback_odometer` (single click Odometer In, read it back by copy-back, settle 1.5 s); a failed copy-back is cached so a step sends at most one Ctrl+A Ctrl+C.
- Owner's Fill goal (2026-11-03): one click fills First, Last, Phone, Year Make, Plate, VIN, Odometer in + out and the mechanic, **also for a customer not yet in InvoMax** (Add New → Save → Vehicles → Confirm Yes). Order of work: copy-back trial → mechanic typing → new-customer path with a made-up test customer the owner agrees → Fill button.
- Leaving the mechanic box seems to move the focus to the parts grid: the odometer double-click failed from a mechanic-box start (13:32) and worked from elsewhere (13:34). `odometer` now refuses to start with the focus on the mechanic box. New `mechanic` recipe types the ticket's mechanic where `odometer` leaves the focus (no Enter); typing adds to what's there, so Fill runs it once, right after `odometer`, on a new invoice. Not yet run live.
- VIN: the mechanic enters it on the phone or the admin adds it before the fill (owner); proposed as a separate shop-tickets task.
- Owner's view of the goal: one click from a Shop ticket to a filled InvoMax invoice, no copy and paste. Today the ticket loads into Ticket Autofill in one click; the InvoMax half is these trials, then the Fill button.

## Parts and labor, recorded by hand (watch log 2026-11-03 13:46–13:48, pictures in `probe/shots/1346*`–`1347*`)
The owner entered a part, an installation charge and a labor charge by hand; some clicks were corrections, so take the order, not every click. Positions are screen points on the maximized invoice (window at (-8, -8)).
- **Part line:** click the first empty grid row's code cell (≈ (197, 423), `TStringGrid#0`) → an in-place editor (`TInplaceEdit#0`, **readable**) opens → type the part code (`FBP`) → Enter → InvoMax replaces it with the parts-list description (`FRONT BRAKE PADS`). Click the quantity/price area (≈ (1365, 427)) → editor shows `1` (qty) → Enter → editor for the price → type `100` → Enter → a **Tchoicebox** opens: *Temporary Price Change / Permanent Price Change / Net Markup / EXIT*, the first highlighted → Enter takes **Temporary Price Change** (ask the owner which one he means to use; Permanent changes the parts list).
- **Labor button** ≈ (451, 348) in `TPanel#3` (the hint says "Labor, Sublet, Warranty, options") → Tchoicebox: *Installation Charge / Labor Charge / Sublet Charge / Create New Labor Code / Find Labor Code / Warranty Labor Adjustment / Labor CREDIT Back / EXIT*. Items are ~24 px apart, first at about y 41 inside the box. **Owner rule:** labor that installs a part with its own cost → **Installation Charge** (InvoMax writes `Remove & Install: <part description>` itself); labor with no part → **Labor Charge**, then type the description (`MOUNT & BALANCE TIRE`) + Enter, and click the price cell (≈ (1548, 480), it showed a default `95.00`) → type the price → Enter. This matches `tickets.to_draft` (`INSTALL-PART` lines with `covers`, `LABOR` lines).
- **Danger:** clicking a filled row's first column opens a Tchoicebox *Erase Line / Insert Empty Line / Mark as "Declined" / EXIT*. Add "erase line", "insert empty line" and "mark as declined" to the never list before any grid recipe. Choice boxes are drawn (unreadable): check them by picture (as the probe does) or by their effect; the tool picks only by Enter on the highlighted first item or by a click at a mapped item position checked against a picture.
- Not yet clear from the log: where the price cell of an installation row is, whether InvoMax prices it, and the exact columns (record one clean part + installation, and one clean labor line, slowly, if needed).

## Resume here (next session)
### TODO: shop tickets
0. **Switch to the TypeScript server** (branch `ts-shop-server`): final review, then the owner's switch-over checklist above. That brings item 1 below (delete, restore, purge; built to the owner's answers in the 2026-11-18 spec), so item 1 is done once the switch is.
1. **Delete tickets from the admin side (owner, 2026-11-18).** *(Built on `ts-shop-server`; the notes below are the original question list.)* The owner wants to remove old test data now and will need to delete tickets while testing. Before the switch nothing can delete a ticket (README: "Nothing is deleted"; `tickets.Store` has no delete; there is no route). To design with the owner first (brainstorm, then plan, then the two reviewers as usual):
   - Which statuses: any not-yet-filled ticket (waiting / working / review / approved), or filled ones too (the owner said "in progress jobs" and "old data": ask)?
   - Hard delete, or a `deleted` status / archive that hides it everywhere but keeps the row (safer for billing records; a filled ticket is already in InvoMax)?
   - Admin only, with a confirmation that names the customer and total; deposits on the ticket: refuse, or warn?
   - What a mechanic's phone and the shop PC's Shop tickets window show when their open ticket disappears (they treat a missing ticket as 404 "gone" today).
   - A one-off clean-up of the existing test tickets in `tickets.db` (customer data: never commit it; back it up first, e.g. copy to `tickets-backup-YYYY-MM-DD.db`, git-ignored).
2. **End-to-end test with the owner** of the admin-entry flow (checklist above), on the live server, with a made-up customer.
3. Reviewers' leftovers (`plans/2026-11-16-admin-full-entry.md`, Review): a waiting ticket given to a mechanic whose account is then turned off shows to no mechanic; a mechanic's change to a sent invoice doesn't reach a draft already loaded into Ticket Autofill; account names that differ only by a non-ASCII letter's case.
4. Check the Startup shortcut after the next real reboot (the shop link opens on a phone).

### TODO: typing into InvoMax (unchanged since 2026-11-03)
Proven live: `customer_by_plate` (exact match loads the customer), `odometer` (both boxes, ends on the mechanic box), `mechanic`, `vehicle_open` (double-click), `vehicles_cancel` (+ optional No). The trial window (`python probe.py trial`, launched with `python`, stderr to a scratch file) and the read-only watch window (`python probe.py watch`) are how every step was tried: dry run, then one live run with the owner's OK; read `probe/trial-YYYY-MM-DD.log` after each (check `dry_run=` in the log; twice the owner thought it was ticked when it wasn't). Close and reopen the trial window after every code change.
1. **Copy-back trial** (`copyback_odometer`, tick Allow copy-back): owner approved trying it. Click into Plate first (never start from the mechanic box). Dry, then one live run; look at Odometer In afterwards.
2. **Part / labor recipes** from the section above: map the grid columns and the choice-box items (`CONTROLS` / positions), add the dangerous captions to the never list, build `part_line`, `installation_charge`, `labor_charge` on the fake first, review, then dry + live one at a time on an invoice staff will clear.
3. **New-customer path** (owner wants Fill to work for a customer not in InvoMax): plate not found → Customers opens → `customer_new` (Add New ≈ (137, 475), first/last/phone, Save ≈ (273, 218); **creates a real record**: agree a made-up test customer with the owner first) → Vehicles opens by itself → `vehicle_choose` (Year/Make/Model dropdowns; then a Confirm whose **Yes** loads Year Make and Eng Specs (owner); expect "Select Engine Later" may not come) → plate and VIN typed into the header (single click, plain typing; Plate/VIN never double-clicked). `customers.exit` is still unmapped.
4. **Fill InvoMax button** in `app.py`: a shop ticket loaded via Shop tickets → draft header/lines (now including VIN and the admin-entered lines) → recipes in this order: lookup (or new customer + vehicle) → `odometer` → `mechanic` → lines; one confirmation per fill; stop at the first failed check and say what's left by hand. `invomax.fill()` still says "isn't set up yet".
5. Push when the owner says (`git credential-manager github login` as **alahrime** if a push returns 403).

Safety rules learned today (keep them): the driver sends only single plain characters, Enter, Tab and copy-back's Ctrl+A Ctrl+C; End/Home/Backspace cleared the invoice. Double-clicks are two guarded clicks 0.2 s apart (an instant one made InvoMax jump to the parts grid). Never start a header step with the focus in the mechanic box. Every step re-checks focus + `name.first` after a settle time. A new key or click is tried by the owner by hand under the watch window first, never first in a live trial.

## Next: test the runner on the real InvoMax
Do these in order and stop at the first surprise. Every stage runs on **an empty invoice** with the owner watching. Anything the tool leaves on the invoice is cleared **by hand**; the tool never presses Clear.

1. **Build `invomax.Driver`** with the interface in the `recipes.py` docstring:
   - Use ctypes reads as in `probe.py` (`WM_GETTEXT`, `BM_GETCHECK`, `CB_GETLBTEXT`, `GetGUIThreadInfo`), plus pywinauto `click_input` / `type_keys` for actions.
   - `CONTROLS` maps names to a class+index or a window-relative position, taken from `probe/map-*.txt` and the watch log.
   - `TLMDEdit` reads use copy-back.
   - Refuse to act if the window isn't maximized at 1936 × 1056.
   - Unit-test the pure parts: locator lookup and the refused-area math.
2. **Read-only driver check (no clicks).** With an invoice on screen, compare `dialog()`, `text()` and `focused()` with what the screen shows. Copy-back is the first thing that touches InvoMax (Ctrl+A / Ctrl+C in one box), so ask the owner before trying it.
3. **Trial mode in `probe.py`** (spec 5.8). It runs one recipe, logs each step's check and timing, and starts only on an empty invoice. Order:
   1. `customer_search` + `customers_exit`, which opens Customers and backs out.
   2. `vehicle_open`, then Cancel (needs a small `vehicles_cancel` recipe).
   3. `customer_by_plate` with a plate the owner gives; staff clear the invoice afterwards.
   4. `odometer` on that loaded invoice.

   Use the timings to set step timeouts.

   **Built (2026-11-02, not yet run on InvoMax):** `trial.bat` / `python probe.py trial`. The trial window lists the recipes in stage order: `customer_search`, `customers_exit`, `customer_by_plate`, `odometer`, `vehicle_open`, `vehicles_cancel`. The two vehicle recipes come last because they need the customer that the plate lookup loads, so `vehicle_open` can't run directly after stage 1. Rules:
   - Dry run first. Dry run is on by default; a live run asks for confirmation and dry run goes back on afterwards. One stage per owner OK. Copy-back stays off until the owner agrees.
   - It starts only on a maximized InvoMax showing the recipe's starting state.
   - Hold Esc or push the mouse into the top-left corner to stop.
   - It never retries. After a live run it reads (read-only) what is left and says what to clear or close by hand.
   - Log: `probe/trial-YYYY-MM-DD.log`.
4. **Saving recipes need the owner's OK first.** `customer_new` creates a real customer record and `vehicle_choose` saves a vehicle. Agree on a made-up test customer the owner is happy to keep or delete by hand.
5. Then: pictures of the choice boxes (run the probe while using Labor), the parts/labor/remark/note recipes, `questions()` / `answer()`, and the side panel.

## Owner decisions on record (2026-10-26/27)
- START isn't needed. A double-click on the Name box opens Customers. Plates are typed with the hyphen.
- One phone only. No address, zip, city or state.
- Plate and VIN are single-clicked and **never double-clicked**. The mechanic was typed by hand; **changed 2026-11-03:** the mechanic box should be filled from the mechanic's phone (the shop ticket's tech, set when they hit Finish job).
- **Never** click: Done, Charge, Print, Clear, Dial Number, Continue, Fast Quote, Change, Delete, Custom Vehicle, Void, Erase.
- (2026-11-03) Vehicles: Cancel's "correct all past history?" Confirm → always **No**; the Confirm after picking a Model → **Yes** (loads Year Make, Eng Specs). Odometer Out must equal Odometer In (billing). Labor installing a part with its own cost → Installation Charge, otherwise Labor Charge. Fill should also work for a customer not yet in InvoMax (first, last, phone, Year Make, plate, VIN, odometer ×2, mechanic). The mechanic enters the VIN on the phone, or it's added before the fill. Copy-back may be tried in a supervised trial.
- Watch mode is approved; it never saves, edits or deletes. Trial mode needs a go-ahead per stage.
- (2026-11-02/03) InvoMax does tax and supplies; our totals are before tax. Deposits are staff-only. Mechanics sign in with name + 6–8 digit PIN; the admin with username + password; the customer iPad is a kiosk. Signature stays on paper from InvoMax's printout.
- The side panel snaps to the four screen corners, bottom-right first.
- The "Parts Cost" window sets a part's **price**. "ACTUAL COST" is the shop's cost.
- (2026-11-16/18) The admin enters the whole invoice (customer, phone, plate, VIN, year / make / model, odometer, mechanic, parts and labor with prices) and sends it to InvoMax; InvoMax computes the tax. A mechanic must still be able to view and change their own final invoice. The owner wants to delete tickets from the admin side, at least in-progress and old test ones (see Resume here).

## Access and tools
- **Git push:** credentials are via Git Credential Manager. This PC also has a **MixtureModels** sign-in that can't push to `alahrime/ticket-autofill`. If a push returns 403, run `git credential-manager github login` and sign in as **alahrime**. The sign-in window can open behind other windows.
- **Phone access:** Remote Control was turned on for the design session. The probe test checklist is at https://claude.ai/artifact/LmrQkF15NFy8eH7wbnnyVX (private).
- **Shared folder:** other Claude sessions commit in this same folder. Commit only your own files, and run the full test list before committing.

## Constraints
- Python + Tk. The InvoMax tool adds no dependencies beyond `pillow` and `pywinauto`.
- Fully offline for photos and InvoMax. Ollama stays on `127.0.0.1`.
- Tests are plain `assert` scripts that print `ok`.
- Never commit real photos, probe logs or pictures, or customer names. Docs use made-up names (JANE DOE, `(555)010-0000`, `XKS-4827`).
