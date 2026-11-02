import http.client, json, os, re, shutil, sys, tempfile, threading, time, urllib.request
from urllib.parse import urlencode
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from http.server import ThreadingHTTPServer
import accounts, pinweb, shop, tickets

ADMIN, PASSWORD = "Owner Test", "made-up-pass-1"
PINS = {"Al Fixit": "246810", "Bo Wrench": "135790"}
CAR = {"first": "Jane", "last": "Testcase", "phone": "555 010 0000", "year": "2019", "make": "Cadillac",
       "model": "XT5", "plate": "tst-0001", "request": "brakes squeak"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a):
        return None


def call(base, path, data=None, cookie="", headers=None):
    """-> (status, parsed JSON or raw bytes); call.headers = the reply's headers.
    API posts go as application/json unless headers say otherwise; dicts to other paths go as a form."""
    if isinstance(data, dict) and not path.startswith("/api/"):
        data = urlencode(data).encode()
    body = data if isinstance(data, bytes) or data is None else json.dumps(data).encode()
    h = {"Cookie": cookie} if cookie else {}
    if data is not None and path.startswith("/api/"):
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, body, {**h, **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect).open(req) as r:
            code, raw, headers = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        code, raw, headers = e.code, e.read(), e.headers
    call.headers = headers
    try:
        return code, json.loads(raw)
    except ValueError:
        return code, raw


def sid():
    """The sid cookie the last call set, as a Cookie header value."""
    return call.headers["Set-Cookie"].split(";")[0]


class Server:
    def __init__(self, admin=True):
        self.admin = admin

    def __enter__(self):
        self.dir = tempfile.mkdtemp()
        j = lambda n: os.path.join(self.dir, n)
        shop.Handler.log_path, shop.CATALOG, shop.WEB, shop.VEHICLES = j("shop.log"), j("parts.csv"), j("web"), j("vehicles.json")
        shop.SETUP = j("setup_code.txt")
        shop.Handler.setup_fails.clear()
        with open(shop.CATALOG, "w", encoding="utf8") as f:
            f.write("code,description,aliases,sided,part_price,labor_price\n"
                    "FBP,FRONT BRAKE PADS,front brake pads|front pads,no,100,100\n"
                    "OIL,OIL CHANGE,oil change,no,40,0\n"
                    + "".join(f"BR{i},BRAKE THING {i},brake thing {i},no,{i},5\n" for i in range(10)))
        shop.Handler.store = tickets.Store(j("tickets.db"))
        self.acc = shop.Handler.accounts = accounts.Accounts(shop.Handler.store, iterations=1000)  # fast hashes
        self.ids = {ADMIN: self.acc.add(ADMIN, "admin", PASSWORD)["id"]} if self.admin else {}
        for name, pin in PINS.items():
            self.ids[name] = self.acc.add(name, "mechanic", pin)["id"]
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), shop.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        return self

    def __exit__(self, *a):
        self.srv.shutdown()
        self.srv.server_close()
        shop.Handler.store.close()
        shutil.rmtree(self.dir)

    def log(self):
        with open(shop.Handler.log_path, encoding="utf8") as f:
            return f.read()


def admin(base, password=PASSWORD):
    code, _ = call(base, "/login/admin", {"name": ADMIN, "secret": password})
    assert code == 303 and call.headers["Location"] == "/admin"
    return sid()


def tech(base, name):
    code, _ = call(base, "/login/tech", {"name": name, "secret": PINS[name]})
    assert code == 303 and call.headers["Location"] == "/tech"
    return sid()


def kiosk(base, password=PASSWORD):
    a = admin(base, password)
    assert call(base, "/api/kiosk", {}, a) == (200, {"ok": True})
    k = sid()
    assert call(base, "/api/me", cookie=a)[0] == 401  # the enrolling admin's session is gone
    return k


def test_pages_and_sign_in():
    with Server() as s:
        b = s.base
        page = call(b, "/")[1]
        assert all(f'href="/{p}"'.encode() in page for p in ("checkin", "tech", "admin"))
        assert call(b, "/desk")[0] == 302 and call.headers["Location"] == "/admin"
        assert b'action="/login/admin"' in call(b, "/admin")[1] and b'type="password"' in call(b, "/admin")[1]
        assert b'action="/login/tech"' in call(b, "/tech")[1] and b'inputmode="numeric"' in call(b, "/tech")[1]
        assert b"isn't set up for check-in" in call(b, "/checkin")[1] and b'href="/admin"' in call(b, "/checkin")[1]
        assert call(b, "/api/tickets")[0] == 401 and call(b, "/api/tickets", CAR)[0] == 401
        assert call(b, "/api/tickets/1/move", {"version": 1, "to": "working"})[0] == 401
        assert call(b, "/api/me", cookie="sid=" + "x" * 43)[0] == 401  # made-up token
        a, m, k = admin(b), tech(b, "Al Fixit"), kiosk(b)
        assert b"isn't built yet" in call(b, "/admin", cookie=a)[1]
        os.makedirs(shop.WEB)
        for name in ("admin", "tech", "checkin"):
            with open(os.path.join(shop.WEB, name + ".html"), "w") as f:
                f.write(f"<p>{name} page</p>")
        for c, mine in ((a, "/admin"), (m, "/tech"), (k, "/checkin")):  # each page only to its role
            for p in ("/admin", "/tech", "/checkin"):
                assert (call(b, p, cookie=c)[1] == f"<p>{p[1:]} page</p>".encode()) == (p == mine)
        assert call(b, "/api/me", cookie=m)[1] == {"role": "mechanic", "name": "Al Fixit", "id": s.ids["Al Fixit"]}
        assert call(b, "/api/me", cookie=k)[1] == {"role": "kiosk", "name": "", "id": None}
        assert shop.HOST == "127.0.0.1"  # everything comes in through the tunnel


