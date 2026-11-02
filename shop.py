"""Shop tickets server: three links, each with its own sign-in (accounts.py sessions in a `sid` cookie).
/admin (username + password): the desk page, mechanics and check-in iPads. /tech (name + PIN): mechanics' own jobs.
/checkin: a kiosk iPad the admin enrolled; it can only create tickets. JSON API over tickets.Store; pages in web/.
Tickets and accounts stay in tickets.db on this PC. `python shop.py admin <name>` makes or resets an admin.
"""
from __future__ import annotations
import getpass, hashlib, hmac, html, ipaddress, json, os, re, secrets, sys, threading, time
from dataclasses import asdict
from http.cookies import CookieError, SimpleCookie
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import tickets
from accounts import LIFETIME, Accounts, Locked, LoginFailed, check_new_secret, client_key, make_admin
from pinweb import HTML, Web, page
from prices import load_catalog

HOST, PORT = "127.0.0.1", 8081  # this PC only: phones and the iPad come in through the Cloudflare tunnel
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "shop.log")  # one line per request: time, path (ticket ids only), status, seconds
DB = os.path.join(HERE, "tickets.db")  # customer data and accounts stay on this PC (git-ignored)
CATALOG = os.path.join(HERE, "parts.csv")
VEHICLES = os.path.join(HERE, "vehicles.json")  # year / make / model lists, built by vehicles.py
WEB = os.path.join(HERE, "web")
SETUP = os.path.join(HERE, "setup_code.txt")  # first-run code while there is no admin (git-ignored)
SETUP_LIFE, SETUP_WINDOW, SETUP_TRIES = 86400, 600, 5  # a code lasts 24 h; 5 wrong codes per client per 10 min
TITLE = "Shop tickets"
MAX_NOTE, MAX_HINTS = 2000, 8
STATUSES = {s for m in tickets.MOVES for s in m}
TICKET = re.compile(r"/api/tickets/([0-9]{1,9})(/move)?")
USER = re.compile(r"/api/users/([0-9]{1,9})")
PAGES = {"/admin": "admin", "/tech": "mechanic", "/checkin": "kiosk"}  # page -> the role it's served to
HOME = {v: k for k, v in PAGES.items()}
KIOSK = ("first", "last", "phone", "year", "make", "model", "plate", "request")  # what check-in may fill
WHO = {"admin": "desk", "mechanic": "mechanic"}  # tickets.edit rules by role
MECHANIC_TOTALS = ("parts", "labor", "total")  # no deposits on the phone


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


_vehicles = {}


def vehicles():
    """vehicles.json as bytes, read once per path; {} when missing or unreadable."""
    if VEHICLES not in _vehicles:
        try:
            with open(VEHICLES, "rb") as f:
                raw = f.read()
            json.loads(raw)
        except (OSError, ValueError):
            raw = b"{}"
        _vehicles[VEHICLES] = raw
    return _vehicles[VEHICLES]


def as_json(t, role):
    """A ticket for the page: the admin sees everything; a mechanic no deposits, nor what was paid."""
    d, tot = asdict(t), tickets.totals(t)
    if role != "admin":
        del d["deposits"]
        tot = {k: tot[k] for k in MECHANIC_TOTALS}
    return {**d, "totals": tot}


def same(a, b):
    return tickets.squash(a).casefold() == tickets.squash(b).casefold()


def web_page(name):
    """web/<name>.html read fresh each time (edit and reload); a placeholder until it's built."""
    try:
        with open(os.path.join(WEB, name + ".html"), "rb") as f:
            return f.read()
    except OSError:
        return page("Not built yet", f"<p>The {name} page isn't built yet.</p><p><a href=\"/\">Back</a></p>")


