"""Watch InvoMax and log what changes, so recipes can be written from real use.

Read-only: it never clicks, types, presses Save or deletes anything in InvoMax; the only
file it writes is its own log. It only asks Windows for window
titles, box texts, list selections, check states, the focused box and where the mouse
clicked. Logs hold customer data, so they go to probe/ (git-ignored, stays on this PC).

    python probe.py watch    window with Start / Pause; logs to probe/watch-YYYY-MM-DD.log
    python probe.py map      dump every InvoMax window's controls to probe/map-*.txt
    python probe.py trial    NOT read-only: runs one trial recipe (spec 5.8) with Run; logs to
                             probe/trial-YYYY-MM-DD.log. Dry run is on by default (nothing is sent).
"""
from __future__ import annotations
import ctypes, os, string, sys, threading, time
from collections import namedtuple
from ctypes import wintypes

import recipes as R

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "probe")
MAIN_CLASS = "TINVOICESCREEN"
TEXT_CLASSES = ("Edit", "Combo", "Memo", "DateTime", "Button", "Radio", "Check", "Label", "Static")
CHECK_CLASSES = ("Radio", "Check")
LIST_CLASSES = ("ListBox",)
KEYS = {0x0D: "Enter", 0x09: "Tab", 0x1B: "Esc"}  # only these keys are logged, never characters
MAX_TEXT = 200
SNAP_EVERY = 0.2  # seconds between full reads
TICK = 0.03       # seconds between mouse/key checks
SHOT_CLASSES = ("Tchoicebox", "Tmsgs", "#32768")  # windows whose contents can't be read: save a picture
SHOT_DELAY = 0.4  # seconds after a window opens, so it has finished drawing

WM_GETTEXT, BM_GETCHECK, MN_GETHMENU = 0x0D, 0xF0, 0x01E1
LB_GETCURSEL, LB_GETTEXT, LB_GETTEXTLEN, LB_GETCOUNT = 0x188, 0x189, 0x18A, 0x18B
SMTO_ABORTIFHUNG, GA_ROOT, VK_LBUTTON, MF_BYPOSITION = 2, 2, 0x01, 0x400


# --- pure helpers (tested on any OS)
def clip(s):
    s = (s or "").replace("\r\n", "⏎").replace("\n", "⏎")
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT] + "…"


def name_controls(classes):
    """['TLMDEdit', 'TEdit', 'TLMDEdit'] -> ['TLMDEdit#0', 'TEdit#0', 'TLMDEdit#1']"""
    seen, out = {}, []
    for c in classes:
        out.append(f"{c}#{seen.get(c, 0)}")
        seen[c] = seen.get(c, 0) + 1
    return out


def diff(prev, cur):
    out = [f"+ {k} = {cur[k]!r}" for k in cur if k not in prev]
    out += [f"~ {k}: {prev[k]!r} -> {cur[k]!r}" for k in cur if k in prev and prev[k] != cur[k]]
    out += [f"- {k}" for k in prev if k not in cur]
    return out


# --- Windows reads
_u = None


def _user32():
    global _u
    if _u is None:
        _u = ctypes.WinDLL("user32", use_last_error=True)
        _u.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                          wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
        _u.WindowFromPoint.argtypes = [wintypes.POINT]
        _u.GetAncestor.restype = wintypes.HWND
        _u.WindowFromPoint.restype = wintypes.HWND
    return _u


def _send(h, msg, wp=0, lp=0):
    r = ctypes.c_size_t()
    ok = _user32().SendMessageTimeoutW(h, msg, wp, lp, SMTO_ABORTIFHUNG, 200, ctypes.byref(r))
    return r.value if ok else None


def cls(h):
    b = ctypes.create_unicode_buffer(128)
    _user32().GetClassNameW(h, b, 128)
    return b.value


def text(h):
    b = ctypes.create_unicode_buffer(2048)
    return b.value if _send(h, WM_GETTEXT, 2048, ctypes.addressof(b)) is not None else ""


def pid_of(h):
    p = wintypes.DWORD()
    _user32().GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def _enum(fn, parent=None):
    out = []
    cb = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(lambda h, _: out.append(h) or True)
    (fn(parent, cb, 0) if parent else fn(cb, 0))
    return out