def test_full_flow():
    with Server() as s:
        b = s.base
        a = admin(b)
        k = kiosk(b)  # enrolled on another device: a fresh admin sign-in there, replaced by the kiosk
        assert call(b, "/api/me", cookie=a)[1] == {"role": "admin", "name": ADMIN, "id": s.ids[ADMIN]}  # still admin

        code, r = call(b, "/api/tickets", CAR, k)
        assert code == 200 and list(r) == ["id"]  # the kiosk gets no ticket data back
        tid, url = r["id"], f"/api/tickets/{r['id']}"
        extra = {"mechanic": "Al Fixit", "lines": [{"desc": "free brakes", "price": 0}], "notes": "x", "odometer": "9",
                 "status": "filled", "back_note": "y", "id": 77}
        kid = call(b, "/api/tickets", {**CAR, **extra}, k)[1]["id"]  # check-in fills the customer's fields only
        t = call(b, f"/api/tickets/{kid}", cookie=a)[1]
        assert (t["status"], t["mechanic"], t["lines"], t["notes"], t["odometer"], t["back_note"]) == ("waiting", "", [], "", "", "")
        assert t["id"] == kid != 77 and t["first"] == "JANE" and t["request"] == "brakes squeak"
        code, bad = call(b, "/api/tickets", {**CAR, "first": "", "year": "1800"}, k)
        assert code == 400 and set(bad["errors"]) == {"first", "year"}
        assert call(b, "/api/vehicles", cookie=k)[0] == 200
        for path in ("/api/tickets", url, "/api/mechanics", "/api/users", "/api/catalog?q=oil"):
            assert call(b, path, cookie=k)[0] == 403, path
        for path, body in ((url, {"version": 1, "first": "X"}), (url + "/move", {"version": 1, "to": "working"}),
                           ("/api/users", {"name": "Cy", "role": "admin", "secret": "x" * 12}), ("/api/kiosk/revoke", {})):
            assert call(b, path, body, k)[0] == 403, path

        al, bo = tech(b, "Al Fixit"), tech(b, "Bo Wrench")
        assert [t["id"] for t in call(b, "/api/tickets?status=waiting,working", cookie=al)[1]["tickets"]] == [kid, tid]
        assert call(b, url, cookie=bo)[1]["first"] == "JANE"  # waiting: anyone may look
        assert call(b, url, {"version": 1, "notes": "x"}, al)[0] == 403  # not theirs until accepted
        code, t = call(b, url + "/move", {"version": 1, "to": "working", "mechanic": "Bo Wrench"}, al)
        assert code == 200 and (t["status"], t["mechanic"], t["version"]) == ("working", "Al Fixit", 2)  # as themselves

        assert [t["id"] for t in call(b, "/api/tickets?status=waiting,working", cookie=bo)[1]["tickets"]] == [kid]  # Al's: hidden
        assert call(b, url, cookie=bo)[0] == 404
        assert call(b, url, {"version": 2, "notes": "mine now"}, bo)[0] == 404
        assert call(b, url + "/move", {"version": 2, "to": "review"}, bo)[0] == 404
        for path in ("/api/users", "/api/mechanics"):
            assert call(b, path, cookie=bo)[0] == 403
        for path, body in (("/api/users", {"name": "Cy Sneak", "role": "admin", "secret": "x" * 12}),
                           (f"/api/users/{s.ids['Bo Wrench']}", {"secret": "999999"}), ("/api/kiosk", {}),
                           ("/api/kiosk/revoke", {}), ("/api/tickets", CAR)):
            assert call(b, path, body, bo)[0] == 403, path

        code, r = call(b, url, {"version": 2, "who": "desk", "first": "JUNE"}, al)  # who in the body: ignored
        assert code == 409 and "first" in r["error"] and r["ticket"]["first"] == "JANE"
        code, t = call(b, url, b'{"version": 2, "lines": [{"desc": "wiper", "id": 1e400}]}', al)
        assert code == 200 and t["lines"][0]["id"] == 1 and t["version"] == 3  # a silly id is renumbered, not a 500
        code, r = call(b, url, b'{"version": 3, "lines": [{"desc": "wiper", "qty": 1e400}]}', al)
        assert code == 400 and "lines" in r["errors"]
        lines = [{"desc": "front brake pads", "qty": 1, "price": "100", "labor": "100", "code": "FBP"},
                 {"desc": "brake fluid flush", "labor": 80}]
        code, t = call(b, url, {"version": 3, "lines": lines, "odometer": "45,120"}, al)
        assert code == 200 and t["version"] == 4 and t["odometer"] == "45120"
        assert t["totals"] == {"parts": 100.0, "labor": 180.0, "total": 280.0}  # phone: no deposits
        assert "deposits" not in t
        code, r = call(b, url, {"version": 3, "notes": "late"}, al)
        assert code == 409 and r["ticket"]["version"] == 4 and r["ticket"]["notes"] == ""  # stale
        assert call(b, url, {"version": "4", "notes": "x"}, al)[0] == 400
        code, r = call(b, url + "/move", {"version": 4, "to": "waiting"}, al)
        assert code == 409 and r["ticket"]["status"] == "working"

        assert call(b, url + "/move", {"version": 4, "to": "review"}, al)[1]["status"] == "review"
        assert call(b, url, cookie=al)[1]["status"] == "review"  # still theirs to look at
        assert call(b, "/api/tickets?status=review", cookie=al)[1] == {"tickets": []}  # the list: waiting + working
        assert call(b, url, {"version": 5, "notes": "x"}, al)[0] == 409  # phone: review is locked
        code, r = call(b, url + "/move", {"version": 5, "to": "approved"}, al)
        assert code == 409 and r["ticket"]["status"] == "review"  # only the desk approves

        assert [t["id"] for t in call(b, "/api/tickets?status=review", cookie=a)[1]["tickets"]] == [tid]
        lines[0].update(qty=2, price="50.50")
        code, t = call(b, url, {"version": 5, "who": "mechanic", "lines": lines, "first": "Joan"}, a)  # desk rules
        assert code == 200 and t["first"] == "JOAN" and t["totals"] == {"parts": 101.0, "labor": 180.0, "total": 281.0, "deposits": 0}
        assert t["deposits"] == []
        mv = lambda body, c=a: call(b, url + "/move", body, c)
        assert mv({"version": 6, "to": "working"})[0] == 409  # sending back needs a note
        assert mv({"version": 6, "to": "working", "note": ["x"]})[0] == 400
        assert mv({"version": 6, "to": "working", "note": "x" * 2001})[0] == 400
        assert mv({"version": 6, "to": ["working"]})[0] == 400
        code, t = mv({"version": 6, "to": "working", "note": "check rear pads too", "mechanic": "Bo Wrench"})
        assert code == 200 and (t["status"], t["back_note"], t["mechanic"]) == ("working", "check rear pads too", "Al Fixit")
        assert (mv({"version": 7, "to": "review"}, al)[1]["back_note"]) == ""
        assert mv({"version": 8, "to": "approved"})[1]["status"] == "approved"
        priced = [dict(ln, price=ln["price"] and ln["price"] + 5, labor=ln["labor"] and ln["labor"] + 10) for ln in t["lines"]]
        assert call(b, url, cookie=al)[0] == 404  # approved: off the phone
        code, t = call(b, url, {"version": 9, "lines": priced}, a)  # prices stay editable after approval
        assert code == 200 and t["status"] == "approved" and t["version"] == 10
        assert [(ln["price"], ln["labor"]) for ln in t["lines"]] == [(ln["price"], ln["labor"]) for ln in priced]
        code, t = mv({"version": 10, "to": "filled"})
        assert code == 200 and t["status"] == "filled" and t["version"] == 11
        assert call(b, url, {"version": 11, "notes": "late"}, a)[0] == 409

        code, t = call(b, "/api/tickets", CAR, a)  # the desk's own intake gets the ticket back
        assert code == 200 and t["status"] == "waiting" and t["phone"] == "(555)010-0000" and t["plate"] == "TST-0001"
        u2 = f"/api/tickets/{t['id']}/move"
        assert call(b, u2, {"version": 1, "to": "working", "mechanic": "Cy Unknown"}, a)[0] == 400
        assert call(b, u2, {"version": 1, "to": "working"}, a)[0] == 400
        code, t = call(b, u2, {"version": 1, "to": "working", "mechanic": "bo  wrench"}, a)  # desk accepts for Bo
        assert code == 200 and t["mechanic"] == "Bo Wrench"
        assert call(b, u2[:-5], {"version": 2, "notes": "on it"}, bo)[0] == 200
        code, t = call(b, "/api/tickets", CAR, a)  # waiting: the desk may set who it's for
        u3 = f"/api/tickets/{t['id']}"
        for m, stored in (("al fixit", "Al Fixit"), ("AL FIXIT", "Al Fixit"), ("Bo Wrench", "Bo Wrench")):
            code, t = call(b, u3, {"version": t["version"], "mechanic": m}, a)  # desk: an account, its spelling
            assert code == 200 and t["mechanic"] == stored
        for m in ("Cy Unknown", "", ["Al Fixit"], None):
            code, r = call(b, u3, {"version": t["version"], "mechanic": m}, a)
            assert code == 400 and "mechanic" in r["errors"], m
        call(b, u3, {"version": t["version"], "mechanic": "al fixit"}, a)
        call(b, f"/api/users/{s.ids['Al Fixit']}", {"active": False}, a)
        code, t = call(b, u3, {"version": t["version"] + 1, "mechanic": "AL FIXIT", "notes": "kept"}, a)
        assert code == 200 and t["mechanic"] == "Al Fixit"  # off now, but it's the ticket's current value
        call(b, u3, {"version": t["version"], "mechanic": "Bo Wrench"}, a)
        assert call(b, u3, {"version": t["version"] + 1, "mechanic": "Al Fixit"}, a)[0] == 400  # off: not pickable
        code, t = call(b, "/api/tickets", CAR, a)
        assert call(b, f"/api/tickets/{t['id']}/move", {"version": 1, "to": "working", "mechanic": "Al Fixit"}, a)[0] == 400
        assert call(b, "/api/mechanics", cookie=a)[1] == {"mechanics": ["Bo Wrench"]}  # active accounts only

        assert call(b, "/api/tickets/999", cookie=a)[0] == 404
        assert call(b, "/api/tickets/999/move", {"version": 1, "to": "working"}, a)[0] == 404
        assert call(b, "/api/tickets/abc", cookie=a)[0] == 404
        assert call(b, "/api/tickets/99999999999999999999", {"version": 1}, a)[0] == 404
        log = s.log()
        assert f"POST /api/tickets/{tid}/move 200" in log and "status=" not in log
        for secret in ["JANE", "FIXIT", "WRENCH", ADMIN.upper(), PASSWORD.upper(), *PINS.values(),
                       *(c.split("=", 1)[1].upper() for c in (a, k, al, bo))]:
            assert secret not in log.upper()


