import os, sys, tempfile
from datetime import date, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from tickets import Line, Ticket, Store, Stale, move, totals, to_draft
from prices import load_catalog
import shopwin
from shopwin import entry_sheet, list_row, total_rows, age, header_rows, invomax_plate, plain, usd, shown, TOTALS_HEAD

CAT = load_catalog(os.path.join(ROOT, "parts.csv"))
DESK = {"first": "jane", "last": "doe", "phone": "5550100000", "year": "2019", "make": "cadillac",
        "model": "cts v", "plate": "xks4827", "request": "brakes squeak"}


def ticket(**kw):
    t = Ticket(id=7, status="approved", first="JANE", last="DOE", phone="(555)010-0000", year="2019", make="CADILLAC",
               model="CTS V", plate="XKS4827", mechanic="Sam", odometer="98431", request="brakes squeak",
               notes="rotors thin", created="2026-11-02T08:00:00",
               lines=[Line("front brake pads", 1, 45.0, 20.0, "BRK"), Line("diag", 1, None, 60.0),
                      Line("wiper blade zz", 2, 1234.5)])
    for k, v in kw.items():
        setattr(t, k, v)
    return t


def test_list_row_and_age():
    now = datetime(2026, 11, 2, 9, 30)
    total = usd(totals(ticket())["total"])
    assert list_row(ticket(), now) == (7, "JANE DOE", "2019 CADILLAC CTS V", total, "1h")
    assert age("2026-11-02T09:25:00", now) == "5m" and age("2026-10-30T09:30:00", now) == "3d"
    assert age("", now) == "" and age("2026-11-02T10:00:00", now) == "0m"
    assert list_row(ticket(status="filled"), now)[4] == "filled"


def test_money_and_plate():
    assert usd(1234.5) == "$1,234.50" and usd(-5) == "-$5.00" and usd(0) == "$0.00"
    assert plain(1234.5) == "1234.50" and plain(None) == "0.00"
    assert invomax_plate("XKS4827") == "XKS-4827" and invomax_plate("xks 482") == "XKS-482"
    assert invomax_plate("XKS-4827") == "XKS-4827" and invomax_plate("AB12") == "AB12"
    assert invomax_plate("ABCD12345") == "ABCD12345" and invomax_plate("") == ""


def test_total_rows_generic():
    assert total_rows({"parts": 45.0, "labor": 80.0, "total": 125.0, "deposits": 50.0}) == \
        [("Parts", "$45.00"), ("Labor", "$80.00"), ("Total", "$125.00"), ("Deposits", "$50.00")]
    assert total_rows({"tax_rate": 0.06, "balance_due": -5, "deposit_count": "2"}) == \
        [("Tax rate", "6%"), ("Balance due", "-$5.00"), ("Deposit count", "2")]


def test_entry_sheet():
    t = ticket()
    d = to_draft(t, CAT, today=date(2026, 11, 2))
    assert [v for _, v in header_rows(d)] == ["JANE", "DOE", "(555)010-0000", "2019 CADILLAC", "CTS V", "XKS-4827",
                                              "98431", "Sam", "11/02/26"]
    d.notes = ["Customer: brakes squeak", "rotors thin"]  # fixed here: to_draft may add deposit notes
    s = entry_sheet(t, d, {"parts": 45.0, "labor": 80.0, "total": 125.0})
    assert s == ("Ticket #7 (approved)\nFirst name: JANE\nLast name: DOE\nPhone: (555)010-0000\nYear/Make: 2019 CADILLAC\n"
                 "Model: CTS V\nPlate: XKS-4827\nOdometer: 98431\nMechanic: Sam\nDate: 11/02/26\n\nLines:\n"
                 "BRK  FRONT BRAKE PADS  qty 1  $45.00 each  part\n"
                 "    INSTALL-PART  Remove & Install: FRONT BRAKE PADS  qty 1  $20.00 each  labor\n"
                 "    LABOR  DIAG  qty 1  $60.00 each  labor\n"
                 "(no code)  WIPER BLADE ZZ  qty 2  $1,234.50 each  part\n\nNotes:\nCustomer: brakes squeak\nrotors thin\n\n"
                 f"{TOTALS_HEAD}\nParts: $45.00\nLabor: $80.00\nTotal: $125.00\n"), s


