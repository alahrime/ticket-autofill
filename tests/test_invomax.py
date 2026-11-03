import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import invomax
from invomax import Driver, NotMapped, NotReadable, Refused, Loc
from draft import Line

INV = (-8, -8, 1928, 1048)  # a maximized 1936 x 1056 window as Windows reports it
CUST = (648, 276, 1288, 780)
VEH = (724, 278, 1212, 778)


class FakeWin:
    """Plain-data stand-in for invomax.Win32: windows, controls, texts, focus, clipboard. Records input."""

    def __init__(self):
        self.inv = 1
        self.tops = [1]                       # Z-order, top first
        self.classes = {1: "TINVOICESCREEN"}
        self.texts = {1: ""}
        self.rects = {1: INV}
        self.kids = {1: []}                   # top -> [(key, hwnd, class)]
        self.parents = {}
        self.zoom = True
        self.focus_h = None
        self.fg = 1
        self.checks = {}
        self.items = {}
        self.input = []
        self.next = 100
        self.focus_follows_click = True
        self.esc = False
        self.corner = False
        self.idle = 10_000
        self.bar = []
        # clipboard
        self.clip, self.formats, self.seq = "staff text", [13, 16, 1, 7], 1
        self.box_values = {}                  # hwnd -> what Ctrl+C copies from that box
        self.clip_set_fails = 0
        self.on_type = None

    def add(self, top, cls, rel, text=""):
        """Add a control at a window-relative (x, y, w, h); -> hwnd."""
        h = self.next
        self.next += 1
        n = sum(1 for _, _, c in self.kids[top] if c == cls)
        self.kids[top].append((f"{cls}#{n}", h, cls))
        t = self.rects[top]
        self.rects[h] = (t[0] + rel[0], t[1] + rel[1], t[0] + rel[0] + rel[2], t[1] + rel[1] + rel[3])
        self.classes[h], self.texts[h], self.parents[h] = cls, text, top
        return h

    def open(self, title, cls, rect):
        h = self.next
        self.next += 1
        self.tops.insert(0, h)
        self.classes[h], self.texts[h], self.rects[h], self.kids[h] = cls, title, rect, []
        self.fg = h
        return h

    def invoice(self): return self.inv
    def pid(self, h): return 99
    def windows(self, pid): return list(self.tops)
    def cls(self, h): return self.classes.get(h, "")
    def text(self, h): return self.texts.get(h, "")
    def rect(self, h): return self.rects[h]
    def zoomed(self, h): return self.zoom
    def controls(self, top): return list(self.kids[top])
    def focus(self, pid): return self.focus_h
    def parent(self, h): return None
    def is_child(self, parent, h): return self.parents.get(h) == parent
    def foreground(self): return self.fg
    def checked(self, h): return self.checks.get(h, False)
    def combo_items(self, h): return self.items.get(h, [])
    def menu_items(self, h): return list(self.texts.get(("menu", h), []))
    def menu_item_rect(self, h, i): t = self.rects[h]; return (t[0], t[1] + 20 * i, t[2], t[1] + 20 * i + 20)
    def menu_bar(self, h): return list(self.bar)
    def esc_down(self): return self.esc
    def in_stop_corner(self): return self.corner
    def idle_ms(self): return self.idle

    def at_point(self, x, y):
        for top in self.tops:
            l, t, r, b = self.rects[top]
            if l <= x < r and t <= y < b:
                child = next((h for _, h, _ in reversed(self.kids[top])
                              if self.rects[h][0] <= x < self.rects[h][2] and self.rects[h][1] <= y < self.rects[h][3]),
                             top)
                return child, top
        return None, None

    def click(self, x, y, double=False):
        self.input.append(("click", x, y, double))
        child, _ = self.at_point(x, y)
        if self.focus_follows_click and child in self.parents:
            self.focus_h = child

    def type(self, keys):
        self.input.append(("type", keys))
        if keys == "^a^c" and self.focus_h in self.box_values:
            self.clip, self.formats, self.seq = self.box_values[self.focus_h], [13], self.seq + 1
        if self.on_type:
            self.on_type(keys)

    def set_edit(self, h, v): self.input.append(("set", h, v))
    def select_combo(self, h, i): self.input.append(("select", h, i))
    def clip_formats(self): return list(self.formats)
    def clip_seq(self): return self.seq
    def clip_get(self): return self.clip if 13 in self.formats else None

    def clip_set(self, s):
        if self.clip_set_fails:
            self.clip_set_fails -= 1
            raise RuntimeError("the clipboard is busy")
        self.clip, self.formats, self.seq = s, ([13] if s is not None else []), self.seq + 1


