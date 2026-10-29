import http.client, json, os, re, shutil, sys, tempfile, threading, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from http.server import ThreadingHTTPServer
import pinweb, shop, tickets

PIN = "730146"
CAR = {"first": "Jane", "last": "Testcase", "phone": "555 010 0000", "year": "2019", "make": "Cadillac",
       "model": "XT5", "plate": "tst-0001", "request": "brakes squeak"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a):
        return None


def call(base, path, data=None, cookie="", headers=None):
    """-> (status, parsed JSON or raw bytes, or the Set-Cookie of a login); call.headers = the reply's headers.
    API posts go as application/json unless headers say otherwise."""
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
        return code, raw if "Set-Cookie" not in headers else headers["Set-Cookie"]


class Server:
    def __enter__(self):
        self.dir = tempfile.mkdtemp()
        j = lambda n: os.path.join(self.dir, n)
        shop.Handler.log_path, shop.MECHANICS, shop.CATALOG, shop.WEB = j("shop.log"), j("mechanics.txt"), j("parts.csv"), j("web")
        shop.VEHICLES = j("vehicles.json")
        with open(shop.MECHANICS, "w", encoding="utf8") as f:
            f.write("# who works here\n\nAl Fixit\nBo  Wrench\n")
        with open(shop.CATALOG, "w", encoding="utf8") as f:
            f.write("code,description,aliases,sided,part_price,labor_price\n"
                    "FBP,FRONT BRAKE PADS,front brake pads|front pads,no,100,100\n"
                    "OIL,OIL CHANGE,oil change,no,40,0\n"
                    + "".join(f"BR{i},BRAKE THING {i},brake thing {i},no,{i},5\n" for i in range(10)))
        shop.Handler.pin, shop.Handler.secret, shop.Handler.store = PIN, "made-up-test-secret", tickets.Store(j("tickets.db"))
        shop.Handler.fails.clear()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), shop.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.srv.server_address[1]}"

    def __exit__(self, *a):
        self.srv.shutdown()
        self.srv.server_close()
        shop.Handler.store.close()
        shutil.rmtree(self.dir)


def login(base):
    code, cookie = call(base, "/login", f"pin={PIN}".encode())
    assert code == 303 and cookie.startswith("shop=") and "HttpOnly" in cookie and "SameSite=Strict" in cookie
    return cookie.split(";")[0]


