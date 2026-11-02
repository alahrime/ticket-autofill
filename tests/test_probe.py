import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recipes as R
from fake_invomax import FakeInvoMax
import probe
from probe import (clip, diff, name_controls, placeholders, start_check, read_start, needs_text, missing_values,
                   wait_idle, run_trial, step_line, final_line, result_lines, classify, Row, TRIAL_RECIPES,
                   read_after, leftovers, trial_work, TrialLog, NOTHING_SENT)


def test_name_controls_counts_per_class():
    assert name_controls(["TLMDEdit", "TEdit", "TLMDEdit"]) == ["TLMDEdit#0", "TEdit#0", "TLMDEdit#1"]


def test_clip_joins_lines_and_truncates():
    assert clip("a\r\nb\nc") == "a⏎b⏎c"
    assert clip(None) == ""
    assert clip("x" * 250) == "x" * 200 + "…"


def test_diff_lists_added_changed_removed():
    prev = {"window Customers [TForm]": "open", "InvoMax / TLMDEdit#0": ""}
    cur = {"InvoMax / TLMDEdit#0": "JANE", "window Vehicles [TForm]": "open"}
    assert diff(prev, cur) == ["+ window Vehicles [TForm] = 'open'",
                               "~ InvoMax / TLMDEdit#0: '' -> 'JANE'",
                               "- window Customers [TForm]"]
    assert diff(cur, cur) == []


# --- trial mode
def test_trial_recipes_exist_in_plan_order():
    assert TRIAL_RECIPES == ("customer_search", "customers_exit", "customer_by_plate", "odometer", "vehicle_open",
                             "vehicles_cancel")
    assert all(n in R.RECIPES for n in TRIAL_RECIPES)


def test_placeholders_from_recipe():
    assert placeholders(R.RECIPES["customer_search"]) == ["by", "text"]
    assert placeholders(R.RECIPES["customer_by_plate"]) == ["plate"]
    assert placeholders(R.RECIPES["odometer"]) == ["odometer"]  # the {ENTER} key isn't a value
    assert placeholders(R.RECIPES["customers_exit"]) == []
    assert placeholders(R.RECIPES["vehicles_cancel"]) == []
    assert "phone" in placeholders(R.RECIPES["customer_new"])  # a `when` value counts too


def test_missing_values():
    assert missing_values(["plate", "text"], {"plate": " ", "text": "DOE"}) == ["plate"]


EMPTY = {"invoice": True, "dialog": None, "name.first": "", "name.last": ""}
LOADED = {"invoice": True, "dialog": None, "name.first": "JANE", "name.last": "DOE"}


def test_start_check_empty_invoice_recipes():
    r = R.RECIPES["customer_search"]
    assert start_check(r, EMPTY) == (True, "Empty invoice.")
    ok, msg = start_check(r, LOADED)
    assert not ok and "isn't empty" in msg
    ok, msg = start_check(r, {**EMPTY, "name.first": "", "name.last": "DOE"})
    assert not ok
    ok, msg = start_check(r, {**EMPTY, "dialog": "Customers"})
    assert not ok and "Customers" in msg
    ok, msg = start_check(r, {"invoice": False, "error": "InvoMax isn't open (no invoice window)."})
    assert not ok and "isn't open" in msg
    ok, msg = start_check(r, {**EMPTY, "error": "TEdit#2 isn't on screen"})
    assert not ok and "couldn't read" in msg
    assert start_check(R.RECIPES["customer_by_plate"], EMPTY)[0]


def test_start_check_customer_recipes_use_the_customer_on_screen():
    for name in ("odometer", "vehicle_open"):
        r = R.RECIPES[name]
        assert start_check(r, LOADED) == (True, "Uses the customer on screen.")
        assert not start_check(r, EMPTY)[0]
        assert not start_check(r, {**LOADED, "dialog": "Vehicles"})[0]
        assert "customer on screen" in needs_text(r)


def test_start_check_dialog_recipes_need_their_window():
    assert start_check(R.RECIPES["customers_exit"], {**EMPTY, "dialog": "Customers"})[0]
    assert not start_check(R.RECIPES["customers_exit"], EMPTY)[0]
    assert start_check(R.RECIPES["vehicles_cancel"], {**LOADED, "dialog": "Vehicles"})[0]
    assert not start_check(R.RECIPES["vehicles_cancel"], {**LOADED, "dialog": "Customers"})[0]
    assert needs_text(R.RECIPES["customer_search"]).startswith("Needs an empty invoice")


def test_read_start_reads_only():
    f = FakeInvoMax()
    f.fields.update({"name.first": "JANE", "name.last": "DOE"})
    assert read_start(f) == {"invoice": True, "dialog": None, "name.first": "JANE", "name.last": "DOE"}
    assert f.actions == []

    class Closed:
        def dialog(self):
            raise RuntimeError("InvoMax isn't open (no invoice window).")
    assert read_start(Closed()) == {"invoice": False, "error": "InvoMax isn't open (no invoice window)."}


