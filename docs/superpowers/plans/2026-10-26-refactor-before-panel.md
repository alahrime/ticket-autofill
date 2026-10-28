# Refactor Before the Side Panel — Plan

Status: **draft for review** (2026-10-26). Goes with `specs/2026-10-26-invomax-overlay-design.md`.

Goal: give the side panel, recipe runner, draft store and Wi-Fi sync one clear home each, **without changing what the current window does**. New features start only after this lands.

Constraints (unchanged): Python + Tk only; dependencies stay pillow and pywinauto; fully offline; tests are plain assert scripts that print `ok`; no real customer data in the repo.

## Where things live after the refactor
| File | Holds | Imports | Status |
|---|---|---|---|
| `ocr.py` | photo → text lines (Ollama) | PIL, urllib | unchanged |
| `read.py` | text lines → `Job`s; **+ `read_photo(path)`** (ocr + parse, moved from `app.read_page`) | `ocr` (lazily) | small move |
| `prices.py` | catalog, overrides, tiers, markup, `match`, `position`, `lines_for` | `draft` (for `Line`) | `Line` moves out |
| `draft.py` | **new.** `Value`, `Line` (kind/qty/cost/covers), `Draft`, `from_job`, `note_text`, later `questions`, `answer`, `expected_totals` | `read`, `prices` | new; logic moved from `app.App.show_job` |
| `invomax.py` | **new, replaces `fill.py`.** pywinauto driver, `CONTROLS`, `esc`, `row_keys`, `NEVER` captions | pywinauto (lazily) | rename + move |
| `recipes.py` | **new (feature step).** `Step`, `Recipe`, `RECIPES`, `run(recipe, values, driver)`, `StepFailed` | nothing GUI | after refactor |
| `panel.py` | **new (feature step).** Tk side panel | `draft`, `recipes`, `invomax`, `store` | after refactor |
| `store.py` | **new (feature step).** `sqlite3` drafts + history | sqlite3 | after refactor |
| `wifi.py` | **new (feature step).** `http.server` page | `draft`, `store` (never `invomax`/`recipes`) | after refactor |
| `probe.py` | **new (first feature step).** map / watch / trial modes (spec 5.8); writes only to git-ignored `probe/` | `invomax`, `recipes` | after refactor |
| `app.py` | entry point: load catalog, start window (later: panel + Wi-Fi thread) | everything above | shrinks |

Rule that keeps this clean: `draft.py`, `recipes.py`, `store.py` and `wifi.py` never import tkinter or pywinauto, so they all test on any machine.

## Steps (each ends with all tests printing `ok` and the window working as before)

### R1. Split `tests/test_fill_ocr.py`
- `tests/test_ocr.py` ← `test_text_lines_drops_fences_and_blanks`, `test_load_image`.
- `tests/test_invomax.py` ← `test_row_keys_escapes_specials`, `test_blank_fields_untouched`.
- Delete `tests/test_fill_ocr.py`; update the README test list.

### R2. `fill.py` → `invomax.py`
- `git mv fill.py invomax.py`; `app.py` does `import invomax` and calls `invomax.fill(...)`.
- The NEVER list lives with the runner in `recipes.py` (done 2026-10-27).
- `FIELD_MAP`/`GRID_START`/`field_writes`/`fill` stay for now; the recipe step replaces them, then they go.

### R3. `draft.py` with `Line`
- Move `Line` from `prices.py` to `draft.py` and extend it: `kind` (`"part"|"labor"|"remark"`), `qty`, `cost`, `covers`, `id`. Keep a `labor` property (`kind == "labor"`) so `prices.lines_for` and `test_prices.py` keep working.
- `prices.py` imports `Line` from `draft`. (`draft` must not import `prices` at module level to avoid a cycle; `from_job` takes the catalog functions it needs, or imports inside the function.)
- Move `note_text` from `app.py` to `draft.py`.

### R4. Move item → line logic out of `App`
- `draft.from_job(job, catalog, overrides, markup, codes={}, sides={})` returns a `Draft`: header `Value`s from `job.fields`/`job.flags`, lines from `lines_for`, notes, and `unmatched` for items with no code or no side.
- `App.show_job` keeps its dialogs for now but only to fill `codes`/`sides`, then calls `from_job`. `App.reprice`, `edit_price`, `delete_line` work on `draft.lines` instead of `self.items`/`self.edits`/`self.deleted` key tuples.
- `tests/test_draft.py`: page text from `test_read.py` → expected header values, flags, lines (codes, prices, LEFT/RIGHT on BOTH, INSTALL-PART labor), notes, unmatched.

### R5. `read_photo` into `read.py`
- `app.read_page` → `read.read_photo(path)` returning `(jobs, error)`; imports `ocr` inside the function so `test_read.py` still runs without Ollama.

### R6. Check
- `python tests/test_read.py`, `test_prices.py`, `test_ocr.py`, `test_invomax.py`, `test_draft.py` → `ok`.
- On this PC: run `app.py`, open the generated test image (no real photos), check the window still reads, reprices, edits and deletes lines exactly as before.

## After the refactor (feature steps, each its own approval)
0. `probe.py` map + watch modes (read-only) and `probe/` in `.gitignore`; run on the shop PC to fill `CONTROLS` and answer the open InvoMax behaviour questions. Trial mode after the runner exists.
1. Line model: qty, remark rows, labor covering several parts, `expected_totals` (6% of parts + 20.00 supplies). Tests.
2. `questions()` and `answer()` in `draft.py`. Tests.
3. `recipes.py` runner + fake InvoMax; recipes `customer_search`, `customer_pick`, `phone_set`. Tests.
4. `invomax.Driver` (pywinauto) and `CONTROLS`, built on the shop PC.
5. `panel.py` replaces `App`; `app.py` becomes the entry point only.
6. `store.py`, then `wifi.py`.
7. Remaining recipes as the owner's screenshots arrive (vehicle, parts, labor, remark, note, address, totals).
