"""Shop accounts in tickets.db: admin and mechanic users, hashed secrets, sessions (admin, mechanic, kiosk) and a
login lockout per name and per client. Stdlib only; shop.py maps Invalid -> 400, LoginFailed -> 401, Locked -> 429."""
from __future__ import annotations
import hashlib, hmac, ipaddress, re, secrets, sqlite3, threading, time
from datetime import datetime
from tickets import Invalid, Store, squash

ITERATIONS = 200_000
LIFETIME = {"admin": 7 * 86400, "mechanic": 30 * 86400, "kiosk": 365 * 86400}
ROLES = ("admin", "mechanic")
WINDOW = LOCKOUT = 600            # failures counted over 10 minutes; a lock lasts 10 minutes
DAY = 86400                       # long cap: 20 failures for a name in 24 h locks it for 24 h (or until a reset)
MAX_NAME_FAILS, MAX_CLIENT_FAILS, MAX_DAY_FAILS = 5, 20, 20
MAX_SECRET = 200                  # longer secrets are refused (and never hashed at login)
MAX_KEYS = 50_000                 # lockout memory cap
HASHERS, HASH_WAIT = 4, 2.0       # at most 4 logins hashing at once; a 5th waits up to 2 s, then gets Locked(5)


class LoginFailed(Exception):
    """Wrong name, secret or role, or the account is off; the message never says which."""


class Locked(Exception):
    """Too many wrong tries for this name or client (or the server is busy); .retry_after is seconds to wait."""
    def __init__(self, retry_after, msg="too many wrong tries; wait and try again", busy=False):
        super().__init__(msg)
        self.retry_after, self.busy = max(int(retry_after + 0.999), 1), busy  # busy: too many logins at once


def utf8(s):
    """True if s is a str that encodes as UTF-8 (no lone surrogates)."""
    try:
        s.encode()
        return True
    except (UnicodeEncodeError, AttributeError):
        return False


def hash_secret(secret, iterations=ITERATIONS, salt=None):
    """-> "pbkdf2$iters$salt_hex$hash_hex" (sha256, 16-byte random salt)."""
    salt = salt or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", secret.encode(), salt, iterations)
    return f"pbkdf2${iterations}${salt.hex()}${h.hex()}"


def check_secret(secret, stored):
    """True if secret matches a hash_secret() string; False for anything malformed (either side)."""
    try:
        kind, iters, salt, want = stored.split("$")
        iters = int(iters)
        if kind != "pbkdf2" or not 0 < iters <= 10_000_000:
            return False
        got = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt), iters)
        return hmac.compare_digest(got, bytes.fromhex(want))
    except (ValueError, TypeError, AttributeError):  # UnicodeEncodeError is a ValueError
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def client_key(client):
    """IPv4 address as is; IPv6 by its /64 (one home or phone gets a whole /64); anything else as text."""
    try:
        ip = ipaddress.ip_address(str(client).strip())
    except ValueError:
        return str(client)
    if ip.version == 6:
        if ip.ipv4_mapped:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def clean_name(name):
    """-> squashed name, or raise Invalid({"name": ...})."""
    if not isinstance(name, str):
        raise Invalid({"name": "name must be text"})
    name = squash(name)
    if not 2 <= len(name) <= 40:
        raise Invalid({"name": "name must be 2 to 40 characters"})
    if not name.isprintable() or not utf8(name):
        raise Invalid({"name": "name has characters that can't be used"})
    return name


def check_new_secret(role, secret):
    """Raise Invalid({"secret": ...}) unless secret suits role: admin password 10+ chars, mechanic PIN 6-8 digits."""
    if not isinstance(secret, str):
        raise Invalid({"secret": "must be text"})
    if role == "admin":
        if not 10 <= len(secret) <= MAX_SECRET:
            raise Invalid({"secret": f"password must be 10 to {MAX_SECRET} characters"})
        if not utf8(secret):
            raise Invalid({"secret": "password has characters that can't be used"})
    elif not re.fullmatch(r"[0-9]{6,8}", secret):
        raise Invalid({"secret": "PIN must be 6 to 8 digits"})