def test_wait_idle():
    t = [0.0]
    now, sleep = (lambda: t[0]), (lambda s: t.__setitem__(0, t[0] + s))
    idle = iter([100, 300, 650])
    assert wait_idle(lambda: next(idle), lambda: False, now, sleep) is None
    assert wait_idle(lambda: 0, lambda: False, now, sleep, give_up=1.0).startswith("didn't start")
    assert wait_idle(lambda: 5000, lambda: True, now, sleep).startswith("stopped")
    # the emergency stop wins over both "idle enough" and "gave up"
    assert wait_idle(lambda: 0, lambda: True, now, sleep, give_up=0.0).startswith("stopped")
    esc = iter([False, False, True])
    assert wait_idle(lambda: 0, lambda: next(esc), now, sleep).startswith("stopped")


def test_trial_defaults():
    assert probe.DRY_RUN_DEFAULT is True and probe.COPYBACK_DEFAULT is False
    assert probe.IDLE_MS == 600


def test_start_check_refuses_a_window_that_isnt_maximized():
    f = FakeInvoMax()
    seen = read_start(f, lambda: "the InvoMax invoice window isn't maximized")
    ok, msg = start_check(R.RECIPES["customer_search"], seen)
    assert not ok and "isn't maximized" in msg and f.actions == []
    assert start_check(R.RECIPES["customer_search"], read_start(f, lambda: None))[0]


def test_run_trial_ok_logs_each_step_with_check_seen_and_time():
    f = FakeInvoMax(lag=0.2)
    rows, kind, exc = run_trial("customer_search", {"by": "license", "text": "XKS-4827"}, f, f.now, f.sleep)
    assert kind == "OK" and exc is None
    assert [r.n for r in rows] == [1, 2, 3] and all(r.result == "ok" for r in rows)
    assert rows[0].check == "window 'Customers'" and rows[0].seen == "window 'Customers'"
    assert rows[0].ms >= 200  # the fake opens Customers after 0.2 s
    assert rows[1].seen == "customers.by_license checked = True"
    line = step_line("customer_search", rows[0])
    assert line.startswith("customer_search step 1: Open the Customers search | check: window 'Customers'")
    assert line.endswith("ms | ok")
    assert final_line("customer_search", kind, exc, rows) == "customer_search final: OK (3 steps)"


def test_run_trial_step_failed_stops_and_shows_what_was_seen():
    f = FakeInvoMax()
    rows, kind, exc = run_trial("customer_by_plate", {"plate": "ABC-0000"}, f, f.now, f.sleep)
    assert kind == "StepFailed" and exc.step_no == 2
    assert rows[0].result == "ok" and rows[1].result == "failed"
    assert rows[1].seen == "name.first = ''" and rows[1].ms >= 3000
    n = len(f.actions)
    assert final_line("customer_by_plate", kind, exc, rows).startswith(
        "customer_by_plate final: StepFailed at step 2 (Type ABC-0000 and press Enter): saw name.first = ''")
    shown = "\n".join(result_lines("customer_by_plate", kind, exc, rows, False, True, read_after(f)))
    assert "✗ 2." in shown and "saw: name.first = ''" in shown and "Nothing is left on the invoice." in shown
    assert "nothing more was pressed" in shown
    assert len(f.actions) == n  # reading what's left does nothing in InvoMax
    shown = "\n".join(result_lines("customer_by_plate", kind, exc, rows, True, False))  # dry-run failure
    assert NOTHING_SENT in shown and "by hand" not in shown and "(dry run)" in shown


def test_run_trial_require_failure_clicks_nothing():
    f = FakeInvoMax()
    f.fields["name.first"] = "JANE"
    rows, kind, exc = run_trial("customer_search", {"by": "license", "text": "X"}, f, f.now, f.sleep)
    assert kind == "StepFailed" and exc.step_no == 0 and f.actions == []
    assert rows == [Row(0, "start checks", "name.first empty", "name.first = 'JANE'", 0, "failed")]


class Refusing(FakeInvoMax):
    def __init__(self, why):
        super().__init__()
        self.why = why

    def click(self, ctl, double=False):
        e = RuntimeError(self.why)
        e.refused = True
        raise e


def test_run_trial_refused_and_emergency_stop():
    f = Refusing("Refused: emergency stop (Esc is held down).")
    rows, kind, exc = run_trial("customer_by_plate", {"plate": "XKS-4827"}, f, f.now, f.sleep)
    assert kind == "stopped" and rows[-1].result == "failed"
    f = Refusing("Refused: plate moved since it was found.")
    _, kind, _ = run_trial("customer_by_plate", {"plate": "XKS-4827"}, f, f.now, f.sleep)
    assert kind == "StepFailed"

    class RefusesReads(FakeInvoMax):
        def dialog(self):
            e = RuntimeError("Refused: no")
            e.refused = True
            raise e
    rows, kind, exc = run_trial("customers_exit", {}, RefusesReads(), lambda: 0.0, lambda s: None)
    assert kind == "Refused" and rows[-1].result == "Refused"


