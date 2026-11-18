# TypeScript shop server, ticket delete and customer history — design

**Date:** 2026-11-18. **Status:** approved by the owner 2026-11-18.
**Replaces:** `shop.py` (the Python shop tickets server) once the new server passes the same tests. **Does not replace:** `shopwin.py`, `app.py`, `invomax.py`, `recipes.py`, `probe.py`. The InvoMax tooling stays in Python because it drives Windows directly.

## Why

1. **Delete tickets.** The owner wants to remove old test data now, and to delete tickets while testing. Today nothing can delete a ticket.
2. **Our own customer history.** InvoMax may fail or become unreachable. The shop needs its own durable record of every completed invoice, reviewable through an API, so the customer's history never depends on InvoMax alone.
3. **The owner's career.** The owner is applying for a senior frontend role whose stack is React 19 + TypeScript, Express, an Nx monorepo, OpenAPI with generated clients (Orval), TanStack Query/Router, Ant Design + Emotion, Jest + Testing Library + Playwright, accessibility testing, GitHub Actions and frontend security (CSP, XSS, token handling). The new server and pages use that stack, so this project shows real, shipped work in it.

## Goals

- A TypeScript Express server that is a **drop-in replacement** for `shop.py`: same port (127.0.0.1:8081, behind the Cloudflare tunnel), same URLs, same JSON shapes, same `tickets.db`, same accounts, sessions and cookies. Phones, iPads and the admin keep working through the switch, and nobody signs in again.
- **Delete and restore** tickets, with a 14-day grace period before unfinished deleted tickets are purged.
- **Customer history:** search customers and list every completed (filled) invoice per customer and per vehicle, admin only.
- The pages move to **React 19 + TypeScript** one at a time, after the server switch.
- **One person can run a whole job from a phone or iPad (owner, 2026-11-18):** check-in, job details, sending to InvoMax, checking InvoMax's final numbers before printing, delete and history.
  - The admin / owner account leads over 90% of jobs, so **every admin screen is built phone-first** and also works on an iPad and the desk PC.
  - Mechanics keep editing the jobs they can see while they work, as today.
- **Next project, its own design (not this one):** a button on the device that starts InvoMax filling on the shop PC, and sends InvoMax's final numbers back to the device for checking. It depends on typing steps not yet built (parts/labor lines, new customer). This design leaves room for it: the final-bill numbers live in `invoice_finals`, whoever records them.
  - **Owner's decisions already on record (2026-11-18):**
    - **Runs with nobody at the PC.** The shop PC only needs to be on, with InvoMax open, the tunnel running and the overlay present.
    - The overlay starts with `start-shop.bat` and is active whenever the tunnel is.
    - The owner **approves the fill remotely** from the device, sees InvoMax's final numbers there, and can **trigger the print remotely**.
    - This **changes a standing rule:** Print is on the never-click list today, and remote print lifts it for that one step.
  - **Print comes last (owner, 2026-11-18):** no automatic print until filling InvoMax's text fields is proven reliable ("no point in printing if the input is flawed").
    - Print opens a modal with a few options. The shop almost always picks **"Save and print order"** or similar.
    - The owner will provide a screenshot of that view when the work gets there.
  - **Sign-in:** remote control is limited to the owner, the sole admin and bill recorder. Stronger sign-in (a second factor) is noted in the README / HANDOFF as a future consideration, not built now.
  - **Still for that design:** remote Stop (nobody can press Esc), and what the device shows while a fill runs.
- An **OpenAPI contract** for every route, with a generated, typed client the React pages use.

## Non-goals

- No change to InvoMax typing or the Ticket Autofill window. The Shop tickets window (`shopwin.py`) changes only for the final-bill capture (phase 4) and the shared-schema rule below.
- No new database engine (no Postgres) and no cloud hosting. Everything stays on the shop PC.
- No Next.js: the job's stack is React + Vite served by Express, and Next.js would duplicate the Express server.
- No multi-tenant / white-label theming, Auth0/OIDC, Contentful, Stripe or localization. These are in the job post, but the shop doesn't need them.

## Anti-goals (a failure even if it works)

