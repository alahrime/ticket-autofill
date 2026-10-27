# InvoMax Side Panel and Recipes — Design

Status: **draft for review** (2026-10-26). No feature code until the shop owner approves.

This replaces the "Overlay drawn over InvoMax" section, and refines the "Multi-step InvoMax actions" section, of the 2026-10-26 revision in `2026-10-14-invomax-autofill-design.md`. Everything else in that spec stands: notebook-page input, offline reading, pricing, Wi-Fi sync with Apply on the PC, InvoMax computes totals, Signature/Charge/Print out of scope.

Customer names, phones and plates in this doc are made up. The InvoMax screenshots this is based on hold real customer data and stay out of the repo.

## 1. Idea in one paragraph
A small always-on-top **side panel** floats next to InvoMax. It holds a **draft** for one notebook job (header fields, lines, notes). From the draft it derives a list of **open questions**: who the customer is, a missing VIN, a labor row with no price, and so on. Staff answer one question at a time. Each answer goes into the draft and, when InvoMax is at the right point, is carried into InvoMax at once by a **recipe**: a short list of clicks and typing, each step checked before the next. A recipe stops at the first surprise and says which step, so staff can finish by hand.

## 2. Side panel

### Window
- Tk `Toplevel`, `-topmost`, about 380 × 720 px, no transparency or click-through.
- **Snaps to a corner.** Staff drag it by its title bar; on release it snaps to the nearest of the four corners (top-left, top-right, bottom-left, bottom-right) of the monitor it is on, with a small margin. The corner is remembered in `settings.json`. Default: bottom-right, over the right side of InvoMax's item grid (Price/Total/Tech columns). Confirmed 2026-10-27: try bottom-right first and adjust after seeing it.
- **While a recipe runs, the panel hides itself** (`withdraw`) so real mouse clicks can't land on it, and comes back when the recipe ends. Runs take a second or two, so this is a short blink, not a mode.

### Layout, top to bottom
```
┌ Ticket Autofill ───────────────────────────┐
│ [Open photo] [Paste photo]   Job: [2 of 3 ▾]│  photo + job picker
│ Reading photo… 3:12                         │  (only while reading)
├─────────────────────────────────────────────┤
│ InvoMax: empty invoice ●                    │  live InvoMax state
├─────────────────────────────────────────────┤
│ QUESTION 3 of 9                             │
│ VIN is missing                              │  current question card
│ ┌─────────────────────────────────────────┐ │
│ │                                         │ │  entry / choices / rows
│ └─────────────────────────────────────────┘ │
│ [Put in InvoMax ⏎]  [Skip]  [I'll type it]  │
├─────────────────────────────────────────────┤
│ ✓ Customer: JANE DOE (existing)             │
│ ✓ Phone (555)010-0000                       │  question list:
│ ▶ VIN missing                               │  ✓ in InvoMax  ▶ current
│ · Plate: check S/5 (XKS4827)                │  · waiting  ✗ failed
│ · Labor price: Remove & Install AXLE F/LEFT │  – skipped / by hand
│ …                                           │
├─────────────────────────────────────────────┤
│ ▸ Draft (fields and lines, editable)        │  collapsed by default
│ ▸ Notes  [Copy]                             │
├─────────────────────────────────────────────┤
│ Expected: Labor 250.00  Parts 300.00        │
│ Supplies 20.00  Tax 19.20  TOTAL 589.20     │  check against InvoMax
│ InvoMax:  TOTAL 589.20 ✓                    │
│ 📱 2 edits from phone — [Review & Apply]     │  only when there are any
└─────────────────────────────────────────────┘
```
- **InvoMax state** line: "not open", "empty invoice", "Customers search open", "customer selected", "a dialog is open (title)". Read every 500 ms by the driver; questions whose recipe needs a different state show "waiting for …" instead of an Apply button.
- **Question card.** The input depends on the question kind: a text entry (VIN, plate, price), radio buttons (side LEFT/RIGHT/BOTH; keep InvoMax's phone or the notebook's), or a short list (customer candidates, catalog codes). Enter = "Put in InvoMax". "Skip" leaves InvoMax as it is. "I'll type it" marks it as done by hand. Both go to the end of the list and can be reopened.
- **Question list.** Click any row to make it current. A failed row shows the step that stopped, e.g. "✗ Phone: no 'Phone Number' window after Change Number".
- **Draft.** Header fields and lines in a Treeview, same as today's window. Editing a value that is already in InvoMax reopens its question as "changed — put in InvoMax?".
- **Expected totals** come from the draft (labor + parts × qty + 20.00 supplies, tax 6% of parts + supplies). The InvoMax line reads InvoMax's totals bar and shows ✓ or the difference. The tool never types totals.
- **Phone edits** (later, with the Wi-Fi page) show as a badge. "Review & Apply" lists each edit with who made it; applying runs the same recipes.