def sign_in(role, msg="", name=""):
    """The server-rendered sign-in page for a page's role (no data on it)."""
    if role == "kiosk":
        return page("Check-in", '<p>This iPad isn\'t set up for check-in. Ask the staff.</p><p><a href="/admin">Staff sign-in</a></p>')
    admin = role == "admin"
    secret = ('<input type="password" name="secret" autocomplete="current-password" placeholder="Password" required>'
              if admin else '<input type="password" name="secret" inputmode="numeric" pattern="[0-9]*" '
              'autocomplete="current-password" placeholder="PIN" required>')
    return page("Shop admin" if admin else "Mechanic sign-in", f"""<form method="post" action="/login/{'admin' if admin else 'tech'}">
<input name="name" autocomplete="username" placeholder="{'Username' if admin else 'Name'}" value="{html.escape(name)}"
autocapitalize="words" autofocus required><br>{secret}<br><button>Sign in</button></form><p class="err">{html.escape(msg)}</p>""")


CHOOSER = page(TITLE, '<a class="big" href="/checkin">Check-in</a><br><a class="big" href="/tech">Mechanic</a><br>'
                      '<a class="big" href="/admin">Admin</a>')


def wait(e):
    """The sign-in page's line for a Locked."""
    if e.busy:
        return "The server is busy. Try again in a few seconds."
    if e.retry_after > 90 * 60:
        return f"Too many tries. Wait {-(-e.retry_after // 3600)} hours."
    return f"Too many tries. Wait {-(-e.retry_after // 60)} min."


def setup_code():
    """The first-run code in setup_code.txt, or "" when missing or over 24 hours old."""
    try:
        if time.time() - os.path.getmtime(SETUP) > SETUP_LIFE:
            return ""
        with open(SETUP, encoding="utf8") as f:
            return f.read().strip()
    except OSError:
        return ""


def make_setup_code(accounts):
    """At start: no active admin -> a fresh code in setup_code.txt unless a live one is there; an admin -> no file."""
    if accounts.list("admin", True):
        if os.path.exists(SETUP):
            os.remove(SETUP)
    elif not setup_code():
        with open(SETUP, "w", encoding="utf8") as f:
            f.write(secrets.token_urlsafe(9) + "\n")


def setup_page(msg="", name=""):
    return page("Shop setup", f"""<p>No admin yet. Type the code from setup_code.txt on the shop PC.</p>
<form method="post" action="/setup"><input name="code" autocomplete="off" placeholder="Setup code" required><br>
<input name="name" autocomplete="username" placeholder="Username" value="{html.escape(name)}" required><br>
<input type="password" name="password" autocomplete="new-password" placeholder="Password (10+ characters)" required><br>
<input type="password" name="again" autocomplete="new-password" placeholder="Password again" required><br>
<button>Make admin</button></form><p class="err">{html.escape(msg)}</p>""")


