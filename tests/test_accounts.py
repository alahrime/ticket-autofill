import os, sqlite3, sys, tempfile, threading
from contextlib import contextmanager
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import accounts
from accounts import Accounts, LoginFailed, Locked, hash_secret, check_secret, client_key, make_admin
from tickets import Invalid, Store

PW = "correct horse 1"
PIN, PIN2 = "123456", "567890"
BAD = "Sam\udc80"  # a lone surrogate: can't be encoded as UTF-8


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@contextmanager
def accts(clock=None):
    with tempfile.TemporaryDirectory() as d:
        a = Accounts(os.path.join(d, "tickets.db"), iterations=1000, now=clock or Clock())
        a.path = os.path.join(d, "tickets.db")
        try:
            yield a
        finally:
            a.close()


def raises(exc, f, *a, **kw):
    try:
        f(*a, **kw)
    except exc as e:
        return e
    raise AssertionError(f"{f.__name__} did not raise {exc.__name__}")


def rows(a, sql):
    with a.lock:
        return a.db.execute(sql).fetchall()


def test_hash_round_trip_and_format():
    h = hash_secret(PIN, 1000)
    kind, iters, salt, digest = h.split("$")
    assert kind == "pbkdf2" and iters == "1000" and len(bytes.fromhex(salt)) == 16 and len(digest) == 64
    assert check_secret(PIN, h) and not check_secret(PIN2, h)
    assert hash_secret(PIN, 1000) != h  # fresh salt each time
    assert accounts.ITERATIONS == 200_000 and hash_secret("x").split("$")[1] == "200000"
    corrupt = h[:-2] + "éé"  # non-ASCII in the stored digest
    for bad in ("", "nope", "pbkdf2$x$00$00", "md5$1000$00$00", None, 5, corrupt, h + "$x", h[:-1]):
        assert not check_secret(PIN, bad)
    assert not check_secret(BAD, h) and not check_secret(None, h)


def test_add_validation():
    with accts() as a:
        e = raises(Invalid, a.add, " a ", "boss", "x")
        assert set(e.errors) == {"name", "role"}
        assert set(raises(Invalid, a.add, "x" * 41, "mechanic", PIN).errors) == {"name"}
        assert set(raises(Invalid, a.add, "Bob\x00", "mechanic", PIN).errors) == {"name"}
        assert set(raises(Invalid, a.add, ["Bob"], "mechanic", PIN).errors) == {"name"}
        assert raises(Invalid, a.add, BAD, "mechanic", PIN).errors == {"name": "name has characters that can't be used"}
        for pin in ("1234", "12345", "123456789", "12a456", "１２３４５６",
                    "١٢٣٤٥٦", " 123456", "12345\udc80"):
            assert raises(Invalid, a.add, "Sam", "mechanic", pin).errors == {"secret": "PIN must be 6 to 8 digits"}
        assert raises(Invalid, a.add, "Sam", "mechanic", 123456).errors == {"secret": "must be text"}
        assert set(raises(Invalid, a.add, "Owner", "admin", "short pw").errors) == {"secret"}
        assert set(raises(Invalid, a.add, "Owner", "admin", "x" * 201).errors) == {"secret"}
        assert raises(Invalid, a.add, "Owner", "admin", "long enough\udc80").errors == \
            {"secret": "password has characters that can't be used"}
        u = a.add("  Sam   Lee ", "mechanic", PIN)
        assert u["name"] == "Sam Lee" and u["role"] == "mechanic" and u["active"] and u["id"]
        assert a.add("Ann", "mechanic", "12345678")["name"] == "Ann"
        assert a.add("Owner", "admin", "0123456789")["role"] == "admin"
        assert a.get(u["id"]) == u and a.get(999) is None and a.find(BAD) is None


def test_duplicate_names_any_case():
    with accts() as a:
        a.add("Sam", "mechanic", PIN)
        for n in ("sam", "SAM", " sAm "):
            assert raises(Invalid, a.add, n, "mechanic", PIN2).errors == {"name": f"{n.strip()} is already taken"}
        assert raises(Invalid, a.add, "SAM", "admin", PW).errors["name"].endswith("already taken")
        assert a.find("sAM")["name"] == "Sam"


