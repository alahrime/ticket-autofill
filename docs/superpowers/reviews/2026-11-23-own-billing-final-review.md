# Final review: own-billing (a14e3c0..cb58c23, 13 commits)

Reviewer: final whole-branch review (read-only). Spec: docs/superpowers/specs/2026-11-23-own-billing-design.md. Plan: docs/superpowers/plans/2026-11-23-own-billing.md.

I read the spec, the plan, the ledger and the source files the branch touched. I did not run any test suite, because Nx and Jest write caches and output and this review had to stay read-only.

## Strengths

- **Numbering is sound where it matters most.** `approve()` does everything in one `BEGIN IMMEDIATE`: the version check, taking the number, `saveTx`, the final, revision 1 and the counter (ownbills.ts:251-294). A Stale ticket or any refusal rolls all of it back, so no number is used up (Review Focus 2).
  - The already-ours check runs before the version check, so a second click gets 409 with the number (Focus 1).
  - `taken()` also skips any old InvoMax number outside the 400-day window.
- **Go-live morning (Focus 3).** The import runs before the proposal and again before the confirm. The confirm re-checks under the write lock. Every later approve recomputes the highest number from fresh InvoMax and finals data.
- **Money rules** are exact bigint half-up rounding (bill.ts:29-31). Cents are kept end to end and dollars appear only at the route edge (`inDollars`). `billable()` re-validates stored lines and deposits rather than trusting them, which closes T1's negative/damaged carry-over.
- **Revisions are insert-only in code.** A fix keeps revision 1's date, time and shop details. The test checks that revision 1's stored text stays byte-identical (Focus 5).
- **The print page shows only the stored snapshot.** It has no revision mark and prints 2 copies. Pagination is weighted for wrapped lines, never truncates, and has a PDF page-count e2e (Focus 4).
- **LinkStore refuses link, unlink, none and typed on our bills,** so the old Bill-history controls can't delete an issued invoice's row.
- **The `ownBilling` flag hides everything when off.** The routes fall through to 404 before the role check, and admin.html keeps "Send to InvoMax".
- **Project rules hold:**
  - shop.py and tickets.py are untouched.
  - Nothing writes to C:\hunni, and there is no CDN or remote URL.
  - Tests use made-up values, and every test makes its own temp dir with port 0.
- **The CHECK migration** rebuilds `invoice_finals` in one locked transaction and re-checks after taking the lock.

## Issues

### Critical

None. None of the four anti-goals is broken: no duplicate number, no rule drift by a cent, no print that differs from what is stored, no overwritten revision.

### Important

**I1. One stray high number permanently drives the counter, and 9999999 stops billing.**
- **Where:** apps/api/src/billing/ownbills.ts:152-166 (`highestUsed`), :198-203 (`takeNumber`); apps/api/src/routes/bills.ts:46-49 (a typed final accepts any 1-7 digits).
- **What's wrong:** Every all-digit typed final, of any age, counts toward the highest number used, both before and after the confirm. Some examples:
  - A desk typo while typing an InvoMax final (8030316 for 8003163) makes every later bill jump to 8030317 and on, for good.
  - 9999999 makes `takeNumber` throw "no 7-digit invoice number is left" (400), so Approve & print stops working.
  - The first-number dialog only allows the proposed number or higher, so the admin can't steer around a bad proposal.
  - The spec also asked the builder to "settle the exact rule from the import data and record it". The 7-digit / 400-day rule was never checked against the live invomax.db, so an odd 7-digit InvoMax number would cause the same permanent jump. Nothing records that check.
- **Why it matters:** Both Task 3 reviewers raised this. The effect on the admin is irreversible from the app. Invoice numbers on paper jump by thousands, or billing halts with a message they can't act on. Fixing it means hand-editing tickets.db.
- **Fix:** both of these.
  - (a) While own billing is on and the counter is confirmed, refuse a typed final whose number is at or above the counter's `next_no`. InvoMax no longer makes new bills, so such a number is a typo. Say so in the 400. `taken()` already prevents reuse of anything lower.
  - (b) In the first-number GET, also return where the highest number came from: "InvoMax #N of <date>" or "typed on ticket #T". Show it in the dialog, so an outlier is caught before it's confirmed.
  - Before go-live, run one read-only query on the live invomax.db: the top 10 seven-digit numbers in the last 400 days, with their dates. Record in HANDOFF that they form the 800xxxx run. This is a check only. Don't put the data in git.