class Accounts:
    """Users and sessions in the tickets.db SQLite file. Pass a path (own connection + lock) or a tickets.Store
    (shares its one connection and lock, so the server has a single writer on the file)."""

    def __init__(self, db, iterations=ITERATIONS, now=time.time):
        if isinstance(db, Store):
            self.db, self.lock, self.own = db.db, db.lock, False
        else:
            self.lock = threading.Lock()
            self.db = sqlite3.connect(db, check_same_thread=False, isolation_level=None)
            self.own = True
        self.iterations, self.now = iterations, now
        self.dummy = hash_secret(secrets.token_hex(16), iterations)  # verified when the name is unknown
        self.fails, self.until, self.fails_lock = {}, {}, threading.Lock()  # lockout: key -> [times] / lock end
        self.pruned = 0
        self.hashing, self.hash_wait = threading.BoundedSemaphore(HASHERS), HASH_WAIT
        with self.lock:
            self.db.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, "
                            "name TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, hash TEXT NOT NULL, "
                            "active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, "
                            "role TEXT NOT NULL, expires REAL NOT NULL, created REAL NOT NULL)")
            self.db.execute("CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)")

    def close(self):
        if self.own:
            with self.lock:
                self.db.close()

    # users

    @staticmethod
    def _user(row):
        return {"id": row[0], "name": row[1], "role": row[2], "active": bool(row[3]), "created": row[4]}

    def get(self, id):
        with self.lock:
            row = self.db.execute("SELECT id, name, role, active, created FROM users WHERE id = ?", (id,)).fetchone()
        return self._user(row) if row else None

    def find(self, name):
        """The user with this name (any case), or None."""
        name = squash(name)
        if not utf8(name):
            return None
        with self.lock:
            row = self.db.execute("SELECT id, name, role, active, created FROM users WHERE name = ?",
                                  (name,)).fetchone()
        return self._user(row) if row else None

    def list(self, role=None, active=None):
        """Users without hashes, by name; role / active None = any."""
        sql, where, args = "SELECT id, name, role, active, created FROM users", [], []
        if role:
            where.append("role = ?")
            args.append(role)
        if active is not None:
            where.append("active = ?")
            args.append(int(bool(active)))
        if where:
            sql += " WHERE " + " AND ".join(where)
        with self.lock:
            rows = self.db.execute(sql + " ORDER BY name COLLATE NOCASE", args).fetchall()
        return [self._user(r) for r in rows]

    def add(self, name, role, secret):
        """New active user -> its dict; raises Invalid ({"name"|"role"|"secret": message})."""
        errors = {}
        try:
            name = clean_name(name)
        except Invalid as e:
            errors.update(e.errors)
        if role not in ROLES:
            errors["role"] = "role must be admin or mechanic"
        else:
            try:
                check_new_secret(role, secret)
            except Invalid as e:
                errors.update(e.errors)
        if errors:
            raise Invalid(errors)
        h = hash_secret(secret, self.iterations)
        created = datetime.fromtimestamp(self.now()).isoformat(timespec="seconds")
        with self.lock:  # NOCASE only folds ASCII: Strauss and Strauß are one name too
            if any(n.casefold() == name.casefold() for (n,) in self.db.execute("SELECT name FROM users")):
                raise Invalid({"name": f"{name} is already taken"})
            try:
                id = self.db.execute("INSERT INTO users (name, role, hash, active, created) VALUES (?, ?, ?, 1, ?)",
                                     (name, role, h, created)).lastrowid
            except sqlite3.IntegrityError:
                raise Invalid({"name": f"{name} is already taken"}) from None
        return {"id": id, "name": name, "role": role, "active": True, "created": created}

    def set_secret(self, user_id, secret):
        """New PIN/password for a user (KeyError if unknown; Invalid if unsuitable); signs them out everywhere
        and clears their name's lockout."""
        user = self.get(user_id)
        if not user:
            raise KeyError(user_id)
        check_new_secret(user["role"], secret)
        h = hash_secret(secret, self.iterations)
        with self.lock:  # one hold: no session can be issued between the new hash and the sign-out
            self.db.execute("UPDATE users SET hash = ? WHERE id = ?", (h, user_id))
            self.db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        self.unlock(user["name"])

    def set_active(self, user_id, active):
        """Turn an account on or off (KeyError if unknown); turning it off signs them out everywhere.
        Raises Invalid({"active": ...}) for turning off the last active admin."""
        with self.lock:
            row = self.db.execute("SELECT role, active FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise KeyError(user_id)
            if not active and row == ("admin", 1) and self.db.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").fetchone()[0] <= 1:
                raise Invalid({"active": "keep at least one admin"})
            self.db.execute("UPDATE users SET active = ? WHERE id = ?", (int(bool(active)), user_id))
            if not active:
                self.db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    # lockout (in memory; callers hold fails_lock)

    def _locked(self, t, key):
        """Seconds this key stays locked (0 = open)."""
        times = self.fails.get(key, [])
        waits = [self.until.get(key, 0) - t]
        if key[0] == "name":
            recent = [x for x in times if t - x < WINDOW]
            if len(recent) >= MAX_NAME_FAILS:
                waits.append(recent[-MAX_NAME_FAILS] + WINDOW - t)
            if len(times) >= MAX_DAY_FAILS:
                waits.append(times[-MAX_DAY_FAILS] + DAY - t)
        elif len(times) >= MAX_CLIENT_FAILS:
            waits.append(times[-MAX_CLIENT_FAILS] + WINDOW - t)
        return max(max(waits), 0)

    def _prune(self, t):
        if t - self.pruned < 60 and len(self.fails) < MAX_KEYS:  # once a minute is plenty
            return
        self.pruned = t
        for key in list(self.fails):
            keep = DAY if key[0] == "name" else WINDOW
            self.fails[key] = [x for x in self.fails[key] if t - x < keep]
            if not self.fails[key]:
                del self.fails[key]
        for key in [k for k, u in self.until.items() if u <= t]:
            del self.until[key]
        if len(self.fails) >= MAX_KEYS:  # flood of made-up names: forget the oldest name keys (locks stay)
            for key in sorted((k for k in self.fails if k[0] == "name"), key=lambda k: self.fails[k][-1])[:MAX_KEYS // 2]:
                del self.fails[key]

    def _fail(self, t, keys):
        with self.fails_lock:
            for k in keys:
                times = self.fails.get(k, [])
                if k[0] == "name":
                    if sum(t - x < WINDOW for x in times) >= MAX_NAME_FAILS:
                        self.until[k] = max(self.until.get(k, 0), t + LOCKOUT)
                    if len(times) >= MAX_DAY_FAILS:
                        self.until[k] = max(self.until.get(k, 0), t + DAY)
                elif len(times) >= MAX_CLIENT_FAILS:
                    self.until[k] = max(self.until.get(k, 0), t + LOCKOUT)

    def unlock(self, name):
        """Forget a name's wrong tries and locks (an admin reset, or make_admin)."""
        key = ("name", squash(name).casefold())
        with self.fails_lock:
            self.fails.pop(key, None)
            self.until.pop(key, None)

    # sessions

    def _session(self, user_id, role, verified=None):
        """New session token. For a user, only while their hash is still `verified` and they are active
        (a reset or turn-off racing the login wins); None if not."""
        token, t = secrets.token_urlsafe(32), self.now()
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE expires <= ?", (t,))  # prune on every new session
            if user_id is None:
                self.db.execute("INSERT INTO sessions (token_hash, user_id, role, expires, created) "
                                "VALUES (?, NULL, ?, ?, ?)", (token_hash(token), role, t + LIFETIME[role], t))
            elif not self.db.execute(
                    "INSERT INTO sessions (token_hash, user_id, role, expires, created) SELECT ?, id, ?, ?, ? "
                    "FROM users WHERE id = ? AND hash = ? AND active = 1 AND role = ?",
                    (token_hash(token), role, t + LIFETIME[role], t, user_id, verified, role)).rowcount:
                return None
        return token

    def login(self, name, secret, role, client):
        """-> (token, user dict). Raises Locked (too many wrong tries, even with the right secret, or too many
        logins hashing at once) or LoginFailed. client is the caller's IP. Every attempt counts as a failure
        for name and client until it succeeds, so parallel guesses can't slip past the limits."""
        name = squash(name if isinstance(name, str) else "")[:80]
        keys = (("name", name.casefold()), ("client", client_key(client)))
        if not self.hashing.acquire(timeout=self.hash_wait):
            raise Locked(5, "busy; try again in a few seconds", busy=True)
        try:
            t = self.now()
            with self.fails_lock:
                self._prune(t)
                wait = max(self._locked(t, k) for k in keys)
                if wait > 0:
                    raise Locked(wait)
                for k in keys:
                    self.fails.setdefault(k, []).append(t)
            row = None
            if utf8(name):  # a lone surrogate can't be a stored name: treat as unknown, no query
                with self.lock:
                    row = self.db.execute("SELECT id, name, role, active, created, hash FROM users WHERE name = ?",
                                          (name,)).fetchone()
            ok = isinstance(secret, str) and len(secret) <= MAX_SECRET and utf8(secret)
            ok = check_secret(secret if ok else "", row[5] if row else self.dummy) and ok  # hash even if unknown
        finally:
            self.hashing.release()
        token = None
        if ok and row and row[3] and row[2] == role:
            token = self._session(row[0], role, row[5])
        if token is None:
            self._fail(t, keys)
            raise LoginFailed("wrong name or " + ("password" if role == "admin" else "PIN"))
        with self.fails_lock:
            self.fails.pop(keys[0], None)
            self.until.pop(keys[0], None)
            ct = self.fails.get(keys[1])
            if ct and t in ct:
                ct.remove(t)  # this attempt was right: not a client failure
        return token, self._user(row)

    def kiosk_session(self):
        """A check-in device session with no user (1 year)."""
        return self._session(None, "kiosk")

    def session(self, token):
        """{role, user_id, name, expires} for a live session, else None (expired or account off: deleted)."""
        if not isinstance(token, str) or not 20 <= len(token) <= 200 or not utf8(token):
            return None
        th = token_hash(token)
        with self.lock:
            row = self.db.execute("SELECT s.role, s.user_id, s.expires, u.name, u.active, u.role FROM sessions s "
                                  "LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (th,)).fetchone()
            if not row:
                return None
            role, user_id, expires, name, active, urole = row
            good = expires > self.now() and (
                role == "kiosk" and user_id is None or user_id is not None and active and urole == role)
            if not good:
                self.db.execute("DELETE FROM sessions WHERE token_hash = ?", (th,))
                return None
        return {"role": role, "user_id": user_id, "name": name or "", "expires": expires}

    def logout(self, token):
        if isinstance(token, str) and utf8(token):
            with self.lock:
                self.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))

    def revoke_user(self, user_id):
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def revoke_kiosks(self):
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE role = 'kiosk'")


def make_admin(accounts, name, password):
    """Create the admin, or reset their password, turn them on, sign them out everywhere and clear their lockout
    in this process (run from the command line, a running server keeps its own lockout until restarted).
    -> user dict. Raises Invalid (bad name/password, or the name belongs to a mechanic)."""
    user = accounts.find(clean_name(name))
    if not user:
        user = accounts.add(name, "admin", password)
    elif user["role"] != "admin":
        raise Invalid({"name": f"{user['name']} is a mechanic"})
    else:
        accounts.set_secret(user["id"], password)  # validates, revokes sessions, unlocks
        accounts.set_active(user["id"], True)
    accounts.unlock(user["name"])
    return accounts.get(user["id"])
