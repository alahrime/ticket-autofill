"""Shop tickets: desk -> mechanic -> desk review -> InvoMax. Model, status rules, cleaning, totals and the SQLite store."""
from __future__ import annotations
import json, re, sqlite3, threading
from dataclasses import dataclass, field, asdict, fields as dc_fields
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

REQUIRED = ("first", "last", "phone", "year", "make", "model")
UPPER = ("first", "last", "make", "model", "plate")
TEXT = ("request", "mechanic", "odometer", "notes")
LONG = ("request", "notes")  # up to 2000 chars; other text fields 80
MECHANIC_KEYS = {"lines", "odometer", "notes"}
MAX_LINES, MAX_MONEY, MAX_QTY = 100, 1e6, 1e4
MOVES = {("waiting", "working"), ("working", "review"), ("review", "working"),
         ("review", "approved"), ("approved", "filled")}


@dataclass
class Line:
    desc: str
    qty: float = 1
    price: float | None = None   # part price each; None = labor-only line
    labor: float | None = None   # labor charge (installing the part, or the service)
    code: str = ""               # catalog code when matched
    id: int = 0


@dataclass
class Ticket:
    id: int = 0
    status: str = "waiting"
    first: str = ""
    last: str = ""
    phone: str = ""
    year: str = ""
    make: str = ""
    model: str = ""
    plate: str = ""
    request: str = ""
    mechanic: str = ""
    odometer: str = ""
    notes: str = ""
    lines: list = field(default_factory=list)  # Line
    back_note: str = ""   # desk's note when sent back; cleared when the mechanic finishes again
    created: str = ""     # ISO time, seconds
    updated: str = ""
    version: int = 1


# shop.py maps: Invalid -> 400, Refused / Stale -> 409, KeyError (unknown id) -> 404.
class Stale(Exception):
    """A save with an old version; .ticket is the stored one."""
    def __init__(self, ticket):
        super().__init__("changed on another device")
        self.ticket = ticket


class Refused(ValueError):
    """A status move or edit not allowed now; the message says why."""


class Invalid(Exception):
    """Bad fields; .errors is field -> message."""
    def __init__(self, errors):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


def now():
    return datetime.now().isoformat(timespec="seconds")


def squash(s):
    return " ".join(str(s or "").split())


def text(v, name, limit=80):
    """A typed value as a stripped string ('' for None); ValueError for lists/dicts or over limit chars."""
    if isinstance(v, (list, dict, tuple, set, bool)):
        raise ValueError(f"{name} must be text")
    v = "" if v is None else str(v).strip()
    if len(v) > limit:
        raise ValueError(f"{name} is too long (max {limit})")
    return v


def cents(x):
    return Decimal(x).quantize(Decimal("0.01"), ROUND_HALF_UP)


def money(v, name, top=MAX_MONEY):
    """'12.5', '$1,200', 3 -> cents-rounded float; '' / None -> None. Raises ValueError with a message."""
    v = text(v, name, 40).replace("$", "").replace(",", "")
    if not v:
        return None
    try:
        x = Decimal(v)
    except InvalidOperation:
        x = Decimal("NaN")
    if not x.is_finite():
        raise ValueError(f"{name} must be a number")
    if x < 0:
        raise ValueError(f"{name} can't be negative")
    if x > top:
        raise ValueError(f"{name} must be {top:g} or less")
    return float(cents(x))  # half-up on the typed digits, not the binary float


def clean_line(d):
    if isinstance(d, Line):
        d = asdict(d)
    if not isinstance(d, dict):
        raise ValueError("bad line")
    desc = " ".join(text(d.get("desc"), "description", 200).split())
    if not desc:
        raise ValueError("description is required")
    qty = money(1 if d.get("qty") in (None, "") else d["qty"], "qty", MAX_QTY)
    if not qty:
        raise ValueError("qty must be more than 0")
    try:
        lid = max(int(d.get("id") or 0), 0)
    except (TypeError, ValueError):
        lid = 0
    return Line(desc, int(qty) if qty == int(qty) else qty, money(d.get("price"), "price"),
                money(d.get("labor"), "labor"), text(d.get("code"), "code", 40).upper(), lid)


