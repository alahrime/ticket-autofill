"""A pretend InvoMax for recipe tests, built from what the probe saw (spec 5.1a-5.6).

It keeps box values, a window stack, focus, a popup menu and a fake clock. InvoMax's reactions
can be delayed (`lag` seconds) to test waiting, and every action is recorded in `actions`.
Made-up customers only.
"""


class FakeInvoMax:
    def __init__(self, customers=None, lag=0.0):
        self.t = 0.0
        self.lag = lag
        self.pending = []      # (due time, fn)
        self.fields = {}       # ctl name -> text
        self.windows = []      # open windows, top last
        self.focus = None
        self.menu = []
        self.radios = {}
        self.combo = {}
        self.customers = customers or {"XKS-4827": ("JANE", "DOE", "(555)010-0000")}
        self.actions = []
        self.highlighted = False

    # --- clock (the runner's now/sleep)
    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s
        for due, fn in [p for p in self.pending if p[0] <= self.t]:
            self.pending.remove((due, fn))
            fn()

    def later(self, fn):
        if self.lag:
            self.pending.append((self.t + self.lag, fn))
        else:
            fn()

    # --- driver reads
    def dialog(self):
        return self.windows[-1] if self.windows else None

    def text(self, ctl):
        return self.fields.get(ctl, "")

    def checked(self, ctl):
        return self.radios.get(ctl, False)

    def focused(self):
        return self.focus

    def menu_items(self):
        return list(self.menu)

    def captions(self):
        top = self.dialog()
        if top == "Vehicles":
            return ["Select Engine Later", "Custom Vehicle", "Select", "Cancel"] if self.combo.get("engine_step") \
                else ["Custom Vehicle", "Select", "Cancel"]
        return []

    def position(self, ctl):
        return {"btn.clear": (120, 350), "btn.done": (1310, 350)}.get(ctl)

    # --- driver actions
    def click(self, ctl, double=False):
        self.actions.append(("double_click" if double else "click", ctl))
        if ctl.startswith("customers.by_"):
            for k in [k for k in self.radios if k.startswith("customers.by_")]:
                self.radios[k] = False
            self.radios[ctl] = True
            return
        self.focus = ctl
        if ctl == "name.first" and not self.dialog():
            if double or self.highlighted:
                self.later(lambda: self.windows.append("Customers"))
            self.highlighted = True
        elif ctl == "year_make" and not self.dialog():
            self.later(lambda: self.windows.append("Vehicles"))
        elif ctl == "phone" and double and self.fields.get("phone"):
            self.menu = ["Change Number", "Dial Number"]

    def set_text(self, ctl, value, typed):
        self.actions.append(("set", ctl, value))
        if ctl == "custinfo.phone":  # masked box: "(703)___-____" takes digits
            d = "".join(c for c in value if c.isdigit())
            value = f"({d[:3]}){d[3:6]}-{d[6:10]}"
        self.fields[ctl] = value

    def key(self, keys):
        self.actions.append(("key", keys))
        if keys != "{ENTER}":
            return
        if self.focus == "plate" and not self.fields.get("name.first"):
            hit = self.customers.get(self.fields.get("plate", ""))
            if hit:
                def load():
                    self.fields.update({"name.first": hit[0], "name.last": hit[1], "phone": hit[2]})
                    self.focus = "vin"
                self.later(load)
        elif self.focus == "odometer.in":
            def copy():
                self.fields["odometer.out"] = self.fields["odometer.in"]
                self.focus = "odometer.out"
            self.later(copy)
        elif self.focus == "odometer.out":
            self.focus = "mechanic"

    def pick(self, ctl, text):
        self.actions.append(("pick", ctl, text))
        self.fields[ctl] = text
        if ctl == "vehicles.model":
            self.later(lambda: self.combo.update(engine_step=True))
        elif ctl == "vehicles.engine":
            def close():
                self.windows.remove("Vehicles")
                self.fields["year_make"] = f"{self.fields['vehicles.year']} {self.fields['vehicles.make']}"
                self.focus = "plate"
            self.later(close)

    def double_click_row(self, ctl, text):
        self.actions.append(("double_click_row", ctl, text))

    def choose_menu(self, item):
        self.actions.append(("choose_menu", item))
        self.menu = []
        if item == "Change Number":
            self.fields["phone.text"] = self.fields.get("phone", "")
            self.later(lambda: self.windows.append("Phone Number"))

    def press(self, caption):
        self.actions.append(("press", caption))
        top = self.dialog()
        if top == "Customers" and caption == "Add New":
            self.fields["custinfo.phone"] = "(703)___-____"
            self.later(lambda: self.windows.append("Customer Information"))
        elif top == "Customers" and caption == "Exit":
            self.windows.pop()
        elif top == "Customer Information" and caption == "Save":
            def save():
                self.windows[-2:] = ["Vehicles"]
                self.fields["name.first"] = self.fields.get("custinfo.first", "")
                self.fields["name.last"] = self.fields.get("custinfo.last", "")
                self.fields["phone"] = self.fields.get("custinfo.phone", "")
            self.later(save)
        elif top == "Phone Number" and caption == "OK":
            self.fields["phone"] = self.fields["phone.text"]
            self.windows.pop()