**I2. Earlier revisions aren't listed or viewable, so the admin can't see what the customer signed.**
- **Where:** apps/api/src/history/bills.ts:399-404 (`own` carries only a count and the latest when/who); apps/admin-app/src/bills/BillDetail.tsx:249-253.
- **What's wrong:** The spec says Bill history "shows the latest and lists the earlier ones". The page shows one line, "Revised <latest date> by <who>". No page or API returns an earlier revision's snapshot. `GET /api/own-bills/:no` gives only the revision metadata, and the print page always prints the latest.
- **Why it matters:** Suppose a customer disputes a fixed bill ("I signed for $X"). The original is stored but unreachable. That falls short of the anti-goal "a fix that silently overwrites what the customer signed": in practice the admin can't tell what changed.
- **Fix:**
  - Return `own.revisions` as a list of `{revision, at, by}` and render each in BillDetail.
  - Add `?rev=N` to `GET /api/own-bills/:no` and to the print page, so an earlier revision can be viewed or printed. It prints unchanged, as today.

**I3. Deleting a billed ticket makes our bill vanish from Bill history.**
- **Where:** web/admin.html:714 (Delete is offered on a billed ticket); apps/api/src/routes/tickets.ts:162 (`markDeleted` allows filled); apps/api/src/history/bills.ts:112 (the `TICKETS` CTE keeps only `status = 'filled'`).
- **What's wrong:** An InvoMax bill stays in Bill history through `im_invoices` even if its ticket is deleted. Ours lives only on the ticket row, so after a delete the issued invoice number disappears from the list.
- **Why it matters:** The admin sees a gap in invoice numbers and can't find or reprint the bill from Bill history. A restore brings it back, but nothing tells them that. Deleting a billed ticket is a natural mistake, or a natural attempt to "void" a bill.
- **Fix:**
  - Refuse delete (409, "this ticket has our bill #N; use Fix bill") for a ticket whose final is `ours`, and hide the Delete button there.
  - Or keep such tickets in the CTE. Refusing is simpler and matches "never lose an issued invoice".

**I4. Bill history dates a fixed bill by the fix day, not the bill day.**
- **Where:** apps/api/src/history/bills.ts:111 and :189 (the row date is `t.day`, from `ticket.updated`).
- **What's wrong:** `fix()` saves the ticket, which changes `updated`. The list row and the From/To search then use the fix day. The detail and the paper still say the original date.
- **Why it matters:** A bill dated 11/23 and fixed on 12/02 shows under 12/02, and a search for 11/23 misses it. That contradicts "same number and date" for fixes. The ledger deferred this as minor, but its effect lands on every fixed bill.
- **Fix:** For `f.source = 'ours'`, use `substr(f.linked_at, 1, 10)` as the row date. `linked_at` is approve's time and a fix never changes it. The From/To filter needs the same change, for example a `day` column computed with a CASE on `f.source` in the second UNION arm. Add a test: fix on a later day, then search by the original day.

### Minor

1. **Stray "null" text in the action row.**
   - **Where:** web/admin.html:703. It is pre-existing, but the branch rewrote this row.
   - **What's wrong:** Native `act.append(..., cond ? btn : null, ...)` turns `null` into the text "null" next to Approve & print, for new, waiting and working tickets.
   - **Fix:** Use `""`, or filter the nulls out.
2. **The grey bands won't print by default.**
   - **Where:** apps/admin-app/src/print/print.css:141, :231.
   - **What's wrong:** Chrome and Edge leave out background colours unless "Background graphics" is ticked.
   - **Fix:** Add `print-color-adjust: exact; -webkit-print-color-adjust: exact;` to `.bill-print`.
3. **Fix bill can't correct a deposit.**
   - **Where:** web/admin.html:904 (the deposits box is closed while fixing), although the server's fix accepts `deposits`.
   - **What's wrong:** A wrong deposit on a printed bill gives a wrong Balance due, and nothing in the app can fix it.
   - **Fix:** Allow deposit edits in fix mode, sent with Save & reprint, or say in the fix note that deposits can't change.
4. **"Revised … by admin#2" shows a raw id** (bills.ts:399-404, ownbills.ts `by`). Look up the account name.
5. **An empty fix still stores a revision and shows "Revised".** Refuse or skip the revision when the snapshot is unchanged, apart from its revision number.
6. **Some failures show a generic server error (500).**
   - SQLITE_BUSY after 5 s, and an unguarded `JSON.parse` of a stored snapshot in `latest()` and `fix()` (ownbills.ts:335, :367).
   - Nothing is written in either case.
   - Map BUSY to 503 "try again", and a bad snapshot to a clear 500 message.
