"""InvoMax actions as data ("recipes"), run one step at a time, each step checked before the next.

A recipe is a straight list of steps. The runner does a step, then polls its check until it passes
or times out, and stops at the first mismatch with StepFailed naming the step. It never presses,
chooses or clicks anything on the NEVER list, whatever a recipe or control map says.

The runner talks to a driver (invomax.Driver on the shop PC, FakeInvoMax in tests):
    dialog() -> title of the top InvoMax window that isn't the invoice, or None
    text(ctl) / checked(ctl) / focused() -> ctl name / menu_items() / captions()
    position(ctl) -> (x, y) inside the invoice window for position-located controls, else None
    click(ctl, double=False) / set_text(ctl, value, typed) / key(keys) / pick(ctl, text)
    double_click_row(ctl, text) / choose_menu(text) / press(caption)
"""
from __future__ import annotations
import time
from dataclasses import dataclass, field

# Captions the runner refuses to press or choose, compared without "&", case and spaces.
NEVER = {"done", "charge", "print", "clear", "dial number", "continue", "fast quote", "change", "delete",
         "custom vehicle", "void this transaction", "erase this transaction",
         "make changes to this transaction", "change the transaction date"}
NO_DOUBLE_CLICK = {"plate", "vin"}
# Invoice-window areas (x1, y1, x2, y2) no click may land in, from the probe log.
REFUSED_AREAS = {"Clear": (90, 335, 160, 370), "Done": (1280, 335, 1350, 370)}
KEYS = {"{ENTER}", "{TAB}"}
POLL = 0.05


def norm(caption):
    return " ".join(caption.replace("&", "").lower().split())


# --- checks
@dataclass(frozen=True)
class Check:
    kind: str
    a: str = ""
    b: str = ""
    parts: tuple = ()

    def fill(self, values):
        return Check(self.kind, self.a.format(**values), self.b.format(**values),
                     tuple(p.fill(values) for p in self.parts))

    def test(self, d):
        """-> (passed, what was seen)."""
        k = self.kind
        if k == "dialog":
            got = d.dialog()
            return got == self.a, f"window {got!r}"
        if k == "gone":
            got = d.dialog()
            return got != self.a, f"window {got!r}"
        if k == "no_dialog":
            got = d.dialog()
            return got is None, f"window {got!r}"
        if k == "text":
            got = d.text(self.a)
            return got == self.b, f"{self.a} = {got!r}"
        if k == "filled":
            got = d.text(self.a)
            return bool(got.strip()), f"{self.a} = {got!r}"
        if k == "empty":
            got = d.text(self.a)
            return not got.strip(), f"{self.a} = {got!r}"
        if k == "focus":
            got = d.focused()
            return got == self.a, f"focus on {got!r}"
        if k == "checked":
            return d.checked(self.a), f"{self.a} checked = {d.checked(self.a)}"
        if k == "menu_has":
            got = d.menu_items()
            return self.a in got, f"menu {got}"
        if k == "caption":
            got = d.captions()
            return self.a in got, f"buttons {got}"
        results = [p.test(d) for p in self.parts]
        ok = any(r[0] for r in results) if k == "any" else all(r[0] for r in results)
        return ok, "; ".join(r[1] for r in results)

    def __str__(self):
        if self.kind in ("any", "all"):
            return f" {'or' if self.kind == 'any' else 'and'} ".join(map(str, self.parts))
        return {"dialog": f"window {self.a!r}", "gone": f"window {self.a!r} closed", "no_dialog": "no window open",
                "text": f"{self.a} = {self.b!r}", "filled": f"{self.a} filled", "empty": f"{self.a} empty",
                "focus": f"focus on {self.a}", "checked": f"{self.a} checked", "menu_has": f"menu with {self.a!r}",
                "caption": f"button {self.a!r}"}[self.kind]


def dialog(title): return Check("dialog", title)
def gone(title): return Check("gone", title)
def no_dialog(): return Check("no_dialog")
def text(ctl, value): return Check("text", ctl, value)
def filled(ctl): return Check("filled", ctl)
def empty(ctl): return Check("empty", ctl)
def focus(ctl): return Check("focus", ctl)
def checked(ctl): return Check("checked", ctl)
def menu_has(item): return Check("menu_has", item)
def caption(c): return Check("caption", c)
def any_of(*checks): return Check("any", parts=checks)
def all_of(*checks): return Check("all", parts=checks)


# --- steps
@dataclass(frozen=True)
class Step:
    kind: str            # click | double_click | wait | set | key | pick | select_row | choose_menu_item | press
    target: str = ""     # control name, caption, menu item or keys
    value: str = ""      # for set / pick / select_row; "{placeholders}" come from the draft
    expect: Check | None = None
    say: str = ""
    typed: bool = False  # set: type keystrokes instead of setting the text
    enter: bool = False  # set: press Enter afterwards
    tries: int = 1       # click: click again if the check hasn't passed after RETRY seconds
    timeout: float = 5.0
    when: str = ""       # skip the step when this value is empty