def test_list_never_returns_hashes_and_filters():
    with accts() as a:
        sam = a.add("Sam", "mechanic", PIN)
        a.add("ann", "mechanic", PIN2)
        a.add("Owner", "admin", PW)
        a.set_active(sam["id"], False)
        all_ = a.list()
        assert [u["name"] for u in all_] == ["ann", "Owner", "Sam"]
        assert [u["name"] for u in a.list("mechanic")] == ["ann", "Sam"]
        assert [u["name"] for u in a.list("mechanic", active=True)] == ["ann"]
        assert [u["name"] for u in a.list(active=False)] == ["Sam"]
        assert [u["name"] for u in a.list("admin", active=False)] == []
        for u in all_ + [a.get(1), a.find("sam")]:
            assert set(u) == {"id", "name", "role", "active", "created"}
            assert "pbkdf2" not in repr(u)
        assert all(r[0].startswith("pbkdf2$1000$") for r in rows(a, "SELECT hash FROM users"))


def test_login_success_and_failure():
    with accts() as a:
        sam = a.add("Sam", "mechanic", PIN)
        token, user = a.login(" sam ", PIN, "mechanic", "1.2.3.4")
        assert user == sam and isinstance(token, str) and len(token) >= 40
        s = a.session(token)
        assert s == {"role": "mechanic", "user_id": sam["id"], "name": "Sam", "expires": a.now() + 30 * 86400}
        assert str(raises(LoginFailed, a.login, "Sam", PIN2, "mechanic", "c")) == "wrong name or PIN"
        assert str(raises(LoginFailed, a.login, "Nobody", PIN, "mechanic", "c")) == "wrong name or PIN"
        raises(LoginFailed, a.login, "Sam", None, "mechanic", "c")
        raises(LoginFailed, a.login, None, PIN, "mechanic", "c")
        raises(LoginFailed, a.login, "Sam", PIN + "x" * 300, "mechanic", "c")
        raises(TypeError, a.login, "Sam", PIN, "mechanic")  # client is required
        a.add("Owner", "admin", PW)
        token, _ = a.login("OWNER", PW, "admin", "c")
        assert a.session(token)["expires"] == a.now() + 7 * 86400
        assert str(raises(LoginFailed, a.login, "Owner", "nope", "admin", "c")) == "wrong name or password"


def test_unknown_name_still_hashes():
    with accts() as a:
        calls = []
        real = accounts.check_secret
        accounts.check_secret = lambda s, h: calls.append(h) or real(s, h)
        try:
            raises(LoginFailed, a.login, "Ghost", PIN, "mechanic", "c")
        finally:
            accounts.check_secret = real
        assert calls == [a.dummy] and a.dummy.startswith("pbkdf2$1000$")


def test_lone_surrogates_at_login():
    with accts() as a:
        a.add("Sam", "mechanic", PIN)
        calls, queries = [], []
        real = accounts.check_secret
        accounts.check_secret = lambda s, h: calls.append(h) or real(s, h)
        a.db.set_trace_callback(queries.append)
        try:
            raises(LoginFailed, a.login, BAD, PIN, "mechanic", "c")  # name: unknown, no query, dummy hash
            assert calls == [a.dummy] and not [q for q in queries if "FROM users" in q]
            raises(LoginFailed, a.login, "Sam", "12345\udc80", "mechanic", "c")  # secret: never matches
        finally:
            accounts.check_secret = real
            a.db.set_trace_callback(None)
        assert a.fails[("name", BAD.casefold())] and len(a.fails[("name", "sam")]) == 1  # both counted
        for _ in range(4):
            raises(LoginFailed, a.login, BAD, PIN, "mechanic", "d")
        raises(Locked, a.login, BAD, PIN, "mechanic", "d")
        assert a.session("x" * 30 + "\udc80") is None
        a.logout("x" * 30 + "\udc80")


def test_wrong_role_and_inactive_refused():
    with accts() as a:
        sam = a.add("Sam", "mechanic", PIN)
        a.add("Owner", "admin", PW)
        raises(LoginFailed, a.login, "Sam", PIN, "admin", "c")
        raises(LoginFailed, a.login, "Owner", PW, "mechanic", "c")
        raises(LoginFailed, a.login, "Sam", PIN, "kiosk", "c")
        a.set_active(sam["id"], False)
        assert a.get(sam["id"])["active"] is False
        raises(LoginFailed, a.login, "Sam", PIN, "mechanic", "c")
        a.set_active(sam["id"], True)
        assert a.login("Sam", PIN, "mechanic", "c")[1]["active"]
        raises(KeyError, a.set_active, 999, False)
        raises(KeyError, a.set_secret, 999, PIN)


