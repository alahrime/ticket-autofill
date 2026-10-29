import os, sys, tempfile, threading
from contextlib import contextmanager
from datetime import date
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from tickets import Line, Ticket, Store, Stale, Invalid, Refused, normalize, edit, move, totals, to_draft, MOVES
from prices import load_catalog

DESK = {"first": " jane ", "last": "doe", "phone": "555 010 0000", "year": "2019", "make": "cadillac",
        "model": " cts   v ", "plate": "xks-4827", "request": "oil change, brakes squeak", "color": "red"}
CAT = load_catalog(os.path.join(ROOT, "parts.csv"))


@contextmanager
def store():
    with tempfile.TemporaryDirectory() as d:
        s = Store(os.path.join(d, "tickets.db"))
        try:
            yield s
        finally:
            s.close()


def raises(exc, f, *a, **kw):
    try:
        f(*a, **kw)
    except exc as e:
        return e
    raise AssertionError(f"{f.__name__} did not raise {exc.__name__}")


def test_normalize_desk_fields():
    out, err = normalize(DESK, create=True)
    assert err == {}
    assert (out["first"], out["last"], out["make"], out["model"], out["plate"]) == \
        ("JANE", "DOE", "CADILLAC", "CTS V", "XKS-4827")
    assert out["phone"] == "(555)010-0000" and out["year"] == "2019"
    assert "color" not in out


def test_normalize_required_and_bad_values():
    _, err = normalize({}, create=True)
    assert set(err) == {"first", "last", "phone", "year", "make", "model"}
    _, err = normalize({"plate": "abc"})
    assert err == {}
    _, err = normalize({"first": "  "})
    assert set(err) == {"first"}
    _, err = normalize({"phone": "555-0100", "year": "19", "odometer": "98k"})
    assert set(err) == {"phone", "year", "odometer"}
    nxt = date.today().year + 1
    assert normalize({"year": str(nxt)})[1] == {} and "year" in normalize({"year": str(nxt + 1)})[1]
    assert "year" in normalize({"year": "1949"})[1] and normalize({"year": 1950})[1] == {}
    assert normalize({"odometer": "98,431"})[0]["odometer"] == "98431"
    assert normalize({"odometer": 0})[0]["odometer"] == "0"


def test_normalize_types_and_lengths():
    _, err = normalize({"first": ["JANE"], "notes": {"a": 1}, "phone": [5550100000], "lines": 5})
    assert err == {"first": "first must be text", "notes": "notes must be text",
                   "phone": "phone must be text", "lines": "lines must be a list"}, err
    assert "odometer" in normalize({"odometer": "12345678"})[1] and normalize({"odometer": "1234567"})[1] == {}
    assert "plate" in normalize({"plate": "X" * 81})[1] and normalize({"plate": "X" * 80})[1] == {}
    assert "request" in normalize({"request": "x" * 2001})[1] and normalize({"notes": "x" * 2000})[1] == {}
    assert "description" in normalize({"lines": [{"desc": "x" * 201}]})[1]["lines"]
    assert normalize({"lines": [{"desc": "x"}] * 101})[1] == {"lines": "at most 100 lines"}
    assert normalize({"lines": [{"desc": "x"}] * 100})[1] == {}


def test_normalize_lines():
    out, err = normalize({"lines": [{"desc": " brake  pads ", "qty": "2", "price": "$45.555", "labor": "80"},
                                    {"desc": "diag", "labor": 60, "id": 7},
                                    Line("wiper", price=12.5)]})
    assert err == {}
    a, b, c = out["lines"]
    assert (a.desc, a.qty, a.price, a.labor, a.id) == ("brake pads", 2, 45.56, 80.0, 8)
    assert (b.price, b.labor, b.id) == (None, 60.0, 7)
    assert c.id == 9 and c.qty == 1
    for bad, msg in (({"desc": "x", "qty": 0}, "qty"), ({"desc": "x", "price": -1}, "price"),
                     ({"desc": "x", "labor": "abc"}, "labor"), ({"desc": " "}, "description"),
                     ({"desc": "x", "qty": -2}, "qty"), ({"desc": "x", "price": "1e30"}, "price"),
                     ({"desc": "x", "price": 1000000.01}, "price"), ({"desc": "x", "qty": "1e30"}, "qty"),
                     ({"desc": "x", "qty": 10001}, "qty"), ({"desc": "x", "labor": "nan"}, "labor"), ("x", "bad")):
        _, err = normalize({"lines": [{"desc": "ok"}, bad]})
        assert err["lines"].startswith("line 2:") and msg in err["lines"], err
    assert normalize({"lines": [{"desc": "x", "qty": 10000, "price": 1e6}]})[1] == {}


