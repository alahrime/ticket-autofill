# Handoff — ticket-autofill

**Updated:** 2026-11-03. **Branch:** `main` (last pushed `700b2ee`; the commits after it are local, push pending, see Access). This PC (Windows 10, user `Owner`) **is the shop PC**: InvoMax runs here with real customers.

Read first:
- Design: `specs/2026-10-26-invomax-overlay-design.md`. This covers the side panel, the draft model, the step runner and every InvoMax recipe learned so far. It supersedes the overlay part of `specs/2026-10-14-invomax-autofill-design.md`.
- Refactor plan: `plans/2026-10-26-refactor-before-panel.md` (R1–R5 done).
- Shop tickets plans: `plans/2026-10-29-shop-tickets.md` (T1–T7) and `plans/2026-10-29-shop-accounts-deploy.md` (A1–A4, then "Follow-up": B1 deposits, P1 Shop tickets window).
- Working style the owner asked for: plan, then per task an implementer subagent plus **two senior reviewer subagents** (spec/correctness and security/robustness), fix until both approve, then commit. Push only when the owner says so.

## State
| Area | Status |
|---|---|
| Photo → text → jobs (`ocr.py`, `read.py`) | Done (Qwen2.5-VL 7B on local Ollama; `read.read_photo`). Never checked against a real notebook page. |
| Pricing (`prices.py`) | Done; placeholder `parts.csv`. |
| Draft model (`draft.py`) | Done: `Value`, `Line` (part / labor / remark, qty, cost, covers, stable id), `Draft`, `from_job`, `needs`. Not done: `questions()`, `answer()`, `expected_totals()` (spec section 3). |
| Step runner (`recipes.py`) | Done; tested against the fake, and `customer_search` / `customer_by_plate` have now run live (see Trial results). Recipes: `customer_by_plate`, `customer_search`, `customer_new`, `customers_exit`, `vehicle_open`, `vehicles_cancel`, `vehicle_choose`, `phone_set`, `odometer`. Driver errors become failed checks / `StepFailed` with the steps done; refusals stop at once. |
| Real driver (`invomax.py`) | Built and reviewed 2026-11-02 (`invomax.Driver`, `8617496`): dry run by default, copy-back off by default; refuses unless the invoice is maximized 1936 × 1056; exact-foreground / top-dialog / no-menu / focused-box guards re-run right before every input; SendInput clicks checked against the control under the point; one key per safety check; never-click captions by word plus allow lists per window; stop latch; Esc or mouse in the top-left corner stops it. `python invomax.py check` only reads. Ran live 2026-11-03. Unmapped: `customers.exit`, `vehicles.engine`, `phone.text`; `phone` and `date` are read-only (place not confirmed / never typed). `fill()` (the Fill InvoMax button) still says "isn't set up yet". |
| Parts / labor / remark / note recipes | Steps known from the probe (spec 5.7); not written. They need pictures of the untitled choice boxes. |
| Side panel (`panel.py`), draft store, Wi-Fi page | Not started. |
| Probe (`probe.py`, `probe.bat`, `trial.bat`) | Done. Read-only watch with Start/Pause; logs to `probe/` and saves pictures of unreadable pop-ups to `probe/shots/` (git-ignored, customer data). Trial mode (`trial.bat`) runs one recipe at a time and has run live (see Trial results). Under `pythonw` the first Run once did nothing with no log; launched as `python probe.py trial` with stderr to a file it worked, cause not found. |
| Shop tickets (`tickets.py`, `accounts.py`, `shop.py`, `pinweb.py`, `web/admin.html`, `web/tech.html`, `web/checkin.html`, `shop.bat`) | Done 2026-10-29 (plans `plans/2026-10-29-shop-tickets.md`, `plans/2026-10-29-shop-accounts-deploy.md`): customer check-in kiosk → mechanic accounts (name + PIN) → admin review (username + password) → approved → `tickets.to_draft`, live at https://shop.japaneseautoservice1.com through the `inspection` tunnel. Year / make / model hints from `vehicles.json` (NHTSA). Since then (2026-11-02): **deposits** (admin only, any status until filled, sent to the draft as notes; mechanics never see them) and **totals before tax** (owner: InvoMax adds the 6% tax and supplies, so our totals are Parts, Labor, Total before tax, Deposits paid); `Store.save` is atomic across processes (`BEGIN IMMEDIATE`). On the shop PC, `run.bat` → **Shop tickets** lists approved tickets with an InvoMax entry sheet and Mark filled, and **Load into Ticket Autofill** (or double-click) fills the main window's fields, lines and notes in one click. The owner's admin account is made through `/setup` (code in `setup_code.txt`, valid 24 h from the server start). Not done: moving `phone.py` onto accounts (ask the owner: logs the phone out once), the Fill InvoMax button using the driver, checking InvoMax accepts a part line with a blank code, starting `shop.bat`/`phone.bat` at boot. |
| Inspection report (`inspection.py`, `report.py`, `phone.py`) | Added by another session in `6f73778`; separate from InvoMax filling. It adds the `python-docx` and `winocr` dependencies and a Cloudflare tunnel for the phone page. |