def find_invomax():
    """Main invoice window -> (hwnd, pid), or (None, None)."""
    u = _user32()
    for h in _enum(u.EnumWindows):
        if u.IsWindowVisible(h) and cls(h) == MAIN_CLASS:
            return h, pid_of(h)
    return None, None


def top_windows(pid):
    u = _user32()
    return [h for h in _enum(u.EnumWindows) if u.IsWindowVisible(h) and pid_of(h) == pid]


def win_key(h):
    c = cls(h)
    if c == MAIN_CLASS:  # its title blanks for a moment on every redraw; keep one name
        return f"InvoMax [{c}]"
    return f"{text(h) or '(no title)'} [{c}]"


def rect_rel(h, top):
    r, t = wintypes.RECT(), wintypes.RECT()
    _user32().GetWindowRect(h, ctypes.byref(r))
    _user32().GetWindowRect(top, ctypes.byref(t))
    return r.left - t.left, r.top - t.top, r.right - r.left, r.bottom - r.top


def controls(top):
    """Visible descendants -> [(key, hwnd, class)]; key is class#n in Windows' child order."""
    u = _user32()
    hs = [h for h in _enum(u.EnumChildWindows, top) if u.IsWindowVisible(h)]
    cs = [cls(h) for h in hs]
    return list(zip(name_controls(cs), hs, cs))


def menu_items(h):
    """Items of an open popup menu window (#32768)."""
    u = _user32()
    m = _send(h, MN_GETHMENU)
    if not m:
        return []
    b, out = ctypes.create_unicode_buffer(256), []
    for i in range(u.GetMenuItemCount(wintypes.HMENU(m))):
        u.GetMenuStringW(wintypes.HMENU(m), i, b, 256, MF_BYPOSITION)
        out.append(b.value.replace("&", ""))
    return out


def list_state(h):
    n = _send(h, LB_GETCOUNT)
    i = _send(h, LB_GETCURSEL)
    if n is None or i is None:
        return None
    i = ctypes.c_int(i).value
    sel = ""
    if 0 <= i < n and (_send(h, LB_GETTEXTLEN, i) or 0) < 500:
        b = ctypes.create_unicode_buffer(512)
        _send(h, LB_GETTEXT, i, ctypes.addressof(b))
        sel = b.value
    return f"{n} rows, selected {i}: {clip(sel)}"


def focused(pid):
    class GUITHREADINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD), ("hwndActive", wintypes.HWND),
                    ("hwndFocus", wintypes.HWND), ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
                    ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND), ("rcCaret", wintypes.RECT)]
    main, _ = find_invomax()
    if not main:
        return None
    gi = GUITHREADINFO(cbSize=ctypes.sizeof(GUITHREADINFO))
    tid = _user32().GetWindowThreadProcessId(main, None)
    return gi.hwndFocus if _user32().GetGUIThreadInfo(tid, ctypes.byref(gi)) else None


def snapshot(pid):
    """-> (state dict, {hwnd: 'window / control key'}) for every visible InvoMax window."""
    state, names = {}, {}
    for top in top_windows(pid):
        w = win_key(top)
        state[f"window {w}"] = "open"
        names[top] = w
        if cls(top) == "#32768":
            state[f"window {w}"] = "menu: " + " | ".join(menu_items(top))
            continue
        for key, h, c in controls(top):
            names[h] = f"{w} / {key}"
            if any(x in c for x in LIST_CLASSES):
                v = list_state(h)
            elif any(x in c for x in CHECK_CLASSES):
                v = f"{clip(text(h))}: {'checked' if _send(h, BM_GETCHECK) == 1 else 'unchecked'}"
            elif any(x in c for x in TEXT_CLASSES):
                v = clip(text(h))
            else:
                continue
            if v is not None:
                state[f"{w} / {key}"] = v
    f = focused(pid)
    if f:
        state["focus"] = names.get(f, cls(f))
    return state, names


def save_picture(h, folder):
    """Picture of one window (screen pixels inside its rectangle) -> file name, or None if it's gone."""
    from PIL import ImageGrab
    u = _user32()
    r = wintypes.RECT()
    if not u.IsWindowVisible(h) or not u.GetWindowRect(h, ctypes.byref(r)) or r.right <= r.left:
        return None
    os.makedirs(folder, exist_ok=True)
    name = time.strftime("%H%M%S") + f"-{cls(h).strip('#')}.png"
    ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom), all_screens=True).save(os.path.join(folder, name))
    return name