def test_deposits_admin_only():
    with Server() as s:
        b = s.base
        a, al, k = admin(b), tech(b, "Al Fixit"), kiosk(b)
        kid = call(b, "/api/tickets", {**CAR, "deposits": [{"amount": 50}]}, k)[1]["id"]
        assert call(b, f"/api/tickets/{kid}", cookie=a)[1]["deposits"] == []  # check-in can't take money
        code, t = call(b, "/api/tickets", CAR, a)
        url, v = f"/api/tickets/{t['id']}", t["version"]
        dep = {"amount": "200", "method": "cash", "date": time.strftime("%Y-%m-%d"), "note": "at drop-off"}
        code, t = call(b, url, {"version": v, "deposits": [dep]}, a)  # waiting
        assert code == 200 and t["deposits"] == [{**dep, "amount": 200.0, "id": 1}]
        assert t["totals"] == {"parts": 0, "labor": 0, "total": 0, "deposits": 200}
        mech = lambda t: ("deposits" not in t and list(t["totals"]) == ["parts", "labor", "total"])
        assert mech(call(b, url, cookie=al)[1])
        assert all(mech(x) for x in call(b, "/api/tickets", cookie=al)[1]["tickets"])
        code, t = call(b, url + "/move", {"version": t["version"], "to": "working"}, al)
        assert code == 200 and mech(t)
        code, t = call(b, url, {"version": t["version"], "lines": [{"desc": "pads", "price": 100, "labor": 50}]}, al)
        assert code == 200 and mech(t) and t["totals"]["total"] == 150
        code, r = call(b, url, {"version": t["version"], "deposits": []}, al)
        assert code == 409 and "deposits" in r["error"] and mech(r["ticket"])  # the phone can't touch them
        assert call(b, url, {"version": t["version"] - 1, "notes": "late"}, al)[1]["ticket"].keys() == r["ticket"].keys()

        v = t["version"]
        code, t = call(b, url, {"version": v, "deposits": [{"id": 1, **dep}, {"amount": 9.5, "method": "card"}]}, a)  # working
        assert code == 200 and [d["id"] for d in t["deposits"]] == [1, 2] and t["totals"]["deposits"] == 209.5
        code, r = call(b, url, {"version": t["version"], "deposits": [], "notes": "x"}, a)
        assert code == 409 and len(r["ticket"]["deposits"]) == 2  # working: deposits alone
        code, r = call(b, url, {"version": t["version"], "deposits": [{"amount": 5, "method": "venmo"}]}, a)
        assert code == 400 and "deposits" in r["errors"]
        assert call(b, url, cookie=a)[1]["totals"]["deposits"] == 209.5
        t = call(b, url + "/move", {"version": t["version"], "to": "review"}, al)[1]
        assert mech(t) and mech(call(b, url, cookie=al)[1])
        code, t = call(b, url, {"version": t["version"], "deposits": [{"id": 2, "amount": 9.5, "method": "card"}]}, a)
        assert code == 200 and [d["id"] for d in t["deposits"]] == [2]  # removed one (review)
        t = call(b, url + "/move", {"version": t["version"], "to": "approved"}, a)[1]
        code, t = call(b, url, {"version": t["version"], "deposits": t["deposits"] + [{"amount": 149.5}]}, a)
        assert code == 200 and t["totals"]["deposits"] == 159 and [d["id"] for d in t["deposits"]] == [2, 3]
        t = call(b, url + "/move", {"version": t["version"], "to": "filled"}, a)[1]
        assert call(b, url, {"version": t["version"], "deposits": []}, a)[0] == 409  # filled: closed
        assert call(b, url, cookie=k)[0] == 403