def test_last_admin_guard():
    with accts() as a:
        own = a.add("Owner", "admin", PW)
        sam = a.add("Sam", "mechanic", PIN)
        assert raises(Invalid, a.set_active, own["id"], False).errors == {"active": "keep at least one admin"}
        a.set_active(sam["id"], False)  # mechanics can all be off
        boss = a.add("Boss", "admin", PW)
        a.set_active(own["id"], False)
        raises(Invalid, a.set_active, boss["id"], False)
        a.set_active(own["id"], False)  # already off: fine
        a.set_active(boss["id"], True)
        assert [u["name"] for u in a.list("admin", active=True)] == ["Boss"]


def test_lockout_per_name():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        for i in range(5):
            clock.t += 1
            raises(LoginFailed, a.login, "SAM" if i % 2 else "sam", "000000", "mechanic", f"10.0.0.{i}")
        e = raises(Locked, a.login, "Sam", PIN, "mechanic", "10.0.0.99")  # right PIN, still locked
        assert e.retry_after == 600
        raises(LoginFailed, a.login, "Ann", "000000", "mechanic", "10.0.0.99")  # other names unaffected
        clock.t += 599
        assert raises(Locked, a.login, "Sam", PIN, "mechanic", "10.0.0.98").retry_after == 1
        clock.t += 2
        assert a.login("Sam", PIN, "mechanic", "10.0.0.98")[1]["name"] == "Sam"


def test_success_clears_name_failures_and_window_slides():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        for _ in range(4):
            raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")
        a.login("Sam", PIN, "mechanic", "c")
        for _ in range(4):
            raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")  # count restarted: not locked yet
        a.login("Sam", PIN, "mechanic", "c")
        for _ in range(4):
            raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")
        clock.t += 601  # old failures age out of the 10-minute window
        for _ in range(4):
            raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")
        raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")
        raises(Locked, a.login, "Sam", PIN, "mechanic", "c")


def test_day_cap_per_name():
    clock = Clock()
    with accts(clock) as a:
        sam = a.add("Sam", "mechanic", PIN)
        start = clock.t
        for burst in range(4):  # 4 slow bursts of 5: never more than 5 per 10 minutes, 20 in a day
            for i in range(5):
                raises(LoginFailed, a.login, "Sam", "000000", "mechanic", f"10.0.{burst}.{i}")
            if burst < 3:
                clock.t += 601
        e = raises(Locked, a.login, "Sam", PIN, "mechanic", "10.9.9.9")
        assert e.retry_after == 86400
        clock.t += 3600  # the 10-minute lock is long over; the day lock holds
        assert raises(Locked, a.login, "Sam", PIN, "mechanic", "10.9.9.9").retry_after == 86400 - 3600
        clock.t = start + 3 * 601 + 86400 - 1
        raises(Locked, a.login, "Sam", PIN, "mechanic", "10.9.9.9")
        clock.t += 1
        assert a.login("Sam", PIN, "mechanic", "10.9.9.9")
        # a PIN reset by the admin lifts the day lock at once
        for burst in range(4):
            for i in range(5):
                raises(LoginFailed, a.login, "Sam", "000000", "mechanic", f"10.1.{burst}.{i}")
            clock.t += 601
        raises(Locked, a.login, "Sam", PIN, "mechanic", "10.9.9.9")
        a.set_secret(sam["id"], PIN2)
        assert a.login("Sam", PIN2, "mechanic", "10.9.9.9")


def test_unlock():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        for _ in range(5):
            raises(LoginFailed, a.login, "Sam", "000000", "mechanic", "c")
        raises(Locked, a.login, "Sam", PIN, "mechanic", "d")
        a.unlock(" SAM ")
        assert a.login("Sam", PIN, "mechanic", "d")
        a.unlock("nobody")  # unknown name: nothing to do


def test_lockout_per_client():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        for i in range(20):
            clock.t += 1
            raises(LoginFailed, a.login, f"guess{i}", "000000", "mechanic", "6.6.6.6")
        e = raises(Locked, a.login, "Sam", PIN, "mechanic", "6.6.6.6")  # new name, same client
        assert e.retry_after == 600
        clock.t += 300
        assert raises(Locked, a.login, "Sam", PIN, "mechanic", "6.6.6.6").retry_after == 300
        assert a.login("Sam", PIN, "mechanic", "7.7.7.7")[1]["name"] == "Sam"  # other clients fine
        clock.t += 300
        assert a.login("Sam", PIN, "mechanic", "6.6.6.6")


