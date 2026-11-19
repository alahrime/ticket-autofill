<!-- Copy of the SDD ledger (.superpowers/sdd/2026-11-18-ts-shop-server/progress.md, git-ignored) taken 2026-11-19 at the final polish round, so it outlives the worktree. Scanned for customer data, PINs, setup codes, usernames and emails: nothing to redact. -->
# SDD ledger — plan: docs/superpowers/plans/2026-11-18-ts-shop-server.md

Spec: docs/superpowers/specs/2026-11-18-typescript-shop-server-design.md
Branch: ts-shop-server (worktree .claude/worktrees/ts-shop-server). Base main b5eb458; spec 7338994; plan a4f846b.
Owner rule: per task, implementer + TWO reviewers (A: spec/correctness, B: security/robustness). Replaces the skill's single task reviewer.

## Pre-flight scan
| Rows | Produces / consumes | Finding |
|---|---|---|
| T1 self | workspace, CI, guard | consistent |
| T2 self | domain tests vs code | consistent |
| T2→T3,T6,T9 | @shop/domain types/fns | names consistent (normalize/newTicket/edit/move/totals) |
| T3 self | store + interop | consistent |
| T3→T5..T9 | TicketStore, openDb | consistent |
| T4 self | accounts + CLI | consistent |
| T4→T5,T7 | Accounts, makeAdmin, deleteKioskSessions | consistent |
| T5 self | core + pages | consistent |
| T5→T6,T7,T9 | middleware, helpers.ts | consistent |
| T6→T7 | routes/tickets.ts both modify | sequential, fine |
| T6/T7→T8 | routes described in openapi | consistent |
| T5↔T8 | T8 validator vs T5 ported error messages | CONFLICT risk (see R1) |
| T8→T9 | T9 must add its routes to openapi.yaml | listed in T9 files, fine |
| T9 self | tickets.py change + PARITY --update | consistent |
| T9→T10 | delete/restore/410/check-in routes | consistent |
| T10 self | deletes web/checkin.html; test_shop.py may reference kiosk | handled by T10 step 4 (R2) |
| T11 self | start-shop.bat run needs owner | stop condition (R3) |

Ruling R1: in T8, the ported Task 5–7 assertions (status + message) win over validator defaults — the validator runs after the JSON Content-Type check and its failures are mapped to 400 {error}; any route whose ported test depends on a hand-written message keeps that message — cost if wrong: a few validator exclusions.
Ruling R2: T10 may adjust only kiosk/checkin assertions in tests/test_shop.py (Python shop.py itself keeps its kiosk code as the fallback) — cost if wrong: Python fallback tests cover less of the retired kiosk.
Ruling R3: T11 never runs start-shop.bat; the live switch is the owner's call after the final review — cost: none.