class Clock:
    def __init__(self): self.t = 100.0
    def now(self): return self.t
    def sleep(self, s): self.t += s


def invoice():
    """A fake invoice with the header boxes at their mapped places. -> (FakeWin, {'Class#n': hwnd})."""
    w = FakeWin()
    hs = {}
    rects = {(l.cls, l.index): l.rect for l in invomax.CONTROLS.values() if l and l.window is None and l.cls}
    for cls, n in (("TLMDEdit", 15), ("TEdit", 3)):
        for i in range(n):
            hs[f"{cls}#{i}"] = w.add(1, cls, rects.get((cls, i), (0, 500 + i, 5, 5)))
    hs["TPanel#3"] = w.add(1, "TPanel", (10, 322, 1916, 52))
    return w, hs


def drv(w, live=False, **k):
    c = Clock()
    out = []
    d = Driver(w, dry_run=not live, log=out.append, now=c.now, sleep=c.sleep, **k)
    d.out = out
    return d


def raises(exc, fn, *a, **k):
    try:
        fn(*a, **k)
    except exc as e:
        return str(e)
    raise AssertionError(f"expected {exc.__name__}")


def customers(w):
    cust = w.open("Customers", "Tshow_customer", CUST)
    for cap, rel in (("Business Name", (372, 74, 128, 17)), ("By Code", (244, 74, 80, 17)),
                     ("License", (371, 55, 73, 17)), ("Phone", (371, 34, 65, 17)),
                     ("Last Name", (243, 55, 89, 17)), ("First Name", (243, 34, 89, 17))):
        w.add(cust, "TRadioButton", rel, cap)
    search = w.add(cust, "TLMDEdit", (19, 39, 209, 27))
    return cust, search


def vehicles(w):
    veh = w.open("Vehicles", "Tvehicle_popup", VEH)
    model = w.add(veh, "TRzComboBox", (17, 107, 458, 24))
    w.add(veh, "TRzComboBox", (16, 78, 162, 24))
    year = w.add(veh, "TRzComboBox", (16, 49, 73, 24), "Year")
    w.add(veh, "TLMDButton", (151, 461, 149, 27), "Custom Vehicle")
    w.add(veh, "TLMDButton", (17, 461, 59, 27), "Select")
    cancel = w.add(veh, "TLMDButton", (79, 461, 68, 27), "Cancel")
    return veh, year, model, cancel


# --- the old helpers still work
def test_row_keys_escapes_specials():
    keys = invomax.row_keys(Line("ACR", "A/C RECHARGE (R) 50%", 60.0))
    assert keys == "ACR{TAB}A/C RECHARGE {(}R{)} 50{%}{TAB}1{TAB}60.00{ENTER}"


def test_blank_fields_untouched():
    old = invomax.FIELD_MAP
    invomax.FIELD_MAP = {"plate": [{"auto_id": "p"}], "first": [{"auto_id": "f"}],
                      "odometer": [{"auto_id": "o1"}, {"auto_id": "o2"}]}
    try:
        writes = invomax.field_writes({"plate": "XKS4827", "first": "", "odometer": "98431"})
    finally:
        invomax.FIELD_MAP = old
    assert writes == [("plate", {"auto_id": "p"}, "XKS4827"), ("odometer", {"auto_id": "o1"}, "98431"),
                      ("odometer", {"auto_id": "o2"}, "98431")]


def test_old_fill_still_says_not_set_up():
    assert "isn't set up yet" in raises(RuntimeError, invomax.fill, {}, [])