def test_run_trial_emergency_while_a_check_polls():
    f = FakeInvoMax()
    f.stopped = ""
    held = {"esc": False}
    orig = f.click

    def click(ctl, double=False):
        orig(ctl, double)
        held["esc"] = True  # Esc pressed while step 1's check polls; the fake never opens Customers
    f.click = click
    f.later = lambda fn: None
    rows, kind, exc = run_trial("customer_search", {"by": "license", "text": "X"}, f, f.now, f.sleep,
                                emergency=lambda: held["esc"])
    assert kind == "stopped" and f.stopped and len(f.actions) == 1 and f.t < 1.0


def test_esc_between_steps_counts_the_finished_step():
    f = FakeInvoMax()
    f.stopped = ""
    calls = [0]

    def emergency():  # read 7 is the window check before step 2; step 1 has passed its check by then
        calls[0] += 1
        return calls[0] >= 7
    rows, kind, exc = run_trial("customer_search", {"by": "license", "text": "X"}, f, f.now, f.sleep,
                                emergency=emergency)
    assert kind == "stopped" and f.stopped
    assert [(r.n, r.result) for r in rows] == [(1, "ok"), (2, "stopped")]
    assert rows[1].say == "Search by license" and "{" not in rows[1].check  # filled, no raw placeholders
    assert f.actions == [("double_click", "name.first")]


def test_result_after_a_live_ok_run_says_what_to_undo():
    f = FakeInvoMax()
    rows, kind, exc = run_trial("customer_by_plate", {"plate": "XKS-4827"}, f, f.now, f.sleep)
    assert kind == "OK"
    shown = result_lines("customer_by_plate", kind, exc, rows, False, True, read_after(f))
    assert shown[-1] == "Clear the invoice by hand (the tool never presses Clear)."
    rows, kind, exc = run_trial("vehicle_open", {}, f, f.now, f.sleep)
    assert kind == "OK"
    shown = result_lines("vehicle_open", kind, exc, rows, False, True, read_after(f))
    assert "Close the Vehicles window by hand (or run customers_exit / vehicles_cancel)." in shown
    assert "Clear the invoice by hand (the tool never presses Clear)." in shown
    assert NOTHING_SENT not in shown
    assert leftovers({"error": "gone"})[0].startswith("Couldn't read InvoMax after the run")


def test_result_when_nothing_was_sent():
    stop = RuntimeError("stopped: emergency stop before the start (Esc held or mouse in the top-left corner)")
    shown = result_lines("customer_search", "stopped", stop, [], False, False)
    assert shown[-1] == NOTHING_SENT and "emergency stop" in "\n".join(shown) and "by hand" not in "\n".join(shown)
    f = FakeInvoMax()
    f.fields["name.first"] = "JANE"
    rows, kind, exc = run_trial("customer_search", {"by": "license", "text": "X"}, f, f.now, f.sleep)
    shown = result_lines("customer_search", kind, exc, rows, False, False)  # require failed: nothing sent
    assert shown[-1] == NOTHING_SENT


class Win:
    def __init__(self, idle=5000, esc=False):
        self.idle, self.esc = idle, esc

    def idle_ms(self): return self.idle
    def esc_down(self): return self.esc
    def in_stop_corner(self): return False


def test_trial_work_live_run_reads_what_is_left_and_logs():
    made, lines = [], []

    def make_driver(w, dry_run, copyback):
        f = FakeInvoMax()
        f.dry_run, f.done = dry_run, []
        f.click = lambda ctl, double=False, orig=f.click: (f.done.append(ctl), orig(ctl, double))
        made.append(f)
        return f
    clock = FakeInvoMax()
    res = trial_work("customer_by_plate", {"plate": "XKS-4827"}, False, False, Win, make_driver, lines.append,
                     clock.now, clock.sleep)
    name, rows, kind, exc, dry, sent, after = res
    assert kind == "OK" and sent and after == {"dialog": None, "name.first": "JANE"}
    assert lines[-1].startswith("customer_by_plate after:") and "final: OK" in lines[-2]
    res = trial_work("customer_by_plate", {"plate": "XKS-4827"}, True, False, Win, make_driver, lines.append,
                     clock.now, clock.sleep)
    assert res[5] is False and res[6] is None  # dry run: nothing sent, nothing read after


def test_trial_work_never_raises_and_a_log_failure_hides_nothing():
    def bad_driver(w, dry_run, copyback):
        raise OSError("no InvoMax")

    def bad_log(line):
        raise OSError("disk full")
    res = trial_work("customers_exit", {}, True, False, Win, bad_driver, bad_log)
    assert res[2] == "error" and "no InvoMax" in str(res[3])
    clock = FakeInvoMax()
    res = trial_work("customers_exit", {}, False, False, lambda: Win(esc=True), lambda *a: FakeInvoMax(),
                     bad_log, clock.now, clock.sleep)
    assert res[2] == "stopped" and res[5] is False
    TrialLog(os.path.join(os.path.abspath(__file__), "x", "trial.log")).write("x")  # can't be written: no raise


def test_classify():
    assert classify(None) == "OK"
    assert classify(RuntimeError("x")) == "error"
    assert classify(R.StepFailed("r", 1, "s", "e", "refused: Refused: emergency stop (Esc)", [])) == "stopped"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
