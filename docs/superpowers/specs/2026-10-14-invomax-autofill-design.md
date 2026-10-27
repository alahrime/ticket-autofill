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
| `ocr.py` | Photo → text lines via a local vision model (Qwen2.5-VL 7B on Ollama, offline) (kept apart so `read.py` tests run without the model) |
| `read.py` | Split text into jobs; extract fields and items |
| `prices.py` | Look up item code + part/labor price from `parts.csv` and `overrides.csv` |
| `fill.py` | Write values into InvoMax via pywinauto; keystroke fallback |
| `parts.csv` | Placeholder catalog (code, description, aliases, sided, part_price, labor_price). Replaced by shop's InvoMax export |
| `overrides.csv` | Prices staff chose to keep, per code + make |

OCR engine (decided 2026-10-14 by testing on the sample page): **Qwen2.5-VL 7B served by Ollama** on the same PC, asked to transcribe the page line by line; the text then goes through `read.py` unchanged. Results on a real notebook page (kept out of this public repo because it holds customer data; tests use made-up values):
- RapidOCR: failed (jobs merged, VIN one char off, items unreadable).
- TrOCR-small-handwritten: failed (worse).
- Qwen2.5-VL 3B: fast (~4 s) but dropped date lines (jobs merged), lost the `$81` cost, misread a plate.
- **Qwen2.5-VL 7B: every field and item correct; ~9 s/page warm on an M3 Pro Mac.** Speed on the shop PC depends on its GPU; a CPU-only PC may take 1–3 min/page.

Still fully offline: the model (~6 GB) is downloaded once; photos go only to `127.0.0.1`. The model name is one constant in `ocr.py` (switch to the 3B there if the shop PC is too slow and accuracy holds on its pages).

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

## Revision 2026-10-26: overlay on InvoMax, multi-step entry, shop Wi-Fi sync
Decided with the shop owner on 2026-10-26, after looking at two final printed InvoMax bills. Those bills are kept out of the repo because they contain customer data.

**Input is unchanged.** The photo is still a handwritten notebook page. The printed bill shows what InvoMax should end up holding. It is not something the app reads.

### What a finished InvoMax invoice holds (from the printed bills)
- **Header:** customer name, street address, up to two phones, Year Make (e.g. "2005 Toyota Camry LE"), Engine ("V6 3.0L"), License, MLG in/out (one odometer value in both boxes), VIN, and a three-letter code under VIN (meaning unknown). There are also Date, Schedule date, time and the invoice number. InvoMax supplies those last four.
- **Labor table:** description, HRS (left blank) and price. It holds two kinds of row:
  - Priced labor rows, such as "Remove & Install: AXLE ASSEMBLY F/LEFT 150.00" or "BLEED, FLUSH BRAKE FLUID 100.00".
  - Unpriced remark rows. Some are free text that wraps over several lines, such as "SERVICE RECOMENDED F/RIGHT AXLE $550.00 AND F/LEFT AXLE $400.00". Others name the job, such as "REPLACE FRONT ENGINE MOUNT, RIGHT 550.00", which is one labor price covering several parts.
- **Parts table:** description, QTY (can be more than 1, e.g. spark plugs 4.00), unit price and total.
- **Totals:** InvoMax computes these, and the tool never types them. Labor, Parts & Lubricants, SHOP SUPPLY 20.00, Sub Total, Sales Tax, TOTAL. On both bills the sales tax is 6% of (parts + shop supply), e.g. (250.00 + 20.00) × 6% = 16.20. The overlay shows its expected total so staff can check InvoMax's total against it.
- Signature, Charge and Print happen after this tool's work and are out of scope.

What changes in the line model:
- A part and its labor are not always one-to-one. One labor row can cover several parts, and a labor row can exist with no part (fluid flush). The current part → `INSTALL-PART` pairing stays the default, and staff can merge labor rows in the overlay.
- Parts carry `qty`.
- Remark rows are a third line type with no price.

### Overlay drawn over InvoMax — superseded
> **Superseded 2026-10-26** by `2026-10-26-invomax-overlay-design.md`: a floating side panel of questions, no markers drawn over InvoMax. Kept for history.

- A see-through, always-on-top, click-through Tk window covers the InvoMax window. It uses Windows `-transparentcolor` and stays aligned with InvoMax's window rectangle, polled every 200 ms.
- For every field the tool knows about, it draws a marker on the InvoMax box:
  - Green: filled and matches.
  - Yellow: read but flagged (VIN check digit, plate S/5).
  - Red: missing (no VIN, no plate, a labor row with no price).