def map_lines(top):
    lines = [f"WINDOW {win_key(top)} rect={rect_rel(top, top)}"]
    for key, h, c in controls(top):
        lines.append(f"  {key:24} rel={rect_rel(h, top)} text={clip(text(h))!r}")
    return lines


# --- modes
def _stamp():
    t = time.time()
    return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int(t % 1 * 1000):03d}"


def do_map():
    _, pid = find_invomax()
    if not pid:
        sys.exit("InvoMax isn't open.")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, time.strftime("map-%Y%m%d-%H%M%S.txt"))
    with open(path, "w", encoding="utf-8") as f:
        for top in top_windows(pid):
            f.write("\n".join(map_lines(top)) + "\n\n")
    print("wrote", path)


class Watcher:
    """One watch session: step() is called every TICK seconds and logs what changed."""

    def __init__(self, path):
        self.log = open(path, "a", encoding="utf-8")
        self.prev, self.names, self.pid, self.last, self.down = {}, {}, None, 0.0, {}
        self.count = 0
        self.shots = []  # (due time, hwnd) of windows to picture once drawn
        self.shot_dir = os.path.join(os.path.dirname(path), "shots")

    def write(self, line):
        self.log.write(f"{_stamp()}  {line}\n")
        self.log.flush()
        self.count += 1

    def close(self):
        self.write("--- watch stopped")
        self.log.close()

    def step(self):
        u = _user32()
        now = time.monotonic()
        if now - self.last >= SNAP_EVERY:
            self.last = now
            _, p = find_invomax()
            if p != self.pid:
                self.write("InvoMax found" if p else "InvoMax not open")
                self.pid, self.prev = p, {}
            if self.pid:
                try:
                    cur, self.names = snapshot(self.pid)
                except OSError:
                    cur = self.prev
                for line in diff(self.prev, cur):
                    self.write(line)
                    if line.startswith("+ window "):
                        top = next((h for h, n in self.names.items() if line.startswith(f"+ window {n} =")), None)
                        if top and cls(top) in SHOT_CLASSES:
                            self.shots.append((now + SHOT_DELAY, top))
                        elif top and "[#32768]" not in line:
                            for m in map_lines(top):
                                self.write("    " + m)
                self.prev = cur
            for due, h in [x for x in self.shots if x[0] <= now]:
                self.shots.remove((due, h))
                name = save_picture(h, self.shot_dir)
                if name:
                    self.write(f"picture: shots/{name}")
        if not self.pid:
            return
        fg = u.GetForegroundWindow()
        for vk, label in [(VK_LBUTTON, "click")] + list(KEYS.items()):
            is_down = bool(u.GetAsyncKeyState(vk) & 0x8000)
            if is_down and not self.down.get(vk) and pid_of(fg) == self.pid:
                if vk == VK_LBUTTON:
                    pt = wintypes.POINT()
                    u.GetCursorPos(ctypes.byref(pt))
                    h = u.WindowFromPoint(pt)
                    top = u.GetAncestor(h, GA_ROOT)
                    if h and pid_of(h) == self.pid:
                        tr = wintypes.RECT()
                        u.GetWindowRect(top, ctypes.byref(tr))
                        self.write(f"click at ({pt.x - tr.left},{pt.y - tr.top}) in {self.names.get(top, win_key(top))}"
                                   f" on {self.names.get(h, cls(h))}")
                else:
                    f = focused(self.pid)
                    self.write(f"key {label} in {self.names.get(f, cls(f)) if f else win_key(fg)}")
            self.down[vk] = is_down