7. **No warning when `ownBilling` is true but the `shop` details are empty** (config.ts). Bills would print with a blank header. Warn once at start-up.
8. **The `@page` rule is global** in the bundled CSS (print.css:4), so printing Bill history also gets letter paper with 0.4in margins. Scope it with a named page later.
9. **The first bill after each page load opens no tab in the click.**
   - **Where:** web/admin.html, `approvePrint`.
   - **What's wrong:** `S.firstOk` starts false, so the tab opens after an await. That relies on the browser's short user-activation window, and otherwise falls back to the "Print bill #N" link.
   - **Fix:** Learn `confirmed` from the upkeep status (or one cheap GET at load), so the tab opens in the click.
10. **"Sub Total" (parts + labor + supplies) and the added "Continued on the next page" wording** need the owner's check against a real bill on the trial.

## Triage of deferred items

| Ledger item | Verdict | Reason |
|---|---|---|
| T1: no tie/boundary tests (10c supplies tie, cap at 400.00, fractional qty) | Fine to leave | The formula is exact half-up bigint by inspection; adding the three cases later is cheap. |
| T1: negatives give half-toward-zero and uncapped supplies | Resolved | `billable()` re-normalizes and refuses negative or non-integer cents (ownbills.ts:98-113). |
| T1: billAmounts round-trips through toFixed | Fine to leave | Exact under MAX_MONEY × MAX_LINES (well below 2^53 cents). |
| T2: no shop:null / bad-hours tests | Fine to leave | The code path is the same `bad.push('shop')` branch, already tested with other bad shapes. |
| T2: no warning when ownBilling is on with an empty shop | Fine to leave | The trial step catches it. Cheap improvement in Minor 7. |
| T2: upkeep test sets config directly | Fine to leave | config.spec covers loading from the file. |
| T2 Ruling: full-file comparison instead of a re-review | Agree | I read config.ts whole. The regex is escaped and the file is LF. |
| T3: an all-digit typed final far above the counter (typo); 9999999 stops billing | **Must fix before merge** | Irreversible number jump or a billing halt, with no way out in the app. See I1. |
| T3: concurrency tested only in one process | Fine to leave | `BEGIN IMMEDIATE` plus busy_timeout is SQLite's documented cross-connection serialization, and approve has no read-then-write outside it. |
| T3: no DB triggers making revisions insert-only | Fine to leave | No UPDATE or DELETE path exists in code; triggers would only guard against hand edits. |
| T3: SQLITE_BUSY after 5 s becomes 500 | Fine to leave | Nothing is written, a retry works, and the server is the only regular writer. Nicer as 503 (Minor 6). |
| T3: every unconfirmed first-number GET runs a full import | Fine to leave | admin.html calls it only on a click, never on a poll (verified). Once confirmed, no import runs. |
| T3: an empty fix makes an identical revision | Fine to leave | Harmless data, but it shows a misleading "Revised" (Minor 5). |
| T3: unguarded JSON.parse of revision 1 | Fine to leave | Only our code writes the snapshots, and History already guards its read. Only disk damage gives a 500 (Minor 6). |
| T3: GET calls firstNumber twice | Fine to leave | Two cheap MAX queries. |
| T3 Ruling: a fix keeps revision 1's shop details | Agree | "Reprint looks exactly like the original". |
| T3 Ruling: up to ~3 min import wait, or 503 on a foreign lock | Agree | It happens once ever. IMPORT_MS (300 s) covers it and the page shows "Checking InvoMax…". |
| Pre-flight Ruling: GET runs the import before proposing | Agree | Matches the spec and Task 6. |
| T4: revised_by shows the raw "admin#2" | Fine to leave | Cosmetic (Minor 4). |
| T4: latest() runs outside History's read transaction | Fine to leave | The worst case is a revision count one behind for a moment. |
| T4: row date = ticket's filled day | **Must fix before merge** | After a fix the list shows the wrong date and the date search misses the bill. See I4. |
| T4: no 403 test on our detail | Fine to leave | The route-level `signedIn('admin')` is tested for all own-bill routes. |
| T4: readOurs doesn't type-check per-row numbers (NaN → null) | Fine to leave | Only damaged data reaches it, and the page then shows blanks, not wrong figures. |
| T4 Ruling: no change needed for a server-side refusal on ours | Agree | Verified: `LinkStore.checkVersion` refuses ours (links.ts:279-283). |
| T5: global @page and body rule | Fine to leave | Only affects printing other admin pages (Minor 8). |
| T5: "Continued on the next page" is extra wording | Fine to leave | Tell the owner on the trial (Minor 10). |
| T5: the X..... and ____ blanks are characters | Fine to leave | They print correctly. |
| T5: Sub Total = parts + labor + supplies | Fine to leave in code | The owner confirms against a real bill on the trial (Minor 10). |
| T5: CPL estimate assumes ordinary capitals; trailing space; header at the caps leaves 3 rows | Fine to leave | Worst case is an extra page, never overlap or lost text. |
| T5 Ruling: never truncate descriptions | Agree | The owner said information over looks. |
| T6: pre-existing stray "null" in the action row | Fix before merge (cheap), not blocking | It sits next to the new Approve & print button the owner will try first, and it is a one-token fix (Minor 1). |
| T6: api() 204 → {} change | Fine to leave | The only 204 route is the first-number POST (verified). |
| T6: weak waitForTimeout negative test | Fine to leave | Test strength only. The positive paths are asserted. |
| T6: sparePort race | Fine to leave | Rare. Startup fails loudly with "port in use?" rather than giving a wrong pass. |
| T6: S.ownBilling set only after the first upkeep result | Fine to leave | A brief flash of "Send to InvoMax" on load. The server refuses nothing wrongly. |
| T6: showBilled catch redraws the pre-bill S.cur | Fine to leave | A second click gets 409 "Already billed" plus Reprint. No second bill. |
| T6: S.cur===t identity miss after a poll | Fine to leave | It only delays the Reprint/Fix buttons until the next showing. |
| T6: ownBillOf runs after busy is released | Fine to leave | It is a read. A click meanwhile is refused or answered by the server. |
| T6: no e2e for Stale-409-then-filled | Fine to leave | The api tests cover the server side, and the client branch is small. |
| T6 Ruling: the by-ticket route | Agree | Needed for Reprint/Fix after a reload. Admin-only and 404 when off. |
| T6 Ruling: approved tickets get Approve & print | Agree | The admin chooses. The risk (a ticket already typed into InvoMax gets our number) is the admin's informed choice. |
| T6: one unexplained api failure in an overlapping run | Fine to leave, keep watching | See below. |