### Question order
Fixed by what InvoMax needs first; within a group, page order.
1. **Customer** — who is it? (existing match / pick one of several / new customer). Nothing else can go into InvoMax before this.
2. **Phone** — missing in InvoMax, or InvoMax's differs from the notebook. One phone only; address, zip, city, state and a second phone are not entered (confirmed 2026-10-27).
3. **Vehicle** — which car (on file, or new via the Vehicles window); Plate; VIN; Odometer.
4. **Lines**, in page order — unknown item code, which side, part price, labor price missing, qty, labor covering several parts, remark rows. *(recipes open)*
5. **Note** — leftover notebook text. *(recipe open; until then, Copy button)*
6. **Check totals** — InvoMax TOTAL vs expected.
7. **Mechanic** — always by hand: a reminder row "Press Enter after the odometer and type the mechanic in InvoMax" (confirmed 2026-10-27).

Questions with nothing to ask (value read cleanly and InvoMax accepts it) still appear in the list as "ready" rows, so **"Put all ready in InvoMax"** fills them in order without stopping. Questions that need a person stop the run there.

## 3. Draft data model
Home: `draft.py` (pure Python, no Tk, no pywinauto; fully unit-tested).

```python
@dataclass
class Value:
    value: str = ""
    source: str = ""     # "page" | "pc" | "phone:<name>" | "invomax"
    flag: str = ""       # reason to double-check, e.g. "VIN check digit fails"
    applied: str | None = None   # what was last put into InvoMax (None = never)
    state: str = ""      # "" | "skipped" | "by_hand"

@dataclass
class Line:
    id: int
    kind: str            # "part" | "labor" | "remark"
    code: str = ""
    desc: str = ""
    qty: float = 1
    price: float | None = None   # None on a labor line = question; always None on a remark
    cost: float | None = None    # shop cost, from "$81 *..." on the page
    covers: list[int] = field(default_factory=list)  # labor -> ids of the part lines it covers
    applied: bool = False
    state: str = ""

@dataclass
class Draft:
    id: str              # e.g. "2026-10-26-1432-2" (photo time + job index)
    photo: str           # path of the page photo
    job: int             # index of the job on that page
    header: dict[str, Value]   # keys below
    lines: list[Line]
    notes: list[str]
    customer: dict       # {"mode": "existing"|"new", "row": [...]} once answered
    unmatched: list      # page items with no catalog code yet: (item, line_id or None)
```
Header keys: `first`, `last`, `phone`, `year_make`, `eng_specs` (read from InvoMax only), `plate` (kept as InvoMax writes it, `ABC-1234`), `vin`, `odometer`, `tech` (shown, never typed), `date`. Address, zip, city, state and a second phone are not part of the billing process (confirmed 2026-10-27).

**Questions are derived, not stored.** `questions(draft, invomax_state) -> list[Question]` is a pure function, so the PC panel and the phone page always agree and there is nothing to keep in sync:
```python
@dataclass
class Question:
    key: str        # "customer", "header.vin", "line.4.price", "line.4.side", "note", "totals"
    kind: str       # "missing" | "check" | "choose" | "conflict" | "ready"
    prompt: str     # "VIN is missing"
    choices: list   # for choose/conflict
    recipe: str     # recipe that carries the answer into InvoMax, "" if none yet
    needs: str      # InvoMax state the recipe needs, e.g. "customer_selected"
    status: str     # "open" | "ready" | "done" | "skipped" | "by_hand" | "failed"
```
- `answer(draft, key, value, who, device)` changes the draft and returns the history row (old → new). Every change, from the PC or a phone, goes through it.
- `from_job(job, catalog, overrides, markup)` builds a draft from a `read.Job`. Unknown codes and missing sides no longer pop dialogs; they become questions.
- `expected_totals(draft)` → labor, parts, supplies (20.00), tax (6% of parts + supplies), total.