def do_watch():
    """Small always-on-top window: Start, then Pause / Resume. Nothing is logged until Start."""
    import tkinter as tk
    from tkinter import ttk
    path = os.path.join(OUT, time.strftime("watch-%Y-%m-%d.log"))
    root = tk.Tk()
    root.title("InvoMax probe")
    root.attributes("-topmost", True)
    root.resizable(False, False)
    status = tk.StringVar(value="Not started. Read-only: never clicks, types or saves in InvoMax.")
    ttk.Label(root, textvariable=status, wraplength=260).pack(padx=8, pady=(8, 4))
    btn = ttk.Button(root, text="▶ Start watching")
    btn.pack(fill="x", padx=8, pady=(0, 8))
    st = {"w": None, "on": False}

    def toggle():
        if st["w"] is None:
            os.makedirs(OUT, exist_ok=True)
            st["w"] = Watcher(path)
            st["w"].write("--- watch started")
        else:
            st["w"].write("--- resumed" if not st["on"] else "--- paused")
        st["on"] = not st["on"]
        btn.config(text="⏸ Pause" if st["on"] else "▶ Resume")
        if not st["on"]:
            status.set(f"Paused. {st['w'].count} lines in {os.path.basename(path)}")

    def loop():
        if st["on"]:
            try:
                st["w"].step()
                status.set(f"Watching… {st['w'].count} lines in {os.path.basename(path)}")
            except Exception as e:
                st["w"].write(f"probe error: {e!r}")
                toggle()
                status.set(f"Paused after an error: {e}")
        root.after(int(TICK * 1000), loop)

    def close():
        if st["w"]:
            st["w"].close()
        root.destroy()

    btn.config(command=toggle)
    root.protocol("WM_DELETE_WINDOW", close)
    loop()
    root.mainloop()


# --- trial mode (spec 5.8): one recipe for real, every step's check and timing logged
# HANDOFF "Next" 3 stage order: the vehicle stages need the customer the plate lookup loads.
TRIAL_RECIPES = ("customer_search", "customers_exit", "customer_by_plate", "odometer", "vehicle_open",
                 "vehicles_cancel")
CHOICES = {"by": ("license", "last_name", "first_name", "phone", "code", "business_name")}
DRY_RUN_DEFAULT = True      # and it goes back ON after every live run
COPYBACK_DEFAULT = False    # copy-back types Ctrl+A, Ctrl+C into InvoMax: owner's OK first
IDLE_MS = 600               # nobody touched the mouse or keyboard for this long before a run starts
IDLE_GIVE_UP = 15.0         # seconds to wait for that before giving up
NOTHING_SENT = "Nothing was sent to InvoMax."
Row = namedtuple("Row", "n say check seen ms result")


def placeholders(recipe):
    """{names} a recipe needs, in order of first use (require checks, then steps; key steps' {ENTER} isn't one)."""
    out = []

    def scan(s):
        for _, name, _, _ in string.Formatter().parse(s or ""):
            if name and name not in out:
                out.append(name)

    def scan_check(c):
        if c:
            scan(c.a), scan(c.b)
            for p in c.parts:
                scan_check(p)
    for c in recipe.require:
        scan_check(c)
    for s in recipe.steps:
        if s.kind != "key":
            scan(s.target)
        scan(s.value), scan(s.say), scan_check(s.expect)
        if s.when and s.when not in out:
            out.append(s.when)
    return out


def step_checks(recipe, values):
    """-> {step no: its check filled with values, or None}."""
    return {n: (s.expect.fill(values) if s.expect else None) for n, s in enumerate(recipe.steps, 1)}


def start_rule(recipe):
    """-> (dialog that must be on top or None, needs a customer on screen) from the recipe's require."""
    want = next((c.a for c in recipe.require if c.kind == "dialog"), None)
    customer = any(c.kind == "filled" and c.a == "name.first" for c in recipe.require)
    return want, customer


def needs_text(recipe):
    want, customer = start_rule(recipe)
    if want:
        return f"Needs the {want} window open on the invoice."
    if customer:
        return "Needs a customer on the invoice; uses the customer on screen."
    return "Needs an empty invoice with no window open on it."


def start_check(recipe, seen):
    """seen: {"invoice": bool, "error": str, "window": why the invoice window isn't ready or None,
    "dialog": title|None, "name.first": str, "name.last": str} (from read_start) -> (ok, message).
    Refuses unless InvoMax shows what this recipe starts from."""
    if not seen.get("invoice"):
        return False, seen.get("error") or "InvoMax isn't open."
    if seen.get("window"):
        return False, f"{seen['window']}. Maximize InvoMax on the main screen first."
    if seen.get("error"):
        return False, f"couldn't read the invoice: {seen['error']}"
    want, customer = start_rule(recipe)
    top = seen.get("dialog")
    first, last = (seen.get("name.first") or "").strip(), (seen.get("name.last") or "").strip()
    if want:
        if top != want:
            return False, f"the {want} window isn't open on top (on top: {top or 'the invoice'})."
        return True, f"Uses the {want} window on screen."
    if top:
        return False, f"close the {top!r} window first; the invoice must have nothing open on it."
    if customer:
        if not first:
            return False, "this recipe needs a customer on the invoice; Name is empty."
        return True, "Uses the customer on screen."
    if first or last:
        return False, "the invoice isn't empty (Name has a customer). Clear it by hand first."
    return True, "Empty invoice."


