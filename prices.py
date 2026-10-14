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
