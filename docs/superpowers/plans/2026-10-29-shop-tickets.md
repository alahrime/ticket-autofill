# Shop tickets: help desk iPad → mechanic phone → iPad review → InvoMax

**Date:** 2026-10-29. **Goal:** carry one repair job through the shop on devices instead of paper, ending in a `draft.Draft` that the InvoMax step fills.

## Flow (user stories)
1. **Desk (iPad, help desk station).** A customer brings a car. Staff (or the customer) enter first name, last name, phone, vehicle year / make / model, an optional plate, and what the customer wants done. Saving creates a ticket in **waiting**.
2. **Mechanic (phone).** The phone was set up once to a mechanic name picked from a list. The mechanic sees waiting tickets and taps **Accept**: the ticket becomes **working** and belongs to them. While working they add lines: each line is a part (description, qty, price) with the **labor charge** for installing it, or a labor-only service (description + labor). Typing a description shows hints from `parts.csv`. They can enter the odometer and notes. **Finish** sends the ticket to **review**.
3. **Desk review (iPad).** The ticket shows up for review with customer, vehicle, mechanic, every line, and totals (parts, labor, sum — no tax: InvoMax computes the final totals). Staff can fix any field or line, **Send back** to the mechanic with a note (→ working), or **Approve** (→ approved, "Ready for InvoMax").
4. **InvoMax (shop PC).** An approved ticket converts to a `draft.Draft` (`tickets.to_draft`) for the InvoMax fill. InvoMax prints the company copy (the customer signs on paper) and the customer's copy; the tool never clicks Print. The real InvoMax driver is still being built (see HANDOFF), so this plan ends at the draft plus a **Filled** mark the desk sets by hand.

Statuses: `waiting → working → review → approved → filled`; `review → working` (send back). Any other move is refused.

## Decisions (owner, 2026-10-29)
- Signature on paper, from InvoMax's printout. No signature capture.
- Server on the shop PC like `phone.py`: one PIN for the shop, reachable on the shop Wi-Fi and through the Cloudflare tunnel (a new hostname, added by the owner; not done by the tool).
- Mechanics pick their name once from `mechanics.txt` (one name per line, git-ignored); the phone remembers it. The name fills `tech` in the draft.
- Parts: free text with catalog hints from `parts.csv`; a matched part carries its code into the draft, an unmatched one keeps code `""`.
- Year / make / model are free-text inputs for now, with empty `<datalist>`s; the option lists come later.

## Architecture
- `tickets.py` — pure ticket model (dataclasses), status rules, validation/normalising (phone → `(555)010-0000`, plate → `ABC-1234` style kept as typed but upper-cased), totals, `to_draft`. Plus `Store`: SQLite (stdlib `sqlite3`) in `tickets.db` (git-ignored; customer data stays on this PC). Each ticket has a `version` that every write bumps; a write with a stale version is refused (two devices editing at once).
- `shop.py` — `ThreadingHTTPServer` on port 8081, same PIN/cookie/lockout pattern as `phone.py` (own `shop_pin.txt`, cookie name `shop`), JSON API, serves `web/desk.html` and `web/tech.html`. No tunnel thread (the owner adds an ingress rule to the existing tunnel config). Pages poll every 4 s.
- `web/desk.html`, `web/tech.html` — plain HTML/CSS/JS, no build, no CDN (works offline on the Wi-Fi). Kept out of Python strings because there are two of them and they're long.
- `shop.bat` — starts `shop.py` with `pythonw`.

### API (all JSON; all but `/login` need the cookie)
| Method, path | Body | Result |
|---|---|---|
| GET `/` | | chooser page: Desk / Mechanic (or PIN page) |
| GET `/desk`, `/tech` | | the page |
| GET `/api/tickets?status=a,b` | | `{"tickets": [...]}` newest first |
| GET `/api/tickets/<id>` | | ticket |
| POST `/api/tickets` | customer + vehicle + request | new ticket (waiting) |
| POST `/api/tickets/<id>` | `{"version", ...fields}` | save edits (desk: any field; mechanic: lines, odometer, notes) |
| POST `/api/tickets/<id>/move` | `{"version", "to", "mechanic"?, "note"?}` | status change; accept needs `mechanic` |
| GET `/api/mechanics` | | `{"mechanics": [...]}` |
| GET `/api/catalog?q=` | | up to 8 `{code, description, part_price, labor_price}` hints |

Errors: 400 `{"error"}` for bad input, 404 unknown ticket, 409 `{"error", "ticket"}` for a stale version or a refused move (the reply carries the current ticket so the page can refresh).

