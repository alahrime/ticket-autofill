# VIN on shop tickets

**Date:** 2026-11-03. Follows `2026-10-29-shop-tickets.md` and `2026-10-29-shop-accounts-deploy.md`. **Goal:** a ticket carries the car's VIN so the one-click "Fill InvoMax" can type it into InvoMax's VIN box (draft header `vin`).

## Decisions (owner, 2026-11-03)
- The mechanic enters the VIN on their phone, or it is added later, at any point before the InvoMax fill starts. Today a ticket has no VIN.
- The VIN is stored upper case with no spaces. A value that isn't 17 characters or fails the check digit is **stored as typed, with a warning**; it never blocks a save.

## Design
- **`tickets.py`**: `Ticket.vin: str = ""` (old stored tickets have no `vin` key and load as ""). `vin` is a text field (80 chars max, like the others) that `normalize` cleans to `re.sub(r"\s", "", v).upper()`; no other change to what was typed (no I/O/Q swaps: that guessing is for OCR, not a person typing). `vin_warning(vin)` -> `""` when empty or valid (`read.vin_valid`), else a short reason: `"VIN has 16 characters, not 17"` or `"VIN check digit fails"`. Warnings are never errors.
  - Mechanic: `MECHANIC_KEYS` gains `vin`, so a mechanic sets it on their own working job (same account/PIN and status rules as odometer/notes).
  - Desk: unchanged rules: any field while waiting / review / approved; read-only while the mechanic works; nothing after filled. So the admin can add or fix it until Mark filled.
  - Check-in kiosk: not a kiosk field (customers don't type VINs).
  - `to_draft`: header `vin` = `Value(t.vin, "desk", flag=vin_warning(t.vin))`, left out when empty (missing stays missing, like plate).
- **`shop.py`**: `as_json` adds `vin_warning` (computed, not stored) so both pages show the same warning. No new routes; `/api/tickets/<id>` edits carry `vin` like any other field.
- **`web/tech.html`**: a VIN box next to Odometer (`autocapitalize="characters"`, no autocorrect/spellcheck, maxlength 30), saved the same way as odometer/notes (debounced save, kept on the phone until saved, retried once on a stale version, error under the box). The server's `vin_warning` shows under the box as a warning, not an error.
- **`web/admin.html`**: `["vin", "VIN", NAMEISH]` in `FIELDS` after Plate, so it is editable exactly when the other fields are; `vin_warning` shown under it (warning style, not `.ferr`).
- **`shopwin.py`**: `HEADER` gains `("vin", "VIN")` after Plate, so the entry sheet text and window show it with a Copy button. A flagged VIN also shows its warning (sheet line `VIN warning: …`; a red line under the VIN row in the window). "Load into Ticket Autofill" already copies header `vin` into the main window's VIN field (`app_fields`); a flagged VIN there gets the yellow flag background, as a flagged page value does.

## Tests (plain-assert style)
- `tests/test_tickets.py`: default "" and old JSON without `vin` loads; normalise (spaces, case); invalid stored as typed with no error; `vin_warning` cases; mechanic may edit vin while working, desk while waiting/review/approved, refused after filled; `to_draft` header `vin` with/without flag, missing when empty.
- `tests/test_shop.py`: mechanic sets `vin` through the API on their own job (and not on someone else's); admin edits it on an approved ticket; `vin_warning` in the JSON; kiosk can't set it.
- `tests/test_shopwin.py`: VIN in entry sheet and `app_fields`, warning line when flagged.

## Not in this plan
Typing the VIN into InvoMax (the Fill InvoMax session, `invomax.py` / `recipes.py`); reading the VIN from a photo of the door sticker; decoding year/make from the VIN.