# --- pure parts
def test_every_recipe_control_has_an_entry():
    import recipes

    def checks(c):
        return [c] + [x for p in c.parts for x in checks(p)] if c else []
    kinds = ("text", "filled", "empty", "focus", "not_focus", "checked")
    names = set()
    for r in recipes.RECIPES.values():
        names |= {c.a for c in sum((checks(c) for c in r.require), []) if c.kind in kinds}
        for s in r.steps:
            if s.kind in ("click", "double_click", "set", "pick", "select_row"):
                names.add(s.target)
            names |= {c.a for c in checks(s.expect) if c.kind in kinds}
    names = {n.replace("{by}", b) for n in names for b in ("license", "phone", "last_name", "first_name")}
    missing = {n for n in names if n not in invomax.CONTROLS}
    assert not missing, missing


def test_press_and_menu_allow_lists_match_the_recipes():
    import recipes
    assert {c for _, c in invomax.PRESS_OK} | invomax.MENU_OK == recipes.ALLOWED
    assert not any(invomax.is_never(c) for c in recipes.ALLOWED)


def test_locate_and_not_mapped():
    assert invomax.locate("plate") == Loc(None, "TLMDEdit", 6, (1468, 247, 110, 28))
    for name in ("customers.exit", "phone.text", "vehicles.engine", "nonsense"):
        assert raises(NotMapped, invomax.locate, name) == f"not mapped yet: {name}"


def test_find_control_by_index_caption_and_rect():
    w = FakeWin()
    _, _ = customers(w)
    cust = w.tops[0]
    w.texts[w.kids[cust][2][1]] = "&License"
    loc = invomax.CONTROLS["customers.by_license"]
    assert invomax.find_control(loc, w.controls(cust), w.text, w.rect, w.rect(cust)) == w.kids[cust][2][1]
    w2, hs = invoice()
    assert invomax.find_control(invomax.CONTROLS["plate"], w2.controls(1), w2.text, w2.rect, INV) == hs["TLMDEdit#6"]
    w2.rects[hs["TLMDEdit#6"]] = (0, 0, 10, 10)  # the layout changed: refuse rather than guess
    assert "layout changed" in raises(RuntimeError, invomax.find_control, invomax.CONTROLS["plate"],
                                      w2.controls(1), w2.text, w2.rect, INV)


def test_position_math():
    assert invomax.rel_rect((100, 50, 150, 70), (-8, -8, 1928, 1048)) == (108, 58, 50, 20)
    assert invomax.centre((100, 50, 150, 70)) == (125, 60)
    loc = invomax.CONTROLS["customers.add_new"]
    assert invomax.spot_point(loc, CUST) == (785, 751)
    assert "measured at 640 x 504" in raises(Refused, invomax.spot_point, loc, (0, 0, 700, 504))


def test_refused_areas_and_button_row():
    assert "Clear" in invomax.refused_reason("btn.clear", (125, 352))
    assert "Done" in invomax.refused_reason("anything", (1280, 335))
    assert "Done" in invomax.refused_reason("x", (1350, 370))
    assert "button row" in invomax.refused_reason("btn.labor", (470, 352))  # not approved until a recipe needs it
    assert "button row" in invomax.refused_reason("plate", (600, 340))
    assert invomax.refused_reason("plate", (1523, 261)) is None
    assert invomax.refused_reason("x", (89, 352)) and invomax.refused_reason("x", (161, 300)) is None
    assert "Custom Vehicle" in invomax.dialog_refused_reason("x", "Vehicles", (200, 470))
    assert invomax.dialog_refused_reason("x", "Vehicles", (100, 470)) is None


def test_never_captions():
    for c in ("Done", "&Clear", "PRINT", "&Print...", "Done!", "Void-This", "Dial Number", "Void This Transaction",
              "Erase This Transaction", "Fast Quote", "Delete", "Custom Vehicle", "Print Invoice", "Clear all",
              "Change", "Change...", "Continue", "Make Changes To This Transaction", "Quote", "(Charge)",
              "Change The Transaction Date", "Change Number Later"):
        assert invomax.is_never(c), c
    for c in ("Add New", "Save", "Exit", "Select Engine Later", "Change Number", "&Change Number", "OK", "Cancel",
              "Customers", "", "2021 Chevrolet EQUINOX"):
        assert not invomax.is_never(c), c


