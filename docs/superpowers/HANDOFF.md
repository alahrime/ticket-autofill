# Handoff — ticket-autofill

**Updated:** 2026-10-28. **Branch:** `main` at `c673314` (push pending, see Access). This PC (Windows 10, user `Owner`) **is the shop PC**: InvoMax runs here with real customers.

Read first:
- Design: `specs/2026-10-26-invomax-overlay-design.md`. This covers the side panel, the draft model, the step runner and every InvoMax recipe learned so far. It supersedes the overlay part of `specs/2026-10-14-invomax-autofill-design.md`.
- Refactor plan: `plans/2026-10-26-refactor-before-panel.md` (R1–R5 done).

## State
| Area | Status |
|---|---|
| Photo → text → jobs (`ocr.py`, `read.py`) | Done (Qwen2.5-VL 7B on local Ollama; `read.read_photo`). Never checked against a real notebook page. |
| Pricing (`prices.py`) | Done; placeholder `parts.csv`. |
| Draft model (`draft.py`) | Done: `Value`, `Line` (part / labor / remark, qty, cost, covers, stable id), `Draft`, `from_job`, `needs`. Not done: `questions()`, `answer()`, `expected_totals()` (spec section 3). |
| Step runner (`recipes.py`) | Done and tested **against the fake only** (`tests/fake_invomax.py`). The recipes are `customer_by_plate`, `customer_search`, `customer_new`, `customers_exit`, `vehicle_open`, `vehicle_choose`, `phone_set` and `odometer`. |
| Real driver (`invomax.py`) | **Not built.** It still holds the old `fill()` / `FIELD_MAP` stubs, which the window's Fill button calls ("control map isn't set up yet"). |
| Parts / labor / remark / note recipes | Steps known from the probe (spec 5.7); not written. They need pictures of the untitled choice boxes. |
| Side panel (`panel.py`), draft store, Wi-Fi page | Not started. |
| Probe (`probe.py`, `probe.bat`) | Done. Read-only watch with Start/Pause; it logs to `probe/` and saves pictures of unreadable pop-ups to `probe/shots/` (git-ignored, customer data). |
| Shop tickets (`tickets.py`, `shop.py`, `pinweb.py`, `web/desk.html`, `web/tech.html`, `shop.bat`) | Done 2026-10-29 (plan `plans/2026-10-29-shop-tickets.md`): desk iPad → mechanic phone → desk review → approved → `tickets.to_draft`. Not done: year/make/model option lists (the pages have empty `year-list` / `make-list` / `model-list` datalists), the shop hostname on the tunnel (owner, README), moving `phone.py` onto `pinweb.PinHandler` (its cookie is a plain hash of the PIN; the move logs the phone out once, so ask the owner), feeding approved drafts to the InvoMax fill, checking InvoMax accepts a part line with a blank code. |
| Inspection report (`inspection.py`, `report.py`, `phone.py`) | Added by another session in `6f73778`; separate from InvoMax filling. It adds the `python-docx` and `winocr` dependencies and a Cloudflare tunnel for the phone page. |

Tests: `python tests/test_<name>.py` for draft, invomax, ocr, phone, prices, probe, read, recipes, report, shop and tickets. All 11 print `ok` (checked 2026-10-29).

## What the probe taught us (details in spec section 4 and 5.x)
- InvoMax is a Delphi app. The invoice window has class `TINVOICESCREEN`, maximized at 1936 × 1056; its title blanks for a moment on redraws.
- **Readable:** the Name boxes (`TEdit#2` first, `TEdit#1` last), every box in Customer Information, the Vehicles dropdowns and button captions, the Parts & Labor captions, the Parts Cost / ACTUAL COST / Mileage boxes, and the grid cell being edited (`TInplaceEdit`).
- **Not readable:** the 15 `TLMDEdit` header boxes, which answer neither `WM_GETTEXT` nor UI Automation. These are Plate `#6`, VIN `#1`, Year Make `#8`, Eng Specs `#7`, Odometer in `#5` / out `#4`, mechanic `#2` and the phones. The drawn lists (Customers, Parts & Labor, item grid, `Tchoicebox`) aren't readable either. The plan: check `TLMDEdit` values by **copy-back** (select all, copy, read, restore the clipboard) and check list picks by their effect.
- **Caption-less buttons** are located by position in the invoice window. The button row is the panel `TPanel#3` at (10, 322)–(1926, 374). Known spots: Clear ≈ x 90–160, Labor ≈ x 440–500, vehicle history ≈ x 765–785, Done ≈ x 1280–1350, all at y 335–370. Inside dialogs: Add New ≈ (137, 475) in Customers, Save ≈ (273, 218) in Customer Information.
- The fastest customer lookup is to type the plate (with the hyphen, `ABC-1234`) in the Plate box and press Enter on an empty invoice.