def test_roles_refused_at_the_wrong_door():
    with Server() as s:
        b = s.base
        code, page = call(b, "/login/tech", {"name": ADMIN, "secret": PASSWORD})
        assert code == 401 and b"Wrong name or PIN." in page and "Set-Cookie" not in call.headers
        code, page = call(b, "/login/admin", {"name": "Al Fixit", "secret": PINS["Al Fixit"]})
        assert code == 401 and b"Wrong name or password." in page
        err = lambda r: (r[0], re.search(rb'class="err">(.*?)<', r[1])[1])
        unknown = err(call(b, "/login/tech", {"name": "Nobody Here", "secret": "123456"}))
        assert unknown == err(call(b, "/login/tech", {"name": "Al Fixit", "secret": "123456"})) == (401, b"Wrong name or PIN.")
        assert call(b, "/login/tech", {"name": "<b>x</b>", "secret": "1"})[1].count(b"<b>") == 0  # escaped


def test_lockout():
    with Server() as s:
        b = s.base
        codes = [call(b, "/login/tech", {"name": "Al Fixit", "secret": p})[0] for p in ("1", "2", "3", "4", "5")]
        code, page = call(b, "/login/tech", {"name": "Al Fixit", "secret": PINS["Al Fixit"]})
        assert codes == [401] * 5 and code == 429 and b"Wait 10 min." in page  # even the right PIN waits
        assert 590 <= int(call.headers["Retry-After"]) <= 600
        tech(b, "Bo Wrench")  # another name is fine
        cf = lambda ip: {"CF-Connecting-IP": ip}  # through cloudflared on this PC: the client is the header
        for i in range(20):
            call(b, "/login/tech", {"name": f"Guess {i}", "secret": "000000"}, headers=cf("203.0.113.5"))
        assert call(b, "/login/tech", {"name": "Bo Wrench", "secret": PINS["Bo Wrench"]}, headers=cf("203.0.113.5"))[0] == 429
        assert 1 <= int(call.headers["Retry-After"]) <= 600
        assert call(b, "/login/tech", {"name": "Bo Wrench", "secret": PINS["Bo Wrench"]}, headers=cf("203.0.113.6"))[0] == 303
        h = shop.Handler.__new__(shop.Handler)  # the header only counts from loopback
        h.headers, h.client_address = {"CF-Connecting-IP": "203.0.113.9"}, ("192.168.1.20", 5000)
        assert h.client() == "192.168.1.20"
        h.client_address = ("127.0.0.1", 5000)
        assert h.client() == "203.0.113.9"