def test_confirm_box_only_no_is_pressed():
    # Cancel in Vehicles asks to correct the past history (trial 2026-11-03); the owner: always No
    w, _ = invoice()
    box = w.open("Confirm", "TMessageForm", (800, 400, 1026, 536))
    w.add(box, "TButton", (116, 92, 75, 26), "&No")
    w.add(box, "TButton", (35, 92, 75, 26), "&Yes")
    raises(Refused, drv(w, live=True).press, "Yes")
    assert "right after Cancel" in raises(Refused, drv(w, live=True).press, "No")  # no Cancel first
    assert w.input == []
    d = drv(w, live=True)
    d._last_press = ("Vehicles", "cancel")  # as press("Cancel") in Vehicles leaves it
    d.press("No")
    assert w.input == [("click", 800 + 116 + 37, 400 + 92 + 13, False)]


def test_no_after_cancel_then_confirm_end_to_end():
    w, _ = invoice()
    veh, year, model, cancel = vehicles(w)
    d = drv(w, live=True)
    d.press("Cancel")
    box = w.open("Confirm", "TMessageForm", (800, 400, 1026, 536))
    w.add(box, "TButton", (116, 92, 75, 26), "&No")
    w.add(box, "TButton", (35, 92, 75, 26), "&Yes")
    d.press("No")
    assert w.input[-1] == ("click", 800 + 116 + 37, 400 + 92 + 13, False)


def test_confirm_no_refused_in_other_boxes():
    for buttons, cls in ((("&Yes", "&No", "Cancel"), "TMessageForm"), (("&Yes", "&No"), "TForm")):
        w, _ = invoice()
        box = w.open("Confirm", cls, (800, 400, 1026, 536))
        for i, c in enumerate(buttons):
            w.add(box, "TButton", (35 + 80 * i, 92, 75, 26), c)
        d = drv(w, live=True)
        d._last_press = ("Vehicles", "cancel")
        raises(Refused, d.press, "No")
        assert w.input == []
    w, _ = invoice()  # any other action between Cancel and No clears it
    box = w.open("Confirm", "TMessageForm", (800, 400, 1026, 536))
    w.add(box, "TButton", (116, 92, 75, 26), "&No")
    w.add(box, "TButton", (35, 92, 75, 26), "&Yes")
    d = drv(w)
    d._last_press = ("Vehicles", "cancel")
    raises(Exception, d.click, "plate")  # refused under a dialog, but it still counts as the last action
    d.stopped = ""
    assert "right after Cancel" in raises(Refused, d.press, "No")


def test_window_must_be_maximized_at_1936_by_1056():
    assert invomax.window_ok(INV, True) is None
    assert "isn't maximized" in invomax.window_ok(INV, False)
    assert "1920 x 1040" in invomax.window_ok((0, 0, 1920, 1040), True)


def test_chunks_and_control_chars():
    assert invomax.chunks("XKS-4827") == list("XKS-4827") and invomax.chunks("ABCDEFGHI")[-1] == "I"  # one key per check
    assert invomax.has_control_chars("A\tB") and invomax.has_control_chars("A\nB") and invomax.has_control_chars("\x1b")
    assert not invomax.has_control_chars("JANE DOE (555)010-0000")


def test_no_double_click_names():
    import recipes
    assert all(recipes.no_double_click(n) for n in ("plate", "vin", "vehicles.vin"))
    assert not recipes.no_double_click("name.first")