def read_start(d, window_problem=None):
    """Read-only: what start_check needs, through the driver (WM_GETTEXT reads of the Name boxes).
    window_problem() -> why the invoice window isn't ready for actions (invomax.window_ok), or None."""
    try:
        seen = {"invoice": True, "dialog": d.dialog()}
        if window_problem:
            seen["window"] = window_problem()
    except RuntimeError as e:
        return {"invoice": False, "error": str(e)}
    try:
        seen["name.first"] = d.text("name.first")
        seen["name.last"] = d.text("name.last")
    except RuntimeError as e:
        seen["error"] = str(e)
    return seen


def read_after(d):
    """Read-only, after a live run: what the trial left on screen. -> {"dialog", "name.first"} or {"error"}."""
    try:
        return {"dialog": d.dialog(), "name.first": d.text("name.first")}
    except Exception as e:  # noqa: BLE001 - shown as "check by hand"
        return {"error": str(e)}


def leftovers(after):
    """What staff must undo by hand after a live run, from read_after."""
    if after.get("error"):
        return [f"Couldn't read InvoMax after the run ({clip(after['error'])}). "
                "Check it and clear by hand anything the trial left."]
    out = []
    if after.get("dialog"):
        out.append(f"Close the {after['dialog']} window by hand (or run customers_exit / vehicles_cancel).")
    if (after.get("name.first") or "").strip():
        out.append("Clear the invoice by hand (the tool never presses Clear).")
    return out or ["Nothing is left on the invoice."]


def missing_values(names, values):
    return [n for n in names if not (values.get(n) or "").strip()]


def wait_idle(idle_ms, emergency, now=time.monotonic, sleep=time.sleep, need=IDLE_MS, give_up=IDLE_GIVE_UP):
    """Wait until nobody has used the mouse or keyboard for need ms. -> None to go, else why not.
    The emergency stop always wins."""
    start = now()
    while True:
        if emergency():
            return "stopped: emergency stop before the start (Esc held or mouse in the top-left corner)"
        if idle_ms() >= need:
            return None
        if now() - start >= give_up:
            return f"didn't start: the mouse or keyboard kept being used for {give_up:.0f} s"
        sleep(0.05)


class _Replay:
    """Answers a check from what the driver last returned, so 'seen' is logged without reading InvoMax again."""

    def __init__(self, seen):
        self.seen = seen

    def _get(self, key):
        if key not in self.seen:
            raise RuntimeError("not read during this step")
        ok, v = self.seen[key]
        if not ok:
            raise v
        return v

    def dialog(self): return self._get(("dialog",))
    def focused(self): return self._get(("focused",))
    def menu_items(self): return self._get(("menu_items",))
    def captions(self): return self._get(("captions",))
    def text(self, ctl): return self._get(("text", ctl))
    def checked(self, ctl): return self._get(("checked", ctl))


class Stopped(RuntimeError):
    refused = True  # recipes.run stops at once on this


class Recorder:
    """Wraps the driver for recipes.run: passes everything through and remembers the last result of each read.
    emergency() is checked on every read too, so Esc stops a run while a check is still polling."""

    def __init__(self, d, emergency=None):
        self._d, self._seen, self._emergency = d, {}, emergency

    def __getattr__(self, name):
        return getattr(self._d, name)

    def _rec(self, key, fn, *a):
        if self._emergency and self._emergency():
            why = "emergency stop (Esc held or mouse in the top-left corner)"
            if hasattr(self._d, "stopped"):
                self._d.stopped = self._d.stopped or why  # the driver refuses everything after this
            raise Stopped(f"Stopped: {why}.")
        try:
            v = fn(*a)
        except Exception as e:
            self._seen[key] = (False, e)
            raise
        self._seen[key] = (True, v)
        return v

    def take(self):
        """-> a replay of the reads since the last take()."""
        r, self._seen = _Replay(self._seen), {}
        return r

    def dialog(self): return self._rec(("dialog",), self._d.dialog)
    def focused(self): return self._rec(("focused",), self._d.focused)
    def menu_items(self): return self._rec(("menu_items",), self._d.menu_items)
    def captions(self): return self._rec(("captions",), self._d.captions)
    def text(self, ctl): return self._rec(("text", ctl), self._d.text, ctl)
    def checked(self, ctl): return self._rec(("checked", ctl), self._d.checked, ctl)