def test_users_and_sessions():
    with Server() as s:
        b = s.base
        a = admin(b)
        code, r = call(b, "/api/users", cookie=a)
        assert code == 200 and [u["name"] for u in r["users"]] == ["Al Fixit", "Bo Wrench", ADMIN]
        assert all(set(u) == {"id", "name", "role", "active", "created"} for u in r["users"])  # no hashes
        code, u = call(b, "/api/users", {"name": "Cy Newhire", "role": "mechanic", "secret": "11223344"}, a)
        assert code == 200 and u["name"] == "Cy Newhire" and u["active"] is True
        assert call(b, "/api/users", {"name": "cy newhire", "role": "mechanic", "secret": "11223344"}, a)[0] == 400
        code, r = call(b, "/api/users", {"name": "Di Short", "role": "mechanic", "secret": "12"}, a)
        assert code == 400 and "secret" in r["errors"]
        assert "Cy Newhire" in call(b, "/api/mechanics", cookie=a)[1]["mechanics"]

        al, al_id = tech(b, "Al Fixit"), s.ids["Al Fixit"]
        code, u = call(b, f"/api/users/{al_id}", {"secret": "975310"}, a)  # reset PIN: Al is signed out
        assert code == 200 and "hash" not in u and "Set-Cookie" not in call.headers
        assert call(b, "/api/me", cookie=al)[0] == 401
        assert call(b, "/login/tech", {"name": "Al Fixit", "secret": PINS["Al Fixit"]})[0] == 401
        assert call(b, "/login/tech", {"name": "Al Fixit", "secret": "975310"})[0] == 303
        al = sid()
        assert call(b, f"/api/users/{al_id}", {"active": "no"}, a)[0] == 400
        assert call(b, f"/api/users/{al_id}", {"active": False}, a)[1]["active"] is False  # off: signed out
        assert call(b, "/api/me", cookie=al)[0] == 401
        assert call(b, "/login/tech", {"name": "Al Fixit", "secret": "975310"})[0] == 401
        assert "Al Fixit" not in call(b, "/api/mechanics", cookie=a)[1]["mechanics"]
        assert call(b, f"/api/users/{al_id}", {"active": True}, a)[1]["active"] is True
        assert call(b, "/api/users/999", {"active": True}, a)[0] == 404

        me = f"/api/users/{s.ids[ADMIN]}"
        assert call(b, me, {"active": False}, a)[0] == 400  # the last admin stays on
        other = admin(b)
        assert call(b, me, {"secret": "short"}, a)[0] == 400
        code, u = call(b, me, {"secret": "made-up-pass-2"}, a)  # own password: this device gets a new sid
        assert code == 200 and call.headers["Set-Cookie"].startswith("sid=")
        a2 = sid()
        assert a2 != a and call(b, "/api/me", cookie=a)[0] == 401 and call(b, "/api/me", cookie=other)[0] == 401
        assert call(b, "/api/me", cookie=a2)[1]["role"] == "admin"
        admin(b, "made-up-pass-2")

        k1, k2 = kiosk(b, "made-up-pass-2"), kiosk(b, "made-up-pass-2")
        assert call(b, "/api/kiosk/revoke", {}, a2) == (200, {"ok": True})
        assert call(b, "/api/me", cookie=k1)[0] == 401 and call(b, "/api/me", cookie=k2)[0] == 401
        assert call(b, "/api/me", cookie=a2)[0] == 200

        bo = tech(b, "Bo Wrench")
        assert call(b, "/logout", b"", bo)[0] == 303 and call.headers["Location"] == "/tech"
        assert "Max-Age=0" in call.headers["Set-Cookie"] and call(b, "/api/me", cookie=bo)[0] == 401
        assert call(b, "/logout", b"", a2)[0] == 303 and call.headers["Location"] == "/admin"
        assert call(b, "/logout", b"")[0] == 303 and call.headers["Location"] == "/"
        k = kiosk(b, "made-up-pass-2")
        assert call(b, "/logout", b"", k)[0] == 303 and call.headers["Location"] == "/checkin"


def test_cookie_flags():
    with Server() as s:
        b = s.base
        for path, form, age in (("/login/admin", {"name": ADMIN, "secret": PASSWORD}, 7 * 86400),
                                ("/login/tech", {"name": "Al Fixit", "secret": PINS["Al Fixit"]}, 30 * 86400)):
            call(b, path, form)
            c = call.headers["Set-Cookie"]
            assert re.fullmatch(rf"sid=[\w-]{{43}}; Path=/; Max-Age={age}; HttpOnly; SameSite=Strict", c), c
            call(b, path, form, headers={"X-Forwarded-Proto": "https"})
            assert call.headers["Set-Cookie"].endswith("; SameSite=Strict; Secure")  # through the tunnel
        call(b, "/api/kiosk", {}, admin(b))
        assert f"Max-Age={365 * 86400}; HttpOnly; SameSite=Strict" in call.headers["Set-Cookie"]