# --- reads
def test_reads_dialog_text_focus_and_copyback_gate():
    w, hs = invoice()
    w.texts[hs["TEdit#2"]] = "JANE"
    w.focus_h = hs["TLMDEdit#6"]
    d = drv(w)
    assert d.dialog() is None and d.text("name.first") == "JANE" and d.focused() == "plate"
    assert "copy-back" in raises(NotReadable, d.text, "plate")
    w.open("", "TLMDShapeHintWindow", (5, 5, 50, 20))  # hints are not dialogs
    assert d.dialog() is None
    customers(w)
    assert d.dialog() == "Customers"
    assert d.text("name.first") == "JANE"  # reads find the invoice under the dialog
    assert d.focused() == "plate"
    w.open("", "Tchoicebox", (700, 400, 900, 600))
    assert d.dialog() == "(Tchoicebox)"
    assert d.checked("customers.by_license") is False  # Customers is open, just not on top
    assert "isn't open" in raises(RuntimeError, d.text, "custinfo.first")
    assert w.input == [] and not d.stopped


def test_focused_lists_each_window_once():
    w, hs = invoice()
    customers(w)
    calls = []
    orig = w.controls
    w.controls = lambda top: calls.append(top) or orig(top)
    w.focus_h = w.kids[w.tops[0]][-1][1]
    assert drv(w).focused() == "customers.search"
    assert sorted(calls) == sorted(set(calls))


def test_captions_leave_out_radio_buttons():
    w, _ = invoice()
    customers(w)
    w.add(w.tops[0], "TButton", (10, 10, 50, 20), "&OK")
    assert drv(w).captions() == ["OK"]


# --- dry run and live input
def test_dry_run_logs_and_sends_nothing():
    w, hs = invoice()
    d = drv(w)
    d.click("plate")
    d.set_text("plate", "XKS-4827", typed=True)  # focus isn't on plate (the click didn't happen): clicks again
    w.focus_h = hs["TLMDEdit#6"]
    d.key("{ENTER}")
    assert w.input == []
    assert d.out == ["DRY RUN, would click plate at (1515, 253)", "DRY RUN, would click plate at (1515, 253)",
                     "DRY RUN, would type 'XKS-4827' into plate", "DRY RUN, would press {ENTER} in plate"]


def test_live_click_then_typing_in_chunks():
    w, hs = invoice()
    d = drv(w, live=True)
    d.set_text("plate", "XKS-4827", typed=True)
    assert w.input == [("click", 1515, 253, False)] + [("type", c) for c in "XKS-4827"]
    d.key("{ENTER}")
    assert w.input[-1] == ("type", "{ENTER}")


def test_guard_rechecked_between_chunks():
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#5"]
    d = drv(w, live=True)
    w.on_type = lambda keys: w.open("", "Tmsgs", (800, 400, 1100, 560))  # a Yes/No box pops up mid-typing
    assert "Refused" in raises(Refused, d.set_text, "odometer.in", "123456789", typed=True)
    assert w.input == [("type", "1")] and d.stopped  # one key, then the pop-up stops it


def test_refusals_before_any_input():
    for name, double in (("btn.clear", False), ("btn.done", False), ("btn.labor", False), ("vin", True),
                         ("plate", True)):
        w, _ = invoice()
        raises(Refused, drv(w, live=True).click, name, double)
        assert w.input == [], name
    w, _ = invoice()
    vehicles(w)
    raises(Refused, drv(w, live=True).click, "vehicles.vin", True)
    w, _ = invoice()
    w.zoom = False
    assert "maximized" in raises(Refused, drv(w, live=True).click, "plate") and w.input == []
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    w.fg = 555  # another program is active: typing would go there
    raises(Refused, drv(w, live=True).key, "{ENTER}")
    assert w.input == []
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    raises(Refused, drv(w, live=True).key, "^a")
    assert w.input == []


def test_confirm_box_on_top_and_enter_is_refused():
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    box = w.open("", "Tmsgs", (800, 400, 1100, 560))
    w.focus_h = w.add(box, "TButton", (20, 100, 75, 25), "&Yes")
    d = drv(w, live=True)
    assert "isn't a mapped box" in raises(Refused, d.key, "{ENTER}")
    assert w.input == []