def click(ctl, expect=None, say="", tries=1, timeout=5.0, when=""):
    return Step("click", ctl, expect=expect, say=say or f"Click {ctl}", tries=tries, timeout=timeout, when=when)


def double_click(ctl, expect=None, say="", timeout=5.0, when=""):
    return Step("double_click", ctl, expect=expect, say=say or f"Double-click {ctl}", timeout=timeout, when=when)


def wait_dialog(title, timeout=10.0, say=""):
    return Step("wait", expect=dialog(title), say=say or f"Wait for {title!r}", timeout=timeout)


def wait_gone(title, timeout=10.0, say=""):
    return Step("wait", expect=gone(title), say=say or f"Wait for {title!r} to close", timeout=timeout)


def set_(ctl, value, typed=False, enter=False, expect=None, say="", timeout=5.0, when=""):
    return Step("set", ctl, value, expect or text(ctl, value), say or f"Put {value} in {ctl}",
                typed=typed, enter=enter, timeout=timeout, when=when)


def key(keys, expect=None, say="", timeout=5.0):
    return Step("key", keys, expect=expect, say=say or f"Press {keys}", timeout=timeout)


def pick(ctl, value, expect=None, say="", timeout=5.0, when=""):
    return Step("pick", ctl, value, expect or text(ctl, value), say or f"Choose {value} in {ctl}",
                timeout=timeout, when=when)


def select_row(ctl, value, expect=None, say="", timeout=5.0):
    return Step("select_row", ctl, value, expect, say or f"Double-click the row {value}", timeout=timeout)


def choose_menu_item(item, expect=None, say="", timeout=5.0):
    return Step("choose_menu_item", item, expect=expect, say=say or f"Choose {item!r}", timeout=timeout)


def press(button, expect=None, say="", timeout=5.0, when=""):
    return Step("press", button, expect=expect, say=say or f"Press {button!r}", timeout=timeout, when=when)


@dataclass(frozen=True)
class Recipe:
    steps: tuple
    require: tuple = ()  # checked before step 1; if one fails nothing is clicked


class StepFailed(Exception):
    def __init__(self, recipe, step_no, say, expected, got, done):
        self.recipe, self.step_no, self.say, self.expected, self.got, self.done = recipe, step_no, say, expected, got, done
        where = f"step {step_no} ({say})" if step_no else "before starting"
        super().__init__(f"{recipe}: stopped {where}: expected {expected}, saw {got}.")


RETRY = 0.5

# --- the recipes (spec 5.x); parts, labor, remark and note are added as the probe shows them
RECIPES = {
    "customer_by_plate": Recipe(  # spec 5.1a
        require=(no_dialog(), empty("name.first")),
        steps=(
            click("plate", expect=focus("plate"), say="Click the Plate box"),
            set_("plate", "{plate}", typed=True, enter=True, expect=filled("name.first"), timeout=3.0,
                 say="Type {plate} and press Enter"),
        )),
    "customer_search": Recipe(  # spec 5.1
        require=(no_dialog(), empty("name.first")),
        steps=(
            double_click("name.first", expect=dialog("Customers"), say="Open the Customers search"),
            click("customers.by_{by}", expect=checked("customers.by_{by}"), say="Search by {by}"),
            set_("customers.search", "{text}", typed=True, say="Type {text}"),
        )),
    "customer_new": Recipe(  # spec 5.3
        require=(dialog("Customers"),),
        steps=(
            press("Add New", expect=dialog("Customer Information"), say="Press Add New"),
            set_("custinfo.first", "{first}", typed=True, say="Type the first name"),
            set_("custinfo.last", "{last}", typed=True, say="Type the last name"),
            click("custinfo.phone", expect=focus("custinfo.phone"), when="phone", say="Click the phone box"),
            set_("custinfo.phone", "{phone_digits}", typed=True, expect=text("custinfo.phone", "{phone}"),
                 when="phone", say="Type the phone"),
            press("Save", expect=all_of(dialog("Vehicles"), text("name.first", "{first}")), timeout=10.0,
                  say="Press Save"),
        )),
    "customers_exit": Recipe(
        require=(dialog("Customers"),),
        steps=(press("Exit", expect=gone("Customers"), say="Close the Customers search"),)),
    "vehicle_open": Recipe(  # spec 5.5
        require=(no_dialog(), filled("name.first")),
        steps=(click("year_make", expect=dialog("Vehicles"), say="Open the Vehicles window"),)),
    "vehicle_choose": Recipe(  # spec 5.5, dropdown path
        require=(dialog("Vehicles"),),
        steps=(
            pick("vehicles.year", "{year}", say="Choose the year"),
            pick("vehicles.make", "{make}", say="Choose the make"),
            pick("vehicles.model", "{model_item}", expect=caption("Select Engine Later"), say="Choose the model"),
            pick("vehicles.engine", "{engine_item}", expect=all_of(gone("Vehicles"), focus("plate")),
                 say="Choose the engine"),
        )),
    "phone_set": Recipe(  # spec 5.4
        require=(no_dialog(), filled("phone")),
        steps=(
            double_click("phone", expect=menu_has("Change Number"), say="Open the phone menu"),
            choose_menu_item("Change Number", expect=dialog("Phone Number")),
            set_("phone.text", "{phone}", say="Type the phone"),
            press("OK", expect=all_of(gone("Phone Number"), text("phone", "{phone}")), say="Press OK"),
        )),
    "odometer": Recipe(  # spec 5.6; stops on the mechanic box, which staff fill by hand
        require=(no_dialog(), filled("name.first")),
        steps=(
            click("odometer.in", expect=focus("odometer.in"), say="Click the odometer box"),
            set_("odometer.in", "{odometer}", typed=True, enter=True, expect=focus("odometer.out"),
                 say="Type {odometer} and press Enter"),
            key("{ENTER}", expect=focus("mechanic"), say="Move on to the mechanic box"),
        )),
}

