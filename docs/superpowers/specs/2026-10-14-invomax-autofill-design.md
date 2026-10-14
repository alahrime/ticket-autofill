# InvoMax Autofill — Design

## Goal
Cut hand-entry of repair/inspection tickets into InvoMax (Windows desktop billing app). Staff photograph a handwritten notebook page; the tool reads it offline, shows the fields for review, then fills InvoMax. InvoMax stays the system of record; nothing is saved or printed by the tool.

**Success:** a ticket's vehicle fields and line items are entered in seconds, with a person reviewing every value before it reaches InvoMax.

## Constraints
- Runs on the shop's Windows PC, fully offline (photos never leave the machine).
- Lightweight: one Python program, no React/Go (dropped by agreement — nothing left for them to do).
- InvoMax is unchanged; the tool fills it from outside.

## Components
| File | Job |
|---|---|
| `app.py` | Tkinter always-on-top window: load/paste photo, pick job, review/edit fields and lines, **Fill** button |
| `ocr.py` | Offline handwriting OCR → text lines (kept apart so `read.py` tests run without the model) |
| `read.py` | Split text into jobs; extract fields and items |
| `prices.py` | Look up item code + part/labor price from `parts.csv` and `overrides.csv` |
| `fill.py` | Write values into InvoMax via pywinauto; keystroke fallback |
| `parts.csv` | Placeholder catalog (code, description, aliases, sided, part_price, labor_price). Replaced by shop's InvoMax export |
| `overrides.csv` | Prices staff chose to keep, per code + make |

OCR engine choice (e.g. TrOCR-handwritten vs PaddleOCR) is decided in the implementation plan by testing against sample pages; it is isolated in `ocr.py`.

## Reading a page
Observed notebook format (sample 2026-10-14):
- Multiple jobs per page; each starts with a date line (`10/14/26`), often separated by a ruled line.
- Labelled fields: `VIN:-`, `TAG:-` (plate), `MIL:-` (odometer), `Car:-` (year make model). Future pages may add `Name`, `Phone`, `Tech`.
- Work items start with `*` and end with a price like `100$`.
- A `$` amount left of an item (`$81 *Left front Axle 200$`) is the shop's **cost** for the part; the right-hand amount is the billed price.
- Other marks (`(R) 4Q`) are side notes.

Rules:
- Label match is fuzzy and case-insensitive (`ViN`, `VIN:-`, `Mil`, `Miles`, `Odo`, `Tag`, `Plate`).
- Unlabelled line right after the date (not an item) → name, split into first/last.
- `Car` → `year` (4-digit) + rest as make/model → InvoMax "Year Make".
- Item line → optional cost (left `$N`) + description + optional written price (right `N$`). Unparsed text → InvoMax Note.
- **Missing or unreadable field → left blank and untouched in InvoMax** (InvoMax's own customer lookup may have filled it).

Checks (failures highlighted, never auto-filled silently):
- VIN: 17 chars, no I/O/Q, valid check digit (pos 9). If invalid, try single swaps among lookalikes (0/O/D, 1/I/L, 5/S, 8/B, 2/Z); accept only if exactly one swap validates.
- Plate: flag any S/5, O/0, I/1 ambiguity.
- Odometer: digits only.

## Line items
- Item description → catalog row by alias match (fuzzy). No match → staff pick from list or type a code.
- Sided parts (axle, bulbs, mirrors, tie rods…) take side from text (`Left`, `Front`); if absent, staff choose L / R / Both. Both → two part lines + two labor lines.
- Each part produces two InvoMax rows: `CODE` part line, then `INSTALL-PART` "Remove & Install: DESCRIPTION" labor line (matches existing InvoMax convention).
- Part price, first that applies: written price → cost × markup (default ×2.5, rounded up to the next $5; the sample's $81 cost was billed $200) → override for this code+make → catalog price × make tier.
- Markup is one editable setting. Cost is kept on screen next to the price so staff see the margin; whether it also goes into InvoMax (e.g. its Profit screen) is decided once the control map is built.
- Labor price: override for this code+make, else catalog `labor_price` × make tier. Flat services (oil change, inspections) have `labor_price` 0 → no labor line.
- Make tiers (placeholder): economy ×1.0 (Honda, Toyota, Nissan, Subaru, Hyundai, Kia, Mazda), mid ×1.15 (Ford, Chevrolet, Dodge, Jeep, VW, GMC), luxury ×1.6 (BMW, Mercedes, Audi, Lexus, Acura, Infiniti, Volvo). Unknown make → ×1.0.
- Every price is editable before Fill. On edit, ask once: "Keep $X for CODE on MAKE?" → yes writes `overrides.csv`.

## Filling InvoMax
- **Fill** writes: Year Make, Plate, VIN, Odometer, name/phone if present, then line items into the grid. Notes are copied to the clipboard for staff to paste into InvoMax's Note (its Note dialog can be automated later once seen on the shop PC).
- Primary: pywinauto (win32/uia backend) sets control values directly. Fallback: focus + typed keystrokes if InvoMax's controls aren't addressable.
- Field → control map lives in one dict in `fill.py`, built against InvoMax on the shop PC.
- Never clicks Done, Charge, Print, or Clear.

## Errors
- OCR failure / unreadable page → show the photo and empty fields for manual entry.
- InvoMax window not found → message, nothing filled.
- Fill stops at the first control it can't set and reports which; already-filled values stay for staff to check.

## Testing
- `test_read.py`: sample page text → expected fields/items (VIN check-digit fix, name inference, label variants, multi-job split).
- `test_prices.py`: tier math, sided expansion, override precedence.
- Fill: manual test on the shop PC against a scratch invoice.

## Open items (non-blocking)
- More sample pages to tune OCR and parsing.
- InvoMax parts/labor export → replaces `parts.csv`.
- Access to the shop PC (remote or in person) to build the control map.
- Real markup rule (flat ×, tiered by cost, or per part) — ×2.5 placeholder until confirmed.
- Meaning of side notes like `(R) 4Q` — kept as Note until clarified.