def test_line_ids_negative_and_duplicate():
    out, _ = normalize({"lines": [{"desc": "a", "id": -5}, {"desc": "b", "id": 3}, {"desc": "c", "id": 3},
                                  {"desc": "d", "id": "x"}]})
    assert [ln.id for ln in out["lines"]] == [4, 3, 5, 6]


def test_moves_happy_path():
    t = Ticket(status="waiting")
    move(t, "working", mechanic=" Mike ")
    assert t.status == "working" and t.mechanic == "Mike"
    t.lines = [Line("oil", price=30, labor=20)]
    move(t, "review")
    move(t, "working", note="check the brakes too")
    assert t.status == "working" and t.back_note == "check the brakes too"
    move(t, "review")
    assert t.back_note == ""
    move(t, "approved")
    move(t, "filled")
    assert t.status == "filled"


def refused(t, to, **kw):
    before = (t.status, t.mechanic, t.back_note)
    e = raises(Refused, move, t, to, **kw)
    assert str(e) and (t.status, t.mechanic, t.back_note) == before


def test_moves_refused():
    refused(Ticket(status="waiting"), "working")
    refused(Ticket(status="waiting"), "working", mechanic="  ")
    refused(Ticket(status="waiting"), "review", mechanic="Mike")
    refused(Ticket(status="working"), "review")  # no lines
    refused(Ticket(status="working", lines=[Line("x", labor=1)]), "approved")
    refused(Ticket(status="review", lines=[Line("x", labor=1)]), "working", note=" ")
    refused(Ticket(status="approved"), "waiting")
    refused(Ticket(status="filled"), "approved")
    refused(Ticket(status="review"), "review")
    assert len(MOVES) == 5


def test_edit():
    t = Ticket(status="waiting", first="JANE", last="DOE", phone="(555)010-0000", plate="XKS-4827")
    edit(t, {"first": "janet", "notes": "call first", "color": "red"}, "desk")
    assert (t.first, t.last, t.plate, t.notes) == ("JANET", "DOE", "XKS-4827", "call first")
    assert edit(t, {"mechanic": "Mike"}, "desk").mechanic == "Mike"  # the desk may fix any field
    assert raises(Invalid, edit, t, {"phone": "123", "last": ""}, "desk").errors.keys() == {"phone", "last"}
    assert t.phone == "(555)010-0000" and t.last == "DOE"
    raises(Refused, edit, t, {"notes": "x"}, "mechanic")
    t.status = "working"
    raises(Refused, edit, t, {"first": "x"}, "desk")
    edit(t, {"lines": [{"desc": "oil", "price": 30}], "odometer": "98,431", "status": "filled"}, "mechanic")
    assert t.lines == [Line("oil", 1, 30.0, None, "", 1)] and t.odometer == "98431" and t.status == "working"
    assert "first" in str(raises(Refused, edit, t, {"first": "x", "notes": "y"}, "mechanic"))
    assert t.first == "JANET" and t.notes == "call first"
    t.status = "review"
    raises(Refused, edit, t, {"notes": "x"}, "mechanic")
    edit(t, {"lines": []}, "desk")
    assert t.lines == [] and t.odometer == "98431"
    raises(ValueError, edit, t, {}, "customer")


def test_totals():
    t = Ticket(lines=[Line("pads", qty=2, price=45.555, labor=80), Line("diag", labor=60.1),
                      Line("wiper", qty=3, price=0.1)])
    assert totals(t) == {"parts": 91.41, "labor": 140.1, "total": 231.51}
    assert totals(Ticket()) == {"parts": 0, "labor": 0, "total": 0}
    assert totals(Ticket(lines=[Line("x", qty=1.5, price=3.33), Line("y", labor=1.005)]))["total"] == 6.01
    # each line is rounded first: 0.015 -> 0.02 twice, not 0.03 -> 0.03
    assert totals(Ticket(lines=[Line("a", qty=1.5, price=0.01), Line("b", qty=1.5, price=0.01)]))["parts"] == 0.04


def test_store_create_get_list():
    with store() as s:
        a = s.create(DESK)
        assert a.id == 1 and a.status == "waiting" and a.version == 1 and a.first == "JANE" and a.created
        b = s.create(dict(DESK, first="john"))
        assert s.get(1) == a and s.get(99) is None
        assert [t.id for t in s.list()] == [2, 1]
        move(b, "working", mechanic="Mike")
        s.save(b, 1)
        assert [t.id for t in s.list(["working"])] == [2]
        assert [t.id for t in s.list(["waiting", "working"])] == [2, 1]
        assert s.list(["filled"]) == []
        assert "phone" in raises(Invalid, s.create, {"first": "jane"}).errors
        c = s.create(dict(DESK, status="approved", version=9, back_note="x"))
        assert c.status == "waiting" and c.version == 1 and c.back_note == ""
        assert s.get(c.id).status == "waiting" and [t.id for t in s.list(["approved"])] == []