def test_bad_requests():
    with Server() as s:
        b, c = s.base, admin(s.base)
        assert call(b, "/api/tickets", b"{not json", c)[0] == 400
        assert call(b, "/api/tickets", b"[1, 2]", c)[0] == 400
        assert call(b, "/api/tickets", b"\xff\xfe", c)[0] == 400
        assert call(b, "/api/tickets", b"[" * 100000, c)[0] == 400  # too deep for json: RecursionError
        for ctype in ("text/plain", "application/x-www-form-urlencoded"):  # what a form on another site can send
            assert call(b, "/api/tickets", json.dumps(CAR).encode(), c, {"Content-Type": ctype})[0] == 400
        assert call(b, "/api/tickets", json.dumps(CAR).encode(), c, {"Content-Type": "application/json; charset=utf-8"})[0] == 200
        assert call(b, "/api/me", cookie='sid="\\x; bad')[0] == 401  # a mangled cookie: no session, no 500
        for path in ("/api/tickets", "/login/admin"):  # says 2 MB: refused before reading it
            conn = http.client.HTTPConnection(b[7:])
            conn.putrequest("POST", path)
            conn.putheader("Cookie", c)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(2 * 1024 * 1024))
            conn.endheaders()
            assert conn.getresponse().status == 400
            conn.close()


def test_stalled_body():
    shop.Handler.timeout = 1
    try:
        with Server() as s:
            c, start = admin(s.base), time.time()
            conn = http.client.HTTPConnection(s.base[7:], timeout=10)
            conn.putrequest("POST", "/api/tickets")
            conn.putheader("Cookie", c)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", "100")
            conn.endheaders(b'{"first"')  # then nothing more
            try:
                conn.getresponse().read()
            except (http.client.HTTPException, OSError):
                pass  # the server hung up
            conn.close()
            assert time.time() - start < 5
            assert call(s.base, "/api/me", cookie=c)[0] == 200  # still serving
            assert "POST /api/tickets dropped" in s.log()
    finally:
        shop.Handler.timeout = pinweb.Web.timeout


def test_security_headers():
    with Server() as s:
        for p in ("/", "/admin", "/tech", "/checkin"):
            call(s.base, p)
            h = call.headers
            assert h["X-Content-Type-Options"] == "nosniff" and h["Referrer-Policy"] == "same-origin"
            assert h["Cache-Control"] == "no-store"
            assert "frame-ancestors 'none'" in h["Content-Security-Policy"] and "form-action 'self'" in h["Content-Security-Policy"]
        call(s.base, "/api/tickets")
        assert call.headers["X-Content-Type-Options"] == "nosniff" and "Content-Security-Policy" not in call.headers


def test_server_error_says_nothing():
    with Server() as s:
        c = admin(s.base)
        def boom(*a):
            raise RuntimeError("C:\\secret\\path tickets.db locked")
        shop.Handler.store.list = boom
        assert call(s.base, "/api/tickets", cookie=c) == (500, {"error": "server error"})
        assert "GET /api/tickets 500" in s.log() and "secret" not in s.log()


def test_etag_per_role():
    with Server() as s:
        b, a, al = s.base, admin(s.base), tech(s.base, "Al Fixit")
        call(b, "/api/tickets", CAR, a)
        tags = {}
        for name, c in (("admin", a), ("al", al)):
            assert call(b, "/api/tickets?status=waiting", cookie=c)[0] == 200
            tags[name] = call.headers["ETag"]
            assert call(b, "/api/tickets?status=waiting", cookie=c, headers={"If-None-Match": tags[name]}) == (304, b"")
            assert call(b, "/api/tickets?status=working", cookie=c, headers={"If-None-Match": tags[name]})[0] == 200
        assert tags["admin"] != tags["al"]  # same tickets, other role: no shared tag
        assert call(b, "/api/tickets?status=waiting", cookie=al, headers={"If-None-Match": tags["admin"]})[0] == 200
        bo = tech(b, "Bo Wrench")
        assert call(b, "/api/tickets?status=waiting", cookie=bo, headers={"If-None-Match": tags["al"]})[0] == 200
        call(b, "/api/tickets/1", {"version": 1, "first": "Joan"}, a)
        assert call(b, "/api/tickets?status=waiting", cookie=al, headers={"If-None-Match": tags["al"]})[0] == 200  # changed
        assert call(b, "/api/tickets?status=bogus", cookie=a)[1] == {"tickets": []}


def test_pin_and_secret_files():  # pinweb's PIN pieces, still there for phone.py's move
    d = tempfile.mkdtemp()
    try:
        pin, secret = pinweb.load_pin(os.path.join(d, "pin.txt")), pinweb.load_secret(os.path.join(d, "secret.txt"))
        assert re.fullmatch(r"[0-9]{6}", pin) and re.fullmatch(r"[0-9a-f]{64}", secret)
        assert pinweb.load_pin(os.path.join(d, "pin.txt")) == pin and pinweb.load_secret(os.path.join(d, "secret.txt")) == secret
        tok = lambda p, s: pinweb.PinHandler.token(type("H", (), {"pin": p, "secret": s})())
        assert tok("123456", secret) != tok("654321", secret) and tok("123456", secret) != tok("123456", "other")
    finally:
        shutil.rmtree(d)