def test_shop_flow():
    with Server() as base:
        for p in ("/", "/desk", "/tech"):
            assert b'name="pin"' in call(base, p)[1]  # PIN page until logged in
        assert call(base, "/api/tickets")[0] == 401 and call(base, "/api/tickets", CAR)[0] == 401
        assert call(base, "/api/tickets/1/move", {"version": 1, "to": "working"})[0] == 401
        assert call(base, "/login", b"pin=111111")[0] == 401
        c = login(base)
        assert b'href="/desk"' in call(base, "/", cookie=c)[1]
        assert b"isn't built yet" in call(base, "/tech", cookie=c)[1]
        os.makedirs(shop.WEB)
        with open(os.path.join(shop.WEB, "tech.html"), "w") as f:
            f.write("<p>tech page</p>")
        assert call(base, "/tech", cookie=c)[1] == b"<p>tech page</p>"

        code, t = call(base, "/api/tickets", CAR, c)
        assert code == 200 and t["status"] == "waiting" and t["version"] == 1 and t["phone"] == "(555)010-0000"
        assert t["plate"] == "TST-0001" and t["totals"] == {"parts": 0, "labor": 0, "total": 0}
        tid, url = t["id"], f"/api/tickets/{t['id']}"
        code, bad = call(base, "/api/tickets", {**CAR, "first": "", "year": "1800"}, c)
        assert code == 400 and set(bad["errors"]) == {"first", "year"}
        assert [x["id"] for x in call(base, "/api/tickets?status=waiting,review", cookie=c)[1]["tickets"]] == [tid]
        assert call(base, "/api/tickets?status=working", cookie=c)[1] == {"tickets": []}
        assert call(base, "/api/tickets?status=bogus", cookie=c)[1] == {"tickets": []}
        assert call(base, url, cookie=c)[1]["first"] == "JANE"
        assert call(base, "/api/mechanics", cookie=c)[1] == {"mechanics": ["Al Fixit", "Bo Wrench"]}

        call(base, "/api/tickets?status=waiting", cookie=c)
        tag = call.headers["ETag"]
        assert call(base, "/api/tickets?status=waiting", cookie=c, headers={"If-None-Match": tag}) == (304, b"")
        assert call(base, "/api/tickets?status=working", cookie=c, headers={"If-None-Match": tag})[0] == 200  # other filter
        code, t = call(base, url, {"version": 1, "who": "desk", "first": "Joan", "request": "brakes squeak, front"}, c)
        assert code == 200 and (t["first"], t["version"]) == ("JOAN", 2)  # desk edits a waiting ticket
        assert call(base, "/api/tickets?status=waiting", cookie=c, headers={"If-None-Match": tag})[0] == 200  # changed

        mv = lambda body: call(base, url + "/move", body, c)
        assert mv({"version": 2, "to": "working", "mechanic": "Cy Unknown"})[0] == 400
        assert mv({"version": 2, "to": "working"})[0] == 400  # accept needs a name from the list
        code, t = mv({"version": 2, "to": "working", "mechanic": "Bo Wrench"})
        assert code == 200 and (t["status"], t["mechanic"], t["version"]) == ("working", "Bo Wrench", 3)
        code, r = mv({"version": 3, "to": "review"})
        assert code == 409 and "line" in r["error"] and r["ticket"]["status"] == "working"  # finish with no lines

        code, r = call(base, url, {"version": 3, "who": "desk", "first": "JUNE"}, c)
        assert code == 409 and (r["ticket"]["first"], r["ticket"]["version"]) == ("JOAN", 3)  # refused: stored copy
        code, r = call(base, url, {"version": 3, "who": "mechanic", "first": "JUNE"}, c)
        assert code == 409 and "first" in r["error"]
        code, t = call(base, url, b'{"version": 3, "who": "mechanic", "lines": [{"desc": "wiper", "id": 1e400}]}', c)
        assert code == 200 and t["lines"][0]["id"] == 1 and t["version"] == 4  # a silly id is renumbered, not a 500
        code, r = call(base, url, b'{"version": 4, "who": "mechanic", "lines": [{"desc": "wiper", "qty": 1e400}]}', c)
        assert code == 400 and "lines" in r["errors"]
        lines = [{"desc": "front brake pads", "qty": 1, "price": "100", "labor": "100", "code": "FBP"},
                 {"desc": "brake fluid flush", "labor": 80}]
        code, t = call(base, url, {"version": 4, "who": "mechanic", "lines": lines, "odometer": "45,120"}, c)
        assert code == 200 and t["version"] == 5 and t["odometer"] == "45120"
        assert t["totals"] == {"parts": 100.0, "labor": 180.0, "total": 280.0}
        assert [ln["id"] for ln in t["lines"]] == [1, 2]
        code, r = call(base, url, {"version": 4, "who": "mechanic", "notes": "late"}, c)
        assert code == 409 and r["ticket"]["version"] == 5 and r["ticket"]["notes"] == ""  # stale
        code, r = call(base, url, {"version": 5, "who": "mechanic", "lines": [{"desc": "x", "qty": 0}]}, c)
        assert code == 400 and "lines" in r["errors"]
        assert call(base, url, {"version": 5, "who": "boss"}, c)[0] == 400
        assert call(base, url, {"version": "5", "who": "mechanic"}, c)[0] == 400

        assert mv({"version": 5, "to": "review"})[1]["status"] == "review"
        assert call(base, url, {"version": 6, "who": "mechanic", "notes": "x"}, c)[0] == 409  # phone: review is locked
        lines[0].update(qty=2, price="50.50")
        code, t = call(base, url, {"version": 6, "who": "desk", "lines": lines}, c)
        assert code == 200 and t["totals"] == {"parts": 101.0, "labor": 180.0, "total": 281.0}  # desk fixes a line
        code, r = mv({"version": 7, "to": "working"})
        assert code == 409 and r["ticket"]["status"] == "review"  # sending back needs a note
        assert mv({"version": 7, "to": "working", "note": ["x"]})[0] == 400
        assert mv({"version": 7, "to": "working", "note": "x" * 2001})[0] == 400
        assert mv({"version": 7, "to": ["working"]})[0] == 400
        code, t = mv({"version": 7, "to": "working", "note": "check rear pads too", "mechanic": "Nobody"})
        assert code == 200 and (t["status"], t["back_note"], t["mechanic"]) == ("working", "check rear pads too", "Bo Wrench")
        t = mv({"version": 8, "to": "review"})[1]
        assert (t["status"], t["back_note"]) == ("review", "")
        code, t = call(base, url, {"version": 9, "who": "desk", "notes": "customer waiting"}, c)
        assert code == 200 and t["notes"] == "customer waiting"
        assert mv({"version": 10, "to": "approved"})[1]["status"] == "approved"
        code, r = call(base, url, {"version": 11, "who": "mechanic", "notes": "late"}, c)
        assert code == 409 and r["ticket"]["notes"] == "customer waiting" and r["ticket"]["version"] == 11
        priced = [dict(ln, price=ln["price"] and ln["price"] + 5, labor=ln["labor"] and ln["labor"] + 10) for ln in t["lines"]]
        code, t = call(base, url, {"version": 11, "who": "desk", "lines": priced}, c)  # prices stay editable after approval
        assert code == 200 and t["status"] == "approved" and t["version"] == 12
        assert [(ln["price"], ln["labor"]) for ln in t["lines"]] == [(ln["price"], ln["labor"]) for ln in priced]
        code, r = mv({"version": 12, "to": "working", "note": "again"})
        assert code == 409 and r["ticket"]["status"] == "approved" and r["ticket"]["version"] == 12  # refused move
        code, t = mv({"version": 12, "to": "filled"})
        assert code == 200 and t["status"] == "filled" and t["version"] == 13
        assert call(base, url, {"version": 13, "who": "desk", "notes": "late"}, c)[0] == 409

        assert call(base, "/api/tickets/999", cookie=c)[0] == 404
        assert call(base, "/api/tickets/999/move", {"version": 1, "to": "working"}, c)[0] == 404
        assert call(base, "/api/tickets/abc", cookie=c)[0] == 404
        assert call(base, "/api/tickets/99999999999999999999", {"version": 1}, c)[0] == 404
        with open(shop.Handler.log_path, encoding="utf8") as f:
            log = f.read()
        assert f"POST /api/tickets/{tid}/move 200" in log and "JOAN" not in log.upper() and "status=" not in log