## Tasks
Task 1: dispatched (base a4f846b)
Task 1: implementer done 539ae89 (impl agent a70b969a29392180f)
Task 1: review A approved (0 Important); review B 2 Important (CI permissions; unused devDependencies).
Task 1: minor (deferred): actions pinned by tag not SHA; CI runs twice push+PR (add concurrency); parity-guard raw stack trace if git/file missing; no .gitattributes eol for *.py (hash relies on autocrlf); main.ts template leftovers (/assets static, /api welcome, new Function ready-signal) — Task 5 replaces main.ts; no engines field; @types/node ^24 vs Node 26; nested shop-web/.gitignore noise; moduleNameMapper .js rule broad.
Task 1: fix round 1/5 (2 addressed, 0 open; commits 539ae89..de17490)
Task 1: complete (commits a4f846b..de17490, review clean)
Task 2: dispatched (base de17490)
Task 2: implementer done fe2c081 (impl agent a9f45d38943c41a67), 30/30. Review HELD: awaiting owner's answer on "dont do that^" (spec React-hooks edit vs Stale class pattern).
Ruling R4: money('1e400') follows real Python ("price must be 1e+06 or less"), not the plan text — spec = parity with Python — cost if wrong: one message string.
Ruling R5: commit trailer "Claude Sonnet 5.5" on fe2c081 left as-is (no history rewrite); later dispatches must use the constraints' trailer — cost: cosmetic.
Task 2: owner says continue (React rule kept). Reviews dispatched.
Owner workflow rule (2026-11-18): pipeline — dispatch task N+1's implementer while task N's reviews run; reviewers are read-only. When a review needs fixes: no NEW implementer starts; let any running implementer finish its commit, run the fix round, then resume. Never two writers at once.
Task 2: review B: 2 Important (ReDoS in pyStrip/text before length check; O(n) len/spread allocation on unbounded strings). Awaiting seat A.
Task 2: minor (deferred, from B): non-object fields TypeError (route must 400); toUpperCase lengthens after limit (ß→SS); kept-id deposit window bypass = Python parity; years <1000 leap-year fringe; mass-assignment guard comment/test; no hostile-input tests (fold into fix round).
Task 2: review A approved (0 Important). Fix round 1 dispatched (B's 2 Important + hostile-input tests), fix base fe2c081 (abfc732 is a docs commit on top).
Task 2: minor (deferred, from A): RED run skipped; decimal underscore parsing narrower than Python; repr() doesn't escape control chars; 2019.0 floats accepted (JSON can't tell); text exported, edit 5th arg today, testing.ts helper.
Carry to Task 3 (from A ⚠️): store loader must fill Python dataclass defaults for stored lines (qty=1, price/labor=null, code='', id=0) and deposits (method='cash', date='', note='', id=0) before totals/edit see them — as tickets.from_dict.
Task 2: fix round 1 committed e3c7105 (re-review dispatched)
Task 3: dispatched (base e3c7105), in parallel with Task 2 re-review
Task 2: fix round 1/5 (2 addressed, 0 open; commits abfc732..e3c7105)
Task 2: complete (commits de17490..e3c7105, review clean)
Task 2: minor (deferred, from re-review): 100ms timing asserts may flake on CI; padding >4x limit refused (documented parity diff).
Task 3: implementer done 343870a (agent a6c4d3b42220993a4); reviews A+B dispatched
Task 4: dispatched (base 343870a), parallel with Task 3 reviews
Task 3: review B approved (0 Important).
Task 3: minor (deferred, from B): one corrupt row 500s whole list (Python parity); non-object data/line/deposit not treated as corrupt; unknown-key big ints / int-like key order not byte-exact (narrow "byte for byte" comment); deep nesting RangeError on save (rolled back); sync driver blocks event loop up to 5s, no past-5s test; openDb leaks handle on DDL failure; test cleanup gaps (kill child in finally, stderr unread, db?.close); statements re-prepared per call.
Carry to Task 5 (from B ⚠️): error mapping must turn NotFound/Stale/Invalid/SQLITE_BUSY/SyntaxError/RangeError/TypeError into 404/409/400/500 without echoing or crashing.
Task 3: review A: 1 Important (typecheck + webpack build share apps/api/dist → flaky CI; pre-existing from T1 config). Fix round queued: waits for Task 4 implementer to commit (owner rule: no two writers).
Task 3: minor (deferred, from A): py-json/errors.ts extra files (keep); rows missing desc/amount load undefined (Python raises); two-connection stale test not ported; test output noise (NO_COLOR/localStorage warnings); @shop/domain not declared in apps/api/package.json.
Task 4: implementer done 6595d10 (agent ad1b867f1d2874b8f), 46/46; reviews A+B dispatched
Task 3: fix round 1 dispatched (fix base 6595d10)
Task 3: fix round 1 committed fecdd6e; re-review dispatched
Task 5: dispatched (base fecdd6e), parallel with Task 3 re-review + Task 4 reviews
Task 3: fix round 1/5 (1 addressed, 0 open; commits 6595d10..fecdd6e)
Task 3: complete (commits e3c7105..343870a + fecdd6e, review clean)
Task 3: minor (deferred, from re-review): libs/domain build+typecheck both tsc --build to dist (same config, no fight) - final review glance.
Task 4: review A approved (0 Important). Carry-overs (usage line, shopRoot removal, empty-args→serve, catch cancel, deleteKioskSessions at start) sent to Task 5 implementer.
Task 4: minor (deferred, from A): hidden prompt drops pasted 2nd line; manual TTY check on shop PC (cmd + PowerShell) needed; isPrintable accepts Unicode 16 chars Python refuses; accounts.ts 699 lines (helpers could split to pystr.ts/clientkey.ts).
Task 4: review B approved (0 Important). clientIp test + getpass-style warning sent to Task 5.
Task 4: complete (commits 343870a..6595d10, review clean)
Task 4: minor (deferred, from B) — FINAL REVIEW SHOULD TRIAGE: reset/sign-out and last-admin check not atomic (wrap in BEGIN IMMEDIATE; Python parity); semaphore wait queue unbounded (cap ~64 → Locked busy); HASHERS=4 = libuv pool (UV_THREADPOOL_SIZE=8 in start script?); eviction weakens 24h cap + no prune/cap test (Python parity); literal PIN in interop code string; CLI messages to stdout not stderr.
Session restart 2026-11-19: Task 5 implementer resumed (partial uncommitted work in tree); carry-over notes re-sent.
Task 5: implementer done 70bea7d (agent a036e4fb2e66df2b1), 67/67; reviews A+B dispatched
Ruling R6: the built server is shop-web/apps/api/dist/main.js (webpack), not shop-web/dist/apps/api/main.js as spec/plan say — the real path wins in the usage line and in Task 11's start-shop.bat — cost if wrong: one path string.
Task 6: dispatched (base 70bea7d), parallel with Task 5 reviews. Carries: repeat JSON bad-request + stall tests on /api/tickets; fix cli usage path (R6).
Task 5: review B: 1 Important (no JSON nesting limit; "too deep" test posts invalid JSON). Fix round waits for seat A + Task 6 implementer commit.
Task 5: minor (deferred, from B): no unhandledRejection safety net in main.ts (cheap, fold into fix); duplicate sid first-wins vs Python last-wins; no Host allowlist (DNS rebinding; Python parity); chunked >1MB overflow path untested; early 403/401/404 replies lack Connection: close; `exclusive: true` comment misleading; startServer opens DB before listening.
Task 5: review A approved (0 Important).
Ruling R7: escalate two robustness minors to the Task 5 fix round — (A5) no 'error' listener on the server after listen (EMFILE kills process) and (B1) no unhandledRejection/uncaughtException safety net — because a process crash takes the live shop down (spec anti-goal) — cost if wrong: two small handlers.
Task 5: minor (deferred, from A): global Stale/Refused→409 without ticket may mask a missing route catch (Python: Refused=400 outside ticket()); log actor set in fewer places; mechanic unknown /api/ path 404 vs Python 403; clientIp treats ::ffff:127/104 loopback (Py3.13 behaviour); refuseCrossSite all non-GET/HEAD; test output localStorage ExperimentalWarning; loadConfig walk-up untested in the webpack bundle (check in Task 11 switch-check).
Task 5: fix round 1 queued (nesting limit + R7), waits for Task 6 implementer commit.
Task 6: implementer done 7b5df3f (agent a1a21622be152fa2a), 80/80; reviews A+B dispatched
Task 5: fix round 1 dispatched (fix base 7b5df3f)
Task 5: fix round 1 committed ac035a8; re-review dispatched
Carry to Task 11: consider a restart watchdog (uncaughtException keep-alive per R7 may leave state half-updated; Node advises restart).
Task 7: dispatched (base ac035a8), parallel with Task 6 reviews + Task 5 re-review
Task 5: fix round 1/5 (4 addressed, 0 open; commits 7b5df3f..ac035a8)
Task 5: complete (commits fecdd6e..70bea7d + ac035a8, review clean)
Task 5: minor (deferred, from re-review): no test with literal \\ before closing quote; {log: config.log, ...opts} undefined override; app.ts double blank line.
Task 6: review B approved (0 Important).
Task 6: minor (deferred, from B): move() error echoes unbounded `to` (validate STATUSES first; matters if pages innerHTML errors — check in T10); vehicles.json BOM/UTF-16 → {} silently (strip BOM, log once); idempotency token may return recycled id (store created too); parts.csv readFileSync per request (mtime cache); access-control test gaps (status/id/created/mech_edit in bodies ignored, __proto__ body, store.save-Stale race path, %31%32 doesn't pin decode); http-core 2MB/5s test flaky under load; mechanic 404 vs 403 no security impact.
Task 6: review A approved (0 Important).
Task 6: complete (commits ac035a8^..7b5df3f, i.e. 70bea7d..7b5df3f, review clean)
Task 6: minor (deferred, from A): mechanic 404 vs Python 403 on any non-matching ticket path (list in parity notes); %31 decodes to 1 (test raw segment; %31%32 test pins nothing); version 1.0 accepted / >2^53 gives 400 not 409 (reviver context.source or document); parts.csv UTF-8 vs cp1252 (latin1 fallback or doc); short CSV row [] vs Python 500 (add to deviations); catch-path 404 untested (stub store.save Stale); flaky http-core 2MB timing test — fold into next fix round that touches http-core.
Task 7: implementer done 043818c (agent a0f143f52bdb91abd), 89/89; reviews A+B dispatched. Concerns: token replay returns reassigned ticket to mechanic; validId duplicated; no tech.html check-in UI (T10); tickets.spec mechanic-403 assertions changed.
Task 8: dispatched (base 043818c), parallel with Task 7 reviews
Task 7: review A approved (0 Important).
Ruling R8: a check-in token replay whose stored ticket the caller no longer `sees(one=True)` answers 404 {"error":"not found"} (as GET /api/tickets/:id), never the ticket — no route may hand a mechanic a ticket it can't see — cost if wrong: one 404 on a rare retry. Goes into Task 7's fix round if B asks for one, else into the Task 9 brief.
Task 7: minor (deferred, from A): validId/ID duplicated users.ts↔tickets.ts (share it when next touched); check-in test should send id:77/odometer/back_note as Python's kiosk test; localStorage ExperimentalWarning noise; /api/users/abc 404 body not asserted.
Task 7: review B: 1 Important (check-in token replay bypasses sees() — same as R8). Fix round queued: waits for Task 8 implementer commit. Scope: R8 404 {"error":"not found"} on replay when !sees(one) (no new ticket) + test; share ID/validId; tests: check-in sends id:77/odometer/back_note, POST /api/users role 'kiosk' refused, body role/name on /api/users/:id ignored.
Task 7: minor (deferred, from B): mechanics can evict desk tokens from shared 500-entry map (per-role map/limit) + no check-in rate limit; {active:false, secret} two-write ordering (Python parity). Carry to Task 9 review: token replay vs soft-deleted ticket, both roles.
Task 8: implementer done 5a77785 (agent accba036ddb5f9b25), 95/95 + domain 35/35; reviews A+B dispatched. Concerns: validation deliberately loose (x-checked-in fields, R1); Ajv per-route instead of express-openapi-validator (gate order); no react deps yet; no shopFetch unit test.
Task 7: fix round 1 dispatched (fix base 5a77785), parallel with Task 8 reviews. Task 9 implementer held until the Task 7 fix commits (owner rule).
Task 8: review A: 1 Important (Move required:[version,to] lets validator answer "to is required" before 404/403 + hand-written "to must be a status" — breaks R1). Fix: prepare() drops x-checked-in names from parent required (guards T9) + tests move {version:1} → 400 'to must be a status', /999/move → 404. Fix round waits for Task 7 fixer commit + seat B.
Task 8: minor (deferred, from A): report says react not installed but react@19.3.1 auto-installed as peer; @types/react absent + skipLibCheck degrades to any (decide: pin now or phase 5); contract example never exercises Line/Deposit/Totals.deposits reply schemas; bad-version contract case passes without validator; NewUser.name maxLength 80 but Python truncates; shopFetch 304 → data undefined (phase 5 note). Carry to Task 10: smoke-check specPath() from the built bundle.
Task 7: fix round 1 committed b942968, 98/98; re-review dispatched. Task 8 fix round waits for seat B (bundle findings); Task 9 held.
Task 8: review B approved (0 Important). Minors folded into fix round: specPath bounded at @shop/api root; integer path ids in spec; verbose errors cleared; query validator uses queryValues; localStorage warning. Deferred: orval dev tree +129 pkgs (esbuild install script stays unapproved).
Task 8: fix round 1 dispatched (fix base b942968), parallel with Task 7 re-review. Task 9 still held.
Task 7: fix round 1/5 (1 Important + 5 minors addressed, 0 open; commits 5a77785..b942968)
Task 7: complete (commits ac035a8..043818c + b942968, review clean)
Ruling R9: a replayed create token whose ticket is deleted answers as GET /:id would for that caller (admin 200, mechanic 410/404), never recreates; token map stores [id, created] so a purged-and-reused id counts as a miss — cost if wrong: a duplicate ticket on a rare retry after purge. Written into task-9-brief.md with the other T9 carries (Python must cope with a deleted row; move() never reaches deleted; cap `to` echo).
Task 8: fix round 1 committed b2690a1, 100/100 + 35/35, test output clean; re-review dispatched. Concern: nx.json copies jest plugin's TS_NODE_COMPILER_OPTIONS (drift on Nx upgrade).
Task 9: dispatched (base b2690a1), parallel with Task 8 re-review
Task 8: fix round 1/5 (1 Important + 8 minors addressed, 0 open; commits b942968..b2690a1)
Task 8: complete (commits 043818c..5a77785 + b2690a1, review clean)
Task 8: minor (deferred, from re-review): specPath stops at first @shop/api package.json (nx prune dist/package.json would lack openapi.yaml); checkedIn infinite recursion on a $ref-only cycle (none today); NODE_OPTIONS in nx.json replaces a user's own for test targets.
Task 9: implementer hit the usage limit mid-run (after RED); resumed via SendMessage after the reset.
Task 9: implementer done 6edf721 (agent aee107d025c69be43), domain 42/42, api 114/114, Python ok, parity OK; reviews A+B dispatched. Concerns: Python Store.list(None) hides deleted + desk edit refuses deleted; shop.py token map id-only (reuse after TS purge); purge log only N>0; 14 local calendar days; deleted_at vs updated 1s.
Task 10: dispatched (base 6edf721), parallel with Task 9 reviews
Owner decision (2026-11-19): switch after T10–T11 + final review, at a quiet time, Python kept as fallback, watch the first day; owner triggers the switch. T11 docs should include this switch/rollback checklist.
Task 9: review B: 1 Important, brief-mandated (mechanic deletes waiting ticket with deposits → purge hard-deletes the deposit record after 14 days). Owner said at brainstorm "everyone can delete ... we can just re-enter the deposit" → asked owner whether purge should skip tickets with deposits. Pending owner answer.
Task 9: minor (from B, fold into fix round): purge skips the MAX(id) row so ids are never reused (protects stale tech/admin/shopwin holders). Deferred: deleted_at clock sanity (>= created); purge busy-path test vs Python lock; shop.py fallback hides deleted with no restore + id-only token map (handover note, T11); restart shopwin.py after deploy (T11 checklist).
Task 9: review A approved (0 Important). Ratified: Python desk edit refuses deleted; purge logs only N>0 (from purgeOnce, not store). Fold into fix round: mixed-list purge_on assertion; contract check of ?status=deleted ListedTicket + one 410 vs Gone; Move.to enum of live statuses (no 'deleted'); drop unreachable 403 on /delete; style nit. Carry to T11 switch-check: confirm a second bind on 127.0.0.1:8081 fails on Windows (TS vs Python never both listen — purge/token safety rests on it).
Task 9: fix round waits for (a) owner answer on deposit purge, (b) Task 10 implementer commit.
Ruling R10 (owner, 2026-11-19): a deleted ticket that has any deposit is never purged (purge_on null), whatever deleted_from is — customers can return after 14 days when parts are delayed. Only deposit-free deleted waiting/working/review tickets purge after 14 days. Spec + T9 fix round + T10 modal text follow this.
Task 10: R10 modal/list text change sent to the running implementer.
Task 11: brief written (rollback arg `start-shop.bat python`, run-shop.cmd restart loop + UV_THREADPOOL_SIZE=8, port double-bind check, switch/rollback checklist, R10 docs). Order: T10 commit → T9 fix round (+R10) → T11 implementer during T10 reviews, if T10 needs no fixes.
Task 10: implementer done 4e62611 (agent a0655f6bdec9ba9a5), e2e 10/10 on built bundle, api 114/114, Python ok, parity OK; specPath + loadConfig walk-up work from dist; no innerHTML in either page. Reviews A+B dispatched. Concerns: autocomplete=off on customer fields; /checkin.html no redirect (never served); playwright-core pinned 1.64.1; tech modal "The desk can restore it."
Task 9: fix round 1 dispatched (fix base 4e62611): R10 + MAX(id) keep + seat A minors + e2e Kept (deposit) assertion. Task 11 held until it commits.
Task 10: review B approved (0 Important). Minors (fold into a T10 fix round if seat A asks for one, else final review): e2e waitUp can hit a stale server on 18081 (check exitCode); bundle.spec runs `main.js admin` against the real repo root — safe only by cli.ts ordering, point at a throwaway tree (do this one regardless, before the switch); tech 400 handler querySelector with server keys (CSS.escape / CUST lookup); closeCust() on sign-out; tech 403 → "Not available" imprecise; CI Chromium cache.
Task 10: review A approved (0 Important).
Ruling R11: tech modal "The desk can restore it." accepted over the brief's 14-day line — under R10 a deposit ticket is never purged and mechanics can't see deposits, so "14 days" could be false — cost: none.
Task 10: polish round (minors, both seats) queued after the T9 fix commits, before T11: bundle.spec on a throwaway tree; e2e waitUp checks exitCode; admin delete when S.cur replaced mid-modal → message, not silent; tech maxlength 80; CSS.escape/CUST lookup for error keys; closeCust() on sign-out; tech new card survives a stale poll; Python fallback Deleted view → NOT_HERE; purged-ticket 404 vs NOT_HERE (distinguish route-missing). Deferred: aria-describedby on .ferr; CI Chromium cache. README kiosk text → T11 (already in scope).
Task 9: fix round 1 committed 8ef7678 (domain 43/43, api 117/117, e2e 10/10 incl. Kept (deposit), Python ok, parity OK); re-review dispatched (opus: data-loss path).
Task 10: polish round dispatched (base 8ef7678), parallel with Task 9 re-review. Task 11 after it commits.
Task 9: re-review: findings 1–7 addressed; 1 NEW Important — store fromRow/complete/items() turns non-array deposits (null, single object, string) into [] before purgeable, so a damaged deposit row is purged (fails open). Fix round 2 queued after the T10 polish commit: purge + purgeOn judge the RAW stored deposits (purge only when key missing or Array.isArray && length 0) + tests {"amount":100} and null → kept; also fix stale design-doc lines 95/110/111. Task 11 waits for it.
Task 10: polish round committed 7b0f79e (e2e 17/17, api 117/117, Python ok, parity OK); re-review dispatched. Note: item 8 uses a POST /api/tickets/0/restore probe on empty Deleted list — reviewer asked to judge vs a GET signal.
Task 9: fix round 2 dispatched (fix base 7b0f79e).
Task 10: polish round re-review: all 9 addressed, 0 new Important. Probe POST /api/tickets/0/restore kept (side-effect free, once per load, no reliable GET signal).
Task 10: fix round 1/5 (9 minors addressed, 0 open; commits 8ef7678..7b0f79e)
Task 10: complete (commits 6edf721..4e62611 + 7b0f79e, review clean)
Task 10: minor (deferred): accepted card re-added as waiting by a stale poll (edge); probe leaves one shop.log 404 per load.
Task 9: fix round 2 committed 4505457 (domain 44/44, api 118/118, e2e 17/17, Python ok, parity OK); re-review dispatched (opus). Implementer edge: restore normalises damaged deposits to [] (re-delete then counts deposit-free) — reviewer to rate.
Task 11: dispatched (base 4505457), parallel with Task 9 fix-2 re-review.
Task 9: fix-2 re-review: NOT ADDRESSED for the main path — a damaged live row deleted via the TS route: save() → toData → complete() writes deposits [] so the row later purges; edit/move/restore also destroy the raw value (shared-schema breach). Fix round 3 queued after the Task 11 commit.
Ruling R12: store.save preserves a stored non-array `deposits` value verbatim unless the request supplied a validated deposits list (admin edit) — keeps unknown data per the shared-schema rule and keeps R10 fail-closed — cost if wrong: a damaged value lingers until the desk re-enters deposits. Fix 3 also: holds() fallback `?? true`; tests: live damaged row ({"amount":100}, null, "100") deleted via route → purge 15+ days kept + purge_on null; delete→restore→re-delete keeps raw; doc ~95 wording + record R11 tech modal text.
Task 11: implementer done 9f997e6 (agent ae1599f377ed19df4); switch-check `ready` (twice, uncached); port double-bind refused both ways on this PC. Never ran start-shop.bat. Concerns: idle scratch `cmd /K shop-web\tools\run-shop.cmd` window PID 3856 left open (controller checked: no node child, no db/log written in worktree; live pythonw shop.py 9392 + phone.py --tunnel 12868 untouched) — owner may close it; loop never restarts after uncaughtException (R7 keep-alive) — reviewers to recommend; plain copy backup vs hot journal; extras (Python fallback if main.js unbuilt, env clearing, .gitattributes CRLF, Startup shortcut note). Reviews A+B dispatched.
Task 9: fix round 3 dispatched (fix base 9f997e6, R12), parallel with Task 11 reviews.
Usage limit hit (all three agents stopped); after the reset all three resumed via SendMessage.
Task 11: review B: 3 Important — I-1 restart loop no back-off/cap (EADDRINUSE spins + floods shop.log; double-click start-shop.bat triggers it); I-2 daily copy not atomic/consistent (no errorlevel check, truncated copy sticks for the day; hot journal after Stop-Process -Force) — controller checked live DB journal_mode read-only: 'delete' (not WAL), so Important not Critical; I-3 R7: exit(1) on uncaughtException only together with I-1 back-off, log 'started' line, HANDOFF note that restart clears lockouts.
Ruling R13: replaces R7's keep-alive for uncaughtException — log class, exit(1), run-shop.cmd restarts with back-off (5 s doubling to 5 min, reset after a 60 s run); EADDRINUSE → distinct exit code 3 → loop logs one line and stops; unhandledRejection stays log-only — cost if wrong: an attacker who can trigger uncaught exceptions resets in-memory lockouts (back-off caps the rate; noted for phase 4).
Ruling R14: daily backup uses SQLite online backup (python sqlite3 .backup or node:sqlite) to a .tmp then move on success, errorlevel checked — supersedes the plan's plain copy — cost: none.
Task 11: minor from B (fold in): M-1 tighten cmd.exe match; M-2 scope node match to this checkout; M-3 absolute node/powershell paths; M-4 switch-check cleanup (error listener, said timeout, await exited, try/finally rmSync); M-5 unknown arg → message + stop; M-6 HANDOFF "daily" wording; M-7 drop admin username from HANDOFF; M-8 README note tunnel restarts; M-9 not-built fallback log (ok). Fix round waits for seat A + Task 9 fix-3 commit.
Task 11: review A approved (0 Important); agrees R13 (exit(1) on uncaughtException, rejection log-only, + a timer-throw test). Minors folded into the T11 fix round: InvariantCulture date stamps; HANDOFF R1–R14 + R12 supersedes the restore-[] line; add dropped deferred minors (T3 non-object line/deposit, T2 non-object fields 400, T4 literal PIN in interop, T6 %31, T8 bad-version case, T1 engines/moduleNameMapper, T9 calendar days/1 s); README "every test" excludes e2e; "phone / iPad" wording; owner to close the leftover "Shop server" window before switch day.
Task 9: fix round 3 committed 956cb02 (domain 44/44, api 131/131, e2e 17/17, Python ok, parity OK); re-review dispatched (opus). Limit: R12 covers deposits only (non-list lines still normalised).
Task 11: fix round 1 dispatched (fix base 956cb02): R13 + R14 + B M-1..M-8 + A minors, parallel with Task 9 fix-3 re-review.
Task 9: fix-3 re-review: addressed, 0 new Important.
Task 9: fix rounds 3/5 (all addressed, 0 open; commits 4e62611..8ef7678, 7b0f79e..4505457, 9f997e6..956cb02)
Task 9: complete (commits b2690a1..6edf721 + 8ef7678 + 4505457 + 956cb02, review clean)
Task 9: minor (deferred, final review): desk page can't see a damaged deposits value (reply shows []) → no deposit warning, "within 14 days" message, plain "Kept" — safe direction; could expose a `deposits_unreadable` flag in the admin reply.
Task 11: fix round 1 committed 4663be9 (switch-check ready; api 132/132; e2e 19/19 incl. exit-1 timer throw + exit-3 port taken); leftover window PID 3856 gone; re-review dispatched. Final whole-branch review waits for it.
Task 11: fix round 1/5 (3 Important + minors addressed, 0 open; commits 956cb02..4663be9)
Task 11: complete (commits 4505457..9f997e6 + 4663be9, review clean)
Task 11: minor (deferred): run-shop.cmd loop match not scoped to this folder; node match path-spelling (8.3/subst) fails safe; GitHub login still in HANDOFF:137/181; python backup retries forever on SQLITE_BUSY; `)`/`&` in arg echo.
Final review: dispatched — two seats (opus), diff main...ts-shop-server (lockfile + gen excluded), triage every deferred minor.
Final review A: approved, 0 Critical/Important; FIX-BEFORE-SWITCH none. Minors for a final doc/polish round: stale spec 117 (R6 path) / 119 (fallback caveat) / plan 360; spec phase 3 note R13/R14; HANDOFF:26 "R1–R11"; copy ledger to a durable tracked path (docs/superpowers/ledgers/) before worktree cleanup; tech.html probeOpen every 4 s for an off-list open job (probe once per id); Python CHOOSER /checkin link after rollback (README note). Awaiting seat B.
Final review B: approved for the switch, 0 Critical/Important; FIX-BEFORE-SWITCH none from deferred list. New cheap pre-switch items: M-1 exit 3 permanent stop on a slow socket release at switch → retry 3×10 s; M-5 .gitignore tickets.db-* / tickets-backup-*. Notes: M-2 lockout reset rate via crash (no trigger found; phase 4 persist), M-3 mechanic 24 h lockout by anyone (Python parity), M-4 CF-Connecting-IP spoofable from loopback (Python parity), M-6 npm ci needs registry + dev tree, M-7 restart forgets create tokens. Check on switch day: cookie Secure via tunnel; one `started` line.
Final polish round dispatched to the T11 implementer (base 4663be9): B M-1, M-5; A minors 1,2,3,5; HANDOFF switch-day notes; durable ledger copy (redacted).
