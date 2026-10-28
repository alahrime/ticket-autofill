"""One notebook job as a draft for InvoMax: header values, lines and notes. No Tk, no pywinauto."""
from __future__ import annotations
from dataclasses import dataclass, field

HEADER_KEYS = ("first", "last", "phone", "year_make", "plate", "vin", "odometer", "tech", "date")


@dataclass
class Value:
    value: str = ""
    source: str = ""     # "page" | "pc" | "phone:<name>" | "invomax"
    flag: str = ""       # reason to double-check, e.g. "VIN check digit fails"
    applied: str | None = None  # what was last put into InvoMax (None = never)
    state: str = ""      # "" | "skipped" | "by_hand"


@dataclass
class Line:
    code: str
    desc: str
    price: float | None
    kind: str = "part"   # "part" | "labor" | "remark"
    qty: float = 1
    cost: float | None = None   # shop cost, from "$81 *..." on the page
    covers: list = field(default_factory=list)  # labor -> ids of the part lines it covers
    id: int = 0
    unsure: bool = False  # written price had no $

    @property
    def labor(self):
        return self.kind == "labor"


@dataclass
class Draft:
    id: str = ""
    photo: str = ""
    job: int = 0
    make: str = ""       # lower-case make, for prices and overrides
    header: dict = field(default_factory=dict)  # key -> Value
    lines: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    unmatched: list = field(default_factory=list)  # (item index, "code" | "side")


def note_text(it):
    s = it.desc
    if it.price is not None:
        s += f" {it.price:g}$"
    if it.cost is not None:
        s += f" (cost ${it.cost:g})"
    return s


def needs(job, catalog):
    """Items that need a person before they become lines: [(item index, "code" | "side")]."""
    from prices import match, position
    out = []
    for i, it in enumerate(job.items):
        code = match(it.desc, catalog)
        if not code:
            out.append((i, "code"))
        elif catalog[code].sided and position(it.desc)[1] is None:
            out.append((i, "side"))
    return out


def from_job(job, catalog, overrides, markup, codes=None, sides=None, id="", photo="", index=0):
    """read.Job -> Draft. codes/sides: answers by item index (None/missing = not answered).
    Items still missing a code or side go to notes and `unmatched`. Line ids follow page order,
    so they stay the same when only the markup changes."""
    from prices import match, position, lines_for
    codes, sides = codes or {}, sides or {}
    d = Draft(id=id, photo=photo, job=index, make=job.fields.get("make", ""), notes=list(job.notes))
    for k in HEADER_KEYS:
        v = job.date if k == "date" else job.fields.get(k, "")
        if v or k in job.flags:
            d.header[k] = Value(v, "page", job.flags.get(k, ""))
    for i, it in enumerate(job.items):
        code = codes.get(i) or match(it.desc, catalog)
        if not code:
            d.notes.append(note_text(it))
            d.unmatched.append((i, "code"))
            continue
        side = None
        if catalog[code].sided and position(it.desc)[1] is None:
            side = sides.get(i)
            if not side:
                d.notes.append(note_text(it))
                d.unmatched.append((i, "side"))
                continue
        part_id = None
        for ln in lines_for(it, code, d.make, catalog, overrides, markup, side):
            ln.id = len(d.lines) + 1
            if ln.labor:
                ln.covers = [part_id]
            else:
                part_id = ln.id
                ln.cost = it.cost
                ln.unsure = it.unsure and it.price is not None
            d.lines.append(ln)
    return d


def line_by_id(draft, line_id):
    return next((ln for ln in draft.lines if ln.id == line_id), None)