def test_enter_refused_when_focus_is_on_a_button_even_if_mapped():
    w, hs = invoice()
    w.classes[hs["TLMDEdit#6"]] = "TLMDButtonEdit"  # pretend the plate box were a button kind
    w.focus_h = hs["TLMDEdit#6"]
    d = drv(w, live=True, controls=dict(invomax.CONTROLS, plate=Loc(None, "TLMDButtonEdit", 0,
                                                                     (1468, 247, 110, 28))))
    w.kids[1] = [(k if h != hs["TLMDEdit#6"] else "TLMDButtonEdit#0", h, c) for k, h, c in w.kids[1]]
    assert "button" in raises(Refused, d.key, "{ENTER}") and w.input == []


def test_menu_or_dropdown_open_refuses_input():
    for cls in ("#32768", "ComboLBox"):
        w, hs = invoice()
        w.focus_h = hs["TLMDEdit#6"]
        w.tops.insert(0, 900)
        w.classes[900], w.rects[900], w.kids[900] = cls, (1500, 280, 1700, 400), []
        d = drv(w, live=True)
        raises(Refused, d.key, "{ENTER}")
        w2 = w
        d2 = drv(w2, live=True)
        raises(Refused, d2.click, "odometer.in")
        assert w.input == [], cls


def test_focus_not_moving_after_click_is_refused():
    w, _ = invoice()
    w.focus_follows_click = False
    d = drv(w, live=True)
    assert "didn't put the focus" in raises(Refused, d.set_text, "plate", "XKS-4827", typed=True)
    assert w.input == [("click", 1515, 253, False)] and d.stopped


def test_click_target_must_be_the_control_itself():
    w, hs = invoice()
    w.add(1, "TPanel", (1460, 240, 200, 60))  # something drawn over the plate box
    d = drv(w, live=True)
    assert "not the control itself" in raises(Refused, d.click, "plate")
    assert w.input == []


def test_fixed_spot_checks_the_class_under_it():
    w, _ = invoice()
    cust, _ = customers(w)
    w.add(cust, "TStringGrid", (11, 440, 600, 60))  # a grid where Add New was measured
    assert "expected Tshow_customer" in raises(Refused, drv(w, live=True).press, "Add New")
    w, _ = invoice()
    customers(w)
    d = drv(w, live=True)
    d.press("Add New")
    assert w.input == [("click", 785, 751, False)]


def test_click_meant_for_a_dialog_cant_reach_the_invoice():
    w, _ = invoice()
    customers(w)
    w.rects[w.tops[0]] = (648, 276, 1288, 780)
    w.tops.insert(0, 901)  # another window covers the radio button
    w.classes[901], w.texts[901], w.rects[901], w.kids[901] = "TForm", "", (600, 250, 1300, 400), []
    d = drv(w, live=True)
    raises(Refused, d.click, "customers.by_license")
    assert w.input == []


def test_stop_latch_after_a_refusal():
    w, hs = invoice()
    d = drv(w, live=True)
    raises(Refused, d.click, "btn.done")
    assert d.stopped
    assert "stopped earlier" in raises(Refused, d.click, "plate")
    assert w.input == []
    assert drv(w, live=True).click("plate") is None and len(w.input) == 1  # a new Driver starts clean


def test_stop_latch_after_an_unexpected_error():
    w, hs = invoice()
    d = drv(w, live=True)
    w.click = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("SendInput sent 0 of 3 mouse events"))
    raises(RuntimeError, d.click, "plate")
    assert "SendInput" in d.stopped
    raises(Refused, d.click, "plate")


def test_emergency_stop_esc_and_corner():
    for attr in ("esc", "corner"):
        w, hs = invoice()
        setattr(w, attr, True)
        d = drv(w, live=True)
        assert "emergency stop" in raises(Refused, d.click, "plate")
        assert w.input == [] and d.stopped
    w, hs = invoice()
    d = drv(w, live=True)
    w.on_type = lambda keys: setattr(w, "esc", True)  # Esc pressed during typing
    w.focus_h = hs["TLMDEdit#5"]
    raises(Refused, d.set_text, "odometer.in", "98431", typed=True)
    assert w.input == [("type", "9")]