def test_catalog():
    with Server() as s:
        b, c = s.base, admin(s.base)
        code, h = call(b, "/api/catalog?q=BRAKE", cookie=c)
        assert code == 200 and len(h) == 8  # capped
        assert h[0] == {"code": "FBP", "description": "FRONT BRAKE PADS", "part_price": 100.0, "labor_price": 100.0}
        assert call(b, "/api/catalog?q=front%20pads", cookie=c)[1][0]["code"] == "FBP"  # alias
        assert call(b, "/api/catalog?q=oil", cookie=tech(b, "Al Fixit"))[1][0]["code"] == "OIL"  # mechanics too
        assert call(b, "/api/catalog?q=", cookie=c)[1] == [] and call(b, "/api/catalog", cookie=c)[1] == []
        assert call(b, "/api/catalog?q=brake")[0] == 401


def test_vehicles():
    with Server() as s:
        b = s.base
        cars = {"TOYOTA": {"CAMRY": [1990, 2027]}}
        with open(shop.VEHICLES, "w", encoding="utf8") as f:
            json.dump(cars, f)
        assert call(b, "/api/vehicles")[0] == 401
        c = kiosk(b)
        assert call(b, "/api/vehicles", cookie=c) == (200, cars)
        os.remove(shop.VEHICLES)
        assert call(b, "/api/vehicles", cookie=c) == (200, cars)  # read once
        shop.VEHICLES += ".missing"
        assert call(b, "/api/vehicles", cookie=c) == (200, {})
        shop.VEHICLES = shop.VEHICLES.replace("vehicles.json", "bad.json")
        with open(shop.VEHICLES, "w", encoding="utf8") as f:
            f.write("{not json")
        assert call(b, "/api/vehicles", cookie=c) == (200, {})


def test_make_admin_command():
    d, db, getpass = tempfile.mkdtemp(), shop.DB, shop.getpass.getpass
    try:
        shop.DB = os.path.join(d, "tickets.db")
        typed = iter(["made-up-pass-1", "made-up-pass-1", "made-up-pass-1", "something-else-2"])
        shop.getpass.getpass = lambda prompt="": next(typed)
        shop.main(["admin", "Test Boss"])
        try:
            shop.main(["admin", "Test Boss"])  # typed twice, not the same: nothing changes
            assert False
        except SystemExit as e:
            assert "match" in str(e)
        store = tickets.Store(shop.DB)
        try:
            acc = accounts.Accounts(store, iterations=1000)
            assert [(u["name"], u["role"]) for u in acc.list()] == [("Test Boss", "admin")]
            assert acc.login("test boss", "made-up-pass-1", "admin", "127.0.0.1")[1]["name"] == "Test Boss"
        finally:
            store.close()
    finally:
        shop.DB, shop.getpass.getpass = db, getpass
        shutil.rmtree(d)


def test_cross_site_posts_refused():
    with Server() as s:
        b, host = s.base, s.base[7:]
        form = {"name": ADMIN, "secret": PASSWORD}
        for h in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": f"http://{host}.evil.example"},
                  {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                  {"Origin": f"http://{host}", "Sec-Fetch-Site": "cross-site"}):
            assert call(b, "/login/admin", form, headers=h)[0] == 403, h
            assert "Set-Cookie" not in call.headers
            assert call(b, "/login/tech", {"name": "Al Fixit", "secret": PINS["Al Fixit"]}, headers=h)[0] == 403
            a = admin(b)
            assert call(b, "/logout", b"", a, headers=h)[0] == 403 and call(b, "/api/me", cookie=a)[0] == 200
            assert call(b, "/api/tickets", CAR, a, headers=h)[0] == 403
            assert call(b, "/setup", {"code": "x"}, headers=h)[0] == 403
        for h in ({"Origin": f"http://{host}"}, {"Origin": f"https://{host}"}, {"Sec-Fetch-Site": "same-origin"},
                  {"Sec-Fetch-Site": "none"}, {"Origin": "null", "Sec-Fetch-Site": "same-origin"}):  # Chrome's own forms
            assert call(b, "/login/admin", form, headers=h)[0] == 303, h
        a = admin(b)
        for path in ("/api/kiosk", "/api/kiosk/revoke"):  # JSON only: a form can't send it
            assert call(b, path, b"", a, {"Content-Type": "application/x-www-form-urlencoded"})[0] == 400
        assert call(b, "/api/me", cookie=a)[0] == 200  # still admin: the refused enrol changed nothing


def test_user_changes_all_or_nothing():
    with Server() as s:
        b, a = s.base, admin(s.base)
        al = f"/api/users/{s.ids['Al Fixit']}"
        code, r = call(b, al, {"secret": "12", "active": False}, a)  # bad PIN: Al isn't turned off either
        assert code == 400 and "secret" in r["errors"]
        assert call(b, "/api/users", cookie=a)[1]["users"][0]["active"] is True
        me = f"/api/users/{s.ids[ADMIN]}"
        code, r = call(b, me, {"secret": "made-up-pass-9", "active": False}, a)  # last admin: password not changed
        assert code == 400 and "active" in r["errors"]
        assert call(b, "/api/me", cookie=a)[0] == 200
        admin(b)  # the old password still works
        call(b, "/api/users", {"name": "Second Boss", "role": "admin", "secret": "made-up-pass-3"}, a)
        code, u = call(b, me, {"secret": "made-up-pass-9", "active": False}, a)  # now allowed: both applied
        assert code == 200 and u["active"] is False and "Set-Cookie" not in call.headers
        assert call(b, "/api/me", cookie=a)[0] == 401