def test_bad_requests():
    with Server() as base:
        c = login(base)
        assert call(base, "/api/tickets", b"{not json", c)[0] == 400
        assert call(base, "/api/tickets", b"[1, 2]", c)[0] == 400
        assert call(base, "/api/tickets", b"\xff\xfe", c)[0] == 400
        assert call(base, "/api/tickets", b"[" * 100000, c)[0] == 400  # too deep for json: RecursionError
        for ctype in ("text/plain", "application/x-www-form-urlencoded"):  # what a form on another site can send
            assert call(base, "/api/tickets", json.dumps(CAR).encode(), c, {"Content-Type": ctype})[0] == 400
        assert call(base, "/api/tickets", json.dumps(CAR).encode(), c, {"Content-Type": "application/json; charset=utf-8"})[0] == 200
        conn = http.client.HTTPConnection(base[7:])  # says 2 MB: refused before reading it
        conn.putrequest("POST", "/api/tickets")
        conn.putheader("Cookie", c)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(2 * 1024 * 1024))
        conn.endheaders()
        assert conn.getresponse().status == 400
        conn.close()


def test_stalled_body():
    shop.Handler.timeout = 1
    try:
        with Server() as base:
            c, start = login(base), time.time()
            conn = http.client.HTTPConnection(base[7:], timeout=10)
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
            assert call(base, "/api/mechanics", cookie=c)[0] == 200  # still serving
            with open(shop.Handler.log_path, encoding="utf8") as f:
                assert "POST /api/tickets dropped" in f.read()
    finally:
        shop.Handler.timeout = pinweb.PinHandler.timeout


