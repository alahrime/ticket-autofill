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
PRICE_RE = re.compile(r"^(.*?)(?:[\s.,]*(\d+(?:\.\d{1,2})?)\s*\$|[\s.,]+(\d+(?:\.\d{1,2})?))\s*$")
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
    unsure: bool = False  # written price had no $


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
    if m and m.group(1).strip():
        desc, price = m.group(1), m.group(2) or m.group(3)
    else:
        desc, price = right, None
    return Item(desc.strip(" .,-"), _num(price), _num(cost.group(1)) if cost else None,
                bool(m and price and not m.group(2))), note


def _set(job, key, value, guessed=False):
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
        if guessed:
            job.flags["first"] = job.flags["last"] = "guessed from first line"
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
            _set(job, "name", line, True)  # unlabelled first line = customer name
        else:
            job.notes.append(line)
    return jobs