## 4. Recipes

### Driver and control names
Recipes never hold pywinauto specs or pixel positions. They name controls (`name.first`, `customers.search`, `phone1`), and `invomax.CONTROLS` maps each name to a locator found on the shop PC:
```python
CONTROLS = {
    "name.first": {"class_name": "ThunderRT6TextBox", "found_index": 3},   # example only
    "customers.list": {"dialog": "Customers", "class_name": "...", "found_index": 0},
    # fallback when a control isn't addressable: offset in the window's client area,
    # with the window size it was measured at; a different size stops the recipe
    "grid.first_code": {"rel": (140, 365), "at_size": (1920, 1000)},
}
```
The runner talks to a **driver** object. `invomax.Driver` implements it with pywinauto; tests use a fake InvoMax that holds fields, dialogs, list rows and menus in plain dicts.
```
text(name) / set_text(name, value, typed) / click(name, double) / press(button_text, dialog)
dialog() -> title of the top modal or None / rows(name) -> [[col1, col2, col3], ...]
double_click_row(name, index) / menu_items() / choose_menu(text) / focused() -> name
combo_items(name) -> [str] / pick(name, text) / key(keys)
```

### What InvoMax is built from (read-only look on this PC, 2026-10-27)
A pywinauto look at the running InvoMax (no clicks, no keys) found:
- It is a **Delphi** program. The main window is class `TINVOICESCREEN`, maximized to 1936 × 1056.
- The header boxes are **15 `TLMDEdit` controls** plus a few `TEdit`/`TLMDMaskEdit`; the black **V** is a `TLMDButton` with caption "V"; the date is a `TDateTimePicker`. These can be addressed and read, so header recipes can use `set` and read back.
- The big rounded buttons (Clear, Parts, Labor, Done…) **expose no caption**. They are drawn on panels. So they are located by a `rel` position in `CONTROLS`, and recipes check their effect (a dialog opens, a box fills) rather than their caption. The never-click rule therefore also lists their **positions**: the runner refuses a `rel` click that lands inside the Done, Clear or Print button rectangles.
- The item grid is a `TStringGrid` / `TProfGrid` (drawn cells): lines will be typed into it, and read back from the totals bar.
- There is a menu bar (File, Edit, Customers, Suppliers, Reports, Inventory, Setup, **Print**, CheckBook, Help, Service Reminders). The tool never opens it.
- Hidden helper windows exist ("InvoMax / CARFAX Integration", an "Invomax" internet warning). The driver ignores windows that aren't visible.
- Which `TLMDEdit` is which box is mapped by the probe (section 5.8).

### Step types
Each step does one thing, then **polls its check every 50 ms** until it passes or the step's timeout (default 5 s, 10 s for dialogs) runs out. No fixed sleeps, so a recipe runs as fast as InvoMax lets it.

| Step | Does | Default check |
|---|---|---|
| `click(ctl, tries=1)` | single click; with `tries=2` clicks again if the check hasn't passed after 0.5 s | given `expect` |
| `double_click(ctl)` | double click | given `expect` |
| `wait_dialog(title)` | nothing | modal with this title is on top |
| `wait_gone(title)` | nothing | that modal is closed |
| `set(ctl, value, typed=False, enter=False)` | set the text; `typed=True` types keystrokes (for boxes that filter as you type); `enter=True` presses Enter after (VIN decoder) | `text(ctl)` reads back the value, or the given `expect` |
| `pick(combo, text)` | chooses an item in a dropdown by its text | `text(combo)` shows that item |
| `select_row(list, match)` | finds the one row matching, double-clicks it | given `expect` (usually `wait_gone`) |
| `choose_menu_item(text)` | picks an item in the open popup menu | menu closed |
| `press(button)` | clicks a button by its caption | given `expect` |

