# The admin enters the whole invoice

**Date:** 2026-11-16. Follows `2026-10-29-shop-tickets.md`, `2026-10-29-shop-accounts-deploy.md` and `2026-11-03-ticket-vin.md` (merged into this branch). **Branch:** `admin-full-entry`.

## Goal (owner, 2026-11-16)
The mechanic does the repair; the admin does the paperwork. From the admin page the admin enters the customer (name, phone), the car (plate, VIN, year, make, model, odometer), the mechanic's name and every part and labor line with its price, then sends the ticket to InvoMax. InvoMax works out tax and supplies itself, so tickets stay before tax. A mechanic can still see and change an invoice that is theirs.

## What changes
- **Statuses stay** (`waiting`, `working`, `review`, `approved`, `filled`). New moves, desk only: `waiting → approved` and `working → approved`. Any move to `approved` needs a mechanic and at least one line. Accept / Finish job / Send back still work for a shop day that uses them.
- **Desk edits** any ticket that isn't filled, including one a mechanic is working on (the version check already stops one device overwriting another).
- **Mechanic edits** their own ticket while it is `working` **or `approved`** (lines, odometer, VIN, notes), never after `filled`, never deposits. They see their own approved tickets on the phone as "My invoices".
- **Waiting tickets with a mechanic set** are shown only to that mechanic (and the admin); unassigned ones to every mechanic, as before.
- **Create** (`POST /api/tickets`, admin) takes the full ticket: header, VIN, odometer, mechanic (an active account or blank), request, notes, lines. The check-in iPad still sends only its own fields.

## Files
- `tickets.py`: `MOVES`, `move` (approve rules), `edit` (desk until filled; mechanic working + approved).
- `shop.py`: `sees` (assigned waiting; mechanic's own approved), mechanic name checked at create.
- `web/admin.html`: "New ticket" is the full ticket screen (same fields, lines table and totals as an open ticket) with **Save** and **Send to InvoMax**; mechanic is a list on every editable ticket; part hints from `parts.csv` on line descriptions; **Send to InvoMax** on waiting / working / review tickets.
- `web/tech.html`: "My invoices" list (own approved tickets), editable without Finish job.
- Tests: `tests/test_tickets.py`, `tests/test_shop.py`. Docs: `README.md`, `HANDOFF.md`.

## Not in this plan
The keystrokes into InvoMax. "Send to InvoMax" puts the ticket on the shop PC's Ready for InvoMax list (`run.bat` → Shop tickets → Load into Ticket Autofill). Typing it into InvoMax automatically is still HANDOFF "Resume here" steps 1–4 (part / labor recipes, new-customer path, Fill button), each of which needs a watched trial on the live InvoMax first.

## Review
Two senior reviewers on the finished diff: spec / correctness, and security / robustness. Both asked for changes; no authorization hole was found. Fixed, then all 14 test scripts re-run (`ok`):
- Part hints no longer leave one part's prices on another (a price the hint brought goes when the description changes; a typed price stays; a 0 part price stays blank).
- The desk and the phone can now edit the same ticket, so: "Put my changes back" keeps lines the other device added; the phone never re-sends odometer / VIN / notes over a value the desk changed meanwhile, and a draft kept on the phone isn't put back over a newer desk value.
- A new ticket carries a one-time token, so Save pressed again after a lost reply returns the same ticket instead of a second invoice.
- A mechanic can't take every charge off a sent invoice; a mechanic's change to a sent invoice sets `mech_edit` (shown on the board card and the ticket until the desk saves); `shop.log` records `role#user id` per request.
- A 409 no longer shows a ticket to a mechanic it was just taken from; line and deposit ids above 1e9 are renumbered; a sent invoice keeps its mechanic at the model level too.

Left as they are (reviewers' nits): a waiting ticket given to a mechanic whose account is then turned off shows to no mechanic until the admin reassigns it; a mechanic's change to a sent invoice doesn't reach a draft already loaded into Ticket Autofill on the shop PC (the Shop tickets window shows its red "changed" banner and Mark filled is refused until it's looked at again); account names differing only by a non-ASCII letter's case.
