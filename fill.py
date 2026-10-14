"""Write a reviewed job into the open InvoMax invoice. Never clicks Done, Charge, Print or Clear."""
from __future__ import annotations

# Filled in on the shop PC (plan Task 4, Step 6) from print_control_identifiers output.
# Each key maps to a list of pywinauto child_window() specs; odometer has two boxes.
FIELD_MAP = {
    # "plate": [{"class_name": "ThunderRT6TextBox", "found_index": 7}],
}
GRID_START = None  # (x, y) client coords of the first empty Item Code cell
# One grid row as keystrokes; confirm column order on the shop PC.
ROW_KEYS = "{code}{{TAB}}{desc}{{TAB}}{qty}{{TAB}}{price}{{ENTER}}"

_SPECIAL = set("+^%~(){}[]")


def esc(s):
    """Escape pywinauto send_keys metacharacters."""
    return "".join("{%s}" % c if c in _SPECIAL else c for c in str(s))


def row_keys(line):
    return ROW_KEYS.format(code=esc(line.code), desc=esc(line.desc), qty=line.qty, price=f"{line.price:.2f}")


def field_writes(fields):
    """[(spec, value)] for mapped fields that have a value. Blank -> untouched in InvoMax."""
    return [(spec, fields[k]) for k, specs in FIELD_MAP.items() if fields.get(k) for spec in specs]


def fill(fields, lines):
    from pywinauto import Application
    from pywinauto.findwindows import ElementNotFoundError
    from pywinauto.keyboard import send_keys

    if not FIELD_MAP or GRID_START is None:
        raise RuntimeError("InvoMax control map isn't set up yet (fill.py FIELD_MAP / GRID_START).")
    try:
        win = Application(backend="win32").connect(title_re=".*InvoMax.*", timeout=3).top_window()
    except (ElementNotFoundError, TimeoutError) as e:
        raise RuntimeError("InvoMax isn't open. Open an invoice first.") from e
    win.restore()
    win.set_focus()
    for spec, value in field_writes(fields):
        try:
            win.child_window(**spec).set_edit_text(value)
        except Exception as e:  # stop at the first failure, report which field
            raise RuntimeError(f"Couldn't set {spec}: {e}") from e
    if lines:
        win.click_input(coords=GRID_START)
        for line in lines:
            send_keys(row_keys(line), with_spaces=True, pause=0.03)