- Every step has a `say` text ("Open the Customers search") shown on the panel while it runs and used in the error.
- A recipe also has `require`: checks run before step 1 (e.g. "invoice has no customer yet"). If one fails, nothing is clicked.
- Values come from the draft through `{placeholders}` (`"{plate}"`, `"{phone1}"`).
- On a failed check the runner raises `StepFailed(recipe, step_no, say, expected, got)`. The panel shows it on the question row; steps already done are listed so staff know what InvoMax has.

### Safety rules (in the runner, not only in recipes)
- **Never** press or choose: `Done`, `Charge`, `Print`, `Clear`, `Dial Number`, `Continue`, `Fast Quote`. The runner checks the caption it is about to click, and for caption-less buttons the position (see above), so a wrong control map can't get there either.
- **Never double-click Plate or VIN** (confirmed 2026-10-27). The runner refuses `double_click` on `plate` and `vin`.
- **Allow list:** `press`/`choose_menu_item` only accept captions that appear in some recipe in `RECIPES`. Anything else (Cash Sale, Estimating, Schedule, See Last Invoice, Profit, Fast Quote, Continue…) is refused until a recipe needs it and the owner confirms it. **Change** (Customers) and **Custom Vehicle** (Vehicles) are not needed and stay refused. **Add New** is allowed only inside `customer_new` (5.3), once the probe confirms that is how the Customer Information window opens.
- The runner stops if InvoMax shows a dialog it didn't expect, or if the window size differs from the control map's for a `rel` locator.
- One recipe at a time. Phone edits never start a recipe.

### Recipe format
Recipes are data in `recipes.py`:
```python
RECIPES = {
    "customer_search": Recipe(
        require=[empty("name.first"), no_dialog()],
        steps=[
            double_click("name.first", expect=dialog("Customers"), say="Open the Customers search"),
            click("customers.by_{by}", expect=checked("customers.by_{by}"), say="Search by {by_label}"),
            set("customers.search", "{text}", typed=True,
                expect=any_of(rows_changed("customers.list"), gone("Customers")), say="Type {text}"),
        ]),
}
```
Branching (one match, several, none) is not in recipes. The panel runs a recipe, reads what InvoMax shows, asks or decides, then runs the next recipe. Recipes stay straight lines.

## 5. InvoMax workflows

### 5.0 Invoice screen (reference)
- Top: Date dropdown, START button, Invoice Number spinner.
- Left header: Name (first | last), Address, Zip | City | St, Phones (two boxes; the icon left of them is not used).
- Right header: Year Make, Eng Specs, Plate | **V** button | VIN, Odometer (two boxes).
- Button row on an empty invoice: Clear, See Last Invoice, Create Quick Jobs, Cash Sale, Note, Estimating, Schedule.
- Button row after a customer is chosen: Clear, Parts, Labor, Quick Jobs, (tool icon), Note, Profit, Done, Estimating, Schedule. "Add Another Vehicle For This Customer" and "Service Recommendations" also appear.
- Grid: Item Code | Description & Comments | Qty | Price | Total | Tech.
- Totals bar (read only, for the check): Discount, Supplies, Sublet, Disposal, Labor, Parts, Sub Total, Sales Tax, TOTAL, BAL DUE.

State the driver reports. Button captions can't be read (section 4), so states come from box contents and dialog titles:
| State | Seen as |
|---|---|
| `no_invomax` | window not found |
| `empty_invoice` | no modal, First and Last Name boxes empty |
| `customers_open` | "Customers" modal on top |
| `customer_info_open` | "Customer Information" modal on top |
| `vehicles_open` | "Vehicles" modal on top |
| `customer_selected` | no modal, Name boxes filled |
| `dialog:<title>` | any other modal (the runner stops) |

