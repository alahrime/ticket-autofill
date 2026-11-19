# TypeScript Shop Server (parity, delete, switch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript Express server in an Nx monorepo (`shop-web/`) that replaces `shop.py` drop-in, adds ticket delete / restore / 14-day purge, retires the kiosk, lets mechanics check customers in, and is ready to switch over in `start-shop.bat`.

**Architecture:** `libs/domain` ports the ticket rules from `tickets.py`. `apps/api` ports `shop.py` + `accounts.py` + `pinweb.py` onto the same `tickets.db` (same tables, same JSON, same PBKDF2 hashes and session tokens), so phones, the old `web/*.html` pages and Python's `shopwin.py` keep working. An OpenAPI file is the contract, with an Orval-generated client for the React pages that come later.

**Tech Stack:** Node 26.13.1, TypeScript (strict), Nx, Express 5, `node:sqlite`, Jest + supertest, Playwright, OpenAPI 3.1 + Orval, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-18-typescript-shop-server-design.md`. This plan covers its phases 1–3: parity, delete, switch, plus the kiosk retirement and mechanic check-in API. Phases 4–5 (bill history, backups, React pages) get their own plans after this one lands.

**Execution (owner's rule):** per task, one implementer subagent, then **two senior reviewer subagents**: (a) spec / correctness, (b) security / robustness. Fix until both approve, then commit. Push only when the owner says so. A whole-branch review runs at the end.

## Global Constraints

- Node 26.13.1 LTS on the shop PC (Windows 10). TypeScript `strict: true`. Express 5. SQLite through `node:sqlite` (`DatabaseSync`); `better-sqlite3` only if Task 1's check shows `node:sqlite` can't run under Jest.
- Listen on `127.0.0.1:8081` only. Files are in the repo root (`SHOP_ROOT`, default: the folder holding `shop.py`): `tickets.db`, `parts.csv`, `vehicles.json`, `web/`, `setup_code.txt`, `shop.log`.
- **`tickets.db` is shared with Python.** Tables `tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)` + index `tickets_status`, `users`, `sessions`, exactly as `tickets.py` / `accounts.py` create them. `data` is the JSON of every `tickets.Ticket` field except `id` and `status`. TS must write every Python field and must keep unknown keys it reads.
- **Shared-schema rule:** any field TS adds to ticket JSON is also added to `tickets.Ticket` (default `""`) in the same commit.
- Times: local time, ISO, seconds, no offset (`2026-11-18T14:03:09`), as Python's `datetime.now().isoformat(timespec="seconds")`.
- Money: integer cents inside; half-up on the typed digits (`cents()`); written to JSON as numbers (`100`, `12.5`) as Python floats are.
- Status codes and error messages match `shop.py` wherever a Python test checks them. Errors never echo internals (500 → `{"error": "server error"}`).
- Passwords / PINs: `pbkdf2$<iters>$<salt_hex>$<hash_hex>`, sha256, 200 000 iterations, 16-byte salt. Session token `base64url(32 random bytes)` in cookie `sid`, stored as sha256 hex. Lifetimes: admin 7 days, mechanic 30 days.
- **The kiosk role is not ported.** `/checkin` → 303 to `/`, `/api/kiosk*` → 404, `role = 'kiosk'` sessions deleted at start.
- No customer data in git or tests: made-up names only (JANE DOE / Jane Testcase, `(555)010-0000`, `XKS-4827`, `tst-0001`). `tickets-backup-*.db` is git-ignored.
- Python tests stay green: `for f in tests/test_*.py; do python "$f"; done` prints `ok` for each.
- Commit only your own files; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **Python writes while Node holds the DB.** `shopwin.py` marks a ticket filled while the server saves another. Node waits (busy timeout 5 s) instead of failing with "database is locked." Test in Task 3.
2. **A Python save keeps TS's fields.** After TS writes a ticket with `deleted_*` fields, a Python `Store.save` of that ticket (or any) keeps them. Tests in Tasks 3 and 9.
3. **Nobody signs in again after the switch.** A session cookie issued by Python's `accounts.login` works on the TS server, and a Python-made hash verifies in TS. Test in Task 4.
4. **Money edges.** `"$1,200.005"` → 1200.01; `"1e400"`, `"NaN"`, `"-1"`, `"1000000.01"` refused with Python's messages; qty 1.5 × 33.33 → parts 50.00 (49.995 rounds up). Tests in Task 2.
5. **A ticket deleted under a mechanic's open phone.** The mechanic's next GET gets 410 `{"error": "removed by the desk"}`, the list drops it, and the old `tech.html` shows that message instead of breaking. Tests in Tasks 9 and 10.

---

### Task 1: Nx workspace, CI and the parity guard

**Files:**
- Create: `shop-web/` (Nx workspace: `package.json`, `nx.json`, `tsconfig.base.json`, `jest.preset.js`, `eslint.config.mjs`), `shop-web/apps/api/` (empty Express 5 app with `src/main.ts`), `shop-web/libs/domain/` (TS lib, Jest)
- Create: `shop-web/PARITY`, `shop-web/tools/parity-guard.mjs`, `.github/workflows/ci.yml`
- Modify: `.gitignore` (add `shop-web/node_modules/`, `shop-web/dist/`, `shop-web/.nx/`, `tickets-backup-*.db`)
- Test: `shop-web/apps/api/test/sqlite.spec.ts`

**Interfaces:**
- Produces: `npx nx run-many -t lint typecheck test build` works from `shop-web/`. Project names `api`, `domain`. Import alias `@shop/domain`.
- Produces: `node tools/parity-guard.mjs` exits 0 when the git blob hashes (`git hash-object`) of `shop.py`, `tickets.py`, `accounts.py`, `pinweb.py` equal those listed in `shop-web/PARITY` (lines `<sha> <file>`). Otherwise it exits 1 with `Python server changed: <files>. Port the change to shop-web, then run: node tools/parity-guard.mjs --update`. `--update` rewrites PARITY.

- [ ] **Step 1:** Create the workspace (`npx create-nx-workspace@latest shop-web --preset=ts --nxCloud=skip --packageManager=npm`), add `@nx/express` + `@nx/jest`, generate `apps/api` and `libs/domain`, upgrade to `express@5`. Use Nx's defaults wherever they don't conflict with this plan.
- [ ] **Step 2: Write the failing test** `sqlite.spec.ts`: `it('opens node:sqlite under jest')`. Open `new DatabaseSync(':memory:')`, create a table, insert, select; `expect(row.x).toBe(1)`.
- [ ] **Step 3:** Run `npx nx test api`. Expected: PASS once the Jest config resolves `node:sqlite`. If it can't be made to resolve, switch the plan to `better-sqlite3` and record that in `shop-web/README.md`.
- [ ] **Step 4:** Write `parity-guard.mjs` and `PARITY`, generated with `--update` at this commit. Check: run it, expect exit 0. Temporarily add a comment to `pinweb.py` in the working tree, run again, expect exit 1 naming `pinweb.py`, then revert the change.
- [ ] **Step 5:** `.github/workflows/ci.yml`, on push and pull_request, `windows-latest`:
  - Job `shop-web`: setup-node 26, `npm ci`, `npx nx run-many -t lint typecheck test build`, `node tools/parity-guard.mjs` (working directory `shop-web`).
  - Job `python`: setup-python 3.12, `pip install -r requirements.txt`, the test-script loop. A failing script fails the job.
- [ ] **Step 6:** `shop-web/README.md`, short: what it is, `npm ci`, `npx nx test api`, `npx nx build api`, how the parity guard works.
- [ ] **Step 7:** Commit: `feat(shop-web): Nx workspace, CI, parity guard`.

### Task 2: Ticket rules in `libs/domain`

**Files:**
- Create: `shop-web/libs/domain/src/ticket.ts` (types + constants), `clean.ts` (text, money, cents, normalize), `rules.ts` (edit, move, totals), `vin.ts`, `index.ts`
- Test: `shop-web/libs/domain/src/*.spec.ts`

**Interfaces:**
- Produces (exported from `@shop/domain`):
  - `type Line = {desc: string; qty: number; price: number | null; labor: number | null; code: string; id: number}`
  - `type Deposit = {amount: number; method: 'cash'|'card'|'check'|'other'; date: string; note: string; id: number}`
  - `type Ticket = {id; status; first; last; phone; year; make; model; plate; request; mechanic; odometer; vin; notes; lines: Line[]; deposits: Deposit[]; back_note; mech_edit; created; updated; version: number; [extra: string]: unknown}`. Field names are exactly Python's. `extra` carries unknown JSON keys through.
  - `class Invalid extends Error { errors: Record<string, string> }` (message `"k: v; k2: v2"`), `class Refused extends Error`, `class Stale extends Error { ticket: Ticket }` (message `"changed on another device"`)
  - `MOVES: ReadonlySet<string>` (as `"from>to"`), `MECHANIC_EDITS`, `MECHANIC_KEYS`, `REQUIRED`, `UPPER`, `TEXT`, `LONG`, `METHODS`, and the limits `MAX_LINES=100, MAX_MONEY=1e6, MAX_QTY=1e4, MAX_DEPOSITS=50, DEPOSIT_DAYS=366`
  - `squash(s: unknown): string`, `nowIso(d = new Date()): string`
  - `money(v: unknown, name: string, top = MAX_MONEY): number | null` (throws `Error` with Python's message)
  - `normalize(fields: Record<string, unknown>, opts?: {create?: boolean; kept?: Set<number>; today?: Date}): {clean: Partial<Ticket>; errors: Record<string, string>}`
  - `newTicket(clean: Partial<Ticket>, now: string): Ticket` (defaults as the dataclass)
  - `edit(t: Ticket, fields: Record<string, unknown>, who: 'desk'|'mechanic', now = nowIso): Ticket` (mutates and returns `t`)
  - `move(t: Ticket, to: string, mechanic?: string, note?: string): Ticket`
  - `totals(t: Ticket): {parts: number; labor: number; total: number; deposits: number}`
  - `vinValid(v: string): boolean` (`read.vin_valid`), `vinWarning(vin: string): string`

- [ ] **Step 1: Write the failing tests.** Port every case in `tests/test_tickets.py` that doesn't touch `Store` or `to_draft`, keeping assertions and messages, plus:
  - `money('$1,200.005','price')===1200.01`; `money('','price')===null`.
  - `money('1e400')`, `money('NaN')` throw `"price must be a number"`; `money('-1')` throws `"price can't be negative"`; `money('1000000.01')` throws `"price must be 1e+06 or less"`. Use Python's `{top:g}` text, checked against Python's real output, not guessed.
  - `totals` with one line `{qty:1.5, price:33.33}` → `parts 50`.
- [ ] **Step 2:** Run `npx nx test domain`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - Money is integer cents parsed from the decimal string, half-up, no float maths.
  - `totals`: each line's `qty×price` is computed as `qty_hundredths × price_cents / 100`, half-up. It stays exact because the maximum is about 1e14, under 2^53.
  - `vinValid` uses `read.py`'s transliteration table and weights.
  - Today's date (deposit window, year range) comes from `opts.today` for tests.
- [ ] **Step 4:** Run `npx nx test domain`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(domain): ticket rules ported from tickets.py`.

### Task 3: Ticket store over `tickets.db`

**Files:**
- Create: `shop-web/apps/api/src/db.ts`, `shop-web/apps/api/src/store.ts`
- Test: `shop-web/apps/api/test/store.spec.ts`, `shop-web/apps/api/test/interop-store.spec.ts`, `shop-web/apps/api/test/py.ts` (helper: `py(code: string, env?): string` runs `python -c` with the repo root on `sys.path`, returns stdout, throws on exit ≠ 0)

**Interfaces:**
- Consumes: `@shop/domain` (`Ticket`, `normalize`, `newTicket`, `Invalid`, `Stale`, `nowIso`).
- Produces:
  - `openDb(path: string): DatabaseSync` (creates the `tickets` table + index if missing, `PRAGMA busy_timeout = 5000`, journal mode left as is)
  - `class TicketStore { constructor(db: DatabaseSync); create(fields: Record<string, unknown>): Ticket; get(id: number): Ticket | null; list(statuses?: string[]): Ticket[]; save(t: Ticket, version: number): Ticket }`
  - `list` is newest first, `undefined` = all. `save` does `BEGIN IMMEDIATE`, re-reads, throws `Stale(stored)` on a version mismatch or `KeyError`-equivalent `NotFound` for an unknown id, writes `version+1`, `updated=nowIso()`, keeps `created`, commits; rolls back on any throw.

- [ ] **Step 1: Write the failing tests.**
  - `store.spec.ts` ports `Store` cases from `tests/test_tickets.py`: create / get / list order / status filter / save bumps version / stale save → `Stale` carrying the stored ticket.
  - `interop-store.spec.ts`:
    - `it('python reads what TS wrote')`: TS creates a ticket with lines and deposits; Python `tickets.Store(path).get(id)` prints `asdict`; fields equal.
    - `it('TS reads what python wrote, unknown keys kept')`: Python creates a ticket and adds key `"zz_future": "x"` to `data` by raw SQL; TS `get` → `t.zz_future === 'x'`; TS `save` keeps `zz_future`.
    - `it('waits for a python write lock')`: Python holds `BEGIN IMMEDIATE` for 1.0 s in a child process; TS `save` started meanwhile succeeds within 5 s.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement `db.ts`, `store.ts`. Row → ticket: `JSON.parse(data)` plus `id` and `status`. Ticket → data: every field except `id` / `status`, unknown keys included.
- [ ] **Step 4:** Run `npx nx test api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): ticket store shared with python`.

### Task 4: Accounts, sessions, lockout, admin command

**Files:**
- Create: `shop-web/apps/api/src/accounts.ts`, `shop-web/apps/api/src/cli.ts`
- Test: `shop-web/apps/api/test/accounts.spec.ts`, `shop-web/apps/api/test/interop-accounts.spec.ts`

**Interfaces:**
- Consumes: `openDb`, `squash`, `Invalid`.
- Produces:
  - `hashSecret(secret: string, iterations = 200_000, salt?: Buffer): Promise<string>`, `checkSecret(secret: string, stored: string): Promise<boolean>`, `tokenHash(token: string): string`, `clientKey(client: string): string`, `checkNewSecret(role: string, secret: unknown): void`, `cleanName(name: unknown): string`
  - `class LoginFailed extends Error`, `class Locked extends Error { retryAfter: number; busy: boolean }`
  - `type User = {id: number; name: string; role: 'admin'|'mechanic'; active: boolean; created: string}`, `type Session = {role: string; user_id: number|null; name: string; expires: number}`
  - `class Accounts { constructor(db: DatabaseSync, opts?: {iterations?: number; now?: () => number}); get(id); find(name); list(role?, active?): User[]; add(name, role, secret): Promise<User>; setSecret(id, secret): Promise<void>; setActive(id, active: boolean): void; login(name, secret, role, client): Promise<{token: string; user: User}>; session(token: unknown): Session | null; logout(token: unknown): void; revokeUser(id): void; deleteKioskSessions(): number; unlock(name): void }`
  - `makeAdmin(accounts, name, password): Promise<User>`
  - `cli.ts`: `runAdminCommand(args: string[], io: {prompt(q: string, hidden: boolean): Promise<string>; out(s: string): void}): Promise<number>` (exit code), messages as `shop.py main()`.
- Rules ported exactly from `accounts.py`:
  - lockout windows and limits (5 per name per 10 min; 20 per name per 24 h → locked 24 h; 20 per client per 10 min);
  - every attempt counts until it succeeds;
  - unknown names hash against a dummy;
  - at most 4 hashing at once, a 5th waits 2 s then `Locked(5, busy)`;
  - `NOCASE` + casefold duplicate-name check;
  - last-admin rule;
  - reset/turn-off revokes sessions;
  - expired / off sessions are deleted on read.
- Hashing uses async `crypto.pbkdf2`, so the event loop isn't blocked.

- [ ] **Step 1: Write the failing tests.**
  - `accounts.spec.ts` ports every case in `tests/test_accounts.py`, with an injected `now`.
  - `interop-accounts.spec.ts`:
    - `it('python hash verifies in TS and back')`.
    - `it('python session token works in TS')`: Python `Accounts(path).login(...)` prints the token; TS `session(token)` returns the user.
    - `it('kiosk sessions are deleted')`: insert a kiosk session row; `deleteKioskSessions()` → 1; `session(thatToken)` → null.
  - CLI: port `test_make_admin_command` with a fake `io`.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx nx test api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): accounts, sessions and lockout compatible with python`.

### Task 5: HTTP core, pages, sign-in and setup

**Files:**
- Create: `shop-web/apps/api/src/config.ts`, `src/app.ts`, `src/http/security.ts`, `src/http/pages.ts`, `src/http/log.ts`, `src/routes/auth.ts`, `src/server.ts`; modify `src/main.ts`
- Test: `shop-web/apps/api/test/http-core.spec.ts`, `test/auth.spec.ts`, `test/helpers.ts`

**Interfaces:**
- Consumes: `TicketStore`, `Accounts`, `makeAdmin`.
- Produces:
  - `type Config = {host: string; port: number; root: string; db: string; catalog: string; vehicles: string; web: string; setup: string; log: string}`, `loadConfig(env = process.env): Config` (`SHOP_ROOT`, `SHOP_PORT` overrides)
  - `createApp(deps: {store: TicketStore; accounts: Accounts; config: Config}): Express` (no listening)
  - `startServer(config: Config): Promise<{close(): Promise<void>}>`. It opens the DB, runs `accounts.deleteKioskSessions()`, makes the setup code, and listens with `exclusive: true`. A second copy on the same port must reject with `EADDRINUSE`.
  - `main.ts`: no args → `startServer(loadConfig())`; `admin <name>` → `runAdminCommand`.
  - Middleware (in `security.ts`), each its own export so later routes reuse them:
    - `securityHeaders` (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, CSP on HTML only, the exact `pinweb.CSP` string);
    - `refuseCrossSite` (POST; `Sec-Fetch-Site` wins, else `Origin` vs `Host`);
    - `jsonBody` (Content-Type must be `application/json`, 1 MB limit → 400 `"Request too big."`, non-object → 400 `"expected a JSON object"`);
    - `sessionOf(req)` (`sid` cookie → `Session|null`);
    - `sessionCookie(token|null, role, req)` (flags as `shop.py cookie()`);
    - `clientIp(req)` (`CF-Connecting-IP` only from loopback).
  - Error mapping (`app.ts`): `Invalid` → 400 `{error, errors}`; `LoginFailed` → 401; `Locked` → 429 + `Retry-After`; plain `Error` from input checking (a `BadInput` class) → 400 `{error}`; anything else → 500 `{"error":"server error"}`, with only the error class name logged.
  - `log.ts`: one line per request to `config.log`: `YYYY-MM-DD HH:MM:SS METHOD /path CODE[ role#id] 0.0s`, path without query.
  - Stall: `server.requestTimeout = 20_000`, `headersTimeout = 20_000`. A stalled body ends the request with no reply and logs `dropped`.
- Routes: `GET /` (chooser with only Mechanic and Admin), `/desk` → 302 `/admin`, `/checkin` → 303 `/`, `/admin` and `/tech` (the `web/<name>.html` file read fresh per request for the right role, else the sign-in page), `GET/POST /setup`, `POST /login/admin`, `POST /login/tech`, `POST /logout`, `GET /api/me`. Sign-in, setup and chooser HTML are ported from `shop.py` / `pinweb.page()`, with every value escaped.

- [ ] **Step 1: Write the failing tests.** Port from `tests/test_shop.py`:
  - `test_one_server_per_port`, `test_pages_and_sign_in`, `test_lockout`, `test_cookie_flags`, `test_bad_requests`, `test_stalled_body`, `test_security_headers`, `test_server_error_says_nothing`, `test_cross_site_posts_refused`, `test_sign_in_messages`, `test_first_run_setup`, `test_setup_code_expires`;
  - `test_roles_refused_at_the_wrong_door`, without its kiosk parts.

  Add `it('checkin is gone')`: `GET /checkin` → 303 `Location: /`; `POST /api/kiosk` (admin) → 404; the chooser has no `/checkin` link.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement. `test/helpers.ts` gives `makeServer()` (temp `SHOP_ROOT` holding a copy of `web/`, `parts.csv`, `vehicles.json`, a fresh DB), `signIn(role, name, secret)` → cookie, and `call(path, body?, cookie?, headers?)`.
- [ ] **Step 4:** Run `npx nx test api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): http core, pages, sign-in and first-run setup`.

### Task 6: Ticket, catalog and vehicle routes

**Files:**
- Create: `shop-web/apps/api/src/routes/tickets.ts`, `src/routes/catalog.ts`, `src/view.ts`
- Test: `shop-web/apps/api/test/tickets.spec.ts`, `test/catalog.spec.ts`

**Interfaces:**
- Consumes: Task 5 middleware, `TicketStore`, `@shop/domain`.
- Produces:
  - `asJson(t: Ticket, role: string): object` (`shop.as_json`: mechanics lose `deposits` and get totals `parts`/`labor`/`total` only, plus `vin_warning`)
  - `sees(s: Session, t: Ticket, one = false): boolean`, `mine(s, t)`
  - `mechanicNamed(name: unknown, keep = ''): string` (active mechanic accounts, casefold match, throws `Invalid({mechanic: 'pick a mechanic from the list'})`)
  - `hints(q: string, catalogPath: string): Hint[]` (max 8; `parts.csv` columns `code,description,aliases,sided,part_price,labor_price`)
- Routes, behaviour as `shop.py`:
  - `GET /api/tickets[?status=a,b]` with ETag / 304 per role + user + filter + `(id, version)` list;
  - `GET /api/tickets/:id`;
  - `POST /api/tickets` (admin: whole invoice + idempotency `token`, 8–64 chars, remembers the last 500);
  - `POST /api/tickets/:id` (edit, `version` required, 409 `{error, ticket}` on Stale / Refused, 404 if no longer visible);
  - `POST /api/tickets/:id/move`;
  - `GET /api/catalog?q=`, `GET /api/vehicles` (file bytes read once; `{}` if missing or bad).

  The id regex is `[0-9]{1,9}`.

- [ ] **Step 1: Write the failing tests.** Port `test_full_flow`, `test_admin_enters_the_whole_invoice`, `test_deposits_admin_only`, `test_vin`, `test_etag_per_role`, `test_catalog`, `test_vehicles` from `tests/test_shop.py`.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx nx test api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): ticket, catalog and vehicle routes`.

### Task 7: Users, mechanics and mechanic check-in

**Files:**
- Create: `shop-web/apps/api/src/routes/users.ts`; modify `src/routes/tickets.ts`
- Test: `shop-web/apps/api/test/users.spec.ts`, `test/checkin.spec.ts`

**Interfaces:**
- Consumes: `Accounts`, Task 5/6 helpers.
- Produces:
  - Routes (admin only), as `shop.py`:
    - `GET /api/mechanics` → `{mechanics: string[]}`;
    - `GET /api/users`;
    - `POST /api/users {name, role, secret}`;
    - `POST /api/users/:id {secret?, active?}`: all-or-nothing; own-password change re-issues the cookie.
  - **New:** `POST /api/tickets` by a **mechanic**:
    - keeps only `first, last, phone, year, make, model, plate, request`, drops every other key;
    - creates a `waiting`, unassigned ticket;
    - replies 200 with `asJson(t, 'mechanic')`;
    - takes the same idempotency `token` as the admin.

- [ ] **Step 1: Write the failing tests.**
  - Port `test_users_and_sessions`, `test_user_changes_all_or_nothing` and `test_names_fold_and_owners_match_exactly` from `tests/test_shop.py`.
  - `checkin.spec.ts`:
    - `it('mechanic checks a customer in')`: POST with CAR + `price`, `lines`, `deposits`, `mechanic`, `status` → 200; stored ticket is `waiting`, `mechanic === ''`, no lines, no deposits; the mechanic's list shows it.
    - `it('mechanic check-in validates')`: missing phone → 400 `errors.phone === 'phone is required'`.
    - `it('same token, same ticket')`: two POSTs with one token → one ticket.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx nx test api`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): users routes and mechanic check-in`.

### Task 8: OpenAPI contract and generated client

**Files:**
- Create: `shop-web/apps/api/openapi.yaml`, `shop-web/libs/api-client/` (Nx lib, generated `src/gen/`), `shop-web/orval.config.ts`
- Modify: `shop-web/apps/api/src/app.ts` (request validation)
- Test: `shop-web/apps/api/test/contract.spec.ts`

**Interfaces:**
- Produces:
  - `openapi.yaml` (OpenAPI 3.1) describing every `/api/*` route from Tasks 5–7: bodies, replies, errors. Schemas `Ticket`, `Line`, `Deposit`, `Totals`, `Error`, `User`, `Me`, `Hint`, `NewTicket`, `CheckIn`, `Edit`, `Move`.
  - `express-openapi-validator` checks request bodies and query strings. A validation failure → 400 `{error}`, the same shape as before. The pages already send valid bodies, so no Task 5–7 test changes, and they must still pass.
  - `npx nx run api-client:generate` runs Orval (`react-query` client, `fetch` mutator with `credentials: 'same-origin'`) into `libs/api-client/src/gen`. The output is committed. `typecheck` covers it.
- [ ] **Step 1: Write the failing test.** `contract.spec.ts`:
  - `it('every route is in the spec')`: walk the Express router stack and expect each `/api/*` method + path in `openapi.yaml`.
  - `it('every spec path answers')`: each one returns something other than 404 for a signed-in admin, with valid input from the spec's examples.
- [ ] **Step 2:** Run `npx nx test api`. Expected: FAIL.
- [ ] **Step 3:** Write `openapi.yaml`, wire the validator, configure Orval, generate.
- [ ] **Step 4:** Run `npx nx run-many -t test typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): OpenAPI contract, request validation, Orval client`.

### Task 9: Delete, restore and the 14-day purge

**Files:**
- Create: `shop-web/libs/domain/src/delete.ts`, `shop-web/apps/api/src/purge.ts`
- Modify: `tickets.py` (three fields on `Ticket`), `shop-web/apps/api/src/routes/tickets.ts`, `shop-web/apps/api/src/server.ts` (purge at start + hourly), `shop-web/apps/api/openapi.yaml`, `shop-web/PARITY` (`--update`)
- Test: `shop-web/libs/domain/src/delete.spec.ts`, `shop-web/apps/api/test/delete.spec.ts`, `tests/test_tickets.py` (one new test)

**Interfaces:**
- Produces (domain):
  - `PURGE_DAYS = 14`, `PURGED_FROM = ['waiting','working','review']`
  - `markDeleted(t: Ticket, by: string, now: string): Ticket`: any non-deleted status; sets `deleted_from = status`, `deleted_at = now`, `deleted_by = by` (`"role#id"`), `status = 'deleted'`; throws `Refused('already deleted')`.
  - `restore(t: Ticket): Ticket`: status back to `deleted_from`, the three fields cleared; throws `Refused("it isn't deleted")`.
  - `purgeable(t: Ticket, now: Date): boolean`: `status === 'deleted' && PURGED_FROM.includes(deleted_from) && deleted_at <= now − 14 days`.
- Produces (store / server):
  - `TicketStore.purge(now: Date): number` (hard-deletes purgeable rows in one transaction, returns the count, logs `purged N` only);
  - `startServer` runs `purge` at start and every 3 600 s.
- Routes:
  - `POST /api/tickets/:id/delete {version}`. Admin: any ticket. Mechanic: a ticket `sees(s, t, true)` allows, which covers their own and waiting unassigned ones. Otherwise 404 as for edits. → 200 `asJson`; Stale → 409.
  - `POST /api/tickets/:id/restore {version}`: admin only → 200.
  - `GET /api/tickets?status=deleted`: admin only; each item adds `purge_on` (ISO date, or `null` for `approved` / `filled`). A mechanic asking for `deleted` gets an empty list.
  - Deleted tickets are never in a list unless the admin asks for `deleted`.
  - `GET /api/tickets/:id` on a deleted ticket: admin → 200. A mechanic who would see it under `deleted_from` → **410** `{"error": "removed by the desk"}`. Anyone else → 404.
  - Edits and moves on a deleted ticket → 409 `can't change a deleted ticket` (admin), 404 / 410 (mechanic).
- Python: `deleted_at: str = ""`, `deleted_by: str = ""`, `deleted_from: str = ""` on `tickets.Ticket`.

- [ ] **Step 1: Write the failing tests.**
  - `delete.spec.ts` (domain): markDeleted / restore round-trip keeps every other field; `purgeable` is true at 14 days + 1 s and false at 14 days − 1 s; false for `deleted_from` `approved` and `filled`.
  - `delete.spec.ts` (api):
    - admin deletes a waiting ticket that has a $100 deposit → 200, gone from the board list, present in `status=deleted` with `purge_on` 14 days later;
    - restore → back to `waiting`, deposits intact;
    - a mechanic deletes their own working ticket → 200, then GET → 410 `removed by the desk`;
    - a mechanic can't delete someone else's working ticket → 404;
    - a mechanic can't restore → 403;
    - a stale version → 409;
    - purge with an injected clock removes a 15-day-old deleted `working` ticket but keeps a 15-day-old deleted `approved` and `filled` one.
  - `interop`: `it('python save keeps deleted fields')`: TS deletes, Python loads and saves via `Store.save`, TS still sees all three fields.
  - `tests/test_tickets.py`: `test_deleted_fields_round_trip` (Ticket with the three fields survives `Store.save` / `get`), and `tickets.move(deleted_ticket, "filled")` raises `Refused`.
- [ ] **Step 2:** Run `npx nx test domain api` and `python tests/test_tickets.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the three fields to `tickets.py`. Run `node tools/parity-guard.mjs --update`.
- [ ] **Step 4:** Run `npx nx run-many -t test` and the Python test loop. Expected: all PASS / `ok`.
- [ ] **Step 5:** Commit: `feat: delete, restore and 14-day purge of unfinished tickets`.

### Task 10: Delete, check-in and kiosk removal in the current pages

**Files:**
- Modify: `web/admin.html`, `web/tech.html`
- Delete: `web/checkin.html`
- Create: `shop-web/apps/pages-e2e/` (Playwright, Chromium only, starts the TS server on a temp `SHOP_ROOT` and port 18081), `shop-web/apps/pages-e2e/src/*.spec.ts`

**Interfaces:**
- Consumes: Task 9 routes, Task 7 check-in.
- UI, in each page's existing style and JS (no framework; build DOM with `textContent`, never `innerHTML` with ticket data):
  - **Delete button** on an open ticket (admin: any status; tech: their jobs). It opens a modal `<dialog>` reading `Delete ticket #<id> — <FIRST LAST>, <PLATE>, $<total>?` On a ticket with deposits (admin only) it adds `It has $<sum> in deposits.` It always adds `Deleted tickets can be restored for 14 days.`, or `This ticket stays in the records.` for approved / filled. Buttons: **Delete** / **Cancel**, focus on Cancel, Esc cancels.
  - **admin.html:** a **Deleted** list (`status=deleted`) with purge date and **Restore**. The iPad / kiosk section and its `/api/kiosk*` calls are removed.
  - **tech.html:**
    - a 410 shows `This ticket was removed by the desk.` and drops the job and its local draft;
    - a **New customer** form (first, last, phone, year / make / model using `/api/vehicles` like the admin page, plate, request) posts to `/api/tickets` with a token and then shows the new waiting job.
  - Both pages stay usable at 375 px width.
- [ ] **Step 1: Write the failing tests** (Playwright):
  - `admin delete with deposit warning`: seed a waiting ticket with a $100 deposit, open it, click Delete, the modal text contains `$100.00 in deposits`, confirm, the ticket leaves the board, the Deleted list shows it, Restore brings it back.
  - `tech delete and 410`: mechanic deletes own job and it's gone. A second mechanic page that has the job open polls and shows `removed by the desk`.
  - `tech new customer`: fill the form and submit; the job shows as waiting.
  - `no kiosk`: `/checkin` lands on `/`; admin page has no iPad section.
  - `a11y`: `@axe-core/playwright` on the open modal, no violations.
- [ ] **Step 2:** Run `npx nx e2e pages-e2e`. Expected: FAIL.
- [ ] **Step 3:** Implement the page changes.
- [ ] **Step 4:** Run `npx nx e2e pages-e2e`, then `python tests/test_shop.py`. Expected: PASS / `ok`. If `test_shop.py` relied on `web/checkin.html` or the kiosk, change only those assertions so they read the file's absence as retired, and say so in the commit.
- [ ] **Step 5:** Commit: `feat(web): delete with confirmation, restore, mechanic check-in; retire the iPad`.

### Task 11: Switch-over and docs

**Files:**
- Modify: `start-shop.bat`, `README.md`, `docs/superpowers/HANDOFF.md`, `.gitignore`
- Create: `shop-web/tools/switch-check.mjs`

**Interfaces:**
- `start-shop.bat`:
  - stops any running `python shop.py`, **and** any `node.exe` whose command line contains `shop-web\dist\apps\api\main.js`;
  - copies `tickets.db` to `tickets-backup-YYYY-MM-DD.db` once per day (skips if it exists);
  - then starts `start "" /min node shop-web\dist\apps\api\main.js`. The `pythonw shop.py` line is kept commented as the fallback, with a one-line note.
- `switch-check.mjs`: builds the api and prints `ready` only when all of these pass: `nx run-many -t test`, the parity guard, the Python loop, and the built `main.js` starting on a temp root and answering `GET /` with 200.
- README:
  - the shop server is now `shop-web` (how to build: `cd shop-web && npm ci && npx nx build api`);
  - deleted tickets and the 14-day purge;
  - the iPad is retired;
  - mechanics can check customers in;
  - fallback to `shop.py`, with its caveat that deleted tickets show again there;
    (Superseded after Task 9: on `shop.py` deleted tickets stay hidden and can't be changed; no Restore. See the README and HANDOFF.)
  - "Nothing is deleted" replaced.
- HANDOFF:
  - where things are;
  - the owner's remote-fill decisions (unattended, remote approve, print last via "Save and print order", screenshot to come);
  - **future: stronger sign-in (second factor) for remote control**;
  - phases 4–5 next.
- [ ] **Step 1:** Write `switch-check.mjs`; run `node tools/switch-check.mjs`. Expected: `ready`.
- [ ] **Step 2:** Edit `start-shop.bat`. Run it **only with the owner's go-ahead** (it restarts the live shop server); before that, check its syntax by reading it back.
- [ ] **Step 3:** Update README and HANDOFF.
- [ ] **Step 4:** Commit: `feat: start-shop.bat runs the TypeScript server; docs`.

### Final: whole-branch review

- [ ] Two senior reviewers over the full diff (`git diff main...ts-shop-server`), one for spec / correctness, one for security / robustness, with this plan's Review Focus as their checklist. Fix, re-review, then report to the owner. Merging and the live switch are the owner's calls.
