# Re-review of the own-billing fix wave (cb58c23..e9bf09c)

Read-only. I read the three reports, the whole diff and the touched source. I did not run tests, and I changed no code or git state.

## Verdict

**Ready to merge. No new Critical or Important breakage found.** All six items are fixed. A few small leftovers are listed at the end.

## The six items

| Item | Status | Evidence |
|---|---|---|
| I1 stray high number | ADDRESSED | (a) `links.ts` `typedFinal` (new `ownNext()` and the `Refused` at about :380-390): once the counter exists, an all-digit number >= `next_no` is a 409. Tested in `ownbills.spec.ts` ("at or above the next number is refused", route test 409). (b) `ownbills.ts` `highestUsed()` now returns `from`. `firstNumber()` passes it on and the openapi has `HighestFrom`. admin.html `numFromText` and `#numFrom` show it in the dialog. The extra outlier rule (`INVOMAX_OUTLIER` 10000 above the median) is in `highestUsed()`. The live data check is in the fix report. |
| I2 earlier revisions | ADDRESSED | `ownbills.ts` `revision(no, rev)` and `read()`. `routes/ownbills.ts` `GET /api/own-bills/:no?rev=N` (404 for an unknown revision, 400 for a bad one). `history/bills.ts` `own.history`. `BillDetail.tsx` `EarlierRevisions` (View and Print links). `BillPrint.tsx` asks the server for `?rev=`. Tests cover the API, the print page, the list and e2e. |
| I3 delete of a billed ticket | ADDRESSED | `routes/tickets.ts` `changeTicket` delete branch: `ownBills.ofTicket(t.id)` gives 409 "use Fix bill". It applies to admin and mechanic, with own billing on or off. admin.html hides Delete when `own` is set. Tested, including the flag turned off. |
| I4 fixed bill's date | ADDRESSED | `history/bills.ts` `T_DAY` (`substr(f.linked_at,1,10)` when `f.source='ours'`) is used in the row's date and in the From/To filters. `fix()` only updates the amounts and version of the final (`ownbills.ts` :378), so `linked_at` stays put. Tested: the row date after a fix, and search by the bill's day and by the fix day. |
| Minor 1 stray "null" | ADDRESSED | admin.html :703 now uses `""`. The only other native `.append` calls I found that pass null go through `el()`, which skips null (:269). The e2e checks for no "null". |
| Minor 2 grey bands | ADDRESSED | `print.css` .bill-print gets `print-color-adjust: exact` and the webkit form. Both band rules (:144, :234) are inside `.bill-print`, and the property is inherited. e2e checks the computed value. |

## New Critical or Important breakage from the fix diff

None. I checked the four areas asked about.

- **Invoice numbers issued twice or at or below a used number.** No.
  - `takeNumber` still loops with `taken()`, which checks every InvoMax number of any age and every final. That holds even for a number the outlier rule leaves out.
  - Approve is still one transaction. It also sets the counter, and `highestUsed` still counts the counter.
  - The outlier rule can only drop an InvoMax number more than 10000 above the median. Such a number is never reused, because of `taken()`. Our numbers could end up below it, but only when it really is a typo.
- **Reprint matching the stored snapshot.** Yes.
  - `read()` returns the stored JSON of the chosen revision. The route only converts cents to dollars, as for the latest.
  - The paper never shows the revision. Only the tab title does.
  - Nothing writes revisions or `linked_at` in the new code.
- **The new `?rev=` route.** Safe.
  - The chain is `ownBilling, admin, validNo, validRequest`. Own billing off gives 404 before anything else. A non-admin gets 403, and the bad-rev 400 comes after both.
  - `read()` first checks that the number is one of ours.
  - The tests cover rev=1, 2, 3, 0 and x as admin. They do not cover `?rev=` while the flag is off or as a non-admin. The route shares the middleware chain of the other own-bill routes, which are tested, so I count this as a test gap, not a hole.
- **Delete-refusal holes.** None found.
  - A filled ticket cannot be moved to another status (only `approved>filled` exists), so a billed ticket can't leave `filled` and then be deleted.
  - The 14-day purge only removes tickets that are already `deleted`, and `delete` can't reach a billed one.
  - Restore needs a deleted ticket, and a billed one can't be deleted.

## Customer data

Clean for this diff. In the added lines I found only JANE/DOE, (555)010-0000, XKS-4827 and 9000001+ numbers. A search of the added lines for real-looking phones, e-mail addresses or 800xxxx numbers found none. The `ownbills.ts` comment gives only aggregate figures. No `.superpowers` file is tracked, and the working tree is clean.

Not part of this diff, but worth knowing: older docs already in git (HANDOFF.md:121 and `specs/2026-11-23-own-billing-design.md`, :49 and :63) name real bill numbers such as #8003164, plus rule breaks like #8003056. These are invoice numbers only, with no names or phones. The owner can decide whether to keep them.

## Small leftovers (none blocks the merge)

1. **I1, before the confirm.** A typed final typo is still counted before the first number is confirmed. The dialog now names where the number came from, and the admin can fix or retype that final. A typed 9999999 before the confirm would still leave no 7-digit number to propose until it is fixed.
2. **`?rev=abc` on the print page.** `BillPrint.tsx` silently prints the latest revision if `rev` is malformed. The tab title also says "Bill N". A hand-edited URL only. It would be better to show an error.
3. **Delete button while `own` is not yet known** (own billing off, or before `askBillOf` returns). Delete shows, and the server answers 409. That is safe, just a bit rude.
4. **Median rule limits.** The 10000 margin and the median assume one 7-digit run in the 400-day window. The fixer says this too. If the run changes again, recheck it.
5. **Tests.** The admin-app and e2e tests were not seen failing first. `tools/switch-check.mjs` was not run (per the fix report).