## Next: test the runner on the real InvoMax
Do these in order and stop at the first surprise. Every stage runs on **an empty invoice** with the owner watching. Anything the tool leaves on the invoice is cleared **by hand**; the tool never presses Clear.

1. **Build `invomax.Driver`** with the interface in the `recipes.py` docstring:
   - Use ctypes reads as in `probe.py` (`WM_GETTEXT`, `BM_GETCHECK`, `CB_GETLBTEXT`, `GetGUIThreadInfo`), plus pywinauto `click_input` / `type_keys` for actions.
   - `CONTROLS` maps names to a class+index or a window-relative position, taken from `probe/map-*.txt` and the watch log.
   - `TLMDEdit` reads use copy-back.
   - Refuse to act if the window isn't maximized at 1936 × 1056.
   - Unit-test the pure parts: locator lookup and the refused-area math.
2. **Read-only driver check (no clicks).** With an invoice on screen, compare `dialog()`, `text()` and `focused()` with what the screen shows. Copy-back is the first thing that touches InvoMax (Ctrl+A / Ctrl+C in one box), so ask the owner before trying it.
3. **Trial mode in `probe.py`** (spec 5.8). It runs one recipe, logs each step's check and timing, and starts only on an empty invoice. Order:
   1. `customer_search` + `customers_exit`, which opens Customers and backs out.
   2. `vehicle_open`, then Cancel (needs a small `vehicles_cancel` recipe).
   3. `customer_by_plate` with a plate the owner gives; staff clear the invoice afterwards.
   4. `odometer` on that loaded invoice.

   Use the timings to set step timeouts.
4. **Saving recipes need the owner's OK first.** `customer_new` creates a real customer record and `vehicle_choose` saves a vehicle. Agree on a made-up test customer the owner is happy to keep or delete by hand.
5. Then: pictures of the choice boxes (run the probe while using Labor), the parts/labor/remark/note recipes, `questions()` / `answer()`, and the side panel.

## Owner decisions on record (2026-10-26/27)
- START isn't needed. A double-click on the Name box opens Customers. Plates are typed with the hyphen.
- One phone only. No address, zip, city or state.
- Plate and VIN are single-clicked and **never double-clicked**. The mechanic is typed by hand.
- **Never** click: Done, Charge, Print, Clear, Dial Number, Continue, Fast Quote, Change, Delete, Custom Vehicle, Void, Erase.
- Watch mode is approved; it never saves, edits or deletes. Trial mode needs a go-ahead per stage.
- The side panel snaps to the four screen corners, bottom-right first.
- The "Parts Cost" window sets a part's **price**. "ACTUAL COST" is the shop's cost.

## Access and tools
- **Git push:** credentials are via Git Credential Manager. This PC also has a **MixtureModels** sign-in that can't push to `alahrime/ticket-autofill`. If a push returns 403, run `git credential-manager github login` and sign in as **alahrime**. The sign-in window can open behind other windows.
- **Phone access:** Remote Control was turned on for the design session. The probe test checklist is at https://claude.ai/artifact/LmrQkF15NFy8eH7wbnnyVX (private).
- **Shared folder:** other Claude sessions commit in this same folder. Commit only your own files, and run the full test list before committing.

## Constraints
- Python + Tk. The InvoMax tool adds no dependencies beyond `pillow` and `pywinauto`.
- Fully offline for photos and InvoMax. Ollama stays on `127.0.0.1`.
- Tests are plain `assert` scripts that print `ok`.
- Never commit real photos, probe logs or pictures, or customer names. Docs use made-up names (JANE DOE, `(555)010-0000`, `XKS-4827`).