def _seen(check, replay):
    if check is None:
        return "-"
    if replay is None:
        return "not read"
    try:
        return check.test(replay)[1]
    except Exception as e:  # a recorded refusal
        return f"error: {e}"


def classify(exc):
    """Exception from a trial (None = it passed) -> 'OK' | 'stopped' | 'StepFailed' | 'Refused' | 'error'."""
    if exc is None:
        return "OK"
    if "emergency stop" in str(exc):
        return "stopped"
    if isinstance(exc, R.StepFailed):
        return "StepFailed"
    if getattr(exc, "refused", False):
        return "Refused"
    return "error"


def run_trial(name, values, d, now=time.monotonic, sleep=time.sleep, emergency=None):
    """Run one recipe once through recipes.run. Never retries, never acts after a failure.
    -> (rows [Row], kind from classify, the exception or None)."""
    recipe = R.RECIPES[name]
    checks = step_checks(recipe, values)
    say = {n: s.say.format(**values) for n, s in enumerate(recipe.steps, 1)}
    rec = Recorder(d, emergency)
    snaps, marks, cur = {}, {}, [None]

    def on_step(n, _say):
        r = rec.take()
        if cur[0] is not None:
            snaps[cur[0]] = r
        cur[0], marks[n] = n, now()

    exc = None
    try:
        done = R.run(name, values, rec, now=now, sleep=sleep, on_step=on_step)
        if cur[0] is not None:
            snaps[cur[0]] = rec.take()
    except R.StepFailed as e:
        exc, done = e, list(e.done)
    except Exception as e:
        # outside a step's try: the require checks (cur is None), or the window reads after step cur's check
        # passed / before the next step. Step cur did its action and passed its check, so it counts as done.
        exc = e
        if cur[0] is not None:
            snaps[cur[0]] = rec.take()
        done = [(n, say[n], None) for n in sorted(snaps)]
    rows = []
    for n, s, secs in done:
        ms = round(secs * 1000) if secs is not None else round((marks.get(n + 1, now()) - marks[n]) * 1000)
        rows.append(Row(n, say[n], str(checks[n]) if checks[n] else "-", _seen(checks[n], snaps.get(n)), ms, "ok"))
    if isinstance(exc, R.StepFailed):
        ms = round((now() - marks[exc.step_no]) * 1000) if exc.step_no in marks else 0
        rows.append(Row(exc.step_no, exc.say or "start checks", exc.expected, exc.got, ms, "failed"))
    elif exc is not None:
        n = (cur[0] or 0) + 1 if cur[0] else 0
        if not n:
            what, check = "start checks", "-"
        elif n in say:
            what, check = say[n], str(checks[n]) if checks[n] else "-"
        else:
            what, check = "after the last step", "-"
        rows.append(Row(n, what, check, f"{type(exc).__name__}: {exc}", 0, classify(exc)))
    return rows, classify(exc), exc


def step_line(recipe, row):
    return (f"{recipe} step {row.n}: {row.say} | check: {row.check} | saw: {clip(row.seen)} | "
            f"{row.ms} ms | {row.result}")


def final_line(recipe, kind, exc, rows):
    done = sum(1 for r in rows if r.result == "ok")
    if kind == "OK":
        return f"{recipe} final: OK ({done} steps)"
    if isinstance(exc, R.StepFailed):
        where = f"step {exc.step_no} ({exc.say})" if exc.step_no else "before starting"
        return f"{recipe} final: {kind} at {where}: saw {clip(exc.got)}; {done} steps done"
    return f"{recipe} final: {kind}: {clip(str(exc))}; {done} steps done"