def normalize(fields, create=False):
    """Typed fields -> (clean values, errors {field: message}). Only known keys are kept.
    At create, first/last/phone/year/make/model are required; on an edit they can't be blanked."""
    out, errors, raw = {}, {}, {}
    for k in UPPER + TEXT + ("phone", "year"):
        if k in fields:
            try:
                raw[k] = text(fields[k], k, 2000 if k in LONG else 80)
            except ValueError as e:
                errors[k] = str(e)
    for k, v in raw.items():
        if k in UPPER:
            out[k] = " ".join(v.split()).upper()
        elif k == "mechanic":
            out[k] = " ".join(v.split())
        elif k in TEXT:
            out[k] = v
    if "odometer" in out:
        out["odometer"] = out["odometer"].replace(",", "").replace(" ", "")
        if not re.fullmatch(r"[0-9]{0,7}", out["odometer"]):
            errors["odometer"] = "odometer must be up to 7 digits"
    if "phone" in raw:
        digits = re.sub(r"[^0-9]", "", raw["phone"])
        if len(digits) == 10:
            out["phone"] = f"({digits[:3]}){digits[3:6]}-{digits[6:]}"
        elif digits:
            errors["phone"] = "phone needs 10 digits"
        else:
            out["phone"] = ""
    if "year" in raw:
        y = raw["year"]
        if not y:
            out["year"] = ""
        elif re.fullmatch(r"[0-9]{4}", y) and 1950 <= int(y) <= date.today().year + 1:
            out["year"] = y
        else:
            errors["year"] = f"year must be 1950 to {date.today().year + 1}"
    if "lines" in fields:
        lines = fields["lines"]
        if not isinstance(lines, list):
            errors["lines"] = "lines must be a list"
        elif len(lines) > MAX_LINES:
            errors["lines"] = f"at most {MAX_LINES} lines"
        else:
            clean = []
            for i, d in enumerate(lines, 1):
                try:
                    clean.append(clean_line(d))
                except ValueError as e:
                    errors["lines"] = f"line {i}: {e}"
                    break
            top = max((ln.id for ln in clean if ln.id > 0), default=0)
            seen = set()
            for ln in clean:
                if ln.id <= 0 or ln.id in seen:
                    top += 1
                    ln.id = top
                seen.add(ln.id)
            out["lines"] = clean
    for k in REQUIRED:
        if k not in errors and (create or k in out) and not out.get(k):
            errors[k] = f"{k} is required"
    return out, errors


def edit(ticket, fields, who):
    """Merge typed fields onto ticket in place. who: "desk" (waiting/review, any field) or
    "mechanic" (working only: lines, odometer, notes). Unknown keys are ignored, as in normalize.
    Raises Refused (not allowed now / not theirs to change) or Invalid (bad values)."""
    if who == "desk":
        if ticket.status not in ("waiting", "review"):
            raise Refused(f"the desk can't change a {ticket.status} ticket")
    elif who == "mechanic":
        if ticket.status != "working":
            raise Refused(f"the phone can't change a {ticket.status} ticket")
        bad = sorted((set(UPPER + TEXT + REQUIRED) & set(fields)) - MECHANIC_KEYS)
        if bad:
            raise Refused(f"the phone can't change {', '.join(bad)}")
    else:
        raise ValueError(f"who must be desk or mechanic, not {who!r}")
    clean, errors = normalize(fields)
    if errors:
        raise Invalid(errors)
    for k, v in clean.items():
        setattr(ticket, k, v)
    return ticket


def move(ticket, to, mechanic=None, note=""):
    """Change ticket.status in place, or raise Refused saying why not."""
    frm = ticket.status
    if (frm, to) not in MOVES:
        raise Refused(f"can't go from {frm} to {to}")
    if frm == "waiting":
        mechanic = squash(mechanic)
        if not mechanic:
            raise Refused("pick a mechanic to accept")
        ticket.mechanic = mechanic
    elif frm == "working":
        if not ticket.lines:
            raise Refused("add at least one line before finishing")
        ticket.back_note = ""
    elif to == "working":
        note = str(note or "").strip()
        if not note:
            raise Refused("say what to fix when sending back")
        ticket.back_note = note
    ticket.status = to
    return ticket


def totals(ticket):
    """{"parts": sum of qty*price, "labor": sum of labor, "total"}; each line rounded half-up to cents (no tax)."""
    d = lambda v: Decimal(str(v))
    parts = sum((cents(d(ln.qty) * d(ln.price)) for ln in ticket.lines if ln.price is not None), Decimal(0))
    labor = sum((cents(d(ln.labor)) for ln in ticket.lines if ln.labor is not None), Decimal(0))
    return {"parts": float(parts), "labor": float(labor), "total": float(parts + labor)}


