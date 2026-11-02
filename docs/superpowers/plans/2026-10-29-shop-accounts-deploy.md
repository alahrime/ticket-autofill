# Shop accounts and public links

**Date:** 2026-10-29. Follows `2026-10-29-shop-tickets.md` (T1–T7 done). **Goal:** three public links on `https://shop.japaneseautoservice1.com`, each with its own sign-in, replacing the single shop PIN.

| Link | Who | Sign-in | Can |
|---|---|---|---|
| `/checkin` | Customer, on the shop iPad | The iPad is enrolled once by the admin (kiosk session) | Create a ticket (name, phone, year/make/model, plate, request). Sees nothing else. |
| `/tech` | Mechanics, own phones | Name + own PIN | See waiting jobs, accept, edit lines/odometer/notes **of their own** working jobs, finish. |
| `/admin` | Owner (and staff with admin accounts) | Username + password | Everything the desk page does today (intake, board, review, edit prices until filled, send back, approve, mark filled), plus manage mechanics and enrol/sign out kiosks. |

## Decisions (owner, 2026-10-29)
- The customer fills check-in themselves on a kiosk page that shows no other tickets.
- Admin signs in with username + password; mechanics with name + PIN; the admin page adds mechanics, resets PINs and turns accounts off.
- Deploy on the existing `inspection` tunnel as `shop.japaneseautoservice1.com` → `http://localhost:8081`; Claude adds the ingress rule and DNS route.

## Design
- **`accounts.py`** (stdlib): tables `users(id, name UNIQUE COLLATE NOCASE, role admin|mechanic, hash, active, created)` and `sessions(token_hash PRIMARY KEY, user_id NULL, role, expires, created)` in `tickets.db`. Secrets hashed with `hashlib.pbkdf2_hmac("sha256", …, salt, 200_000)`; session tokens are `secrets.token_urlsafe(32)`, stored as sha256. Roles: `admin`, `mechanic`, `kiosk` (a session with no user). Lifetimes: admin 7 days, mechanic 30 days, kiosk 1 year. Deactivating a user or resetting a PIN/password deletes their sessions. Lockout: 5 wrong tries per name in 10 min locks that name for 10 min, plus 20 wrong tries per client IP (`CF-Connecting-IP` when the request comes from loopback, else the socket address) per 10 min. Also 20 wrong tries per name in 24 h lock it for 24 h (an admin PIN reset unlocks; a locked admin name clears when `shop.bat` restarts); IPv6 clients are keyed by /64; at most 4 logins hash at once (a 5th gets "busy, try again"). Admin password ≥ 10 chars; mechanic PIN 6–8 digits. `python shop.py admin <username>` creates or resets an admin (password typed with `getpass`, twice); the server never creates an admin by itself. For setting up away from the shop PC, `/setup` works only while no active admin exists and needs the one-time code the server writes to `setup_code.txt` (git-ignored, 24 h, deleted once used). The server listens on 127.0.0.1 only: every device, the shop iPad included, uses the public tunnel link (owner, 2026-10-29).
- **`shop.py`**: drops the shop PIN cookie for a `sid` session cookie (HttpOnly, SameSite=Strict, Secure behind the tunnel). `who` comes from the session role, never from the request body. Mechanics may only accept as themselves and only edit/finish tickets whose `mechanic` is their own name. Kiosk may only `POST /api/tickets` and read `/api/vehicles`. New: `POST /login/admin`, `POST /login/tech`, `POST /logout`, `GET /api/me`, `GET/POST /api/users` (admin: list, add mechanic/admin, reset PIN/password, (de)activate), `POST /api/kiosk` (admin enrols this device: replaces the admin session with a kiosk one), `POST /api/kiosk/revoke` (admin signs out all kiosks). `/api/mechanics` lists active mechanic accounts. `/desk` redirects to `/admin`. `mechanics.txt` and `shop_pin.txt` are no longer used. `pinweb.py` keeps serving `phone.py` later.
- **Pages**: `web/admin.html` (today's desk page + Mechanics screen + "Use this iPad for check-in" + Sign out), `web/tech.html` (name + PIN sign-in replaces the name picker; Sign out), `web/checkin.html` (big-type form for customers, thank-you screen that clears itself after 15 s; year/make/model lists). Sign-in pages are served by the server, no data on them.
- **Deploy**: ingress `shop.japaneseautoservice1.com` → `http://localhost:8081` above the 404 rule in `%USERPROFILE%\.cloudflared\inspection.yml`; `cloudflared tunnel --config … route dns 7988b810-… shop.japaneseautoservice1.com`; the tunnel runs from `phone.bat`, so `shop.bat` and `phone.bat` both run. Owner creates the admin with `python shop.py admin <name>`.

## Tasks (implementer + two senior reviewers each)
- **A1** `accounts.py` + `tests/test_accounts.py`.
- **A2** `shop.py` sessions, roles, new routes + `tests/test_shop.py` rewritten for roles.
- **A3** pages: `web/admin.html` + `web/checkin.html` (one implementer), `web/tech.html` sign-in (another, in parallel).
- **A4** deploy on the tunnel, check the three public links with made-up data, README/HANDOFF.

## Not in this plan
Moving `phone.py` onto accounts; email/SMS to customers; customer-facing bill view; signature capture.

## Follow-up (owner, 2026-11-02)
- **B1 Deposits (no tax here).** Our totals are raw prices: InvoMax adds the 6% tax and its supplies charge, so `totals()` is Parts, Labor, Total (before tax) and Deposits paid, with no tax and no balance (it would be wrong without InvoMax's tax and supplies; the desk takes deposits off InvoMax's total). Deposits are recorded by the admin only (amount, method cash/card/check/other, a date within a year of today, optional note), several per ticket, at any status until filled, including while the mechanic works; removable by the admin. Mechanics and the check-in iPad never see deposits. `to_draft` adds each deposit as a note ("Deposit $200.00 (cash, 2026-11-02)").
- **P1 Shop tickets on the shop PC.** A "Shop tickets" window in the PC app (`app.py`, `run.bat`) lists approved tickets from `tickets.db` (refreshing every few seconds), shows the InvoMax entry sheet for the selected one (header values, lines in order, notes, totals) with copy buttons, and **Mark filled**. It reads the same `tickets.db` as `shop.py` on this PC. Typing into InvoMax by itself stays the next stage (HANDOFF: driver + live trials).