- The live shop breaks during the move: a phone loses its job mid-repair, the desk can't send to InvoMax, or staff must sign in again.
- A completed invoice is ever lost from our own records.
- Customer data, `tickets.db` or its backups end up in git.
- Security gets weaker than `shop.py` today (lockouts, cookie flags, cross-site POST refusal, CSP, role checks).

## Constraints

- **Shop PC:** Windows 10, Node 26.13.1 LTS (installed 2026-11-18), Python stays for the InvoMax tools. `start-shop.bat` starts everything at boot.
- **`tickets.db` is shared with Python.** `shopwin.py` reads approved tickets and marks them filled through `tickets.Store` directly, not over HTTP. So the `tickets` table keeps its shape (`id INTEGER PRIMARY KEY, status TEXT, data TEXT` holding JSON), and `version` optimistic locking (`BEGIN IMMEDIATE`, check, write) must stay compatible with `Store.save`.
- **Shared-schema rule:** Python's `Store.save` rewrites `data` from the `Ticket` dataclass, so any field the TS server adds to a ticket's JSON must also be added to `tickets.Ticket`. If it isn't, a Python save wipes it. New data that Python never needs goes in **new tables**.
- **Accounts carry over:** `users` and `sessions` tables, PBKDF2-SHA256 hashes (`pbkdf2$iters$salt_hex$hash_hex`, 200 000 iterations), session token = 32 random bytes urlsafe in the `sid` cookie, stored as SHA-256 hex. Node's `crypto.pbkdf2` reads these as-is.
- The owner's working style: a plan, then per task one implementer plus two senior reviewers (spec/correctness, and security/robustness), fixing until both approve, then commit. Push only when the owner says so.
- Tests must not use real customer data. Use made-up names (JANE DOE, `(555)010-0000`, `XKS-4827`).

## Approaches considered

- **A. Drop-in replacement (chosen by the owner).** Build the whole TS server next to `shop.py`, prove it with the same tests, then switch `start-shop.bat` in one step. Python stays as the fallback. Delete arrives with the switch, not before.
- **B. Route by route behind a proxy.** Express takes port 8081 and forwards routes not yet ported to `shop.py`. Delete ships sooner, but for weeks two servers share one database and the login sessions. Rejected: that's where bugs hide in a live shop.
- **C. Fresh app and new database (Postgres).** The cleanest history schema, but it adds a database service on the shop PC and forces `shopwin.py` to be rewritten. Rejected as too much moving at once.

## Decisions

### Stack (chosen to match the job; the owner asked for this)

- **Nx monorepo** in `shop-web/` at the repo root. Not named `shop/`, so it doesn't collide with `import shop` in Python.
  - `apps/api`: Express 5 + TypeScript.
  - `apps/web`: React 19 + Vite + TanStack Router + TanStack Query + Ant Design + Emotion.
  - `libs/domain`: ticket rules (ported `tickets.py`: normalize, edit, move, totals, `vin_warning`), shared by api and web.
  - `libs/api-client`: generated by **Orval** from `apps/api/openapi.yaml`.
