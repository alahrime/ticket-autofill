"""Shop tickets server: desk iPad and mechanic phones behind one shop PIN (shop Wi-Fi, or the Cloudflare tunnel
through an ingress rule the owner adds). JSON API over tickets.Store; the pages are web/desk.html and web/tech.html.
Tickets stay in tickets.db on this PC.
"""
from __future__ import annotations
import hashlib, json, os, re
from dataclasses import asdict
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import tickets
from pinweb import HTML, PinHandler, load_pin, load_secret, login_page, page
from prices import load_catalog

PORT = 8081
HERE = os.path.dirname(os.path.abspath(__file__))
SHOP_PIN = os.path.join(HERE, "shop_pin.txt")  # the PIN; edit to change it (git-ignored)
SHOP_SECRET = os.path.join(HERE, "shop_secret.txt")  # signs the cookie; made once (git-ignored)
LOG = os.path.join(HERE, "shop.log")  # one line per request: time, path (ticket ids only), status, seconds
DB = os.path.join(HERE, "tickets.db")  # customer data stays on this PC (git-ignored)
MECHANICS = os.path.join(HERE, "mechanics.txt")  # one name per line; # comments (git-ignored)
CATALOG = os.path.join(HERE, "parts.csv")
WEB = os.path.join(HERE, "web")
TITLE = "Shop tickets"
MAX_NOTE, MAX_HINTS = 2000, 8
STATUSES = {s for m in tickets.MOVES for s in m}
TICKET = re.compile(r"/api/tickets/([0-9]{1,9})(/move)?")


def load_mechanics(path=None):
    """Names in mechanics.txt (blank lines and # comments skipped); made with one placeholder name when missing."""
    path = path or MECHANICS
    if not os.path.exists(path):
        with open(path, "w", encoding="utf8") as f:
            f.write("MECHANIC 1\n")
    with open(path, encoding="utf-8-sig", errors="replace") as f:  # Notepad may add a BOM
        return [n for n in (tickets.squash(s) for s in f) if n and not n.startswith("#")]


def hints(q, path=None):
    """Up to MAX_HINTS parts.csv rows whose code, description or aliases contain q (any case); [] for an empty q."""
    q = q.strip().lower()
    if not q:
        return []
    try:
        cat = load_catalog(path or CATALOG)
    except (OSError, KeyError, ValueError):
        return []
    hits = [p for p in cat.values() if q in p.code.lower() or q in p.description.lower() or any(q in a for a in p.aliases)]
    return [{"code": p.code, "description": p.description, "part_price": p.part_price, "labor_price": p.labor_price}
            for p in hits[:MAX_HINTS]]


def as_json(t):
    return {**asdict(t), "totals": tickets.totals(t)}


def web_page(name):
    """web/<name>.html read fresh each time (edit and reload); a placeholder until it's built."""
    try:
        with open(os.path.join(WEB, name + ".html"), "rb") as f:
            return f.read()
    except OSError:
        return page("Not built yet", f"<p>The {name} page isn't built yet.</p><p><a href=\"/\">Back</a></p>")


CHOOSER = page(TITLE, '<a class="big" href="/desk">Desk</a><br><a class="big" href="/tech">Mechanic</a>')