def test_client_keys():
    assert client_key("203.0.113.9") == "203.0.113.9"
    assert client_key("2001:db8:1:2:aaaa::1") == client_key("2001:db8:1:2:ffff::9") == "2001:db8:1:2::/64"
    assert client_key("2001:db8:1:3::1") != client_key("2001:db8:1:2::1")
    assert client_key("::ffff:203.0.113.9") == "203.0.113.9"
    assert client_key("not an ip") == "not an ip" and client_key("") == ""
    clock = Clock()
    with accts(clock) as a:  # one IPv6 /64 hopping addresses is still one client
        for i in range(20):
            raises(LoginFailed, a.login, f"guess{i}", "000000", "mechanic", f"2001:db8:1:2::{i + 1:x}")
        raises(Locked, a.login, "x", "000000", "mechanic", "2001:db8:1:2::ffff")
        raises(LoginFailed, a.login, "x", "000000", "mechanic", "2001:db8:1:3::1")


def test_parallel_guesses_cant_pass_the_limit():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        out, gate = [], threading.Barrier(12)

        def go():
            gate.wait()
            try:
                a.login("Sam", "000000", "mechanic", "c")
            except Exception as e:
                out.append(type(e).__name__)

        ts = [threading.Thread(target=go) for _ in range(12)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        assert out.count("LoginFailed") == 5 and out.count("Locked") == 7, out


def test_hash_semaphore():
    with accts() as a:
        a.add("Sam", "mechanic", PIN)
        a.hash_wait = 0.05
        for _ in range(4):
            assert a.hashing.acquire(timeout=1)  # four logins busy hashing
        try:
            e = raises(Locked, a.login, "Sam", PIN, "mechanic", "c")
            assert e.retry_after == 5 and not a.fails  # turned away before counting
        finally:
            for _ in range(4):
                a.hashing.release()
        assert a.login("Sam", PIN, "mechanic", "c")
        raises(ValueError, a.hashing.release)  # bounded: every acquire was released


def test_reset_racing_login_issues_no_session():
    with accts() as a:
        sam = a.add("Sam", "mechanic", PIN)
        real = accounts.check_secret

        def slow(s, h):  # the admin resets the PIN while this login is checking the old one
            ok = real(s, h)
            accounts.check_secret = real
            a.set_secret(sam["id"], PIN2)
            return ok

        accounts.check_secret = slow
        try:
            raises(LoginFailed, a.login, "Sam", PIN, "mechanic", "c")
        finally:
            accounts.check_secret = real
        assert rows(a, "SELECT COUNT(*) FROM sessions") == [(0,)]

        def off(s, h):  # same, turning the account off
            ok = real(s, h)
            accounts.check_secret = real
            a.set_active(sam["id"], False)
            return ok

        accounts.check_secret = off
        try:
            raises(LoginFailed, a.login, "Sam", PIN2, "mechanic", "c")
        finally:
            accounts.check_secret = real
        assert rows(a, "SELECT COUNT(*) FROM sessions") == [(0,)]


def test_session_expiry_and_logout():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        a.add("Owner", "admin", PW)
        mech, _ = a.login("Sam", PIN, "mechanic", "c")
        adm, _ = a.login("Owner", PW, "admin", "c")
        clock.t += 7 * 86400 - 1
        assert a.session(adm) and a.session(mech)
        clock.t += 1
        assert a.session(adm) is None and a.session(mech)
        assert len(rows(a, "SELECT * FROM sessions")) == 1  # the expired one was deleted
        clock.t += 23 * 86400
        assert a.session(mech) is None
        tok, _ = a.login("Sam", PIN, "mechanic", "c")
        a.logout(tok)
        assert a.session(tok) is None
        for junk in (None, "", "x" * 500, 5, tok + "x"):
            assert a.session(junk) is None
        a.logout(None)


def test_expired_sessions_pruned_on_new_session():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        for _ in range(3):
            a.login("Sam", PIN, "mechanic", "c")
        clock.t += 31 * 86400
        a.login("Sam", PIN, "mechanic", "c")
        assert len(rows(a, "SELECT * FROM sessions")) == 1


def test_revoke_on_reset_and_deactivate():
    with accts() as a:
        sam = a.add("Sam", "mechanic", PIN)
        ann = a.add("Ann", "mechanic", PIN2)
        t1, _ = a.login("Sam", PIN, "mechanic", "c")
        t2, _ = a.login("Sam", PIN, "mechanic", "c")
        ta, _ = a.login("Ann", PIN2, "mechanic", "c")
        raises(Invalid, a.set_secret, sam["id"], "12")  # bad PIN: nothing changes
        assert a.session(t1)
        a.set_secret(sam["id"], "999999")
        assert a.session(t1) is None and a.session(t2) is None and a.session(ta)
        raises(LoginFailed, a.login, "Sam", PIN, "mechanic", "c")
        t3, _ = a.login("Sam", "999999", "mechanic", "c")
        a.set_active(ann["id"], False)
        assert a.session(ta) is None and a.session(t3)
        # a session row left for an inactive user (e.g. turned off by another process) is refused and deleted
        a.set_active(ann["id"], True)
        ta, _ = a.login("Ann", PIN2, "mechanic", "c")
        with a.lock:
            a.db.execute("UPDATE users SET active = 0 WHERE id = ?", (ann["id"],))
        assert a.session(ta) is None
        assert rows(a, f"SELECT COUNT(*) FROM sessions WHERE user_id = {ann['id']}") == [(0,)]


def test_kiosk_sessions():
    clock = Clock()
    with accts(clock) as a:
        a.add("Sam", "mechanic", PIN)
        k1, k2 = a.kiosk_session(), a.kiosk_session()
        m, _ = a.login("Sam", PIN, "mechanic", "c")
        s = a.session(k1)
        assert s == {"role": "kiosk", "user_id": None, "name": "", "expires": clock.t + 365 * 86400}
        a.revoke_kiosks()
        assert a.session(k1) is None and a.session(k2) is None and a.session(m)
        k3 = a.kiosk_session()
        clock.t += 365 * 86400
        assert a.session(k3) is None


def test_tokens_not_stored_in_plain_text():
    with accts() as a:
        a.add("Sam", "mechanic", PIN)
        tok, _ = a.login("Sam", PIN, "mechanic", "c")
        k = a.kiosk_session()
        db = sqlite3.connect(a.path)
        try:
            dump = "\n".join(db.iterdump())
            hashes = [r[0] for r in db.execute("SELECT token_hash FROM sessions")]
        finally:
            db.close()
        assert tok not in dump and k not in dump and PIN not in dump
        assert sorted(hashes) == sorted([accounts.token_hash(tok), accounts.token_hash(k)])
        assert all(len(h) == 64 for h in hashes)


def test_shares_a_ticket_store():
    with tempfile.TemporaryDirectory() as d:
        st = Store(os.path.join(d, "tickets.db"))
        try:
            a = Accounts(st, iterations=1000)
            assert a.db is st.db and a.lock is st.lock
            a.add("Sam", "mechanic", PIN)
            a.close()  # doesn't close the store's connection
            assert st.list() == [] and a.find("sam")
        finally:
            st.close()
        a2 = Accounts(os.path.join(d, "tickets.db"), iterations=1000)  # tables already there
        assert [u["name"] for u in a2.list()] == ["Sam"]
        a2.close()


def test_make_admin():
    with accts() as a:
        raises(Invalid, make_admin, a, "Owner", "short")
        u = make_admin(a, "  Owner ", PW)
        assert u["role"] == "admin" and u["name"] == "Owner"
        tok, _ = a.login("owner", PW, "admin", "c")
        boss = a.add("Boss", "admin", PW)
        a.set_active(u["id"], False)
        u2 = make_admin(a, "OWNER", "another password")
        assert u2["id"] == u["id"] and u2["active"] and a.session(tok) is None
        raises(LoginFailed, a.login, "Owner", PW, "admin", "c")
        tok, _ = a.login("Owner", "another password", "admin", "c")
        make_admin(a, "Owner", "third password")
        assert a.session(tok) is None
        for _ in range(5):
            raises(LoginFailed, a.login, "Owner", "wrong password", "admin", "c")
        raises(Locked, a.login, "Owner", "third password", "admin", "d")
        make_admin(a, "owner", "fourth password")  # also lifts the lock
        assert a.login("Owner", "fourth password", "admin", "d")
        a.add("Sam", "mechanic", PIN)
        assert raises(Invalid, make_admin, a, "sam", PW).errors == {"name": "Sam is a mechanic"}
        assert len(a.list("admin")) == 2 and boss["role"] == "admin"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