ALLOWED = {norm(s.target) for r in RECIPES.values() for s in r.steps if s.kind in ("press", "choose_menu_item")}


def _refuse(recipe, n, step, why, done):
    raise StepFailed(recipe, n, step.say, "a step the tool may take", f"refused: {why}", done)


def _guard(name, n, step, d, done, allowed):
    """Safety checks before a step touches InvoMax."""
    if step.kind in ("press", "choose_menu_item"):
        c = norm(step.target)
        if c in NEVER:
            _refuse(name, n, step, f"{step.target!r} is never pressed by the tool", done)
        if c not in allowed:
            _refuse(name, n, step, f"{step.target!r} isn't in any recipe", done)
    if step.kind == "double_click" and step.target in NO_DOUBLE_CLICK:
        _refuse(name, n, step, f"{step.target} is never double-clicked", done)
    if step.kind == "key" and step.target not in KEYS:
        _refuse(name, n, step, f"key {step.target!r}", done)
    if step.kind in ("click", "double_click"):
        pos = d.position(step.target)
        for label, (x1, y1, x2, y2) in REFUSED_AREAS.items():
            if pos and x1 <= pos[0] <= x2 and y1 <= pos[1] <= y2:
                _refuse(name, n, step, f"{step.target} is on the {label} button", done)


def _act(step, d, value):
    k = step.kind
    if k == "click":
        d.click(step.target)
    elif k == "double_click":
        d.click(step.target, double=True)
    elif k == "set":
        d.set_text(step.target, value, step.typed)
        if step.enter:
            d.key("{ENTER}")
    elif k == "key":
        d.key(step.target)
    elif k == "pick":
        d.pick(step.target, value)
    elif k == "select_row":
        d.double_click_row(step.target, value)
    elif k == "choose_menu_item":
        d.choose_menu(step.target)
    elif k == "press":
        d.press(step.target)


def _wait(check, d, timeout, now, sleep, retry=None):
    """Poll check until it passes or timeout. retry: (seconds, fn) to call once more if still failing."""
    start = now()
    while True:
        ok, got = check.test(d)
        if ok:
            return True, got
        if now() - start >= timeout:
            return False, got
        if retry and now() - start >= retry[0]:
            retry[1]()
            retry = None
        sleep(POLL)


def run(name, values, d, recipes=None, now=time.monotonic, sleep=time.sleep, on_step=None):
    """Run one recipe. values: draft values for {placeholders}. -> [(step no, say, seconds)].
    on_step(n, say) is called before each step (the panel shows it)."""
    recipe = (recipes or RECIPES)[name]
    allowed = ALLOWED  # always the approved recipes' buttons, never ones a caller passes in
    done = []
    for c in recipe.require:
        c = c.fill(values)
        ok, got = c.test(d)
        if not ok:
            raise StepFailed(name, 0, "", str(c), got, done)
    window = d.dialog()
    for n, step in enumerate(recipe.steps, 1):
        if step.when and not values.get(step.when):
            continue
        target = step.target if step.kind == "key" else step.target.format(**values)  # "{ENTER}" is a key, not a value
        step = Step(step.kind, target, step.value, step.expect, step.say.format(**values),
                    step.typed, step.enter, step.tries, step.timeout, step.when)
        if d.dialog() != window:  # something opened or closed that the last step didn't ask for
            raise StepFailed(name, n, step.say, f"window {window!r}", f"window {d.dialog()!r}", done)
        _guard(name, n, step, d, done, allowed)
        if on_step:
            on_step(n, step.say)
        value = step.value.format(**values)
        start = now()
        _act(step, d, value)
        retry = (RETRY, lambda: _act(step, d, value)) if step.kind == "click" and step.tries > 1 else None
        check = step.expect.fill(values) if step.expect else None
        if check:
            ok, got = _wait(check, d, step.timeout, now, sleep, retry)
            if not ok:
                raise StepFailed(name, n, step.say, str(check), got, done)
        if check and _about_windows(check):
            window = d.dialog()
        elif d.dialog() != window:  # this step wasn't meant to open or close a window
            raise StepFailed(name, n, step.say, f"window {window!r}", f"window {d.dialog()!r}", done)
        done.append((n, step.say, round(now() - start, 2)))
    return done


def _about_windows(check):
    return check.kind in ("dialog", "gone", "no_dialog") or any(_about_windows(p) for p in check.parts)