### 5.1 `customer_search(by, text)` — open the Customers search and filter
Needs `empty_invoice`. START is **not** pressed (confirmed 2026-10-26).
1. `double_click(name.first)` → expect `dialog("Customers")`. *(Confirmed: a double-click opens it, same as click-then-click; the Last Name box does the same.)*
2. `click(customers.by_<by>)` → expect that radio checked. `by` is `license` when the page has a plate, else `phone` when it has a phone, else `last_name`, else `first_name`. *(Double-clicking an empty Phones box opens the same Customers modal with Phone already checked; the tool still goes through the Name box so there is one way in.)*
3. `set(customers.search, text, typed=True)` → expect the list to change, **or** the Customers modal to close (see below). A plate is typed **with the hyphen**, as InvoMax stores it (confirmed 2026-10-27): `draft.invomax_plate()` turns `XKS4827` into `XKS-4827`: hyphen after the 3rd character for 6- and 7-character plates; longer plates go in without a hyphen if the box can't hold it (confirmed 2026-10-27). No question is asked.

**License search (confirmed from a screenshot, 2026-10-26).** With "License" checked the list shows two columns: **plate | full name**, sorted by plate. Plates are stored with a dash (`ABC-1234`). Typing moves the highlight to the nearest plate as you type, so **a highlighted row does not mean a match**: with a partial plate typed, the highlight sits on the first plate after it. When the full plate of an existing customer is typed, InvoMax selects that row by itself. Otherwise staff double-click a row. Whether "selects" means only highlighting or also loading the customer is measured by the probe (5.8); the panel handles both outcomes below either way.

So after step 3 the panel reads the state:
- **Modal closed and the name boxes are filled** → InvoMax picked the customer itself. Go straight to the checks in 5.2 step 2 (name on the page, if any, must match; if not, the panel says so and nothing else is typed).
- **Modal still open** → read `rows(customers.list)` and compare plates with dashes and spaces removed. One exact plate → confirm question "Is it JANE DOE (ABC-1234)?", then `customer_pick`. No exact plate → search again by last name (the list rows near the highlight are not offered as matches).

Name search: rows are first name | full name (the third column is unused, confirmed 2026-10-27). Rows whose full name equals first + last (ignoring case and spaces) count as matches. One → confirm question; several → choose question; none → "No customer found — New customer / Search again / I'll pick it in InvoMax". How a new customer is entered without Add New is open (question 3).

Backing out: `press("Exit")` → expect `wait_gone("Customers")` closes the search without choosing (confirmed).

### 5.2 `customer_pick(row)` — choose an existing customer
Needs `customers_open`.
1. `select_row(customers.list, row)` → double-click → expect `wait_gone("Customers")`. *(Confirmed: highlighting the row and pressing **Select** works the same. The double-click is the default; `click` row + `press("Select")` is the fallback if double-clicking a list row through pywinauto proves unreliable.)*
2. check `text(name.first) == row.first` and no modal → state `customer_selected`. If InvoMax shows a list of the customer's cars next, the state is `dialog:<its title>` and `vehicle_pick` (5.6) takes over.

After this the driver reads Phone, Year Make, Plate, VIN, Odometer from InvoMax into the draft as `source="invomax"`, so later questions can say "InvoMax has (555)010-0000, the notebook says (555)010-0001 — keep which?".

*"I'll pick it in InvoMax"*: the panel waits (no clicks) for state `customer_selected`, then reads the fields the same way.

### 5.3 `customer_new(first, last, phone)` — brand-new customer
Needs `customers_open` (the search found nobody and staff chose "New customer"). A brand-new customer is entered in the **"Customer Information"** window (confirmed 2026-10-27, from a screenshot): First Name, Last, then Company, Street, ZIP-City-St, Home/Cell phones and Email, and the buttons **Save**, **Exit**, **Cancel**. Only the first two boxes, and the phone, are filled.
1. `press("Add New")` → expect `wait_dialog("Customer Information")`. *(How the window opens is confirmed by the probe before this recipe is enabled.)*
2. `set(custinfo.first, "{first}")`, `set(custinfo.last, "{last}")`.
3. `set(custinfo.home, "{phone}")` when the page has a phone (format `(555)010-0000`).
4. `press("Save")` → expect `wait_gone("Customer Information")`.
5. expect state `customer_selected` with the new name, or `customers_open` with the new row, which then goes to `customer_pick`. The probe settles which.