**The flaky api test.** I looked for isolation problems in what the branch added and found none:
- Every api test uses `mkdtempSync` for its own root.
- Servers listen on port 0.
- The import lock (`lock.db`) lives under each test root's `invomax-import`.
- config.spec writes shop-settings.json only in its temp dir.
- ownbills.spec uses a fixed clock for the unit tests and `date('now','localtime')` for the route test, so no date is close to falling out of the 400-day window.

The likely candidates are pre-existing and need two runs at once to collide:
- backup.spec's `freePort()` followed by `restoreBackup`'s "is a server listening on this port" probe. Another run can take the freed ephemeral port.
- http-core.spec's EADDRINUSE test.

`loadConfig({})` in http-core.spec reads the worktree root's shop-settings.json. It would fail only if one existed there. If the failure comes back, log the test name; it is not caused by this branch.

## Declined to judge

- **Pixel match to InvoMax's paper.** The photos aren't in the repo; the owner compares on the trial.
- **Whether Sub Total should include shop supplies.** Only a real bill settles it (owner).
- **Whether the 7-digit / 400-day rule fits the live InvoMax data.** I can't read customer data. It is turned into a check to run in I1.
- **What shopwin.py shows with own billing on.** The spec leaves it to the builder, and the branch doesn't touch it.
- **Cross-process races beyond SQLite's BEGIN IMMEDIATE guarantees.** These are standard engine semantics, not branch logic.
- **Reproducing the flaky test.** No suites were run, because the review is read-only and Nx/Jest write caches and output.
- **The corrected typos "STRORAGE" and "intial", and the extra "Continued" line.** These are the spec's and the owner's calls.
- **InvoMax bills made after go-live (staff still using InvoMax) colliding with our numbers.** The spec says InvoMax stops on that day. `taken()` covers anything already imported.
- **A fix changing the customer or vehicle on a signed bill.** The spec explicitly allows it (Focus 5).
- **Popup behaviour on the desk PC's exact browser.** Unknown browser; noted only as Minor 9.
- **Print-page accessibility beyond the axe check the branch runs.** It's a paper output.

## Assessment

**Ready to merge: With fixes.**

Fix I1 to I4 first: the counter guard and first-number provenance, listing and viewing revisions, no delete of a billed ticket, and the fixed bill's date. Fold in the one-token "null" fix (Minor 1) and `print-color-adjust` (Minor 2) since both are cheap and visible on the trial. The rest can follow after the trial. The core money, numbering and transaction work is correct and well tested.