Tests: `python tests/test_<name>.py` for accounts, draft, invomax, ocr, phone, prices, probe, read, recipes, report, shop, shopwin, tickets and vehicles. All 14 print `ok` (checked 2026-11-03).

## What the probe taught us (details in spec section 4 and 5.x)
- InvoMax is a Delphi app. The invoice window has class `TINVOICESCREEN`, maximized at 1936 × 1056; its title blanks for a moment on redraws.
- **Readable:** the Name boxes (`TEdit#2` first, `TEdit#1` last), every box in Customer Information, the Vehicles dropdowns and button captions, the Parts & Labor captions, the Parts Cost / ACTUAL COST / Mileage boxes, and the grid cell being edited (`TInplaceEdit`).
- **Not readable:** the 15 `TLMDEdit` header boxes, which answer neither `WM_GETTEXT` nor UI Automation. These are Plate `#6`, VIN `#1`, Year Make `#8`, Eng Specs `#7`, Odometer in `#5` / out `#4`, mechanic `#2` and the phones. The drawn lists (Customers, Parts & Labor, item grid, `Tchoicebox`) aren't readable either. The plan: check `TLMDEdit` values by **copy-back** (select all, copy, read, restore the clipboard) and check list picks by their effect.
- **Caption-less buttons** are located by position in the invoice window. The button row is the panel `TPanel#3` at (10, 322)–(1926, 374). Known spots: Clear ≈ x 90–160, Labor ≈ x 440–500, vehicle history ≈ x 765–785, Done ≈ x 1280–1350, all at y 335–370. Inside dialogs: Add New ≈ (137, 475) in Customers, Save ≈ (273, 218) in Customer Information.
- The fastest customer lookup is to type the plate (with the hyphen, `ABC-1234`) in the Plate box and press Enter on an empty invoice. On an exact match InvoMax loads the customer; with no exact match it opens Customers with near matches and loads nobody (seen live 2026-11-03).