def test_security_headers():
    with Server() as base:
        call(base, "/")
        h = call.headers
        assert h["X-Content-Type-Options"] == "nosniff" and h["Referrer-Policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in h["Content-Security-Policy"] and "form-action 'self'" in h["Content-Security-Policy"]
        call(base, "/api/tickets")
        assert call.headers["X-Content-Type-Options"] == "nosniff" and "Content-Security-Policy" not in call.headers
        assert "Secure" not in call(base, "/login", f"pin={PIN}".encode())[1]  # plain http on the shop Wi-Fi
        cookie = call(base, "/login", f"pin={PIN}".encode(), headers={"X-Forwarded-Proto": "https"})[1]
        assert cookie.endswith("; Secure")  # through the tunnel


def test_server_error_says_nothing():
    with Server() as base:
        c = login(base)
        def boom(*a):
            raise RuntimeError("C:\\secret\\path tickets.db locked")
        shop.Handler.store.list = boom
        assert call(base, "/api/tickets", cookie=c) == (500, {"error": "server error"})
        with open(shop.Handler.log_path, encoding="utf8") as f:
            assert "GET /api/tickets 500" in f.read()


def test_pin_and_secret_files():
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
    with Server() as base:
        c = login(base)
        code, h = call(base, "/api/catalog?q=BRAKE", cookie=c)
        assert code == 200 and len(h) == 8  # capped
        assert h[0] == {"code": "FBP", "description": "FRONT BRAKE PADS", "part_price": 100.0, "labor_price": 100.0}
        assert call(base, "/api/catalog?q=front%20pads", cookie=c)[1][0]["code"] == "FBP"  # alias
        assert call(base, "/api/catalog?q=oil", cookie=c)[1][0]["code"] == "OIL"
        assert call(base, "/api/catalog?q=", cookie=c)[1] == [] and call(base, "/api/catalog", cookie=c)[1] == []
        assert call(base, "/api/catalog?q=brake")[0] == 401


def test_vehicles():
    with Server() as base:
        cars = {"TOYOTA": {"CAMRY": [1990, 2027]}}
        with open(shop.VEHICLES, "w", encoding="utf8") as f:
            json.dump(cars, f)
        assert call(base, "/api/vehicles")[0] == 401
        c = login(base)
        assert call(base, "/api/vehicles", cookie=c) == (200, cars)
        os.remove(shop.VEHICLES)
        assert call(base, "/api/vehicles", cookie=c) == (200, cars)  # read once
        shop.VEHICLES += ".missing"
        assert call(base, "/api/vehicles", cookie=c) == (200, {})
        shop.VEHICLES = shop.VEHICLES.replace("vehicles.json", "bad.json")
        with open(shop.VEHICLES, "w", encoding="utf8") as f:
            f.write("{not json")
        assert call(base, "/api/vehicles", cookie=c) == (200, {})


def test_mechanics_file_made():
    with Server() as base:
        os.remove(shop.MECHANICS)
        assert call(base, "/api/mechanics", cookie=login(base))[1] == {"mechanics": ["MECHANIC 1"]}
        assert os.path.exists(shop.MECHANICS)
        with open(shop.MECHANICS, "w", encoding="utf-8-sig") as f:  # Notepad's BOM
            f.write("Al Fixit\nBo Wrench\n")
        assert call(base, "/api/mechanics", cookie=login(base))[1] == {"mechanics": ["Al Fixit", "Bo Wrench"]}


def test_pin_lockout():
    with Server() as base:
        codes = [call(base, "/login", f"pin={p}".encode())[0] for p in ["1", "2", "3", "4", "5", PIN]]
        assert codes == [401] * 5 + [429]  # even the right PIN waits out the lockout


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