def result_lines(recipe, kind, exc, rows, dry_run, sent, after=None):
    """What the trial window shows after a run. sent: input reached InvoMax (a live run whose driver acted);
    after: read_after() for live runs that sent input."""
    head = f"{recipe}: {kind}"
    out = [head + (" (dry run)" if dry_run else "")]
    for r in rows:
        if r.result == "ok":
            out.append(f"  ✓ {r.n}. {r.say}  {r.ms} ms")
        else:
            out.append(f"  ✗ {r.n}. {r.say}  ({r.result} after {r.ms} ms)")
            out.append(f"      expected: {r.check}")
            out.append(f"      saw: {clip(r.seen)}")
    if kind != "OK":
        if exc is not None and not rows:
            out.append(f"  {clip(str(exc))}")
        out.append("Stopped here; nothing more was pressed and nothing is retried.")
    if sent:
        out += leftovers(after or {"error": "not read"})
    else:
        out.append(NOTHING_SENT)
    return out


class TrialLog:
    def __init__(self, path):
        self.path, self.lock = path, threading.Lock()

    def write(self, line):
        """Best effort: a log that can't be written never hides a result."""
        try:
            with self.lock:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(f"{_stamp()}  {line}\n")
        except Exception:  # noqa: BLE001
            pass


def trial_work(name, values, dry_run, copyback, make_win, make_driver, log, now=time.monotonic,
               sleep=time.sleep):
    """The worker thread's job: wait for idle input, run once, read what's left (live runs), log.
    Never raises. -> (name, rows, kind, exc, dry_run, sent, after)."""
    rows, kind, exc, sent, after, d = [], "error", None, False, None, None
    try:
        w = make_win()  # fresh per run: its clipboard owner window belongs to this thread
        d = make_driver(w, dry_run, copyback)
        emergency = lambda: w.esc_down() or w.in_stop_corner()
        why = wait_idle(w.idle_ms, emergency, now, sleep)
        if why:
            exc = RuntimeError(why)
            kind = "stopped" if why.startswith("stopped") else "error"
        else:
            rows, kind, exc = run_trial(name, values, d, now, sleep, emergency=emergency)
            sent = not dry_run and bool(getattr(d, "done", None))
            if sent:
                after = read_after(d)
    except Exception as e:  # noqa: BLE001 - shown and logged, never retried
        kind, exc = "error", e
        sent = not dry_run and bool(getattr(d, "done", None))  # it may have acted before failing
    try:  # best effort: a log failure never hides the result
        for r in rows:
            log(step_line(name, r))
        log(final_line(name, kind, exc, rows))
        if after is not None:
            log(f"{name} after: {after}")
    except Exception:  # noqa: BLE001
        pass
    return name, rows, kind, exc, dry_run, sent, after