## Trial results (2026-11-03, owner watching, empty invoice)
- `python invomax.py check`: invoice 1936 × 1056 maximized, no dialog, name boxes read empty; the menu bar (182 items) has no keyboard shortcuts. The focused box on an empty invoice is the date box (`TLMDMaskEdit#0`, now mapped read only).
- `customer_search` live: Customers opened in 0.2 s, License ticked, the plate typed; step 3 can't be confirmed without copy-back (stopped, as designed).
- `customer_by_plate` live with a plate not in InvoMax: Plate focused in 0.02 s, typed, Enter → Customers with near matches, nothing loaded; trial mode now says so. Still to try: a plate that is in InvoMax, then `odometer` and the vehicle stages on that customer.
- Second session (same day): `check` clean again, but the focused box was Plate this time (left from the earlier trial). `customer_by_plate` live with a plate that **is** in InvoMax: Plate focused in 60 ms, typed + Enter, First Name filled in 0.66 s, no dialog left. `odometer` ran live (Dry run unticked by mistake): all three checks passed, but InvoMax had pre-filled Odometer In with the last visit's reading and the typed number was **appended** to it (the checks only see focus, not the text). Owner fixed the box by hand. A first fix pressed End, Shift+Home, Backspace before typing; re-run live (`8e7335d`), **Backspace in Odometer In cleared the whole invoice like Clear** (focus jumped to the parts grid; the guard refused before any typing; the saved customer was untouched, per the owner). The clear is removed and the driver now refuses Backspace and Delete in every send (`NEVER_KEYS`, `Driver._send`). **`odometer` is parked**: it still appends to the pre-filled reading. Options for the owner: End + Shift+Home then type over the selection (unproven live), or staff type the odometer. Note: twice the owner believed Dry run was ticked when the log shows a live run; read the log's `dry_run=` after every run.
- `vehicle_open` live (single click on Year Make, twice): nothing opened. The watch log (owner by hand) shows one click only focuses Year Make; a **double-click** opens Vehicles. Recipe changed to `double_click`. Also seen: after picking the Model, Vehicles closed and a **"Confirm" Yes/No** box opened (`TMessageForm`, question text not readable, **Yes focused by default**); the owner pressed No and focus went to Plate. `vehicle_choose` expects the engine step instead, so it must not run until the owner says what Confirm asks.
- `vehicle_open` live with the double-click: Vehicles opened in 80 ms. `vehicles_cancel` live: Cancel closed Vehicles in 80 ms and a **"Confirm" Yes/No** box asked to correct all past history; the owner answered No by hand. Owner: **always No** there. `vehicles_cancel` now presses Cancel, then No; the driver presses No only right after Cancel in Vehicles, in a `TMessageForm` with exactly Yes and No buttons (`_guard_confirm_no`), and never Yes. A second live `vehicles_cancel` (right after an earlier Cancel) got **no** Confirm: Vehicles just closed. So the No is optional: recipes now have `if_(check, step, grace)` (wait up to grace for the check, skip the step if it doesn't come) and `vehicles_cancel` = Cancel (expect no window or Confirm) then `if_(dialog("Confirm"), press("No"))`. The optional No hasn't run live yet.
- Owner (2026-11-03): the Confirm after picking a Model → **Yes** loads Year Make and Eng Specs (and Odometer "0000" when there's no past history). Odometer should **replace** the old reading. Tried End, Shift+Home then type (`7b6e3fe`): live, **End / Shift+Home alone cleared the whole invoice** too (focus to the parts grid ~0.5 s later, after the per-key guard had already passed; so the first clear was probably End/Home too, not only Backspace). The driver now sends **only** single plain characters, Enter, Tab and the copy-back Ctrl+A Ctrl+C (`SENDABLE`, `Driver._send`); no navigation or editing keys at all. Owner by hand (watch log): double-click Odometer In (selects the reading), Backspace, type, Enter, Enter → mechanic box. The recipe now does double-click → type over the selection → Enter → Enter (no Backspace: a selection is replaced by typing anyway). Each step also expects `name.first` still filled and re-checks after `settle` = 1.5 s (`Step.settle`), to catch a late clear before the next input. Live (owner watching): after the tool's double-click (one instant burst) the focus moved from Odometer In to the parts grid within 1.5 s, nothing typed or cleared (the settle check stopped it). The owner's double-click is two clicks ~0.2 s apart. The driver now sends a double-click as two guarded single clicks `DOUBLE_GAP` = 0.2 s apart (all checks re-run before the second, refused after 0.45 s); trial-only recipe `odometer_select` (double-click + 3 s watch) tests whether that fixes the jump, with the watch log running. Owner: **Odometer Out must equal Odometer In** (billing); with an old Out, Enter from In leaves Out as it was. Live with the paced double-click (`a0b3cf8`): focus stayed in Odometer In for 3 s and the old reading was **highlighted** (owner). The `odometer` recipe is now double-click In → type + Enter → double-click Out → type the same + Enter → mechanic box, each step checking focus + `name.first` after a 1.5 s settle. **Live OK (13:23, owner watching):** all 4 steps passed (1.7–2.0 s each with the settle), both boxes got the new reading, focus ended on the mechanic box, customer still loaded. Staff check the odometer before Done (nothing reads it back). Lesson: InvoMax's reaction to a key can lag the guard; a new key needs a watch-log test by hand first, never a live trial.
- Owner's view of the goal: one click from a Shop ticket to a filled InvoMax invoice, no copy and paste. Today the ticket loads into Ticket Autofill in one click; the InvoMax half is these trials, then the Fill button.

## Resume here (next session)
1. With the owner at the shop PC: InvoMax on an empty invoice, **maximized**. `python invomax.py check` (read only) to confirm.
2. `trial.bat` → `customer_by_plate` with a plate the owner says **is** in InvoMax: dry run, then live with the owner's OK. Expect First Name to fill. Leave the customer loaded.
3. `odometer` on that customer (dry, then live). Then `vehicle_open` + `vehicles_cancel`.
4. Ask the owner about **copy-back** (needed to confirm typed text in Plate, the Customers search box and the other `TLMDEdit` boxes; uses the clipboard briefly and restores it). The menu bar has no Ctrl+A/C shortcuts, which makes it less risky but not proven.
5. Map `customers.exit`: run `probe.bat` while the owner presses Exit in Customers once; take the click position "in Customers" from the watch log.
6. Then wire **Fill InvoMax** in `app.py` to run the header recipes (plate lookup or search → odometer → vehicle) through the driver, still one confirmation per fill at first. Parts/labor lines need pictures of the Labor choice boxes first (Next 5).

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

   **Built (2026-11-02, not yet run on InvoMax):** `trial.bat` / `python probe.py trial`. The trial window lists the recipes in stage order: `customer_search`, `customers_exit`, `customer_by_plate`, `odometer`, `vehicle_open`, `vehicles_cancel`. The two vehicle recipes come last because they need the customer that the plate lookup loads, so `vehicle_open` can't run directly after stage 1. Rules:
   - Dry run first. Dry run is on by default; a live run asks for confirmation and dry run goes back on afterwards. One stage per owner OK. Copy-back stays off until the owner agrees.
   - It starts only on a maximized InvoMax showing the recipe's starting state.
   - Hold Esc or push the mouse into the top-left corner to stop.
   - It never retries. After a live run it reads (read-only) what is left and says what to clear or close by hand.
   - Log: `probe/trial-YYYY-MM-DD.log`.
4. **Saving recipes need the owner's OK first.** `customer_new` creates a real customer record and `vehicle_choose` saves a vehicle. Agree on a made-up test customer the owner is happy to keep or delete by hand.
5. Then: pictures of the choice boxes (run the probe while using Labor), the parts/labor/remark/note recipes, `questions()` / `answer()`, and the side panel.

## Owner decisions on record (2026-10-26/27)
- START isn't needed. A double-click on the Name box opens Customers. Plates are typed with the hyphen.
- One phone only. No address, zip, city or state.
- Plate and VIN are single-clicked and **never double-clicked**. The mechanic was typed by hand; **changed 2026-11-03:** the mechanic box should be filled from the mechanic's phone (the shop ticket's tech, set when they hit Finish job).
- **Never** click: Done, Charge, Print, Clear, Dial Number, Continue, Fast Quote, Change, Delete, Custom Vehicle, Void, Erase.
- Watch mode is approved; it never saves, edits or deletes. Trial mode needs a go-ahead per stage.
- (2026-11-02/03) InvoMax does tax and supplies; our totals are before tax. Deposits are staff-only. Mechanics sign in with name + 6–8 digit PIN; the admin with username + password; the customer iPad is a kiosk. Signature stays on paper from InvoMax's printout.
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