- The marker positions come from pywinauto's `rectangle()` of each mapped control, not from fixed coordinates. That way they follow window moves and resizes. If InvoMax's controls can't be addressed (Task 5 decides this), markers fall back to positions relative to the window, and a size change shows a warning instead of misplaced markers.
- Clicking a marker opens a small input next to it. Enter puts the value into the draft and carries out the matching InvoMax action. A docked list (the current side window) shows every open question in order: "VIN missing", "Labor price for Remove & Install: AXLE F/LEFT?" and so on. Staff can work through it without hunting for markers.
- The overlay hides itself while a fill step is running, so its clicks and keys reach InvoMax.

### Multi-step InvoMax actions ("recipes")
> **Refined 2026-10-26** in `2026-10-26-invomax-overlay-design.md` (step types `click`, `double_click`, `wait_dialog`, `set`, `select_row`, `choose_menu_item`, `press`; recipes in `recipes.py`, driver in `invomax.py`).

Adding a labor charge takes several modal dialogs in InvoMax, and so may a part or a note. Each action is a recipe: a list of steps kept as data in `fill.py`, so changing it doesn't touch the logic. The step types are:
- `click(control)`
- `wait_dialog(title)`, which times out with a clear message.
- `set(control, value)`
- `select(list_control, text)`
- `press(button)`, but never Done, Charge, Print or Clear.

After each step the recipe checks the expected dialog or value, and stops at the first mismatch. The error names the step, so staff can finish by hand. The same recipe drives both the overlay's single-field fill and the full Fill. The labor, part and remark recipes are written from InvoMax screenshots and checked on a scratch invoice on the shop PC.

### Phone edits over shop Wi-Fi
- The shop PC runs a small web page, built on stdlib `http.server`, so there are no new dependencies. It listens on the shop LAN only. Nothing goes to the internet, and the offline rule stands.
- Staff sign in with a name and a PIN. PINs are stored hashed in a local file, and a session cookie keeps them signed in.
- The page shows the current draft: header fields, lines and open questions. Staff can answer questions or edit values from a phone.
- Phone edits update the draft. They appear on the overlay marked "from <name>", and InvoMax isn't touched until someone presses Apply on the PC. That keeps a phone edit from typing into InvoMax while someone is using the keyboard.
- **History:** a stdlib `sqlite3` file keeps one row per change (time, who, device, field, old value, new value) for the PC and phones alike. Each draft has its own history view. Drafts and history stay on the shop PC.
- The page uses plain HTTP inside the LAN. Shops whose Wi-Fi is shared with customers need a separate staff network, or HTTPS with a self-signed certificate (open item).

### Order of work
1. **InvoMax screenshots** (coming from the owner). They show the main invoice screen, each labor and part dialog in order, and where totals appear. They are used to write the recipes and the field list.
2. **Line model update** (qty, remark rows, merged labor) plus the expected-total check, with tests.
3. **Recipe runner** in `fill.py`, unit-tested with a fake window. Recipes for header fields, part, labor and remark.
4. **Side panel** (`panel.py`), see `2026-10-26-invomax-overlay-design.md`.
5. **Draft store + history** (`sqlite3`), then the **Wi-Fi page**.
6. Shop PC: control map (Task 5) and acceptance (Task 6), extended to recipes and the overlay.

## Open items (non-blocking)
- Meaning of the three-letter code under VIN on printed bills (e.g. "ABD", "EDG"): tech initials, or something else?
- Is the Engine field ("V6 3.0L") written in the notebook, or filled by InvoMax's VIN lookup?
- Is shop supply always 20.00, and is tax always 6% of parts + shop supply?
- Is the shop Wi-Fi shared with customers? This decides plain HTTP or a self-signed certificate for the phone page.
- Should a phone edit ever go into InvoMax without someone pressing Apply on the PC? (Default: no.)
- More sample pages to confirm the 7B model's accuracy across handwriting styles.
- Shop PC specs (CPU/GPU/RAM) to confirm reading speed.
- InvoMax parts/labor export → replaces `parts.csv`.
- Access to the shop PC (remote or in person) to build the control map.
- Real markup rule (flat ×, tiered by cost, or per part) — ×2.5 placeholder until confirmed.
- Meaning of side notes like `(R) 4Q` — kept as Note until clarified.