def do_trial():
    """Small always-on-top window: pick a trial recipe, fill its values, Run. One run per click."""
    import tkinter as tk
    from tkinter import ttk, messagebox
    import invomax
    log = TrialLog(os.path.join(OUT, time.strftime("trial-%Y-%m-%d.log")))
    names = [n for n in TRIAL_RECIPES if n in R.RECIPES]
    reader = invomax.Win32()  # reads only (start checks); also makes this process DPI aware before Tk starts
    root = tk.Tk()
    root.title("InvoMax trial")
    root.attributes("-topmost", True)
    root.resizable(False, False)
    tk.Label(root, text="STOP: hold Esc or push the mouse into the top-left corner to stop",
             fg="white", bg="#b00020", font=("Segoe UI", 12, "bold"), wraplength=340, padx=6, pady=6
             ).pack(fill="x", padx=8, pady=(8, 6))
    pick = tk.StringVar(value=names[0])
    ttk.Combobox(root, textvariable=pick, values=names, state="readonly").pack(fill="x", padx=8)
    needs = tk.StringVar()
    ttk.Label(root, textvariable=needs, wraplength=340).pack(anchor="w", padx=8, pady=(2, 4))
    box = ttk.Frame(root)
    box.pack(fill="x", padx=8)
    vals = {}  # placeholder -> StringVar, kept across recipe changes
    dry = tk.BooleanVar(value=DRY_RUN_DEFAULT)
    copyback = tk.BooleanVar(value=COPYBACK_DEFAULT)

    def dry_changed():
        if not dry.get() and not messagebox.askyesno("Live run", f"Run {pick.get()} LIVE on InvoMax?", parent=root):
            dry.set(True)

    ttk.Checkbutton(root, text="Dry run (nothing is sent to InvoMax)", variable=dry,
                    command=dry_changed).pack(anchor="w", padx=8)
    ttk.Checkbutton(root, text="Allow copy-back", variable=copyback).pack(anchor="w", padx=8)
    tk.Label(root, text="Copy-back presses Ctrl+A, Ctrl+C in an InvoMax box and puts the clipboard back. "
             "Only with the owner's OK.", fg="#b00020", wraplength=340, justify="left").pack(anchor="w", padx=8)
    btn = ttk.Button(root, text="▶ Run")
    btn.pack(fill="x", padx=8, pady=6)
    out = tk.Text(root, width=52, height=12, wrap="word", state="disabled")
    out.pack(padx=8, pady=(0, 8))

    def show(lines):
        out.config(state="normal")
        out.delete("1.0", "end")
        out.insert("end", "\n".join(lines))
        out.config(state="disabled")

    def changed(*_):
        dry.set(True)  # a live run is confirmed for one named recipe
        recipe = R.RECIPES[pick.get()]
        needs.set(needs_text(recipe))
        for w in box.winfo_children():
            w.destroy()
        for i, p in enumerate(placeholders(recipe)):
            v = vals.setdefault(p, tk.StringVar(value=CHOICES.get(p, ("",))[0]))
            ttk.Label(box, text=p).grid(row=i, column=0, sticky="w", padx=(0, 6), pady=1)
            if p in CHOICES:
                ttk.Combobox(box, textvariable=v, values=CHOICES[p], state="readonly", width=24).grid(row=i, column=1)
            else:
                ttk.Entry(box, textvariable=v, width=26).grid(row=i, column=1)

    st = {"result": None}

    def restore():
        root.deiconify()
        root.attributes("-topmost", True)
        btn.config(state="normal")

    def run():
        try:
            name = pick.get()
            recipe = R.RECIPES[name]
            values = {p: vals[p].get().strip() for p in placeholders(recipe)}
            miss = missing_values(list(values), values)
            if miss:
                show([f"Fill in: {', '.join(miss)}"])
                return
            is_dry, cb = dry.get(), copyback.get()
            d = invomax.Driver(win=reader, dry_run=True, allow_copyback=False)  # start checks only read

            def window_problem():
                h = reader.invoice()
                return invomax.window_ok(reader.rect(h), reader.zoomed(h)) if h else None
            ok, msg = start_check(recipe, read_start(d, window_problem))
            if not ok:
                log.write(f"--- {name} not started: {msg}")
                show([f"Didn't start: {msg}", NOTHING_SENT])
                return
            log.write(f"--- trial {name} {values} dry_run={is_dry} copyback={cb}; {msg}")
            btn.config(state="disabled")
            root.withdraw()

            def make_driver(w, dry_run, allow_copyback):
                return invomax.Driver(win=w, dry_run=dry_run, allow_copyback=allow_copyback,
                                      log=lambda s: log.write(f"  driver: {s}"))

            def work():
                res = None
                try:
                    res = trial_work(name, values, is_dry, cb, invomax.Win32, make_driver, log.write)
                finally:
                    st["result"] = res or (name, [], "error", RuntimeError("the trial stopped unexpectedly"),
                                           is_dry, False, None)

            threading.Thread(target=work, daemon=True).start()
            poll()
        except Exception as e:  # noqa: BLE001 - nothing is retried; the window always comes back
            log.write(f"--- trial error before the run: {e!r}")
            restore()
            show([f"Error: {e}", NOTHING_SENT])

    def poll():
        if st["result"] is None:
            root.after(100, poll)
            return
        name, rows, kind, exc, was_dry, sent, after = st["result"]
        st["result"] = None
        if not was_dry:
            dry.set(True)  # every live run is confirmed again
        restore()
        show(result_lines(name, kind, exc, rows, was_dry, sent, after))

    pick.trace_add("write", changed)
    btn.config(command=run)
    changed()
    show(["Pick a recipe, fill its values, then Run.", "Each Run runs it once; nothing is retried."])
    root.mainloop()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "watch"
    if mode == "map":
        do_map()
    elif mode == "watch":
        do_watch()
    elif mode == "trial":
        do_trial()
    else:
        sys.exit(__doc__)