def test_recent_user_input_refuses():
    w, hs = invoice()
    w.idle = 120
    d = drv(w, live=True)
    assert "someone used the mouse" in raises(Refused, d.click, "plate") and w.input == []


def test_own_input_isnt_taken_for_the_users():
    w, hs = invoice()
    d = drv(w, live=True)
    w.on_type = lambda keys: setattr(w, "idle", 0)  # our own keystrokes reset the idle time
    w.focus_h = hs["TLMDEdit#5"]
    d.set_text("odometer.in", "98431", typed=True)
    assert w.input == [("type", c) for c in "98431"]


def test_backspace_and_delete_are_never_sent():
    # trial 2026-11-03: Backspace in a header box cleared the whole InvoMax invoice
    for keys in ("{BACKSPACE}", "{BKSP}", "{bs}", "{DEL}", "{DELETE}"):
        w, hs = invoice()
        w.focus_h = hs["TLMDEdit#5"]
        d = drv(w, live=True)
        assert "never sent" in raises(Refused, d._send, keys)
        assert w.input == []
    assert "{BACKSPACE}" not in invomax.KEYS and "{DEL}" not in invomax.KEYS


def test_dropdowns_are_never_typed_into():
    w, hs = invoice()
    d = drv(w, live=True)
    d.controls = dict(d.controls, **{"vehicles.year": Loc(window="Vehicles", cls="TRzComboBox", index=0)})
    assert "dropdown" in raises(Refused, d.set_text, "vehicles.year", "2015", True)
    assert w.input == []


def test_control_characters_are_refused():
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    for v in ("XKS\n4827", "A\tB", "\x1b"):
        raises(Refused, drv(w, live=True).set_text, "plate", v, True)
    assert w.input == []


def test_unconfirmed_phone_is_read_only():
    w, hs = invoice()
    d = drv(w, live=True)
    assert "isn't confirmed" in raises(Refused, d.click, "phone")
    assert drv(w)._hwnd("phone")[0] == hs["TLMDEdit#10"]
    assert w.input == []


def test_press_by_caption_never_list_and_allow_list():
    w, _ = invoice()
    veh, year, model, cancel = vehicles(w)
    d = drv(w, live=True)
    d.press("Cancel")
    assert w.input == [("click", 724 + 79 + 34, 278 + 461 + 13, False)]
    for bad in ("Custom Vehicle", "Done", "&Print", "Select", "No"):  # Select isn't in any recipe; No only in Confirm
        raises(Refused, drv(w, live=True).press, bad)
    assert len(w.input) == 1
    w, _ = invoice()
    customers(w)
    assert raises(NotMapped, drv(w, live=True).press, "Exit") == "not mapped yet: customers.exit"
    w, _ = invoice()
    customers(w)
    w.add(w.tops[0], "TRadioButton", (10, 10, 50, 20), "Add New")  # a radio with that caption is not a button
    drv(w, live=True).press("Add New")
    assert w.input == [("click", 785, 751, False)]


def test_pick_reads_combo_items_and_refuses_never_items():
    w, _ = invoice()
    veh, year, model, cancel = vehicles(w)
    w.items[year] = ["2022", "2021"]
    d = drv(w, live=True)
    d.pick("vehicles.year", "2021")
    assert w.input == [("select", year, 1)]
    assert "isn't in the vehicles.year list" in raises(RuntimeError, drv(w, live=True).pick, "vehicles.year", "1901")
    w.items[model] = ["Custom Vehicle"]
    raises(Refused, drv(w, live=True).pick, "vehicles.model", "Custom Vehicle")
    assert len(w.input) == 1


def test_choose_menu():
    w, hs = invoice()
    m = 950
    w.tops.insert(0, m)
    w.classes[m], w.rects[m], w.kids[m], w.texts[m] = "#32768", (300, 300, 450, 340), [], ""
    w.texts[("menu", m)] = ["Change Number", "Dial Number"]
    raises(Refused, drv(w, live=True).choose_menu, "Dial Number")
    raises(Refused, drv(w, live=True).choose_menu, "Erase")
    drv(w, live=True).choose_menu("Change Number")
    assert w.input == [("click", 375, 310, False)]


