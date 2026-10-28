import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recipes as r
from recipes import run, StepFailed, Recipe, press, click, double_click, choose_menu_item, dialog
from fake_invomax import FakeInvoMax


def go(name, values, fake, recipes=None):
    return run(name, values, fake, recipes=recipes, now=fake.now, sleep=fake.sleep)


def fails(name, values, fake, recipes=None):
    try:
        go(name, values, fake, recipes)
    except StepFailed as e:
        return e
    assert False, "expected StepFailed"


def test_customer_by_plate_loads_customer():
    f = FakeInvoMax()
    done = go("customer_by_plate", {"plate": "XKS-4827"}, f)
    assert [n for n, _, _ in done] == [1, 2]
    assert f.fields["name.first"] == "JANE" and f.focus == "vin"


def test_plate_not_on_file_stops_at_step_2():
    e = fails("customer_by_plate", {"plate": "ZZZ-0000"}, FakeInvoMax())
    assert e.step_no == 2 and "name.first filled" in e.expected
    assert [n for n, _, _ in e.done] == [1]


def test_require_failure_clicks_nothing():
    f = FakeInvoMax()
    f.fields["name.first"] = "SOMEONE"  # a customer is already on the invoice
    e = fails("customer_by_plate", {"plate": "XKS-4827"}, f)
    assert e.step_no == 0 and f.actions == []


def test_waits_for_slow_invomax_and_times_out_when_stuck():
    f = FakeInvoMax(lag=2.0)
    done = go("customer_by_plate", {"plate": "XKS-4827"}, f)
    assert done[-1][2] >= 2.0  # it waited, no fixed sleep
    e = fails("customer_by_plate", {"plate": "XKS-4827"}, FakeInvoMax(lag=4.0))  # past the 3 s timeout
    assert e.step_no == 2 and f.now() < 10


def test_new_customer_then_vehicle():
    f = FakeInvoMax(customers={})
    go("customer_search", {"by": "last_name", "text": "DOE"}, f)
    assert f.dialog() == "Customers" and f.radios["customers.by_last_name"]
    go("customer_new", {"first": "JANE", "last": "DOE", "phone": "(555)010-0000", "phone_digits": "5550100000"}, f)
    assert f.dialog() == "Vehicles" and f.fields["name.last"] == "DOE" and f.fields["phone"] == "(555)010-0000"
    go("vehicle_choose", {"year": "2021", "make": "Chevrolet", "model_item": "2021 Chevrolet EQUINOX",
                          "engine_item": "1.5L L4"}, f)
    assert f.dialog() is None and f.focus == "plate" and f.fields["year_make"] == "2021 Chevrolet"


def test_new_customer_without_phone_skips_phone_steps():
    f = FakeInvoMax(customers={})
    f.windows = ["Customers"]
    go("customer_new", {"first": "JOHN", "last": "ROE", "phone": "", "phone_digits": ""}, f)
    assert not any(a[1] == "custinfo.phone" for a in f.actions if a[0] in ("click", "set"))


def test_phone_set_never_chooses_dial_number():
    f = FakeInvoMax()
    go("customer_by_plate", {"plate": "XKS-4827"}, f)
    go("phone_set", {"phone": "(555)010-0001"}, f)
    assert f.fields["phone"] == "(555)010-0001"
    assert ("choose_menu", "Dial Number") not in f.actions


def test_odometer_stops_on_mechanic_box():
    f = FakeInvoMax()
    go("customer_by_plate", {"plate": "XKS-4827"}, f)
    go("odometer", {"odometer": "98431"}, f)
    assert f.fields["odometer.out"] == "98431" and f.focus == "mechanic"
    assert f.actions[-1] == ("key", "{ENTER}")  # nothing typed into the mechanic box


def test_never_list_refused_before_anything_is_touched():
    for bad in ("Done", "&Clear", "Print", "Charge", "Delete", "Custom Vehicle", "Void This Transaction"):
        f = FakeInvoMax()
        e = fails("x", {}, f, recipes={"x": Recipe(steps=(press(bad, expect=dialog("x")),))})
        assert "refused" in e.got and f.actions == [], bad
    f = FakeInvoMax()
    f.menu = ["Change Number", "Dial Number"]
    e = fails("x", {}, f, recipes={"x": Recipe(steps=(choose_menu_item("Dial Number"),))})
    assert "refused" in e.got and f.actions == []


def test_caption_not_in_any_recipe_is_refused():
    f = FakeInvoMax()
    e = fails("x", {}, f, recipes=dict(r.RECIPES, x=Recipe(steps=(press("Cash Sale"),))))
    assert "isn't in any recipe" in e.got and f.actions == []


def test_no_double_click_on_plate_or_vin_and_no_clicks_on_clear_or_done():
    for ctl in ("plate", "vin"):
        f = FakeInvoMax()
        e = fails("x", {}, f, recipes={"x": Recipe(steps=(double_click(ctl),))})
        assert "never double-clicked" in e.got and f.actions == []
    for ctl, label in (("btn.clear", "Clear"), ("btn.done", "Done")):
        f = FakeInvoMax()
        e = fails("x", {}, f, recipes={"x": Recipe(steps=(click(ctl),))})
        assert f"on the {label} button" in e.got and f.actions == []


def test_unexpected_window_stops_the_recipe():
    f = FakeInvoMax()
    orig = f.set_text

    def set_and_popup(ctl, value, typed):
        orig(ctl, value, typed)
        f.windows.append("Invomax")  # e.g. a warning box nobody asked for
    f.set_text = set_and_popup
    e = fails("customer_new", {"first": "A", "last": "B", "phone": "", "phone_digits": ""},
              _with_customers_open(f))
    assert e.step_no == 2 and "Invomax" in e.got  # the step during which it appeared


def _with_customers_open(f):
    f.windows = ["Customers"]
    return f


def test_every_recipe_press_is_allowed_and_none_is_on_the_never_list():
    assert r.ALLOWED and not (r.ALLOWED & r.NEVER)


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