def to_draft(ticket, catalog, today=None):
    """Approved (or filled) ticket -> draft.Draft for the InvoMax fill. Header values come from the desk;
    year/make are also kept apart for the Vehicles dropdowns. A part's code is the ticket's, else
    prices.match, else "". Lines with neither price nor labor go to notes."""
    from draft import Draft, Value, Line as DLine
    from prices import match
    if ticket.status not in ("approved", "filled"):
        raise Refused(f"a {ticket.status} ticket isn't ready for InvoMax")
    t = ticket
    vals = {"first": t.first, "last": t.last, "phone": t.phone, "year_make": squash(f"{t.year} {t.make}"),
            "year": t.year, "make": t.make, "model": t.model, "plate": t.plate, "odometer": t.odometer,
            "tech": t.mechanic, "date": (today or date.today()).strftime("%m/%d/%y")}
    d = Draft(id=str(t.id), make=t.make.lower(), header={k: Value(v, "desk") for k, v in vals.items() if v})
    d.notes = [s for s in (t.request and f"Customer: {t.request}", t.notes) if s]

    def add(ln):
        ln.id = len(d.lines) + 1
        d.lines.append(ln)
        return ln.id

    for ln in t.lines:
        desc = ln.desc.upper()
        if ln.price is not None:
            part = add(DLine(ln.code or match(ln.desc, catalog or {}) or "", desc, ln.price, qty=ln.qty))
            if ln.labor:
                add(DLine("INSTALL-PART", f"Remove & Install: {desc}", ln.labor, kind="labor", covers=[part]))
        elif ln.labor:
            add(DLine("LABOR", desc, ln.labor, kind="labor"))
        else:
            d.notes.append(desc)
    return d


def from_dict(d):
    names = {f.name for f in dc_fields(Ticket)}
    t = Ticket(**{k: v for k, v in d.items() if k in names})
    t.lines = [ln if isinstance(ln, Line) else Line(**ln) for ln in t.lines]
    return t


class Store:
    """Tickets in SQLite: id, indexed status, the rest as JSON. One connection behind a lock (server threads)."""

    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        with self.lock:
            self.db.execute("CREATE TABLE IF NOT EXISTS tickets "
                            "(id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)")
            self.db.execute("CREATE INDEX IF NOT EXISTS tickets_status ON tickets (status)")

    def close(self):
        with self.lock:
            self.db.close()

    @staticmethod
    def _ticket(row):
        d = json.loads(row[2])
        d.update(id=row[0], status=row[1])
        return from_dict(d)

    @staticmethod
    def _data(t):
        d = asdict(t)
        del d["id"], d["status"]
        return json.dumps(d)

    def create(self, fields):
        """New waiting ticket from desk fields; raises Invalid."""
        clean, errors = normalize(fields, create=True)
        if errors:
            raise Invalid(errors)
        t = Ticket(**clean)
        t.created = t.updated = now()
        with self.lock:
            t.id = self.db.execute("INSERT INTO tickets (status, data) VALUES (?, ?)",
                                   (t.status, self._data(t))).lastrowid
        return t

    def get(self, id):
        with self.lock:
            row = self.db.execute("SELECT id, status, data FROM tickets WHERE id = ?", (id,)).fetchone()
        return self._ticket(row) if row else None

    def list(self, statuses=None):
        """Newest first; statuses None = all."""
        sql, args = "SELECT id, status, data FROM tickets", ()
        if statuses:
            args = tuple(statuses)
            sql += f" WHERE status IN ({','.join('?' * len(args))})"
        with self.lock:
            rows = self.db.execute(sql + " ORDER BY id DESC", args).fetchall()
        return [self._ticket(r) for r in rows]

    def save(self, ticket, version):
        """Write ticket if version is the stored one (else raise Stale); returns it with version + 1."""
        with self.lock:
            row = self.db.execute("SELECT id, status, data FROM tickets WHERE id = ?", (ticket.id,)).fetchone()
            if row is None:
                raise KeyError(ticket.id)
            cur = self._ticket(row)
            if cur.version != version:
                raise Stale(cur)
            ticket.version, ticket.updated, ticket.created = version + 1, now(), cur.created
            self.db.execute("UPDATE tickets SET status = ?, data = ? WHERE id = ?",
                            (ticket.status, self._data(ticket), ticket.id))
        return ticket