class Handler(PinHandler):
    cookie, title, log_path, fails = "shop", TITLE, LOG, []
    store = None  # tickets.Store, set by serve()

    def data(self):
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise ValueError("send JSON (Content-Type: application/json)")  # a form from another site can't
        try:
            d = json.loads(self.body() or b"{}")
        except RecursionError:
            raise ValueError("JSON nested too deep") from None
        if not isinstance(d, dict):
            raise ValueError("expected a JSON object")
        return d

    def get(self):
        url = urlsplit(self.path)
        path, q = url.path, parse_qs(url.query)
        if path in ("/", "/desk", "/tech") and not self.authed():
            return self.reply(200, login_page(TITLE), HTML)
        if path == "/":
            return self.reply(200, CHOOSER, HTML)
        if path in ("/desk", "/tech"):
            return self.reply(200, web_page(path[1:]), HTML)
        if not path.startswith("/api/"):
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return self.reply(401, {"error": "PIN needed"})
        if path == "/api/tickets":
            want = None
            if "status" in q:
                want = [s for s in ",".join(q["status"]).split(",") if s in STATUSES]
            found = self.store.list(want) if want or want is None else []
            tag = '"%s"' % hashlib.sha256(f"{want}|{[(t.id, t.version) for t in found]}".encode()).hexdigest()[:32]
            if self.headers.get("If-None-Match") == tag:  # the pages poll every 4 s: nothing changed, nothing sent
                return self.reply(304, b"", headers=[("ETag", tag)])
            return self.reply(200, {"tickets": [as_json(t) for t in found]}, headers=[("ETag", tag)])
        if path == "/api/mechanics":
            return self.reply(200, {"mechanics": load_mechanics()})
        if path == "/api/catalog":
            return self.reply(200, hints(q.get("q", [""])[0]))
        m = TICKET.fullmatch(path)
        t = m and not m[2] and self.store.get(int(m[1]))
        self.reply(200, as_json(t)) if t else self.reply(404, {"error": "not found"})

    def post(self):
        if not self.authed():
            return self.reply(401, {"error": "PIN needed"})
        path = urlsplit(self.path).path
        if path == "/api/tickets":
            try:
                return self.reply(200, as_json(self.store.create(self.data())))
            except tickets.Invalid as e:
                return self.reply(400, {"error": str(e), "errors": e.errors})
        m = TICKET.fullmatch(path)
        if not m:
            return self.reply(404, {"error": "not found"})
        d = self.data()
        version = d.pop("version", None)
        if type(version) is not int:
            raise ValueError("version must be a whole number")
        t = self.store.get(int(m[1]))
        if t is None:
            return self.reply(404, {"error": "no such ticket"})
        try:
            if t.version != version:  # edit the copy the device saw, or not at all
                raise tickets.Stale(t)
            if m[2]:
                self.move(t, d)
            else:
                who = d.pop("who", None)
                if who not in ("desk", "mechanic"):
                    raise ValueError("who must be desk or mechanic")
                tickets.edit(t, d, who)
            self.reply(200, as_json(self.store.save(t, version)))
        except tickets.Invalid as e:
            self.reply(400, {"error": str(e), "errors": e.errors})
        except tickets.Stale as e:
            self.reply(409, {"error": str(e), "ticket": as_json(e.ticket)})
        except tickets.Refused as e:  # a ValueError too: caught before run()'s 400
            self.reply(409, {"error": str(e), "ticket": as_json(self.store.get(t.id))})  # the stored one, unedited

    def move(self, t, d):
        to, mechanic, note = d.get("to"), d.get("mechanic"), d.get("note")
        if not isinstance(to, str):
            raise ValueError("to must be a status")
        if note is not None and not isinstance(note, str):
            raise ValueError("note must be text")
        if len(note or "") > MAX_NOTE:
            raise ValueError(f"note is too long (max {MAX_NOTE})")
        if (t.status, to) == ("waiting", "working"):  # only accepting uses the name
            if not isinstance(mechanic, str) or tickets.squash(mechanic) not in load_mechanics():
                raise ValueError("pick a mechanic from the list")
        tickets.move(t, to, mechanic, note or "")


def serve(port=PORT):
    Handler.pin, Handler.secret = load_pin(SHOP_PIN), load_secret(SHOP_SECRET)
    load_mechanics()  # makes mechanics.txt for the owner to fill in
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # opened first: a second copy fails here
    Handler.store = tickets.Store(DB)
    try:
        server.serve_forever()
    finally:
        Handler.store.close()


if __name__ == "__main__":
    print(f"Serving on port {PORT}; PIN is in {SHOP_PIN}")
    serve()