# --- copy-back
def copyback_setup(**k):
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    w.box_values[hs["TLMDEdit#6"]] = "XKS-4827"
    return w, drv(w, live=True, allow_copyback=True, **k)


def test_copyback_reads_and_restores_the_clipboard():
    w, d = copyback_setup()
    assert d.text("plate") == "XKS-4827"
    assert w.input == [("type", "^a^c")] and w.clip == "staff text"
    assert d.text("plate") == "XKS-4827" and len(w.input) == 1  # once per step: no second Ctrl+C


def test_copyback_off_dry_run_and_unfocused():
    w, hs = invoice()
    w.focus_h = hs["TLMDEdit#6"]
    assert "owner's OK" in raises(NotReadable, drv(w, live=True).text, "plate")
    d = drv(w, allow_copyback=True)  # dry run
    raises(NotReadable, d.text, "plate")
    assert "would copy-back plate" in d.out[-1] and not d.stopped
    w.focus_h = hs["TLMDEdit#1"]
    assert "focused box" in raises(NotReadable, drv(w, live=True, allow_copyback=True).text, "plate")
    assert w.input == []


def test_copyback_refuses_a_clipboard_with_a_picture():
    w, d = copyback_setup()
    w.formats = [2, 8]  # CF_BITMAP, CF_DIB
    raises(Refused, d.text, "plate")
    assert w.input == [] and w.formats == [2, 8]


def test_copyback_nothing_copied_is_not_readable_and_restores():
    w, d = copyback_setup()
    w.box_values.clear()
    assert "no text" in raises(NotReadable, d.text, "plate")
    assert w.clip == "staff text" and not d.stopped


def test_copyback_restores_an_empty_clipboard():
    w, d = copyback_setup()
    w.clip, w.formats = None, []
    assert d.text("plate") == "XKS-4827"
    assert w.clip is None and w.formats == []


def test_copyback_restore_failure_is_loud_and_stops():
    w, d = copyback_setup()
    w.clip_set_fails = 2
    assert d.text("plate") == "XKS-4827" and w.clip == "staff text"  # retried
    w, d = copyback_setup()
    w.clip_set_fails = 99
    d.text("plate")
    assert any("CLIPBOARD" in s for s in d.out) and d.stopped
    raises(Refused, d.click, "plate")


# --- the read-only check
def test_check_prints_reads_and_sends_nothing():
    w, hs = invoice()
    w.texts[hs["TEdit#2"]] = "JANE"
    w.bar = ["File > Print\tCtrl+P", "Edit > Select All\tCtrl+A", "Help > About"]
    out = []
    assert invomax.check(drv(w), out.append) == 0
    text = "\n".join(out)
    assert "dialog(): None" in text and "ready for actions: yes" in text
    assert "name.first" in text and "'JANE'" in text and "needs copy-back" in text
    assert "Edit > Select All   [Ctrl+A]" in text and "About" not in text
    assert "not mapped yet" in text and "place not confirmed" in text and w.input == []
    w.inv = None
    assert invomax.check(drv(w), out.append) == 1


def test_clip_owner_recreated_when_its_window_is_gone():
    class U:
        def __init__(self):
            self.alive, self.made = set(), []

        def IsWindow(self, h):
            return h in self.alive

        def CreateWindowExW(self, *a):
            h = 500 + len(self.made)
            self.made.append(h)
            self.alive.add(h)
            return h
    w = invomax.Win32.__new__(invomax.Win32)  # no real Windows calls
    w.u, w.wt, w._owner = U(), type("WT", (), {"HWND": staticmethod(lambda x: x)}), None
    first = w._clip_owner()
    assert w._clip_owner() == first and w.u.made == [first]  # reused while it exists
    w.u.alive.discard(first)  # destroyed when the thread that made it ended
    second = w._clip_owner()
    assert second != first and w.u.made == [first, second]


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