def test_store_round_trips_lines():
    with store() as s:
        t = s.create(DESK)
        edit(t, {"lines": [{"desc": "diag", "labor": 60}, {"desc": "brake pads", "qty": 2, "price": 45,
                                                            "labor": 80, "code": "pads"}]}, "desk")
        s.save(t, 1)
        got = s.get(t.id).lines
        assert got == [Line("diag", 1, None, 60.0, "", 1), Line("brake pads", 2, 45.0, 80.0, "PADS", 2)], got


def test_store_save_versions_and_stale():
    with store() as s:
        t = s.create(DESK)
        t.lines = normalize({"lines": [{"desc": "oil", "price": 30, "labor": 20}]})[0]["lines"]
        saved = s.save(t, 1)
        assert saved.version == 2
        got = s.get(t.id)
        assert got.version == 2 and got.lines == [Line("oil", 1, 30.0, 20.0, "", 1)] and got.created == t.created
        other = s.get(t.id)
        other.notes = "from the phone"
        s.save(other, 2)
        t.notes = "from the ipad"
        e = raises(Stale, s.save, t, 2)
        assert e.ticket.notes == "from the phone" and e.ticket.version == 3
        assert s.get(t.id).notes == "from the phone"
        raises(KeyError, s.save, Ticket(id=42), 1)


def test_store_threads():
    with store() as s:
        t = s.create(DESK)
        wins, errs = [], []

        def worker():
            try:
                s.save(s.get(t.id), 1)
                wins.append(1)
            except Stale:
                pass
            except Exception as e:  # noqa
                errs.append(e)
        ths = [threading.Thread(target=worker) for _ in range(8)]
        for th in ths:
            th.start()
        for th in ths:
            th.join()
        assert errs == [] and len(wins) == 1 and s.get(t.id).version == 2
        for _ in range(20):
            s.create(DESK)
        assert len(s.list()) == 21


def approved_ticket(**kw):
    t = Ticket(id=7, status="approved", first="JANE", last="DOE", phone="(555)010-0000", year="2019",
               make="CADILLAC", model="ATS", plate="XKS-4827", request="brakes squeak", mechanic="Sam",
               odometer="98431", notes="rear tires worn", lines=[
                   Line("front brake pads", 1, 120.0, 90.0, id=4),
                   Line("wiper insert", 2, 15.5, id=9),
                   Line("diag", labor=60.0),
                   Line("check rattle", code="X", id=2),
                   Line("cabin filter", price=30.0, labor=20.0, code="CAB")])
    for k, v in kw.items():
        setattr(t, k, v)
    return t


def test_to_draft_header_and_notes():
    d = to_draft(approved_ticket(), CAT, today=date(2026, 3, 5))
    assert d.id == "7" and d.make == "cadillac"
    h = {k: v.value for k, v in d.header.items()}
    assert h == {"first": "JANE", "last": "DOE", "phone": "(555)010-0000", "year_make": "2019 CADILLAC",
                 "year": "2019", "make": "CADILLAC", "model": "ATS", "plate": "XKS-4827", "odometer": "98431",
                 "tech": "Sam", "date": "03/05/26"}, h
    assert {v.source for v in d.header.values()} == {"desk"}
    assert d.notes == ["Customer: brakes squeak", "rear tires worn", "CHECK RATTLE"]
    d = to_draft(approved_ticket(plate="", odometer="", request="", notes="", status="filled", lines=[]), CAT,
                 today=date(2026, 3, 5))
    assert "plate" not in d.header and "odometer" not in d.header  # missing stays missing
    assert d.notes == [] and d.lines == [] and d.header["date"].value == "03/05/26"


def test_to_draft_lines():
    d = to_draft(approved_ticket(), CAT)
    assert [(ln.id, ln.code, ln.desc, ln.price, ln.qty, ln.kind, ln.covers, ln.cost) for ln in d.lines] == [
        (1, "FBP", "FRONT BRAKE PADS", 120.0, 1, "part", [], None),
        (2, "INSTALL-PART", "Remove & Install: FRONT BRAKE PADS", 90.0, 1, "labor", [1], None),
        (3, "", "WIPER INSERT", 15.5, 2, "part", [], None),  # no match, no labor
        (4, "LABOR", "DIAG", 60.0, 1, "labor", [], None),
        (5, "CAB", "CABIN FILTER", 30.0, 1, "part", [], None),  # ticket code wins
        (6, "INSTALL-PART", "Remove & Install: CABIN FILTER", 20.0, 1, "labor", [5], None)]


def test_to_draft_refuses_unapproved():
    for st in ("waiting", "working", "review"):
        raises(Refused, to_draft, approved_ticket(status=st), CAT)


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