def test_names_fold_and_owners_match_exactly():
    with Server() as s:
        b, a = s.base, admin(s.base)
        assert call(b, "/api/users", {"name": "Strauss", "role": "mechanic", "secret": "11223344"}, a)[0] == 200
        for name in ("STRAUß", "strauß", "STRAUSS"):
            code, r = call(b, "/api/users", {"name": name, "role": "mechanic", "secret": "11223344"}, a)
            assert code == 400 and "name" in r["errors"], name
        try:  # the same rule straight on accounts
            s.acc.add("Strauß", "admin", PASSWORD)
            assert False
        except tickets.Invalid as e:
            assert "name" in e.errors
        st = shop.Handler.store.create(CAR)  # a ticket naming Al in other letters: not Al's
        tickets.move(st, "working", "AL FIXIT")
        shop.Handler.store.save(st, 1)
        al = tech(b, "Al Fixit")
        assert call(b, f"/api/tickets/{st.id}", cookie=al)[0] == 404
        assert call(b, f"/api/tickets/{st.id}", {"version": 2, "notes": "x"}, al)[0] == 404
        code, t = call(b, "/api/tickets", CAR, a)
        PINS["Strauss"] = "11223344"
        try:
            code, t = call(b, f"/api/tickets/{t['id']}/move", {"version": 1, "to": "working"}, tech(b, "Strauss"))
        finally:
            del PINS["Strauss"]
        assert code == 200 and t["mechanic"] == "Strauss"


def test_sign_in_messages():
    with Server() as s:
        b = s.base
        err = lambda r: (r[0], re.search(rb'class="err">(.*?)<', r[1])[1])
        a = admin(b)
        call(b, f"/api/users/{s.ids['Bo Wrench']}", {"active": False}, a)
        off = err(call(b, "/login/tech", {"name": "Bo Wrench", "secret": PINS["Bo Wrench"]}))
        assert off == err(call(b, "/login/tech", {"name": "Nobody Here", "secret": "123456"})) == (401, b"Wrong name or PIN.")
        s.acc.until[("name", "al fixit")] = time.time() + 5 * 3600  # a day-cap lock: hours, not minutes
        assert err(call(b, "/login/tech", {"name": "Al Fixit", "secret": "1"})) == (429, b"Too many tries. Wait 5 hours.")
        s.acc.until[("name", "al fixit")] = time.time() + 90 * 60
        assert err(call(b, "/login/tech", {"name": "Al Fixit", "secret": "1"})) == (429, b"Too many tries. Wait 90 min.")
        s.acc.hashing, s.acc.hash_wait = threading.BoundedSemaphore(1), 0.05
        s.acc.hashing.acquire()  # every hashing slot taken
        code, page = call(b, "/login/admin", {"name": ADMIN, "secret": PASSWORD})
        assert code == 429 and b"The server is busy" in page and call.headers["Retry-After"] == "5"


def read_code():
    with open(shop.SETUP, encoding="utf8") as f:
        return f.read().strip()


def test_first_run_setup():
    with Server(admin=False) as s:
        b = s.base
        assert not os.path.exists(shop.SETUP)
        shop.make_setup_code(s.acc)
        code = read_code()
        assert re.fullmatch(r"[\w-]{12}", code)
        shop.make_setup_code(s.acc)  # a restart keeps a live code
        assert read_code() == code
        assert b'action="/setup"' in call(b, "/setup")[1]
        form = {"code": code, "name": "First Boss", "password": "made-up-pass-5", "again": "made-up-pass-5"}
        assert call(b, "/setup", {**form, "again": "other-pass-55"})[0] == 400  # code kept: not used yet
        assert call(b, "/setup", {**form, "password": "short", "again": "short"})[0] == 400
        for i in range(5):
            assert call(b, "/setup", {**form, "code": f"wrong{i}"})[0] == 401
        status, page = call(b, "/setup", form)  # 5 wrong codes: even the right one waits
        assert status == 429 and b"Wait 10 min." in page and 590 <= int(call.headers["Retry-After"]) <= 600
        assert call(b, "/setup", form, headers={"CF-Connecting-IP": "203.0.113.7"})[0] == 303  # another client
        assert call.headers["Location"] == "/admin"
        c = sid()
        assert call(b, "/api/me", cookie=c)[1]["name"] == "First Boss" and not os.path.exists(shop.SETUP)
        assert call(b, "/setup")[0] == 404
        assert call(b, "/setup", form, headers={"CF-Connecting-IP": "203.0.113.8"})[0] == 404  # used once only
        shop.make_setup_code(s.acc)  # with an admin: no code made
        assert not os.path.exists(shop.SETUP)
        log = s.log()
        assert "made-up-pass-5" not in log and code not in log and "First Boss" not in log


def test_setup_code_expires():
    with Server(admin=False) as s:
        shop.make_setup_code(s.acc)
        old = read_code()
        os.utime(shop.SETUP, (time.time() - 86401, time.time() - 86401))
        form = {"code": old, "name": "First Boss", "password": "made-up-pass-5", "again": "made-up-pass-5"}
        assert call(s.base, "/setup", form)[0] == 401  # over 24 hours old
        shop.make_setup_code(s.acc)  # the next start makes a new one
        assert read_code() != old


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