class Handler(Web):
    title, log_path = TITLE, LOG
    store = accounts = None  # tickets.Store and accounts.Accounts, set by serve()
    setup_fails, setup_lock = {}, threading.Lock()  # wrong setup codes: client -> times

    def run(self, fn):
        """Web.run plus the account and ticket errors any route may raise."""
        def mapped():
            try:
                fn()
            except tickets.Invalid as e:
                self.reply(400, {"error": str(e), "errors": e.errors})
            except LoginFailed as e:
                self.reply(401, {"error": str(e)})
            except Locked as e:
                self.reply(429, {"error": str(e)}, headers=[("Retry-After", str(e.retry_after))])
        super().run(mapped)

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

    def client(self):
        """The caller's IP for the lockout: cloudflared (on this PC) passes it in CF-Connecting-IP."""
        peer, cf = self.client_address[0], (self.headers.get("CF-Connecting-IP") or "").strip()
        try:
            local = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            local = False
        return cf if local and cf else peer

    def token(self):
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie") or "")
        except CookieError:  # a mangled cookie header: no session
            return None
        return c["sid"].value if "sid" in c else None

    def cookie(self, token, role=None):
        """Set-Cookie header for a new session token (role sets the lifetime), or one that clears sid."""
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return ("Set-Cookie", f"sid={token or ''}; Path=/; Max-Age={LIFETIME[role] if token else 0}; "
                              f"HttpOnly; SameSite=Strict{secure}")

    def get(self):
        url = urlsplit(self.path)
        path, q = url.path, parse_qs(url.query)
        s = self.accounts.session(self.token())
        role = s and s["role"]
        if path == "/":
            return self.reply(200, CHOOSER, HTML)
        if path == "/desk":
            return self.reply(302, b"", "text/plain", [("Location", "/admin")])
        if path == "/setup":  # only until there is an admin
            return self.reply(404, {"error": "not found"}) if self.accounts.list("admin", True) else \
                self.reply(200, setup_page(), HTML)
        if path in PAGES:
            want = PAGES[path]
            return self.reply(200, web_page(path[1:]) if role == want else sign_in(want), HTML)
        if not path.startswith("/api/"):
            return self.reply(404, {"error": "not found"})
        if not s:
            return self.reply(401, {"error": "sign in"})
        if path == "/api/me":
            return self.reply(200, {"role": role, "name": s["name"], "id": s["user_id"]})
        if path == "/api/vehicles":
            return self.reply(200, vehicles())
        if role == "kiosk":
            return self.refuse()
        if path == "/api/catalog":
            return self.reply(200, hints(q.get("q", [""])[0]))
        if path == "/api/tickets":
            want = None
            if "status" in q:
                want = [x for x in ",".join(q["status"]).split(",") if x in STATUSES]
            found = [t for t in (self.store.list(want) if want or want is None else []) if self.sees(s, t)]
            tag = '"%s"' % hashlib.sha256(f"{role}|{s['user_id']}|{want}|{[(t.id, t.version) for t in found]}"
                                          .encode()).hexdigest()[:32]
            if self.headers.get("If-None-Match") == tag:  # the pages poll every 4 s: nothing changed, nothing sent
                return self.reply(304, b"", headers=[("ETag", tag)])
            return self.reply(200, {"tickets": [as_json(t, role) for t in found]}, headers=[("ETag", tag)])
        m = TICKET.fullmatch(path)
        if m and not m[2]:
            t = self.store.get(int(m[1]))
            return self.reply(200, as_json(t, role)) if t and self.sees(s, t, True) else self.reply(404, {"error": "not found"})
        if role != "admin":
            return self.refuse()
        if path == "/api/mechanics":
            return self.reply(200, {"mechanics": self.mechanics()})
        if path == "/api/users":
            return self.reply(200, {"users": self.accounts.list()})
        self.reply(404, {"error": "not found"})

    def cross_site(self):
        """True for a POST another site's page made (a form or script there): the browser says so.
        Sec-Fetch-Site wins when sent (with no-referrer, Chrome sends Origin: null on our own forms)."""
        site = self.headers.get("Sec-Fetch-Site")
        if site:
            return site not in ("same-origin", "none")
        origin, host = self.headers.get("Origin"), self.headers.get("Host") or ""
        return origin is not None and origin not in (f"http://{host}", f"https://{host}")

    def post(self):
        path = urlsplit(self.path).path
        if self.cross_site():
            return self.refuse()
        if path == "/setup":
            return self.first_run()
        if path in ("/login/admin", "/login/tech"):
            return self.login("admin" if path == "/login/admin" else "mechanic")
        token = self.token()
        s = self.accounts.session(token)
        if path == "/logout":
            self.accounts.logout(token)
            return self.reply(303, b"", "text/plain", [("Location", HOME.get(s and s["role"], "/")), self.cookie(None)])
        if not s:
            return self.reply(401, {"error": "sign in"})
        role = s["role"]
        if path == "/api/tickets" and role == "kiosk":  # the customer's fields only; nothing back but the id
            d = self.data()
            return self.reply(200, {"id": self.store.create({k: d[k] for k in KIOSK if k in d}).id})
        if path == "/api/tickets" and role == "admin":
            return self.reply(200, as_json(self.store.create(self.data()), role))
        m = TICKET.fullmatch(path)
        if m and role != "kiosk":
            return self.ticket(s, int(m[1]), bool(m[2]))
        if role != "admin":
            return self.refuse()
        if path == "/api/users":
            d = self.data()
            return self.reply(200, self.accounts.add(d.get("name"), d.get("role"), d.get("secret")))
        if path == "/api/kiosk":
            self.data()  # JSON only, like every API post
            self.accounts.logout(token)
            return self.reply(200, {"ok": True}, headers=[self.cookie(self.accounts.kiosk_session(), "kiosk")])
        if path == "/api/kiosk/revoke":
            self.data()
            self.accounts.revoke_kiosks()
            return self.reply(200, {"ok": True})
        m = USER.fullmatch(path)
        if m:
            return self.user(s, int(m[1]))
        self.reply(404, {"error": "not found"})

    def refuse(self):
        self.reply(403, {"error": "not allowed"})

    def mechanics(self):
        return [u["name"] for u in self.accounts.list("mechanic", True)]

    @staticmethod
    def mine(s, t):  # exact: accepting and the desk always write the account's own spelling
        return s["role"] == "mechanic" and t.mechanic == s["name"]

    def sees(self, s, t, one=False):
        """Admin: every ticket. Mechanic: waiting ones and their own working ones (one ticket: also their own in review)."""
        return (s["role"] == "admin" or t.status == "waiting"
                or self.mine(s, t) and t.status in (("working", "review") if one else ("working",)))

    def signed_in(self, role, token, where):
        """303 to where with a new session cookie, signing out whatever this device was before."""
        self.accounts.logout(self.token())
        self.reply(303, b"", "text/plain", [("Location", where), self.cookie(token, role)])

    def login(self, role):
        f = parse_qs(self.body().decode(errors="replace"))
        name, secret = f.get("name", [""])[0][:80], f.get("secret", [""])[0]
        try:
            token, _ = self.accounts.login(name, secret, role, self.client())
        except LoginFailed as e:
            return self.reply(401, sign_in(role, str(e)[:1].upper() + str(e)[1:] + ".", name), HTML)
        except Locked as e:
            return self.reply(429, sign_in(role, wait(e), name), HTML, [("Retry-After", str(e.retry_after))])
        self.signed_in(role, token, HOME[role])

    def user(self, s, id):
        """Admin changes a user: {secret} resets their PIN/password, {active: bool} turns them on or off.
        Everything is checked before anything is written: no half-applied change."""
        d, headers = self.data(), []
        u = self.accounts.get(id)
        if u is None:
            return self.reply(404, {"error": "no such user"})
        if "active" in d and type(d["active"]) is not bool:
            raise ValueError("active must be true or false")
        if "secret" in d:
            check_new_secret(u["role"], d["secret"])
        if "active" in d:  # the last-admin rule is checked before its write; the secret can't fail now
            self.accounts.set_active(id, d["active"])
        if "secret" in d:
            self.accounts.set_secret(id, d["secret"])
            if id == s["user_id"] and d.get("active", True):  # own password: every session went; sign back in
                try:
                    headers.append(self.cookie(self.accounts.login(s["name"], d["secret"], "admin", self.client())[0], "admin"))
                except (LoginFailed, Locked):
                    pass
        self.reply(200, self.accounts.get(id), headers=headers)

    def first_run(self):
        """First run, no admin yet: the one-time code in setup_code.txt makes the admin and signs them in."""
        f = {k: v[0] for k, v in parse_qs(self.body().decode(errors="replace")).items()}  # read before the lock
        name = f.get("name", "")[:80]
        with self.setup_lock:
            if self.accounts.list("admin", True):
                return self.reply(404, {"error": "not found"})
            t, key = time.time(), client_key(self.client())
            for k in [k for k, v in self.setup_fails.items() if not v or t - v[-1] >= SETUP_WINDOW]:
                del self.setup_fails[k]
            tries = self.setup_fails[key] = [x for x in self.setup_fails.get(key, []) if t - x < SETUP_WINDOW]
            if len(tries) >= SETUP_TRIES:
                e = Locked(tries[-SETUP_TRIES] + SETUP_WINDOW - t)
                return self.reply(429, setup_page(wait(e), name), HTML, [("Retry-After", str(e.retry_after))])
            code = setup_code()
            if not code or not hmac.compare_digest(f.get("code", "").strip().encode(), code.encode()):
                tries.append(t)
                return self.reply(401, setup_page("Wrong or expired setup code.", name), HTML)
            if f.get("password", "") != f.get("again", ""):
                return self.reply(400, setup_page("The passwords don't match.", name), HTML)
            try:
                user = make_admin(self.accounts, name, f.get("password", ""))
            except tickets.Invalid as e:
                return self.reply(400, setup_page(" ".join(e.errors.values()), name), HTML)
            try:
                os.remove(SETUP)
            except OSError:
                pass
        try:
            token, _ = self.accounts.login(user["name"], f["password"], "admin", self.client())
        except (Locked, LoginFailed):  # the admin exists now; just sign in on /admin
            return self.reply(303, b"", "text/plain", [("Location", "/admin")])
        self.signed_in("admin", token, "/admin")

    def ticket(self, s, id, moving):
        d = self.data()
        d.pop("who", None)  # the session says who, never the body
        version = d.pop("version", None)
        if type(version) is not int:
            raise ValueError("version must be a whole number")
        t = self.store.get(id)
        if t is None or not self.sees(s, t, True):
            return self.reply(404, {"error": "no such ticket"})
        if s["role"] == "mechanic" and not (self.mine(s, t) or moving and t.status == "waiting"):
            return self.refuse()  # someone else's job (or waiting: only accepting it)
        if s["role"] == "admin" and not moving and "mechanic" in d:  # an active account, or left as it is
            m = d["mechanic"]
            names = [n for n in self.mechanics() if isinstance(m, str) and same(n, m)]
            if isinstance(m, str) and same(m, t.mechanic):
                d["mechanic"] = t.mechanic
            elif names:
                d["mechanic"] = names[0]
            else:
                raise tickets.Invalid({"mechanic": "pick a mechanic from the list"})
        try:
            if t.version != version:  # edit the copy the device saw, or not at all
                raise tickets.Stale(t)
            if moving:
                self.move(s, t, d)
            else:
                tickets.edit(t, d, WHO[s["role"]])
            self.reply(200, as_json(self.store.save(t, version), s["role"]))
        except tickets.Stale as e:
            self.reply(409, {"error": str(e), "ticket": as_json(e.ticket, s["role"])})
        except tickets.Refused as e:  # a ValueError too: caught before run()'s 400
            self.reply(409, {"error": str(e), "ticket": as_json(self.store.get(t.id), s["role"])})  # the stored one, unedited

    def move(self, s, t, d):
        to, mechanic, note = d.get("to"), d.get("mechanic"), d.get("note")
        if not isinstance(to, str):
            raise ValueError("to must be a status")
        if note is not None and not isinstance(note, str):
            raise ValueError("note must be text")
        if len(note or "") > MAX_NOTE:
            raise ValueError(f"note is too long (max {MAX_NOTE})")
        if s["role"] == "mechanic":
            if (t.status, to) not in (("waiting", "working"), ("working", "review")):
                raise tickets.Refused("only the desk can do that")
            mechanic = s["name"]  # accepting: always as themselves
        elif (t.status, to) == ("waiting", "working"):  # the desk accepting for a mechanic: an active account
            names = [n for n in self.mechanics() if isinstance(mechanic, str) and same(n, mechanic)]
            if not names:
                raise ValueError("pick a mechanic from the list")
            mechanic = names[0]
        tickets.move(t, to, mechanic, note or "")


def serve(port=PORT, host=HOST):
    server = ThreadingHTTPServer((host, port), Handler)  # opened first: a second copy fails here
    Handler.store = tickets.Store(DB)
    Handler.accounts = Accounts(Handler.store)
    make_setup_code(Handler.accounts)
    try:
        server.serve_forever()
    finally:
        Handler.store.close()


def main(args):
    if not args:
        print(f"Serving on {HOST}:{PORT}. No admin yet? Open /setup with the code in {SETUP},"
              " or run: python shop.py admin <name>")
        return serve()
    if len(args) != 2 or args[0] != "admin":
        sys.exit("usage: python shop.py [admin <name>]")
    password = getpass.getpass("New password (10+ characters): ")
    if password != getpass.getpass("Same password again: "):
        sys.exit("The passwords don't match; nothing changed.")
    store = tickets.Store(DB)
    try:
        user = make_admin(Accounts(store), args[1], password)
    except tickets.Invalid as e:
        sys.exit("; ".join(e.errors.values()))
    finally:
        store.close()
    print(f"Admin {user['name']} is ready; sign in at /admin. A running shop.bat keeps its lockout until restarted.")


if __name__ == "__main__":
    main(sys.argv[1:])