## Tasks
Each task: an implementer subagent, then two senior reviewers in parallel (A: spec compliance + correctness + tests; B: code quality, security, repo idiom), fixes until both approve, then a commit. Tests are plain `assert` scripts printing `ok`; run the full test list before each commit.

### T1 — `tickets.py` model, rules and store
- `Line(desc, qty=1, price=None, labor=None, code="", id=0)`; `Ticket(id, status, first, last, phone, year, make, model, plate, request, mechanic, odometer, notes, lines, back_note, created, updated, version)`.
- `normalize(fields)` → cleaned values + errors (first/last/phone/year/make/model required at create; phone 10 digits; year 4 digits 1950–next year; qty > 0; money ≥ 0 with 2 decimals).
- `MOVES` table and `move(ticket, to, mechanic=None, note="")` raising `ValueError` on a refused move; accept requires a mechanic; send back requires a note.
- `totals(ticket)` → parts, labor, total.
- `Store(path)`: `create`, `get`, `list(statuses)`, `save(ticket, version)` (refuses stale), thread-safe (one connection per call or a lock). Tickets stored as one JSON column + indexed status.
- `tests/test_tickets.py`.

### T2 — `tickets.to_draft(ticket, catalog)`
- Header `first`, `last`, `phone`, `year_make` = `"2019 CADILLAC"`, `model`, `plate`, `odometer`, `tech` (mechanic), `date` (today `MM/DD/YY`), all `Value(source="desk")`; `make` lower-case.
- Each line: a part `Line(code, DESC, price, qty=qty)` (code from `prices.match` unless the ticket line has one), then if labor > 0 a `Line("INSTALL-PART", f"Remove & Install: {DESC}", labor, kind="labor", covers=[part id])`. A labor-only line (no price) → `Line("LABOR", DESC, labor, kind="labor")`. Ids follow order like `draft.from_job`.
- Ticket notes and the customer request go to `Draft.notes`.
- Tests in `tests/test_tickets.py`.

### T3 — `shop.py` server + API
- As in Architecture. Reuse `phone.load_pin` (path argument) and the login/lockout pattern; do not change `phone.py`'s behaviour.
- Mechanic-only edits are limited to lines/odometer/notes, and only while the ticket is `working`; desk edits allowed in waiting/review.
- `mechanics.txt` made with one placeholder line when missing.
- `tests/test_shop.py`: full flow over HTTP (login, create, accept, add lines, finish, send back, finish, approve, filled), 401 without cookie, 409 on stale version and on a bad move, catalog hints.

### T4 — Desk page (`web/desk.html`)
- iPad landscape and portrait; large touch targets.
- **New ticket** form (first, last, phone with numeric keypad, year/make/model with empty datalists, plate, request). 
- **Board**: columns Waiting / Working / Review / Approved, cards show name, vehicle, mechanic, age. Review cards stand out.
- **Review screen**: everything editable, lines table with qty × price, labor, totals; buttons Send back (asks for a note), Approve; approved tickets show "Ready for InvoMax" and a **Mark filled** button.
- Polls `/api/tickets` every 4 s without wiping a field being typed in; handles 401 (reload) and 409 (show "changed on another device", reload ticket).
- All text inserted with `textContent` (no `innerHTML` with data).

### T5 — Mechanic page (`web/tech.html`)
- Phone width. First visit: pick your name (saved in `localStorage`); a link to change it.
- **Waiting** list with Accept; **My jobs** (working, mine) — tap to open.
- Job screen: customer first name + vehicle + request + back note (if sent back). Lines list; **Add part** (description with catalog hints → fills code and suggested price/labor, qty, price, labor) and **Add labor** (description, labor). Edit/remove a line. Odometer, notes. Saves on each change. **Finish job** (confirm) → review.
- Same polling / 401 / 409 / `textContent` rules.

### T6 — Wiring, docs, end-to-end check
- `shop.bat`, `.gitignore` (`tickets.db`, `shop_pin.txt`, `shop.log`, `mechanics.txt`), README section, HANDOFF row, tunnel steps for the owner (ingress `shop.<domain>` → `http://localhost:8081` in `inspection.yml`, `cloudflared tunnel route dns`), test list.
- Browser check in the app's browser: desk at iPad size and tech at phone size, one ticket through every status, made-up data only.

## Not in this plan
Year/make/model option lists; the real InvoMax fill (see HANDOFF "Next"); signature capture; tax; history/search of old tickets; deleting tickets.
