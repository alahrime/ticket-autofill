# InvoMax Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small always-on-top Windows window that reads a photo of a handwritten notebook page offline, lets staff review the vehicle fields and priced line items, then fills them into the open InvoMax invoice.

**Architecture:** Five small Python files. `read.py` (text lines → jobs) and `prices.py` (item → InvoMax part + labor lines) are pure and fully tested. `ocr.py` wraps the offline OCR engine. `fill.py` writes into InvoMax with pywinauto. `app.py` is the Tkinter window that ties them together.

**Tech Stack:** Python 3.11+ (Windows), Tkinter (stdlib), Pillow, numpy, rapidocr-onnxruntime (offline OCR), pywinauto (Windows only). Tests are plain `assert` scripts run with `python tests/<file>.py`, so no test framework is needed.

**Spec:** `docs/superpowers/specs/2026-10-14-invomax-autofill-design.md`

## Global Constraints

- Runs on the shop's Windows PC, fully offline (photos never leave the machine).
- One Python program; no React/Go.
- InvoMax is unchanged; the tool fills it from outside and never clicks Done, Charge, Print, or Clear.
- Missing or unreadable field → left blank and untouched in InvoMax.
- Part price precedence: written price → cost × markup (default ×2.5, rounded up to the next $5) → override for code+make → catalog price × make tier.
- Each part produces a `CODE` row then an `INSTALL-PART` "Remove & Install: DESCRIPTION" row; `labor_price` 0 → no labor row.
- `parts.csv` columns are fixed: `code,description,aliases,sided,part_price,labor_price` (the shop's export gets converted to this shape).

## Review Focus

1. **iPhone HEIC photo or a non-image file:** staff get "Save the photo as JPG or PNG" instead of a crash. Covered by `load_image` → `ValueError` in Task 3.
2. **Phone photo taken sideways (EXIF rotation):** text is read upright. Handled by `exif_transpose` in Task 3; checked with a real sideways photo in Task 6.
3. **InvoMax closed or minimised when Fill is clicked:** staff get "InvoMax isn't open" or the window is restored, never a traceback. Handled in `fill.fill`; checked manually in Task 6.
4. **Descriptions with send_keys metacharacters (`A/C`, `(R)`, `50%`):** typed literally. Covered by `test_row_keys_escapes_specials`.
5. **InvoMax customer lookup already filled name or phone, and the page has none:** those fields are untouched. Covered by `test_blank_fields_untouched`.

## Files

| File | Responsibility |
|---|---|
| `read.py` | OCR lines → `Job`s: date split, labelled fields, name inference, items with cost/price, notes, VIN check digit, flags |
| `prices.py` | catalog/override CSV I/O, alias match, make tier, markup, `lines_for()` |
| `ocr.py` | image load (EXIF rotate, downscale), RapidOCR, row grouping |
| `fill.py` | InvoMax control map, keystroke escaping, `fill()` |
| `app.py` | Tkinter window |
| `parts.csv` | placeholder catalog (already exists) |
| `overrides.csv` | created at runtime when staff keep a price |
| `tests/test_read.py`, `tests/test_prices.py`, `tests/test_fill_ocr.py` | assert-based checks |
| `tests/samples/page1.jpg` | sample notebook page (already exists) |
| `requirements.txt`, `run.bat` | install and launch on the shop PC |

---

### Task 1: Page parser (`read.py`)

**Files:**
- Create: `read.py`, `tests/test_read.py`, `.gitignore`, `requirements.txt`

**Interfaces:**
- Produces: `Item(desc: str, price: float|None=None, cost: float|None=None)`; `Job(date: str, fields: dict, flags: dict, items: list[Item], notes: list[str])`; `parse(lines: list[str]) -> list[Job]`; `fix_vin(raw: str) -> tuple[str, bool]`.
- `Job.fields` keys (only present when found): `vin, plate, odometer, year_make, make (lowercase first word of the car), first, last, phone, tech`.

- [ ] **Step 1: Initialise the repo**

```bash
git init
printf '__pycache__/\n_pasted.png\noverrides.csv\n' > .gitignore
printf 'pillow\nnumpy\nrapidocr-onnxruntime\npywinauto; sys_platform == "win32"\n' > requirements.txt
git add .gitignore requirements.txt parts.csv tests/samples/page1.jpg docs
git commit -m "chore: spec, plan, placeholder catalog, sample page"
```

- [ ] **Step 2: Write the failing test** `tests/test_read.py`

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from read import parse, fix_vin

PAGE1 = """10/14/26
VIN:- 2T1BR32614C809083
TAG:- XKS4827
MIL:- 98431
Car:- 2004 Subaru Forester.
*oil chng. 30$
*Front brake pads 100$
*Rear brake pads. 100$
$81 *Left front Axle 200$
________________
10/14/26
TAG:- JTW2648
MIL:- 142087
Car: 1994 Nissan Altima.
(R) 4Q *oil chng. 20$
*Left brake light 30$""".splitlines()


def test_splits_jobs_and_reads_fields():
    a, b = parse(PAGE1)
    assert a.date == "10/14/26"
    assert a.fields["vin"] == "2T1BR32614C809083"
    assert a.fields["plate"] == "XKS4827"
    assert a.fields["odometer"] == "98431"
    assert a.fields["year_make"] == "2004 Subaru Forester"
    assert a.fields["make"] == "subaru"
    assert "vin" not in b.fields and "first" not in b.fields  # missing stays missing
    assert b.fields["plate"] == "JTW2648"


def test_items_cost_price_and_notes():
    a, b = parse(PAGE1)
    assert [(i.desc, i.price) for i in a.items] == [
        ("oil chng", 30), ("Front brake pads", 100), ("Rear brake pads", 100), ("Left front Axle", 200)]
    assert a.items[3].cost == 81
    assert b.items[0].desc == "oil chng" and b.items[0].price == 20
    assert b.notes == ["(R) 4Q"]


def test_name_phone_when_present():
    (j,) = parse(["10/14/26", "Jane Doe", "Ph: 555 010 0123", "Mil: 12,000"])
    assert (j.fields["first"], j.fields["last"]) == ("Jane", "Doe")
    assert j.fields["phone"] == "(555)010-0123"
    assert j.fields["odometer"] == "12000"


def test_label_variants():
    (j,) = parse(["ViN;- 2T1BR32614C809083", "Odo - 99", "plate: abc 123"])
    assert j.fields["vin"] == "2T1BR32614C809083"
    assert j.fields["odometer"] == "99"
    assert j.fields["plate"] == "ABC123"


def test_vin_fixes():
    assert fix_vin("2T1BR326I4C8O9083") == ("2T1BR32614C809083", True)  # I/O normalised
    assert fix_vin("2T1BR326L4C809083") == ("2T1BR32614C809083", True)  # unique lookalike swap
    assert fix_vin("2T1BR32G14C809083") == ("2T1BR32G14C809083", False)  # two swaps validate -> don't guess
    assert fix_vin("2T1BR32614C80908") == ("2T1BR32614C80908", False)   # too short


def test_flags():
    (j,) = parse(["VIN: 12345", "TAG: XKS4827", "MIL: 12a45", "Ph: 555"])
    assert set(j.flags) == {"vin", "plate", "odometer", "phone"}


def test_garbage_does_not_crash():
    assert parse([]) == []
    (j,) = parse(["???", "*", "$ *", "Car: Honda"])
    assert j.fields["year_make"] == "Honda" and j.fields["make"] == "honda"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
```

- [ ] **Step 3: Run it to verify it fails**

Run: `python tests/test_read.py`
Expected: `ModuleNotFoundError: No module named 'read'`

- [ ] **Step 4: Implement** `read.py`

```python
"""Turn OCR text lines from a notebook page into jobs (fields, items, notes)."""
from __future__ import annotations
import re
from dataclasses import dataclass, field

LABELS = {
    "vin": "vin",
    "tag": "plate", "plate": "plate",
    "mil": "odometer", "mile": "odometer", "miles": "odometer", "odo": "odometer", "odometer": "odometer",
    "car": "car",
    "name": "name",
    "ph": "phone", "phone": "phone", "tel": "phone",
    "tech": "tech", "inspector": "tech", "mechanic": "tech",
}
LABEL_RE = re.compile(r"^\s*([a-z]+)\s*[:;.\-–°]+[\s:;\-–.]*(.+)$", re.I)
DATE_RE = re.compile(r"^\s*\d{1,2}\s*/\s*\d{1,2}\s*/\s*\d{2,4}\s*$")
PRICE_RE = re.compile(r"^(.*?)[\s.,]*(\d+(?:\.\d{1,2})?)\s*\$?\s*$")
COST_RE = re.compile(r"\$\s*(\d+(?:\.\d{1,2})?)")

# VIN transliteration and weights (49 CFR 565)
_T = dict(zip("ABCDEFGHJKLMNPRSTUVWXYZ", [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 7, 9, 2, 3, 4, 5, 6, 7, 8, 9]))
_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
_SWAP = {"0": "D", "D": "0", "1": "L", "L": "1", "5": "S", "S": "5", "8": "B", "B": "8",
         "2": "Z", "Z": "2", "6": "G", "G": "6"}


def vin_valid(v):
    if len(v) != 17 or any(c not in _T and not c.isdigit() for c in v):
        return False
    s = sum((int(c) if c.isdigit() else _T[c]) * w for c, w in zip(v, _W)) % 11
    return v[8] == ("X" if s == 10 else str(s))


def fix_vin(raw):
    """Return (vin, ok). Tries one lookalike swap; accepts only a unique fix."""
    v = re.sub(r"[^A-Z0-9]", "", raw.upper()).replace("O", "0").replace("Q", "0").replace("I", "1")
    if vin_valid(v):
        return v, True
    fixes = {v[:i] + _SWAP[c] + v[i + 1:] for i, c in enumerate(v) if c in _SWAP}
    fixes = [f for f in fixes if vin_valid(f)]
    return (fixes[0], True) if len(fixes) == 1 else (v, False)


@dataclass
class Item:
    desc: str
    price: float | None = None
    cost: float | None = None


@dataclass
class Job:
    date: str = ""
    fields: dict = field(default_factory=dict)  # only fields actually found
    flags: dict = field(default_factory=dict)   # field -> reason to double-check
    items: list = field(default_factory=list)
    notes: list = field(default_factory=list)


def _num(s):
    return float(s) if s is not None else None


def parse_item(line):
    left, _, right = line.partition("*")
    cost = COST_RE.search(left)
    note = COST_RE.sub("", left).strip()
    m = PRICE_RE.match(right.strip())
    desc, price = (m.group(1), m.group(2)) if m and m.group(1).strip() else (right, None)
    return Item(desc.strip(" .,-"), _num(price), _num(cost.group(1)) if cost else None), note


def _set(job, key, value):
    value = value.strip(" .,")
    if key == "vin":
        value, ok = fix_vin(value)
        if not ok:
            job.flags["vin"] = "VIN check digit fails"
    elif key == "plate":
        value = re.sub(r"[^A-Z0-9]", "", value.upper())
        if re.search(r"[S5O0I1]", value):
            job.flags["plate"] = "check S/5, O/0, I/1"
    elif key == "odometer":
        value = value.replace(",", "").replace(" ", "")
        if not value.isdigit():
            job.flags["odometer"] = "not a number"
    elif key == "phone":
        d = re.sub(r"\D", "", value)
        if len(d) == 10:
            value = f"({d[:3]}){d[3:6]}-{d[6:]}"
        else:
            job.flags["phone"] = "not 10 digits"
    elif key == "car":
        job.fields["year_make"] = value
        words = re.sub(r"^\d{4}\s*", "", value).split()
        if words:
            job.fields["make"] = words[0].lower()
        return
    elif key == "name":
        parts = value.split()
        job.fields["first"], job.fields["last"] = parts[0], " ".join(parts[1:])
        return
    job.fields[key] = value


def parse(lines):
    """lines: OCR text lines top-to-bottom. Returns list[Job]."""
    jobs, job = [], None
    for raw in lines:
        line = raw.strip()
        if not line or set(line) <= set("-_—=~ "):
            continue
        if DATE_RE.match(line):
            job = Job(date=re.sub(r"\s", "", line))
            jobs.append(job)
            continue
        if job is None:
            job = Job()
            jobs.append(job)
        if "*" in line:
            item, note = parse_item(line)
            job.items.append(item)
            if note:
                job.notes.append(note)
            continue
        m = LABEL_RE.match(line)
        key = m and LABELS.get(m.group(1).lower())
        if key:
            _set(job, key, m.group(2))
        elif not job.fields and not job.items and re.fullmatch(r"[A-Za-z'\-]+(\s+[A-Za-z'\-]+)+", line):
            _set(job, "name", line)  # unlabelled first line = customer name
        else:
            job.notes.append(line)
    return jobs
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python tests/test_read.py`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add read.py tests/test_read.py
git commit -m "feat: parse notebook text into jobs with VIN check"
```

---

### Task 2: Pricing (`prices.py`)

**Files:**
- Create: `prices.py`, `tests/test_prices.py`

**Interfaces:**
- Consumes: `read.Item`, `parts.csv`.
- Produces: `Part`, `Line(code: str, desc: str, price: float, labor: bool=False, qty: int=1)`; `load_catalog(path) -> dict[str, Part]`; `load_overrides(path) -> dict[(code, make, kind), float]`; `save_override(path, overrides, code, make, kind, price)`; `match(desc, catalog) -> str|None`; `position(desc) -> (front_rear|None, side|None)`; `markup_price(cost, markup=2.5) -> int`; `tier(make) -> float`; `lines_for(item, code, make, catalog, overrides, markup=2.5, side=None) -> list[Line]`; `DEFAULT_MARKUP`.

- [ ] **Step 1: Write the failing test** `tests/test_prices.py`

```python
import os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from prices import load_catalog, load_overrides, save_override, match, lines_for, markup_price, tier
from read import Item

CAT = load_catalog(os.path.join(ROOT, "parts.csv"))


def test_match_aliases():
    assert match("Front brake pads", CAT) == "FBP"
    assert match("Rear brake pads", CAT) == "RBP"
    assert match("oil chng", CAT) == "OIL"
    assert match("Left front Axle", CAT) == "AXL"
    assert match("Left brake light", CAT) == "BBLB"
    assert match("oil filter", CAT) == "OFL"  # longest alias wins
    assert match("flux capacitor", CAT) is None


def test_written_price_and_labor_like_invomax():
    lines = lines_for(Item("Front brake pads", 100), "FBP", "subaru", CAT, {})
    assert [(l.code, l.desc, l.price) for l in lines] == [
        ("FBP", "FRONT BRAKE PADS", 100), ("INSTALL-PART", "Remove & Install: FRONT BRAKE PADS", 100)]


def test_sided_part_takes_position_from_text():
    part, labor = lines_for(Item("Left front Axle", 200, 81), "AXL", "subaru", CAT, {})
    assert part.desc == "AXLE ASSEMBLY    FRONT/LEFT" and part.price == 200  # written price beats cost
    assert labor.desc == "Remove & Install: AXLE ASSEMBLY    FRONT/LEFT" and labor.labor


def test_both_sides_expands_to_two_pairs():
    lines = lines_for(Item("mirror"), "MIR", "honda", CAT, {}, side="BOTH")
    assert [l.desc for l in lines if not l.labor] == ["SIDE MIRROR    LEFT", "SIDE MIRROR    RIGHT"]
    assert len(lines) == 4


def test_price_precedence():
    ov = {("FBP", "bmw", "part"): 333, ("FBP", "bmw", "labor"): 120}
    assert lines_for(Item("pads", 90), "FBP", "bmw", CAT, ov)[0].price == 90            # written
    assert lines_for(Item("pads", None, 81), "FBP", "bmw", CAT, ov)[0].price == 205      # cost x markup
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, ov)[0].price == 333                # override
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, ov)[1].price == 120
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, {})[0].price == 160                # 100 x 1.6
    assert lines_for(Item("pads"), "FBP", "unknownmake", CAT, {})[0].price == 100


def test_flat_service_has_no_labor_line():
    assert len(lines_for(Item("oil chng", 30), "OIL", "nissan", CAT, {})) == 1


def test_markup_and_tiers():
    assert markup_price(81) == 205
    assert markup_price(80, 2.0) == 160
    assert (tier("Honda"), tier("ford"), tier("BMW"), tier(None)) == (1.0, 1.15, 1.6, 1.0)


def test_overrides_round_trip():
    path = os.path.join(tempfile.mkdtemp(), "overrides.csv")
    ov = load_overrides(path)
    assert ov == {}
    save_override(path, ov, "AXL", "subaru", "labor", 275.0)
    assert load_overrides(path) == {("AXL", "subaru", "labor"): 275.0}


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python tests/test_prices.py`
Expected: `ModuleNotFoundError: No module named 'prices'`

- [ ] **Step 3: Implement** `prices.py`

```python
"""Item description -> InvoMax lines (part + INSTALL-PART labor) with prices."""
from __future__ import annotations
import csv, math, os, re
from dataclasses import dataclass

TIERS = {  # placeholder make multipliers
    1.15: "ford chevrolet chevy dodge jeep ram gmc buick chrysler volkswagen vw",
    1.6: "bmw mercedes mercedes-benz audi lexus acura infiniti volvo porsche land",
}
DEFAULT_MARKUP = 2.5


@dataclass
class Part:
    code: str
    description: str
    aliases: list
    sided: bool
    part_price: float
    labor_price: float


@dataclass
class Line:
    code: str
    desc: str
    price: float
    labor: bool = False  # True = INSTALL-PART row
    qty: int = 1


def load_catalog(path):
    with open(path, newline="") as f:
        return {r["code"]: Part(r["code"], r["description"], r["aliases"].lower().split("|"),
                                r["sided"] == "yes", float(r["part_price"]), float(r["labor_price"]))
                for r in csv.DictReader(f)}


def load_overrides(path):
    if not os.path.exists(path):
        return {}
    with open(path, newline="") as f:
        return {(r["code"], r["make"], r["kind"]): float(r["price"]) for r in csv.DictReader(f)}


def save_override(path, overrides, code, make, kind, price):
    overrides[(code, make, kind)] = price
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["code", "make", "kind", "price"])
        for (c, m, k), p in sorted(overrides.items()):
            w.writerow([c, m, k, p])


def tier(make):
    return next((m for m, makes in TIERS.items() if (make or "").lower() in makes.split()), 1.0)


def match(desc, catalog):
    """Longest alias contained in desc wins (so 'oil filter' beats 'oil'). None if no match."""
    d = " " + re.sub(r"[^a-z0-9/ ]", " ", desc.lower()) + " "
    hits = [(len(a), code) for code, p in catalog.items() for a in p.aliases if f" {a} " in d]
    return max(hits)[1] if hits else None


def position(desc):
    """'Left front Axle' -> ('FRONT', 'LEFT'); missing parts are None."""
    d = desc.lower().split()
    fr = "FRONT" if "front" in d else "REAR" if "rear" in d else None
    side = ("LEFT" if {"left", "lh", "driver"} & set(d) else
            "RIGHT" if {"right", "rh", "passenger"} & set(d) else
            "BOTH" if "both" in d else None)
    return fr, side


def markup_price(cost, markup=DEFAULT_MARKUP):
    return math.ceil(cost * markup / 5) * 5


def lines_for(item, code, make, catalog, overrides, markup=DEFAULT_MARKUP, side=None):
    """item: read.Item. side: 'LEFT'/'RIGHT'/'BOTH' chosen in the UI when the text has none."""
    p = catalog[code]
    fr, text_side = position(item.desc)
    side = text_side or side
    t = tier(make)
    if item.price is not None:
        price = item.price
    elif item.cost is not None:
        price = markup_price(item.cost, markup)
    else:
        price = overrides.get((code, make, "part"), round(p.part_price * t))
    labor = overrides.get((code, make, "labor"), round(p.labor_price * t))
    sides = ["LEFT", "RIGHT"] if side == "BOTH" else [side]
    out = []
    for s in sides:
        tag = "/".join(x for x in (fr, s) if x) if p.sided else ""
        desc = f"{p.description}    {tag}" if tag else p.description
        out.append(Line(code, desc, price))
        if labor:
            out.append(Line("INSTALL-PART", f"Remove & Install: {desc}", labor, labor=True))
    return out
```

- [ ] **Step 4: Run both test files**

Run: `python tests/test_prices.py && python tests/test_read.py`
Expected: `ok` twice

- [ ] **Step 5: Commit**

```bash
git add prices.py tests/test_prices.py
git commit -m "feat: catalog match, tiers, markup, part+labor lines"
```

---

### Task 3: Offline OCR (`ocr.py`) and fill helpers (`fill.py`)

These share one test file because both pure helpers are tiny. `fill.fill()` itself is only exercised on the shop PC (Task 6).

**Files:**
- Create: `ocr.py`, `fill.py`, `tests/test_fill_ocr.py`

**Interfaces:**
- Consumes: `prices.Line`.
- Produces: `ocr.load_image(path) -> numpy.ndarray` (raises `ValueError` with a staff-readable message); `ocr.group_lines(result) -> list[str]`; `ocr.ocr_lines(path) -> list[str]`; `fill.FIELD_MAP: dict[str, list[dict]]`; `fill.GRID_START: tuple|None`; `fill.row_keys(line) -> str`; `fill.field_writes(fields) -> list[(spec, value)]`; `fill.fill(fields: dict, lines: list[Line])` (raises `RuntimeError` with a readable message).

- [ ] **Step 1: Write the failing test** `tests/test_fill_ocr.py`

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fill
from ocr import group_lines
from prices import Line


def box(x, y, w=50, h=20):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def test_group_lines_merges_rows_left_to_right():
    result = [[box(200, 102), "2T1BR32614C809083", .9], [box(10, 100), "VIN:-", .9],
              [box(10, 140), "TAG:-", .9], [box(200, 143), "XKS4827", .9]]
    assert group_lines(result) == ["VIN:- 2T1BR32614C809083", "TAG:- XKS4827"]
    assert group_lines([]) == []


def test_row_keys_escapes_specials():
    keys = fill.row_keys(Line("ACR", "A/C RECHARGE (R) 50%", 60.0))
    assert keys == "ACR{TAB}A/C RECHARGE {(}R{)} 50{%}{TAB}1{TAB}60.00{ENTER}"


def test_blank_fields_untouched():
    fill.FIELD_MAP = {"plate": [{"auto_id": "p"}], "first": [{"auto_id": "f"}],
                      "odometer": [{"auto_id": "o1"}, {"auto_id": "o2"}]}
    writes = fill.field_writes({"plate": "XKS4827", "first": "", "odometer": "98431"})
    assert writes == [({"auto_id": "p"}, "XKS4827"), ({"auto_id": "o1"}, "98431"), ({"auto_id": "o2"}, "98431")]


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python tests/test_fill_ocr.py`
Expected: `ModuleNotFoundError: No module named 'fill'`

- [ ] **Step 3: Implement** `ocr.py`

```python
"""Photo -> text lines, offline (RapidOCR: ONNX models, no internet)."""
from __future__ import annotations

_engine = None


def load_image(path):
    """Open, apply phone EXIF rotation, return RGB numpy array. Clear error for unreadable files."""
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError(f"Can't read {path}. Save the photo as JPG or PNG and try again.") from e
    img.thumbnail((2500, 2500))  # phone photos are huge; OCR doesn't need more
    return np.array(img)


def group_lines(result):
    """result: [[box (4 points), text, score], ...]. Merge boxes on the same row, left to right."""
    boxes = sorted((sum(p[1] for p in b) / 4, b[0][0], abs(b[2][1] - b[0][1]), t) for b, t, _ in result)
    rows = []
    for y, x, h, t in boxes:
        if rows and abs(y - rows[-1][0]) < max(h, rows[-1][1]) * 0.5:
            rows[-1][2].append((x, t))
        else:
            rows.append([y, h, [(x, t)]])
    return [" ".join(t for _, t in sorted(r[2])) for r in rows]


def ocr_lines(path):
    global _engine
    from rapidocr_onnxruntime import RapidOCR
    _engine = _engine or RapidOCR()
    result, _ = _engine(load_image(path))
    return group_lines(result or [])
```

- [ ] **Step 4: Implement** `fill.py`

```python
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
```

- [ ] **Step 5: Run the tests**

Run: `python tests/test_fill_ocr.py`
Expected: `ok`

- [ ] **Step 6: Check the OCR engine against the sample page (decides the engine)**

```bash
pip install -r requirements.txt
python -c "from ocr import ocr_lines; from read import parse; ls=ocr_lines('tests/samples/page1.jpg'); print('\n'.join(ls)); [print(j) for j in parse(ls)]"
python -c "from ocr import load_image; load_image('requirements.txt')"
```

Expected:
- The second command raises `ValueError: Can't read requirements.txt. Save the photo as JPG or PNG…`.
- **Pass bar for the first command:**
  - Two jobs are found.
  - Job 1's VIN reads as `2T1BR32614C809083`, either directly or flagged with at most one wrong character.
  - Plate and odometer are correct.
  - At least 3 of job 1's 4 items match a catalog code.

**If it passes:** keep RapidOCR and record the output in the commit message.

**If it fails:** replace `ocr_lines` with RapidOCR detection plus TrOCR handwriting recognition on each box. This adds about 450 MB (torch CPU plus model), downloaded once and then used offline:

```python
def ocr_lines(path):
    global _engine
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    if _engine is None:
        name = "microsoft/trocr-small-handwritten"
        _engine = (RapidOCR(), TrOCRProcessor.from_pretrained(name), VisionEncoderDecoderModel.from_pretrained(name))
    det, proc, model = _engine
    arr = load_image(path)
    boxes = det(arr)[0] or []  # reuse RapidOCR boxes, replace their text
    img = Image.fromarray(arr)
    result = []
    for b, _, score in boxes:
        xs, ys = [p[0] for p in b], [p[1] for p in b]
        crop = img.crop((min(xs), min(ys), max(xs), max(ys)))
        ids = model.generate(proc(images=crop, return_tensors="pt").pixel_values, max_new_tokens=32)
        result.append([b, proc.batch_decode(ids, skip_special_tokens=True)[0], score])
    return group_lines(result)
```

Add `transformers` and `torch` to `requirements.txt`. Set `HF_HUB_OFFLINE=1` in `run.bat` after the first model download. Rerun the pass-bar command above.

- [ ] **Step 7: Commit**

```bash
git add ocr.py fill.py tests/test_fill_ocr.py requirements.txt
git commit -m "feat: offline OCR wrapper and InvoMax fill helpers"
```

---

### Task 4: Window (`app.py`) and launcher

**Files:**
- Create: `app.py`, `run.bat`

**Interfaces:**
- Consumes: `read.parse/Job`, `prices.*`, `ocr.ocr_lines`, `fill.fill`.
- Produces: the runnable app.

- [ ] **Step 1: Implement** `app.py`

```python
"""Always-on-top helper next to InvoMax: photo -> review -> Fill."""
import os, sys, tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from read import parse, Job
from prices import (load_catalog, load_overrides, save_override, match, position, lines_for,
                    DEFAULT_MARKUP)
import fill

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = load_catalog(os.path.join(HERE, "parts.csv"))
OV_PATH = os.path.join(HERE, "overrides.csv")
FIELDS = [("first", "First"), ("last", "Last"), ("phone", "Phone"), ("year_make", "Year Make"),
          ("plate", "Plate"), ("vin", "VIN"), ("odometer", "Odometer"), ("tech", "Tech")]
FLAG_BG = "#fff3b0"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("InvoMax Autofill")
        self.attributes("-topmost", True)
        self.overrides = load_overrides(OV_PATH)
        self.jobs, self.items, self.lines, self.make = [], [], [], ""

        bar = ttk.Frame(self)
        bar.pack(fill="x")
        ttk.Button(bar, text="Open photo", command=self.open_photo).pack(side="left")
        ttk.Button(bar, text="Paste photo", command=self.paste_photo).pack(side="left")
        self.job_box = ttk.Combobox(bar, state="readonly", width=28)
        self.job_box.pack(side="left")
        self.job_box.bind("<<ComboboxSelected>>", lambda e: self.show_job(self.job_box.current()))
        ttk.Label(bar, text=" Markup ×").pack(side="left")
        self.markup = tk.StringVar(value=str(DEFAULT_MARKUP))
        ttk.Spinbox(bar, from_=1, to=5, increment=0.1, width=4, textvariable=self.markup,
                    command=self.reprice).pack(side="left")

        form = ttk.Frame(self)
        form.pack(fill="x")
        self.vars, self.entries = {}, {}
        for r, (k, label) in enumerate(FIELDS):
            ttk.Label(form, text=label).grid(row=r, column=0, sticky="w")
            self.vars[k] = tk.StringVar()
            self.entries[k] = tk.Entry(form, textvariable=self.vars[k], width=32)
            self.entries[k].grid(row=r, column=1, sticky="w")

        self.tree = ttk.Treeview(self, columns=("code", "desc", "cost", "price"), show="headings", height=10)
        for c, w in (("code", 100), ("desc", 320), ("cost", 60), ("price", 70)):
            self.tree.heading(c, text=c.title())
            self.tree.column(c, width=w)
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<Double-1>", self.edit_price)
        self.tree.bind("<Delete>", self.delete_line)
        ttk.Label(self, text="Notes (copied for InvoMax Note):").pack(anchor="w")
        self.note = tk.Text(self, height=3)
        self.note.pack(fill="x")
        ttk.Button(self, text="Fill InvoMax", command=self.do_fill).pack(fill="x")

    # --- photo -> jobs
    def open_photo(self):
        p = filedialog.askopenfilename(filetypes=[("Images", "*.jpg *.jpeg *.png *.webp")])
        if p:
            self.load(p)

    def paste_photo(self):
        from PIL import ImageGrab
        img = ImageGrab.grabclipboard()
        if isinstance(img, list):  # a copied file
            return self.load(img[0])
        if img is None:
            return messagebox.showinfo("Paste", "No image on the clipboard.")
        p = os.path.join(HERE, "_pasted.png")
        img.save(p)
        self.load(p)

    def load(self, path):
        from ocr import ocr_lines
        try:
            self.jobs = parse(ocr_lines(path))
        except Exception as e:
            self.jobs = []
            messagebox.showwarning("Couldn't read page", str(e))
        if not self.jobs:  # nothing read: show the photo and empty fields for manual entry
            if sys.platform == "win32" and os.path.exists(path):
                os.startfile(path)
            self.jobs = [Job()]
        self.job_box["values"] = [f"{i + 1}: {j.date} {j.fields.get('year_make', '')}"
                                  for i, j in enumerate(self.jobs)]
        self.job_box.current(0)
        self.show_job(0)

    def show_job(self, i):
        job = self.jobs[i]
        for k, v in self.vars.items():
            v.set(job.fields.get(k, ""))
            self.entries[k].config(bg=FLAG_BG if k in job.flags else "white")
        notes = list(job.notes)
        self.make = job.fields.get("make", "")
        self.items = []
        for it in job.items:
            code = match(it.desc, CATALOG) or self.ask_code(it.desc)
            if not code:
                notes.append(it.desc)
                continue
            side = None
            if CATALOG[code].sided and position(it.desc)[1] is None:
                side = self.ask_side(it.desc)
            self.items.append((it, code, side))
        self.note.delete("1.0", "end")
        self.note.insert("1.0", "\n".join(notes))
        self.reprice()

    def ask_code(self, desc):
        while True:
            c = simpledialog.askstring("Unknown item", f"No catalog match for:\n{desc}\n\n"
                                       "Item code? (blank = put it in the note)", parent=self)
            if not c:
                return None
            if c.strip().upper() in CATALOG:
                return c.strip().upper()

    def ask_side(self, desc):
        while True:
            s = simpledialog.askstring("Which side?", f"{desc}\nLEFT, RIGHT or BOTH?",
                                       initialvalue="LEFT", parent=self)
            if s is None:
                return None
            if s.strip().upper() in ("LEFT", "RIGHT", "BOTH"):
                return s.strip().upper()

    # --- lines
    def reprice(self):
        try:
            markup = float(self.markup.get())
        except ValueError:
            markup = DEFAULT_MARKUP
        # ponytail: repricing drops unsaved manual price edits; only markup changes trigger it
        self.tree.delete(*self.tree.get_children())
        self.lines = []
        for it, code, side in self.items:
            for ln in lines_for(it, code, self.make, CATALOG, self.overrides, markup, side):
                cost = "" if ln.labor or it.cost is None else f"{it.cost:.2f}"
                iid = self.tree.insert("", "end", values=(ln.code, ln.desc, cost, f"{ln.price:.2f}"))
                self.lines.append((iid, ln, code))

    def edit_price(self, event):
        iid = self.tree.identify_row(event.y)
        hit = next((x for x in self.lines if x[0] == iid), None)
        if not hit:
            return
        _, ln, code = hit
        new = simpledialog.askfloat("Price", ln.desc, initialvalue=ln.price, minvalue=0, parent=self)
        if new is None:
            return
        ln.price = new
        self.tree.set(iid, "price", f"{new:.2f}")
        kind = "labor" if ln.labor else "part"
        if messagebox.askyesno("Keep price?", f"Keep ${new:.2f} {kind} for {code} on {self.make or 'unknown make'}?"):
            save_override(OV_PATH, self.overrides, code, self.make, kind, new)

    def delete_line(self, _event):
        for iid in self.tree.selection():
            self.tree.delete(iid)
        self.lines = [x for x in self.lines if self.tree.exists(x[0])]

    def do_fill(self):
        fields = {k: v.get().strip() for k, v in self.vars.items() if v.get().strip()}
        try:
            fill.fill(fields, [ln for _, ln, _ in self.lines])
        except Exception as e:
            return messagebox.showerror("Fill stopped", str(e))
        note = self.note.get("1.0", "end").strip()
        if note:
            self.clipboard_clear()
            self.clipboard_append(note)
        messagebox.showinfo("Filled", "Check the invoice in InvoMax." + (" Notes are on the clipboard for the Note box." if note else ""))


if __name__ == "__main__":
    App().mainloop()
```

- [ ] **Step 2: Launcher** `run.bat`

```bat
@echo off
cd /d "%~dp0"
start "" pythonw app.py
```

- [ ] **Step 3: Smoke-check on any machine**

Run: `python app.py`, then **Open photo** → `tests/samples/page1.jpg`.

Expected:
- The job dropdown shows two jobs.
- Job 1 shows VIN, plate, odometer and Year Make; the plate is highlighted yellow (S/5 check).
- The lines read FBP/INSTALL-PART ×2, RBP/INSTALL-PART ×2, `AXLE ASSEMBLY    FRONT/LEFT` at 200.00 with cost 81.00, and OIL at 30.00 with no labor row.
- Double-clicking a price asks for a new value, then asks "Keep price?". Saying yes writes `overrides.csv`.
- Clicking **Fill InvoMax** before the control map exists shows "control map isn't set up yet".

- [ ] **Step 4: Commit**

```bash
git add app.py run.bat
git commit -m "feat: review window and launcher"
```

---

### Task 5: InvoMax control map (on the shop PC)

**Files:**
- Modify: `fill.py` (`FIELD_MAP`, `GRID_START`, `ROW_KEYS`)

- [ ] **Step 1: Dump InvoMax's controls** with a blank invoice open

```bash
python -c "from pywinauto import Desktop; Desktop(backend='win32').window(title_re='.*InvoMax.*').print_control_identifiers(filename='invomax_controls.txt')"
```

If the file shows no edit boxes, rerun with `backend='uia'` and change `Application(backend=...)` in `fill.fill` to match.

- [ ] **Step 2: Fill `FIELD_MAP`.** Type a unique value into each InvoMax box (First, Last, Phone, Year Make, Plate, Vin, Odometer ×2), rerun Step 1, and find each value in the dump. Record each box's `class_name` plus `found_index` (or `auto_id` under uia), for example:

```python
FIELD_MAP = {
    "first": [{"class_name": "ThunderRT6TextBox", "found_index": 0}],
    "odometer": [{"class_name": "ThunderRT6TextBox", "found_index": 9},
                 {"class_name": "ThunderRT6TextBox", "found_index": 10}],
}
```

These indexes are examples; use the values from the dump.

- [ ] **Step 3: Set the grid entry.**
  1. Hover over the first empty Item Code cell and run `python -c "import win32api; print(win32api.GetCursorPos())"`.
  2. Convert that screen position to window-client coordinates: subtract `win.client_area_rect().left/top`.
  3. Set `GRID_START` to the result.
  4. Type one row by hand, then set `ROW_KEYS` to the key order that worked. If InvoMax auto-fills the description from the code, drop `{desc}{{TAB}}`.

- [ ] **Step 4: Verify on a scratch invoice.** Run the app, load `page1.jpg`, choose job 1, click Fill.

Expected: Year Make, Plate, Vin and both Odometer boxes are filled. Name and Phone are untouched. Six item rows are added, matching the screenshot convention. Nothing is saved.

- [ ] **Step 5: Commit**

```bash
git add fill.py
git commit -m "feat: InvoMax control map for shop PC"
```

---

### Task 6: Shop acceptance

- [ ] **Step 1:** With InvoMax closed, click Fill. Expected: "InvoMax isn't open. Open an invoice first."
- [ ] **Step 2:** With InvoMax minimised, click Fill. Expected: the window is restored and filled.
- [ ] **Step 3:** Load an iPhone HEIC photo. Expected: the "Save the photo as JPG or PNG" warning, then empty fields for manual entry.
- [ ] **Step 4:** Load a sideways phone photo of a page. Expected: the same fields as the upright photo.
- [ ] **Step 5:** Run three real pages end to end and note every field staff had to fix. Feed those cases back into `tests/test_read.py`.
- [ ] **Step 6:** Replace `parts.csv` with the shop's InvoMax export, converted to the same columns, and rerun `python tests/test_prices.py`. Update the expected prices in the test only where the shop's real prices differ.