### 5.4 `phone_set(value)` — change the phone number
Needs `customer_selected`. Only the first phone box is used.
1. `double_click(phone)` → expect a popup menu with "Change Number".
2. `choose_menu_item("Change Number")` → expect `wait_dialog("Phone Number")`. *("Dial Number" is on the same menu and is refused by the runner.)*
3. `set(phone.text, value)` → read back the value.
4. `press("OK")` → expect `wait_gone("Phone Number")`.
5. check `text(phone) == value`.

Format: `(555)010-0000`, as InvoMax shows it and as `read.py` already writes it.

An **empty** phone box doesn't show the popup; it opens the Customers search with Phone checked. So `phone_set` runs only when InvoMax already holds a number; a customer with no phone gets it through `customer_new`, or by hand. A second phone is never entered (confirmed 2026-10-27).

### 5.5 `vehicle_add(...)` — choose the car on the Vehicles modal
Needs `customer_selected`. From a screenshot (2026-10-27): clicking **Year Make** opens a **"Vehicles"** modal with three dropdowns, **Year**, **Make**, **Model** (each narrows the next; Model items read like "2019 Cadillac ATS"), a VIN box labelled "InvoMax subscription enabled VIN decoder — press Enter after typing the VIN", and the buttons **Select**, **Cancel**, **Custom Vehicle**. Choosing Year, Make and Model fills Year Make and Eng Specs on the invoice.

VIN path first when the page's VIN passed its check digit (decoder confirmed working on the shop PC, 2026-10-27); dropdown path otherwise.

Dropdown path:
1. `click(year_make)` → expect `wait_dialog("Vehicles")`.
2. `pick(vehicles.year, "{year}")`.
3. `pick(vehicles.make, "{make}")` → the page's make is matched against `combo_items` ignoring case (`chevy` → `Chevrolet` via a small alias table in `draft.py`).
4. `pick(vehicles.model, "{model_item}")` → `model_item` is the one Model entry that contains the page's model word(s). Several (trims) → the panel asks a choose question with the items read from the dropdown, then reruns from step 4.
5. `press("Select")` → expect `wait_gone("Vehicles")`.
6. check `text(year_make)` contains year and make; read `eng_specs` into the draft (`source="invomax"`).

VIN path, replacing steps 2–4:
- `set(vehicles.vin, "{vin}", enter=True)` → expect Year, Make and Model to be filled. If they stay empty within 10 s (decoder offline or VIN unknown), fall back to the dropdown path.

Backing out: `press("Cancel")` → `wait_gone("Vehicles")`. `Custom Vehicle` is refused.