- **SQLite from Node:** `node:sqlite` (built in, no native build on Windows) is preferred. `better-sqlite3` is the fallback if `node:sqlite` falls short. Builder's call, recorded in the plan.
- **Tests:** Jest + supertest for the API, Jest + Testing Library for components, Playwright for end-to-end, and `@axe-core/playwright` for accessibility. **GitHub Actions** runs lint, typecheck, test and build on every push.
- **OpenAPI-first:** `openapi.yaml` is the contract. Request bodies are validated against it, either with `express-openapi-validator` or with zod schemas generated from it (builder's call). Orval generates the client and TanStack Query hooks.

### Parity with `shop.py` (phase 1)

Every route, status code, JSON shape and rule in `shop.py`, `tickets.py` and `accounts.py` is ported as-is:

- (The kiosk role, `/checkin` and the `/api/kiosk*` routes are **not** ported: the iPad is retired. See phase 5.)
- Pages `/`, `/admin`, `/tech`, `/setup` and the redirect `/desk` → `/admin`.
- Login: `/login/admin`, `/login/tech`, `/logout` (server-rendered form posts).
- API routes: `/api/me`, `/api/vehicles`, `/api/catalog`, `/api/tickets` (GET with `status` filter + ETag/304; POST for kiosk and admin, with the idempotency `token`), `/api/tickets/:id` (GET/POST edit), `/api/tickets/:id/move`, `/api/mechanics`, `/api/users` (+ `/:id`), `/api/kiosk`, `/api/kiosk/revoke`.
- Rules: who sees what (`sees`), `version` checks → 409 with the stored ticket, deposits hidden from mechanics, the mechanic-name matching, and the login lockout (per name and per client, the 4-hasher limit, `CF-Connecting-IP` only from loopback).
- Security behaviour: cookie flags (`HttpOnly; SameSite=Strict`, `Secure` behind https), refusing cross-site POSTs (`Sec-Fetch-Site` / `Origin`), JSON-only API posts, the 1 MB body limit, the 20 s stall timeout, the security headers and the CSP, and the `shop.log` request log (ticket ids only, no customer data).
- The existing `web/*.html` pages are served unchanged until React replaces them.
- **Parity target (my call):** `shop.py` / `tickets.py` / `accounts.py` as of the commit the plan starts from. Any change to those files before the switch, by any session, must land in the TS port and its Jest tests in the same commit. The plan names the starting commit, and a CI check fails if those Python files changed after it without the TS side changing too.
- **The proof:** the HTTP cases in `tests/test_shop.py`, `tests/test_tickets.py` and `tests/test_accounts.py` are ported to Jest. The new server must pass all of them before the switch.

### Delete, restore, purge (phase 2)

Owner's decisions (2026-11-18):
- Delete **hides**; it doesn't erase.
- **Everyone who can see a ticket can delete it.**
- A **confirmation pop-up** names the ticket and warns when it has deposits. If a deposit is needed again later, staff re-enter it by hand.
- Unfinished deleted tickets are purged after a grace period of 7–14 days.

Design:
- New status **`deleted`**. New ticket fields: `deleted_at` (ISO time), `deleted_by` ("role#user id") and `deleted_from` (the status it had). Per the shared-schema rule, the same three fields are added to Python's `tickets.Ticket`, defaulting to `""`.
- `POST /api/tickets/:id/delete {version}` → 200 with the ticket. Allowed for an admin on any ticket, and for a mechanic on any ticket `sees(..., one=True)` allows them. A kiosk is never allowed.
- `POST /api/tickets/:id/restore {version}`, admin only → the ticket goes back to `deleted_from`.
- `GET /api/tickets?status=deleted`, admin only → the "Deleted" list, with each ticket's purge date.
- Deleted tickets are left out of every list, unless the admin asks for `status=deleted`. A single GET of a deleted ticket returns 410 `{"error": "removed by the desk"}` to a mechanic, so the phone can say that instead of "not found". The admin still gets it with 200.
- **Grace period: 14 days** (my call, the safe end of the owner's 7–14). One constant, `PURGE_DAYS`.
- **Purge:** at server start and every hour, hard-delete rows with `status = 'deleted'` whose `deleted_at` is more than `PURGE_DAYS` old **and** whose `deleted_from` is `waiting`, `working` or `review`. Those are the "in-progress bills that are never completed."
- **Approved and filled tickets are never purged** (my call). A filled ticket is a completed invoice and part of the customer history. An approved ticket may already have been typed into InvoMax before someone deleted it. Deleting either one hides it from the shop lists, but the row stays, marked deleted, and a filled one stays in history.
- `shopwin.py` needs no change: it lists `approved`/`filled` only, and `tickets.move` refuses `deleted → filled`.
- **UI in phase 2 (my call):** a Delete button and confirmation pop-up are added to the existing `admin.html` and `tech.html`, plus a Deleted list with Restore in `admin.html`. The owner can then clean up test data right after the switch, without waiting for the React admin. The pop-up reads, for example: "Delete ticket #12 — JANE DOE, XKS-4827, $340.00? It has $100.00 in deposits." / "Deleted tickets can be restored for 14 days."
- **One-off clean-up:** before the first switch, copy `tickets.db` to `tickets-backup-2026-MM-DD.db`. `.gitignore` must cover `tickets-backup-*.db`. After the switch, the owner deletes the test tickets through the UI, and the purge removes them 14 days later.

### Switch (phase 3)

- `start-shop.bat` starts `node shop-web/dist/apps/api/main.js` instead of `pythonw shop.py`, after the same "stop any copy already running" step (extended to `node.exe` running that file).
- Before the switch: back up the database and run the full Python test list plus the Jest suite.
- **Fallback:** `shop.py` stays in the repo. If something breaks, switch the line back. One caveat: `shop.py` doesn't know the `deleted` status, so deleted tickets would show again in the old admin's unfiltered list until the switch back.

### Customer history (phase 4)

- **Data:** filled tickets stay in the `tickets` table forever, so history is a query over them. No copy or snapshot is made, which keeps it correct when `shopwin.py` marks tickets filled behind the server's back.
- **Before and after (owner, 2026-11-18):** history keeps both records of each job.
  - **Before:** the filled ticket, meaning our lines and totals before tax.
  - **After:** InvoMax's final bill. The owner's source is the bill as it looks on screen just before the final "confirm bill" step that leads to printing. That screen has the final prices, tax, supplies, total and invoice number, including price changes made in the Ticket Autofill window.
- **Final-bill capture (my design, in `shopwin.py`):**
  - "Mark filled" becomes **"Record bill & mark filled"**. Staff bring InvoMax to the finished bill, before pressing Confirm, and click it.
  - **No pictures are stored (owner).** Only the bill's details are kept.
  - The tool **reads the numbers straight from InvoMax's boxes**, read-only, the way the probe and watch window read text (`WM_GETTEXT`). No keys or clicks are sent to InvoMax, so the safety rules hold.
  - A small dialog shows invoice number, parts, labor, supplies, tax and total, pre-filled with what was read. Staff glance at the screen, fix anything, and press Save. That save is the check, done while the bill is still on screen. Then the ticket is marked filled.
  - Any box that can't be read (InvoMax draws some as unreadable `TLMDEdit`s) is left empty for staff to type. Reading the final-bill view needs mapping first: a **watch-window session with the owner** on a real final bill, as with every earlier InvoMax screen. Until it's mapped, the dialog opens empty.
  - If InvoMax isn't open, staff can still type the numbers, or skip, and history then shows "no final bill."
  - Later option (not in this project): pre-fill unreadable boxes with the local vision model from a picture that's never saved.
- **Totals line up (owner, 2026-11-18):** the shop supplies charge scales with the job's cost, and it must be recorded, so that **admin-entered prices + supplies + tax = InvoMax's total**.
  - **Supplies are never entered (owner):** they're the shop's implicit materials. InvoMax adds them itself, always as a **multiple of $20**, and they show on InvoMax's final view of the invoice.
  - **Observe and record only (owner):** the web app never calculates tax or supplies, and doesn't check InvoMax's arithmetic. It records the numbers InvoMax finally shows, read from the final-bill picture.
  - Each job records our `{parts, labor, subtotal}` (before) and InvoMax's `{parts, labor, supplies, tax, total, invoice_no}` (after), as shown.
- **Final-bill table:** new `invoice_finals` table (`ticket_id`, `recorded_at`, `recorded_by`, `invoice_no`, `parts`, `labor`, `supplies`, `tax`, `total`, `source` read/typed). It's a new table, so Python's `Store.save` can't wipe it. `shopwin.py` writes it in the same transaction as the move to filled. The admin can correct a row later from Customer history.
- **Customer key:** the phone number's digits (my call: the shop already asks for one phone per customer, and names get misspelled). Vehicles within a customer are grouped by plate, then VIN.
- **API (admin only):**
  - `GET /api/invoices` searches bill history (owner, 2026-11-18). Filters, combinable: `tag` (plate), `name` (first or last, any case, partial), `phone` (digits, partial), `vin` (partial), `from` / `to` (date filled, inclusive). Newest first, paged. Each row has customer, vehicle, date, invoice number and InvoMax total.
  - `GET /api/invoices/:id` returns one bill with its `before` (our ticket: lines, parts, labor, subtotal) and `after` (InvoMax's numbers as recorded).
  - `POST /api/invoices/:id/final {numbers, version}` lets the admin correct the recorded numbers.
  - `GET /api/customers/:phone` returns one customer's bills grouped by vehicle.
  - Each is described in OpenAPI.
  - Indexes: `tickets.status`; a filled-date index (an expression index on `json_extract(data, '$.updated')`, or a `filled_at` column in `invoice_finals`, builder's call). It must stay fast with tens of thousands of bills.
- **UI:** the first React page is **Bill history** in the admin: a filter bar (tag, name, phone, VIN, date range), a results table, and a bill detail showing before and after side by side. It's new, so moving it to React carries no parity risk.
- **Backups (owner, 2026-11-18): no cloud, ever (no fees, no changing policies). Save on the PC now; copy to a USB drive later. Must not block this project.** History is only as safe as `tickets.db`. The shop PC has a single disk (C:; E: is an empty CD drive).
  - Nightly at 2:00, the server takes a dated copy with SQLite's online backup. It's safe while the server runs.
  - The copies go to `backups/` next to the app (git-ignored), keeping **90** (a few MB in all). This covers a bad edit, a corrupted file or a deleted ticket. It does **not** cover a dead disk, theft or fire. Until a USB copy exists, that risk is accepted by the owner.
  - **Later, with a USB drive:** a `copy-backups <drive>` command (and a "Copy backups to USB" button on the admin page) copies every dated backup to the drive. The drive can also be added to a `targets` list in the config, so it gets a nightly copy whenever it's plugged in. No code change is needed when the drive arrives.
  - A `restore <file>` command puts a backup back (the server stopped first, the current file kept aside). It's part of the phase and tested.
  - **Admin page line:** "Last backup: <time>". Red if no good copy in 2 days. A gentle "No copy off this PC yet" note stays until a USB copy has been made. Most backups fail silently, so this is what keeps them working long-term.
  - No encryption for now (copies stay on the PC). If a USB drive is later carried off-site, encrypting those copies can be added then.

### React pages (phase 5)

- **Staff check customers in (owner, 2026-11-18):** some customers don't want to type on a device, so check-in is staff's job.
  - The check-in view and the admin's New ticket are **one and the same**.
  - **Mechanics can also take a customer's first information**: first and last name, phone, year / make / model; plate and request optional.
  - New: `POST /api/tickets` for a mechanic, with the check-in fields only (no prices, deposits or lines). The ticket starts `waiting`, unassigned, like a kiosk ticket today. The mechanic's phone gets a **New customer** form.
  - No separate React check-in page is built.
- **The customer iPad is retired (owner, 2026-11-18).** The TS server drops the kiosk role from day one, so the parity port leaves it out, and the kiosk test cases are replaced by tests that it's gone:
  - `/checkin` redirects to `/`.
  - `/api/kiosk` and `/api/kiosk/revoke` return 404.
  - Any `role = 'kiosk'` rows in `sessions` are deleted at first start, so an old iPad cookie gets nothing.
  - The iPad section of the current `admin.html` is removed in phase 2, and `web/checkin.html` is deleted.
  - The chooser at `/` shows only Mechanic and Admin.
- Replace pages: `/tech` first (it gains New customer), then `/admin`. Each keeps the existing behaviour (4 s polling with ETag via TanStack Query `refetchInterval`, the 409 "someone changed it" handling, phone-first layout for `/tech`).
- Each page ships with Testing Library tests, a Playwright flow and an axe check with no violations.
- **CSP gets stricter:** once no inline scripts remain, drop `'unsafe-inline'` from `script-src`.
- Login pages may stay server-rendered forms (they work without JS and with password managers). Builder's call.

## Left to the builder (decide in the plan)

- `node:sqlite` vs `better-sqlite3`; the validator choice; Express 5 middleware layout.
- The Jest config under Nx (swc or ts-jest).
- How the ported Python test cases are organised.
- The exact OpenAPI schema names.
- Whether `libs/domain` runs in the browser for live totals or the pages trust the API's `totals`.