def test_app_fields_and_rows():  # what "Load into Ticket Autofill" puts in the main window
    d = to_draft(ticket(), CAT, today=date(2026, 11, 2))
    keys = ("first", "last", "phone", "year_make", "plate", "vin", "odometer", "tech")
    assert shopwin.app_fields(d, keys) == {"first": "JANE", "last": "DOE", "phone": "(555)010-0000",
                                           "year_make": "2019 CADILLAC", "plate": "XKS-4827", "vin": "",
                                           "odometer": "98431", "tech": "Sam"}
    assert [shopwin.app_row(ln) for ln in d.lines] == [
        ("BRK", "FRONT BRAKE PADS", "1", "", "45.00"),
        ("INSTALL-PART", "    Remove & Install: FRONT BRAKE PADS", "1", "", "20.00"),
        ("LABOR", "    DIAG", "1", "", "60.00"),
        ("", "WIPER BLADE ZZ", "2", "", "1234.50")]
    assert shopwin.app_fields(to_draft(ticket(plate="", mechanic=""), CAT), ("plate", "tech")) == {"plate": "", "tech": ""}


def test_app_load_ticket_tk():  # App.load_ticket and its "changes here" checks; skipped without a display
    import tkinter as tk
    import app
    try:
        a = app.App()
    except tk.TclError:
        return print("skip test_app_load_ticket_tk: no display")
    asked, yes = [], app.messagebox.askyesno
    app.messagebox.askyesno = lambda *x, **k: asked.append(x[1]) or True
    try:
        a.withdraw()
        t = ticket()
        assert a.load_ticket(t, to_draft(t, CAT)) and not asked and not a.unsaved()
        assert a.vars["plate"].get() == "XKS-4827" and len(a.tree.get_children()) == 4 and a.markup_sp.instate(["disabled"])
        assert a.load_ticket(t, to_draft(t, CAT)) and not asked  # no changes: reload is silent
        a.vars["vin"].set("1G6")
        assert a.unsaved()
        assert a.load_ticket(t, to_draft(t, CAT)) and asked == ["Reload ticket #7 and lose your changes here?"]
        assert a.vars["vin"].get() == "" and not a.unsaved()
        a.filled = True
        a.load_ticket(t, to_draft(t, CAT))
        assert asked[-1] == "Ticket #7 was already filled here. Reload it?"
        a.ticket_changed(ticket(version=2))
        assert a.title() == "Ticket Autofill — shop ticket #7 (newer version in Shop tickets — Load again)"
    finally:
        app.messagebox.askyesno = yes
        a.destroy()


def test_shown_and_mark_filled():
    with tempfile.TemporaryDirectory() as tmp:
        s = Store(os.path.join(tmp, "tickets.db"))
        try:
            t = s.create(DESK)
            s.save(move(t, "working", "Sam"), t.version)
            t.lines = [Line("diag", 1, None, 60.0)]
            s.save(move(t, "review"), t.version)
            s.save(move(t, "approved"), t.version)
            assert [x.id for x in shown(s)] == [t.id]
            old = s.get(t.id)
            s.save(move(s.get(t.id), "filled"), old.version)
            assert shown(s) == [] and [x.id for x in shown(s, True)] == [t.id]
            assert [x.id for x in shown(s, True, date(2000, 1, 1))] == []
            cap, shopwin.FILLED_CAP = shopwin.FILLED_CAP, 0  # only the newest FILLED_CAP filled rows are read
            try:
                assert shown(s, True) == []
            finally:
                shopwin.FILLED_CAP = cap
            try:  # a second Mark filled on the old copy is stale
                s.save(move(old, "filled"), old.version)
                raise AssertionError("no Stale")
            except Stale:
                pass
        finally:
            s.close()


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