### 5.6 `plate_vin_odometer(plate, vin, odometer)` — the boxes on the main screen
Needs `customer_selected` and a car chosen. Confirmed 2026-10-27: **single-click** Plate and VIN and type straight into them; **never double-click** them.
1. `click(plate)` → `set(plate, "{plate}", typed=True)` → read back `ABC-1234`.
2. `click(vin)` → `set(vin, "{vin}", typed=True)` → read back.
3. `click(odometer.in)` → `set(odometer.in, "{odometer}", typed=True, enter=True)` → expect `text(odometer.out) == odometer` (InvoMax copies it into the second box on Enter).
4. Stop. The next Enter leads to the mechanic, which staff type by hand (the panel's last row says so).

Each part runs only if the draft has that value and InvoMax doesn't already hold the same one.

### 5.7 Still to come (recipes left open)
| Recipe | Needs | What's known | Found by |
|---|---|---|---|
| `vehicle_pick` | customer_selected | a "Do Not Show Multiple Vehicles List" option exists, so a list probably appears for customers with several cars | the probe (watch mode) |
| `part_add(code, desc, qty, price)` | customer_selected | Parts button; grid columns | screenshots + probe |
| `labor_add(desc, price)` | customer_selected | Labor button | screenshots + probe |
| `remark_add(text)` | customer_selected | — | screenshots + probe |
| `note_set(text)` | customer_selected | Note button | screenshots + probe |
| `totals_read` | customer_selected | totals bar labels | probe (are they readable controls?) |

### 5.8 Probe: learning InvoMax without babysitting
`probe.py` is a separate tool (not part of the panel) that answers "what does InvoMax do when…" by watching it, so the owner doesn't have to QA each step. Everything it writes goes to `probe/` (git-ignored: it sees customer data).

**Map mode** (read-only). Dumps every visible InvoMax window's controls (class, index, rectangle, caption) to `probe/controls-<title>.txt`. With staff clicking each box once while it runs, it records which `TLMDEdit` got focus, so `CONTROLS` is filled from a log instead of by hand.

**Watch mode** (read-only, runs during a normal working day; built 2026-10-27, start with `probe.bat`). It never clicks, types, presses Save or deletes anything in InvoMax: it only uses Windows read calls (window text, list selection, check state, focused box, mouse position) and writes nothing but its own log, `probe/watch-YYYY-MM-DD.log`. It also logs where each click landed (window-relative position and control) and Enter/Tab/Esc presses, never typed characters, so caption-less buttons can be mapped. Every 100 ms it records the top dialog's title, the focused control and the text of each mapped box, and logs **only changes**: "Customers opened", "search box = XKS-48", "Customers closed, name.first filled", "Vehicles opened"… Staff just work as usual. Reading the log answers, from real use:
- whether typing a full plate only highlights the row or also loads the customer (question 2);
- what appears after picking a customer with cars on file (question 5, `vehicle_pick`);
- how Customer Information opens for a new customer, and what Save leads to;
- which dialogs Parts, Labor and Note open, in what order.

**Trial mode** (clicks, opt-in per run). Runs one recipe for real against InvoMax and logs every step's check with timings. It only runs recipes whose steps end in a way-out (Exit, Cancel), never Save or Select, and refuses to start unless InvoMax is on an empty invoice. Example: "open Customers, type a plate, observe, Exit". It also measures how long each check took, which sets the step timeouts. If a trial leaves a customer on the invoice, staff clear it (the tool never presses Clear).

## 6. Wi-Fi sync fit (later)
- `store.py` keeps drafts and history in `drafts.db` (`sqlite3`, git-ignored): `drafts(id, json, updated)` and `history(id, draft_id, time, who, device, key, old, new)`. `answer()` + store write happen in one transaction.
- `wifi.py` (`http.server` on a thread) serves the same `questions(draft)` and calls the same `answer()` with `device="phone"`. It never imports `invomax` or `recipes`.
- The panel polls `drafts.updated` every second and shows phone edits as pending until Apply.

## 7. Testing
- `test_draft.py`: `from_job` (unknown code and missing side become questions, qty, labor covering parts, remarks), `questions` order and states, `answer` history rows, `expected_totals` (6% of parts + 20.00 supplies).
- `test_recipes.py`: every recipe against the fake InvoMax: happy path; stops at the first mismatch with the right step number; refuses Done/Charge/Print/Clear/Dial Number even if a recipe or control map points at them; `tries=2` click; `require` failure clicks nothing.
- Shop PC: probe map and watch logs first; then each recipe in trial mode; then the full flow on a scratch invoice with a made-up customer.

## 8. Open questions for the owner
Answered 2026-10-26/27: START isn't needed; a double-click opens Customers (Last Name box too); Select = double-click; License search shows plate | name; plates are typed with the hyphen; the third column is unused; brand-new customers go through the Customer Information window (first two boxes); one phone only, no address/zip/city/state; Year Make opens the Vehicles window and the VIN decoder works; Plate and VIN are single-clicked and typed in place, never double-clicked; Odometer + Enter copies to the second box, then the mechanic is typed by hand; Change, Continue and Fast Quote are never needed; Exit just closes; panel snaps to the four corners, bottom-right first.

Left to the probe instead of the owner: full-plate auto-select behaviour; what appears for a customer with cars on file; how Customer Information opens and what Save does; Parts/Labor/Note dialogs.

Still for the owner:
Watch mode approved 2026-10-27 ("never save anything, don't delete or edit customer data").
1. **Trial mode go-ahead** (later, once the runner exists): run on an empty invoice, opening Customers/Vehicles and backing out with Exit/Cancel?
