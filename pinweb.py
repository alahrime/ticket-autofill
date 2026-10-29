"""PIN-protected little web servers (shop.py; phone.py keeps its own copy for now): PIN and secret files, the
login with a lockout, a signed cookie, security headers and a one-line-per-request log without customer data."""
from __future__ import annotations
import hashlib, hmac, json, secrets, threading, time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

HTML = "text/html; charset=utf-8"
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
MAX_TRIES, LOCKOUT = 5, 600  # wrong PINs allowed per 10 minutes, from anyone


def load_pin(path, new=lambda: f"{secrets.randbelow(10 ** 6):06d}"):
    """The value in path; made with new() (a random 6-digit PIN) the first time."""
    try:
        with open(path, encoding="utf8") as f:
            pin = f.read().strip()
    except OSError:
        pin = ""
    if not pin:
        pin = new()
        with open(path, "w", encoding="utf8") as f:
            f.write(pin + "\n")
    return pin


def load_secret(path):
    """The cookie-signing secret in path; a random one the first time."""
    return load_pin(path, lambda: secrets.token_hex(32))


class Gone(Exception):
    """The client stopped sending (socket timeout or drop): end the request without a reply."""


def page(title, body):
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>body{{font:16px system-ui,sans-serif;margin:0;padding:40px 16px;background:#f4f4f4;color:#222;text-align:center}}
input,button,a.big{{font:inherit;font-size:22px;padding:12px;border-radius:8px;width:100%;max-width:280px;box-sizing:border-box}}
input{{border:1px solid #ccc;text-align:center;letter-spacing:4px;margin:12px 0}} button,a.big{{border:0;background:#1f5fbf;color:#fff}}
a.big{{display:inline-block;margin:10px 0;text-decoration:none}} p.err{{color:#b00}}</style></head><body>
<h1>{title}</h1>
{body}
</body></html>""".encode()


def login_page(title, msg=""):
    return page(title, f"""<form method="post" action="/login"><input type="password" name="pin" inputmode="numeric"
autocomplete="current-password" placeholder="PIN" autofocus required><br><button>Open</button></form><p class="err">{msg}</p>""")


class PinHandler(BaseHTTPRequestHandler):
    """Subclasses set cookie, title, log_path, their own fails list, and get()/post(); serve() sets pin and secret."""
    cookie, title, log_path = "pin", "", ""
    pin = secret = ""
    fails, fails_lock = [], threading.Lock()  # times of recent wrong PINs (all callers look alike behind a tunnel)
    max_body = 1024 * 1024
    timeout = 20  # seconds a client may stall; then the request ends

    def log_message(self, *args):  # pythonw has no console; reply() logs instead
        pass

    def log(self, code):
        try:
            with open(self.log_path, "a", encoding="utf8") as f:  # path only: queries are left out
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.command} {urlsplit(self.path).path} {code} "
                        f"{time.time() - getattr(self, 'started', time.time()):.1f}s\n")
        except OSError:
            pass

    def reply(self, code, body=b"", ctype="application/json", headers=()):
        self.log(code)
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        for h in headers:
            self.send_header(*h)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 <= n <= self.max_body:
            raise ValueError("Request too big.")
        try:
            data = self.rfile.read(n)
        except OSError as e:  # socket timeout included
            raise Gone() from e
        if len(data) < n:
            raise Gone()
        return data

    def token(self):  # the cookie value; changing the PIN (or the secret) logs every device out
        return hmac.new(self.secret.encode(), self.pin.encode(), hashlib.sha256).hexdigest()

    def authed(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return bool(self.pin and self.secret) and self.cookie in c and hmac.compare_digest(c[self.cookie].value, self.token())

    def login(self):
        pin = parse_qs(self.body().decode(errors="replace")).get("pin", [""])[0].strip()
        with self.fails_lock:
            now = time.time()
            self.fails[:] = [t for t in self.fails if now - t < LOCKOUT]
            if len(self.fails) >= MAX_TRIES:
                return self.reply(429, login_page(self.title, "Too many wrong PINs. Wait 10 minutes."), HTML)
            if not hmac.compare_digest(pin.encode(), self.pin.encode()):
                self.fails.append(now)
                return self.reply(401, login_page(self.title, "Wrong PIN."), HTML)
            self.fails.clear()
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.reply(303, b"", "text/plain", [("Location", "/"), ("Set-Cookie",
                   f"{self.cookie}={self.token()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict{secure}")])

    def run(self, fn):
        """fn() with the endings every request shares: dropped client, bad input (400), anything else (500)."""
        self.started = time.time()
        try:
            fn()
        except (Gone, ConnectionError):  # the client stopped sending, or left mid-reply
            self.close_connection = True
            self.log("dropped")
        except (ValueError, TypeError) as e:
            self.reply(400, {"error": str(e)})
        except Exception as e:  # never echo it: the reply goes to whoever asked; the log gets the type only
            self.log(f"error {type(e).__name__}")
            self.reply(500, {"error": "server error"})

    def do_GET(self):
        self.run(self.get)

    def do_POST(self):
        self.run(lambda: self.login() if urlsplit(self.path).path == "/login" else self.post())

    def get(self):
        self.reply(404, {"error": "not found"})

    def post(self):
        self.reply(404, {"error": "not found"})
