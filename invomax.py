"""The real InvoMax driver for the recipe runner (recipes.py), plus a read-only check.

    python invomax.py check    read-only: print what dialog(), focused() and text() see right now

`Driver` implements the interface in the recipes.py docstring. Reads use plain Windows messages
(WM_GETTEXT, BM_GETCHECK, CB_GETLBTEXT, GetGUIThreadInfo), the same calls as probe.py. Clicks are one
SendInput batch; typing goes through pywinauto's send_keys in short chunks. It is safe by default:
  - dry_run=True: every action is logged ("would click ...") and nothing is sent to InvoMax;
  - allow_copyback=False: the TLMDEdit header boxes (Plate, VIN, Odometer...) can't be read with
    WM_GETTEXT; reading them needs copy-back (Ctrl+A, Ctrl+C, read, restore the clipboard), which
    types into InvoMax, so it stays off until the owner says yes.
Before every piece of input (each click, each chunk of up to 4 typed characters) it checks again:
  - the invoice window (TINVOICESCREEN) is maximized at 1936 x 1056;
  - the window meant to get the input is on top and in the foreground, with no menu or dropdown open;
  - a click lands on its own control (or the mapped class for a fixed spot), never in REFUSED_AREAS, the
    button row, a per-dialog refused area, or on a control whose caption is on the NEVER list;
  - typing goes to the expected box, never a button;
  - nobody touched the mouse or keyboard in the last 0.5 s, Esc isn't held and the mouse isn't in the
    top-left screen corner (the emergency stop).
Any refusal or error during an action latches the driver: it refuses everything after that.

Control positions and indices come from probe/map-*.txt and the 2026-10-27 watch log (spec 4, 5.x).
"""
from __future__ import annotations
import functools, re, sys, time
from dataclasses import dataclass

from recipes import NEVER, REFUSED_AREAS, KEYS, ALLOWED, norm, no_double_click

INVOICE_CLASS = "TINVOICESCREEN"
INVOICE_SIZE = (1936, 1056)
BUTTON_ROW = (10, 322, 1926, 374)          # TPanel#3: the caption-less button row (Clear ... Done)
BUTTON_ROW_OK = set()                      # button-row spots a click may land on: none until a recipe needs one
# Fixed spots (rel locators) a click may use. Anything else on a panel may be a drawn button.
SPOT_OK = {"customers.add_new", "custinfo.save"}
# Dialog-relative areas (x1, y1, x2, y2) no click may land in, from the probe maps where known.
DIALOG_REFUSED_AREAS = {
    "Vehicles": {"Custom Vehicle (first step)": (151, 461, 300, 488)},
}
# Single words that make a caption refused, wherever they appear; "change number" is the only exception.
NEVER_WORDS = {"continue", "quote", "void", "erase", "done", "charge", "print", "clear", "delete", "dial",
               "custom", "change"}
NEVER_EXCEPTIONS = {"change number"}
# press() / choose_menu() captions the driver accepts, per window (also checked against recipes.ALLOWED).
PRESS_OK = {("Customers", "add new"), ("Customers", "exit"), ("Customer Information", "save"),
            ("Phone Number", "ok"), ("Vehicles", "cancel"),
            ("Confirm", "no")}  # No only right after Cancel in Vehicles, in a Yes/No box (_guard_confirm_no)
MENU_OK = {"change number"}
RECT_SLACK = 4                             # px a class+index control may sit away from its mapped rect
COPYBACK_CLASSES = ("TLMDEdit",)           # answer neither WM_GETTEXT nor UI Automation
CHUNK = 1                                  # characters typed between two safety checks
# Only these keys are ever sent: one plain character (escaped for send_keys), Enter, Tab, and the copy-back
# Ctrl+A Ctrl+C. Trials 2026-11-03: End, Shift+Home and Backspace in Odometer In each run cleared the
# whole invoice (twice; focus jumped to the parts grid a moment later, after the per-key guard had passed).
SENDABLE = {"{ENTER}", "{TAB}", "^a^c"}
RECENT_INPUT_MS = 500                      # someone used the mouse/keyboard this recently: refuse
FOCUS_WAIT = 1.0                           # seconds a click has to put the focus in its box
# Top-level windows of the InvoMax process that are never "the dialog on top".
NOT_DIALOGS = {INVOICE_CLASS, "TApplication", "TLMDShapeHintWindow", "SysShadow", "ComboLBox", "#32768",
               "tooltips_class32"}
POPUPS = {"#32768", "ComboLBox"}           # an open menu or dropdown list: no input while one is open


class NotMapped(RuntimeError):
    def __init__(self, name):
        super().__init__(f"not mapped yet: {name}")
        self.name = name


class NotReadable(RuntimeError):
    pass


class Refused(RuntimeError):
    refused = True  # recipes.run stops at once on this, instead of polling on


@dataclass(frozen=True)
class Loc:
    """Where a control is. window: dialog title, or None for the invoice window.
    Either cls + index (+ rect, the window-relative (x, y, w, h) it was mapped at, checked on use),
    cls + caption (radio buttons), or rel: an (x, y) point in the window, measured at at_size, with
    `under` the class Windows must report at that point. confirmed=False: readable, never acted on."""
    window: str | None = None
    cls: str = ""
    index: int | None = None
    rect: tuple | None = None
    caption: str = ""
    rel: tuple | None = None
    at_size: tuple | None = None
    under: str = ""
    confirmed: bool = True

    @property
    def needs_copyback(self):
        return self.cls in COPYBACK_CLASSES

    @property
    def readable(self):
        return bool(self.cls) and self.rel is None


def _inv(cls, index, rect, confirmed=True):
    return Loc(None, cls, index, rect, confirmed=confirmed)


def _in(window, cls, index, rect):
    return Loc(window, cls, index, rect)


def _radio(caption, rect):
    return Loc("Customers", "TRadioButton", caption=caption, rect=rect)


def _spot(window, x, y, under, at_size=None):
    return Loc(window, rel=(x, y), under=under, at_size=at_size or (INVOICE_SIZE if window is None else None))


# Names used by recipes.py -> locator; None = not mapped yet (the driver raises NotMapped).
CONTROLS = {
    # invoice header (map-20261027 rects; TLMDEdit boxes need copy-back to read)
    "name.first": _inv("TEdit", 2, (214, 184, 141, 28)),
    "name.last": _inv("TEdit", 1, (373, 184, 201, 28)),
    "plate": _inv("TLMDEdit", 6, (1468, 247, 110, 28)),
    "vin": _inv("TLMDEdit", 1, (1603, 249, 169, 26)),
    "year_make": _inv("TLMDEdit", 8, (1468, 186, 366, 26)),
    "eng_specs": _inv("TLMDEdit", 7, (1468, 218, 348, 26)),
    "odometer.in": _inv("TLMDEdit", 5, (1468, 283, 73, 26)),
    "odometer.out": _inv("TLMDEdit", 4, (1553, 283, 69, 26)),
    "mechanic": _inv("TLMDEdit", 2, (1659, 283, 164, 26)),
    # invoice date (owner pointed it out 2026-11-03; read only: never clicked or typed into)
    "date": _inv("TLMDMaskEdit", 0, (1506, 130, 117, 27), confirmed=False),
    # first Phones box: placed by layout in the map (left column, Phones row); no probe click confirms it,
    # so it can be read but not clicked or typed into
    "phone": _inv("TLMDEdit", 10, (212, 286, 197, 26), confirmed=False),
    # caption-less button row, window-relative centres (probe click log); none is in SPOT_OK
    "btn.clear": _spot(None, 125, 352, "TPanel"),
    "btn.labor": _spot(None, 470, 352, "TPanel"),
    "btn.vehicle_history": _spot(None, 775, 352, "TPanel"),
    "btn.done": _spot(None, 1315, 352, "TPanel"),
    # Customers (Tshow_customer, 640 x 504)
    "customers.search": _in("Customers", "TLMDEdit", 0, (19, 39, 209, 27)),
    "customers.by_first_name": _radio("First Name", (243, 34, 89, 17)),
    "customers.by_last_name": _radio("Last Name", (243, 55, 89, 17)),
    "customers.by_phone": _radio("Phone", (371, 34, 65, 17)),
    "customers.by_license": _radio("License", (371, 55, 73, 17)),
    "customers.by_code": _radio("By Code", (244, 74, 80, 17)),
    "customers.by_business_name": _radio("Business Name", (372, 74, 128, 17)),
    "customers.add_new": _spot("Customers", 137, 475, "Tshow_customer", (640, 504)),
    "customers.exit": None,           # caption-less; never clicked in the probe log
    "customers.list": None,           # drawn TStringGrid, rows can't be read
    # Customer Information (Tcusindexcard, 794 x 588)
    "custinfo.first": _in("Customer Information", "TEdit", 11, (114, 34, 160, 24)),
    "custinfo.last": _in("Customer Information", "TEdit", 10, (311, 34, 225, 24)),
    "custinfo.phone": _in("Customer Information", "TMaskEdit", 1, (114, 143, 102, 24)),
    "custinfo.save": _spot("Customer Information", 273, 218, "Tcusindexcard", (794, 588)),
    # Vehicles (Tvehicle_popup, 488 x 500), first step; the engine step re-numbers the combos
    "vehicles.year": _in("Vehicles", "TRzComboBox", 2, (16, 49, 73, 24)),
    "vehicles.make": _in("Vehicles", "TRzComboBox", 1, (16, 78, 162, 24)),
    "vehicles.model": _in("Vehicles", "TRzComboBox", 0, (17, 107, 458, 24)),
    "vehicles.vin": _in("Vehicles", "TEdit", 0, (89, 149, 283, 21)),
    "vehicles.engine": None,          # engine-step combo: which one is unclear from the log
    # Phone Number (opened by Change Number): not seen by the probe yet
    "phone.text": None,
}

# Caption-less buttons that press() reaches by position: (dialog title, normalised caption) -> control.
PRESS_SPOTS = {
    ("Customers", "add new"): "customers.add_new",
    ("Customers", "exit"): "customers.exit",
    ("Customer Information", "save"): "custinfo.save",
}


# --- pure helpers
def locate(name, controls=None):
    """Control name -> Loc, or NotMapped."""
    loc = (CONTROLS if controls is None else controls).get(name)
    if loc is None:
        raise NotMapped(name)
    return loc


def words(caption):
    """Letters-only words: '&Print...' -> ['print'], 'Void-This' -> ['void', 'this']."""
    return re.findall(r"[a-z]+", (caption or "").replace("&", "").lower())


def is_never(caption):
    """True for a caption the tool must never press: a NEVER phrase as consecutive words, or a NEVER_WORDS
    word anywhere, except the exact caption 'Change Number'."""
    w = words(caption)
    if " ".join(w) in NEVER_EXCEPTIONS:
        return False
    if NEVER_WORDS & set(w):
        return True
    for phrase in NEVER:
        p = words(phrase)
        if any(w[i:i + len(p)] == p for i in range(len(w) - len(p) + 1)):
            return True
    return False


def has_control_chars(value):
    return any(ord(c) < 0x20 for c in str(value))


def chunks(value, n=CHUNK):
    s = str(value)
    return [s[i:i + n] for i in range(0, len(s), n)]


def in_area(pt, area):
    x1, y1, x2, y2 = area
    return x1 <= pt[0] <= x2 and y1 <= pt[1] <= y2


def refused_reason(name, rel_pt):
    """Invoice-relative point -> why a click there is refused, or None."""
    for label, area in REFUSED_AREAS.items():
        if in_area(rel_pt, area):
            return f"{name} at {rel_pt} is on the {label} button"
    if in_area(rel_pt, BUTTON_ROW) and name not in BUTTON_ROW_OK:
        return f"{name} at {rel_pt} is in the button row, outside the mapped buttons"
    return None


def dialog_refused_reason(name, title, rel_pt):
    for label, area in DIALOG_REFUSED_AREAS.get(title, {}).items():
        if in_area(rel_pt, area):
            return f"{name} at {rel_pt} is on {label} in {title}"
    return None


def window_ok(rect, zoomed):
    """rect: screen (left, top, right, bottom) of the invoice window -> None if fine, else why not."""
    size = (rect[2] - rect[0], rect[3] - rect[1])
    if not zoomed:
        return "the InvoMax invoice window isn't maximized"
    if size != INVOICE_SIZE:
        return f"the InvoMax invoice window is {size[0]} x {size[1]}, not {INVOICE_SIZE[0]} x {INVOICE_SIZE[1]}"
    return None


def rel_rect(child, top):
    """Screen rects (l, t, r, b) -> child's (x, y, w, h) relative to top, as in probe maps."""
    return child[0] - top[0], child[1] - top[1], child[2] - child[0], child[3] - child[1]


def rect_matches(got, want, slack=RECT_SLACK):
    return all(abs(a - b) <= slack for a, b in zip(got, want))


def centre(rect):
    """Screen rect (l, t, r, b) -> its centre point."""
    return (rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2


def spot_point(loc, win_rect):
    """A rel locator -> screen point, checking the window is the size it was measured at."""
    size = (win_rect[2] - win_rect[0], win_rect[3] - win_rect[1])
    if loc.at_size and size != tuple(loc.at_size):
        where = loc.window or "the invoice"
        raise Refused(f"{where} window is {size[0]} x {size[1]}, the spot was measured at "
                      f"{loc.at_size[0]} x {loc.at_size[1]}")
    return win_rect[0] + loc.rel[0], win_rect[1] + loc.rel[1]


def find_control(loc, controls, text_of, rect_of, top_rect):
    """controls: [(key 'Class#n', hwnd, class)] of the window -> hwnd for loc, or raise."""
    if loc.caption:
        hits = [h for _, h, c in controls if c == loc.cls and norm(text_of(h)) == norm(loc.caption)]
        if len(hits) != 1:
            raise RuntimeError(f"found {len(hits)} {loc.cls} {loc.caption!r} controls, expected 1")
        h = hits[0]
    else:
        key = f"{loc.cls}#{loc.index}"
        h = next((h for k, h, _ in controls if k == key), None)
        if h is None:
            raise RuntimeError(f"{key} isn't on screen")
    if loc.rect:
        got = rel_rect(rect_of(h), top_rect)
        if not rect_matches(got, loc.rect):
            raise RuntimeError(f"{loc.cls}#{loc.index if loc.index is not None else loc.caption} is at {got}, "
                               f"mapped at {loc.rect}: the window layout changed")
    return h


def is_button(cls):
    """Push-button classes; radio buttons and check boxes are not buttons to press."""
    return "Button" in cls and "Radio" not in cls and "Check" not in cls


_SPECIAL = set("+^%~(){}[]")


def esc(s):
    """Escape pywinauto send_keys metacharacters."""
    return "".join("{%s}" % c if c in _SPECIAL else c for c in str(s))


# --- Windows access (the only part that touches the OS; tests pass a fake with the same methods)
class Win32:
    CF_UNICODETEXT = 13
    TEXT_FORMATS = {1, 7, 13, 16}  # CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT, CF_LOCALE

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        import probe
        self.ct, self.wt, self.p = ctypes, wintypes, probe
        try:  # per-monitor DPI aware, so window rects and click coordinates are the same pixels
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (OSError, AttributeError):
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except (OSError, AttributeError):
                pass
        self.u = u = probe._user32()
        self.k = k = ctypes.WinDLL("kernel32", use_last_error=True)
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        u.GetParent.restype = wintypes.HWND
        u.GetForegroundWindow.restype = wintypes.HWND
        u.IsChild.argtypes = [wintypes.HWND, wintypes.HWND]
        u.IsWindow.argtypes = [wintypes.HWND]
        u.GetMenu.restype = wintypes.HMENU
        u.GetSubMenu.restype = wintypes.HMENU
        u.GetClipboardData.restype = ctypes.c_void_p
        u.SetClipboardData.restype = ctypes.c_void_p
        u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        u.CreateWindowExW.restype = wintypes.HWND
        u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                      ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                      wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        k.GlobalAlloc.restype, k.GlobalAlloc.argtypes = ctypes.c_void_p, [ctypes.c_uint, ctypes.c_size_t]
        k.GlobalLock.restype, k.GlobalLock.argtypes = ctypes.c_void_p, [ctypes.c_void_p]
        k.GlobalUnlock.argtypes = [ctypes.c_void_p]
        k.GlobalFree.argtypes = [ctypes.c_void_p]
        self._owner = None

    # reads
    def invoice(self):
        return self.p.find_invomax()[0]

    def pid(self, h):
        return self.p.pid_of(h)

    def windows(self, pid):
        return self.p.top_windows(pid)  # visible, top of the Z-order first

    def cls(self, h):
        return self.p.cls(h)

    def text(self, h):
        return self.p.text(h)

    def rect(self, h):
        r = self.wt.RECT()
        self.u.GetWindowRect(h, self.ct.byref(r))
        return r.left, r.top, r.right, r.bottom

    def zoomed(self, h):
        return bool(self.u.IsZoomed(h))

    def controls(self, top):
        return self.p.controls(top)

    def focus(self, pid):
        return self.p.focused(pid)

    def parent(self, h):
        return self.u.GetParent(h)

    def is_child(self, parent, h):
        return bool(self.u.IsChild(parent, h))

    def foreground(self):
        return self.u.GetForegroundWindow()

    def at_point(self, x, y):
        """-> (deepest hwnd, its root hwnd) under a screen point; the first is the root when it has no child there."""
        h = self.u.WindowFromPoint(self.wt.POINT(x, y))
        return h, (self.u.GetAncestor(h, self.p.GA_ROOT) if h else None)

    def checked(self, h):
        return self.p._send(h, self.p.BM_GETCHECK) == 1

    def combo_items(self, h):
        CB_GETCOUNT, CB_GETLBTEXT, CB_GETLBTEXTLEN = 0x146, 0x148, 0x149
        out = []
        for i in range(self.p._send(h, CB_GETCOUNT) or 0):
            n = self.p._send(h, CB_GETLBTEXTLEN, i)
            if n is None or n > 1000:
                continue
            b = self.ct.create_unicode_buffer(n + 2)
            self.p._send(h, CB_GETLBTEXT, i, self.ct.addressof(b))
            out.append(b.value)
        return out

    def menu_items(self, h):
        return self.p.menu_items(h)

    def menu_item_rect(self, h, i):
        m = self.p._send(h, self.p.MN_GETHMENU)
        r = self.wt.RECT()
        if not m or not self.u.GetMenuItemRect(None, self.wt.HMENU(m), i, self.ct.byref(r)):
            raise RuntimeError("couldn't find the menu item on screen")
        return r.left, r.top, r.right, r.bottom

    def menu_bar(self, h):
        """The window's menu bar as 'File > Print<TAB>Ctrl+P' lines (GetMenu / GetMenuString, read-only)."""
        u, b = self.u, self.ct.create_unicode_buffer(256)

        def walk(m, path, depth):
            out = []
            for i in range(max(u.GetMenuItemCount(m), 0)):
                u.GetMenuStringW(m, i, b, 256, self.p.MF_BYPOSITION)
                name = b.value.replace("&", "")
                sub = u.GetSubMenu(m, i)
                if sub and depth < 4:
                    out += walk(sub, path + [name], depth + 1)
                elif name:
                    out.append(" > ".join(path + [name]))
            return out
        m = u.GetMenu(h)
        return walk(m, [], 0) if m else []

    def esc_down(self):
        return bool(self.u.GetAsyncKeyState(0x1B) & 0x8000)

    def in_stop_corner(self):
        pt = self.wt.POINT()
        self.u.GetCursorPos(self.ct.byref(pt))
        return pt.x - self.u.GetSystemMetrics(76) <= 2 and pt.y - self.u.GetSystemMetrics(77) <= 2

    def idle_ms(self):
        """Milliseconds since the last mouse or keyboard input from anyone (GetLastInputInfo)."""
        class LASTINPUTINFO(self.ct.Structure):
            _fields_ = [("cbSize", self.wt.UINT), ("dwTime", self.wt.DWORD)]
        li = LASTINPUTINFO(cbSize=self.ct.sizeof(LASTINPUTINFO))
        if not self.u.GetLastInputInfo(self.ct.byref(li)):
            return 0
        return (self.k.GetTickCount() - li.dwTime) & 0xFFFFFFFF

    # input (only ever called by Driver when dry_run is False, right after its guards)
    def click(self, x, y, double=False):
        """One SendInput batch: absolute move, left down, left up (twice for a double-click)."""
        ct, wt = self.ct, self.wt

        class MOUSEINPUT(ct.Structure):
            _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD),
                        ("time", wt.DWORD), ("dwExtraInfo", ct.c_size_t)]

        class KEYBDINPUT(ct.Structure):
            _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                        ("dwExtraInfo", ct.c_size_t)]

        class _U(ct.Union):
            _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]

        class INPUT(ct.Structure):
            _fields_ = [("type", wt.DWORD), ("u", _U)]
        MOVE, DOWN, UP, VIRTUALDESK, ABSOLUTE = 0x1, 0x2, 0x4, 0x4000, 0x8000
        gm = self.u.GetSystemMetrics
        vx, vy, vw, vh = gm(76), gm(77), gm(78), gm(79)
        dx = int((x - vx) * 65535 / max(vw - 1, 1))
        dy = int((y - vy) * 65535 / max(vh - 1, 1))
        flags = [MOVE | ABSOLUTE | VIRTUALDESK] + [DOWN, UP] * (2 if double else 1)
        arr = (INPUT * len(flags))()
        for i, f in enumerate(flags):
            arr[i].type = 0  # INPUT_MOUSE
            arr[i].u.mi = MOUSEINPUT(dx, dy, 0, f | (ABSOLUTE | VIRTUALDESK if f != flags[0] else 0), 0, 0)
        self.u.SendInput.argtypes = [wt.UINT, ct.c_void_p, ct.c_int]
        sent = self.u.SendInput(len(flags), ct.cast(arr, ct.c_void_p), ct.sizeof(INPUT))
        if sent != len(flags):
            raise RuntimeError(f"SendInput sent {sent} of {len(flags)} mouse events")

    def type(self, keys):
        from pywinauto.keyboard import send_keys
        send_keys(keys, with_spaces=True, pause=0.03)

    def set_edit(self, h, value):
        from pywinauto.controls.win32_controls import EditWrapper
        EditWrapper(h).set_edit_text(value)

    def select_combo(self, h, index):
        from pywinauto.controls.win32_controls import ComboBoxWrapper
        ComboBoxWrapper(h).select(index)

    # clipboard (copy-back), opened with our own message-only window as the owner
    def _clip_owner(self):
        if self._owner and not self.u.IsWindow(self._owner):  # destroyed (e.g. its thread ended): make a new one
            self._owner = None
        if not self._owner:
            HWND_MESSAGE = self.wt.HWND(-3)
            self._owner = self.u.CreateWindowExW(0, "STATIC", "invomax-clipboard", 0, 0, 0, 0, 0,
                                                 HWND_MESSAGE, None, None, None)
            if not self._owner:
                raise RuntimeError("couldn't create the clipboard owner window")
        return self._owner

    def _clip_open(self):
        owner = self._clip_owner()
        for _ in range(10):
            if self.u.OpenClipboard(owner):
                return
            time.sleep(0.02)
        raise RuntimeError("the clipboard is busy")

    def clip_formats(self):
        self._clip_open()
        out, f = [], 0
        try:
            while True:
                f = self.u.EnumClipboardFormats(f)
                if not f:
                    return out
                out.append(f)
        finally:
            self.u.CloseClipboard()

    def clip_seq(self):
        return self.u.GetClipboardSequenceNumber()

    def clip_get(self):
        """Clipboard text, or None when it holds no text."""
        self._clip_open()
        try:
            h = self.u.GetClipboardData(self.CF_UNICODETEXT)
            if not h:
                return None
            p = self.k.GlobalLock(h)
            if not p:
                raise RuntimeError("couldn't lock the clipboard text")
            try:
                return self.ct.wstring_at(p)
            finally:
                self.k.GlobalUnlock(h)
        finally:
            self.u.CloseClipboard()

    def clip_set(self, s):
        """Put text on the clipboard; None empties it."""
        self._clip_open()
        try:
            if not self.u.EmptyClipboard():
                raise RuntimeError("couldn't empty the clipboard")
            if s is None:
                return
            data = (s + "\0").encode("utf-16-le")
            h = self.k.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
            if not h:
                raise RuntimeError("GlobalAlloc failed")
            p = self.k.GlobalLock(h)
            if not p:
                self.k.GlobalFree(h)
                raise RuntimeError("GlobalLock failed")
            self.ct.memmove(p, data, len(data))
            self.k.GlobalUnlock(h)
            if not self.u.SetClipboardData(self.CF_UNICODETEXT, h):
                self.k.GlobalFree(h)
                raise RuntimeError("SetClipboardData failed")
        finally:
            self.u.CloseClipboard()


# --- the driver
def _action(fn):
    """Driver actions: refuse after an earlier stop; any refusal or error latches the stop."""
    @functools.wraps(fn)
    def wrapper(self, *a, **k):
        if self.stopped:
            raise Refused(f"Refused: the driver stopped earlier ({self.stopped}); start again with a new Driver.")
        # the press just before this action, for presses that only follow another one (Confirm "No")
        self._prev_press, self._last_press = getattr(self, "_last_press", None), None
        try:
            return fn(self, *a, **k)
        except NotReadable:  # a read that couldn't be done (copy-back off, nothing copied) isn't a stop
            raise
        except Exception as e:
            self.stopped = self.stopped or str(e) or type(e).__name__
            raise
    return wrapper


class Driver:
    """recipes.py driver for the real InvoMax. dry_run (default) logs actions instead of doing them."""

    def __init__(self, win=None, dry_run=True, allow_copyback=False, log=print, controls=None,
                 now=time.monotonic, sleep=time.sleep):
        self.w = win or Win32()
        self.dry_run = dry_run
        self.allow_copyback = allow_copyback
        self.log = log
        self.controls = CONTROLS if controls is None else controls
        self.now, self.sleep = now, sleep
        self.done = []          # actions performed or, in dry run, that would have been
        self.stopped = ""       # why the driver stopped; once set, every action is refused
        self._own_input = None  # now() when this driver last sent input
        self._copied = {}       # copy-back results since the last action (at most one copy-back per step)
        self._last_press = self._prev_press = None  # (window title, caption) of a press that was the last action

    # --- window lookups
    def _invoice(self):
        h = self.w.invoice()
        if not h:
            raise RuntimeError("InvoMax isn't open (no invoice window).")
        return h

    def _tops(self):
        return self.w.windows(self.w.pid(self._invoice()))

    def _dialogs(self):
        """-> [(hwnd, title)] of visible InvoMax windows that aren't the invoice, top first."""
        out = []
        for h in self._tops():
            c = self.w.cls(h)
            if c in NOT_DIALOGS:
                continue
            l, t, r, b = self.w.rect(h)
            if r <= l or b <= t:
                continue
            out.append((h, self.w.text(h) or f"({c})"))
        return out

    def _top_dialog(self):
        """-> (hwnd, title) of the top InvoMax window that isn't the invoice, or (None, None)."""
        d = self._dialogs()
        return d[0] if d else (None, None)

    def _popup_open(self):
        return next((self.w.cls(h) for h in self._tops() if self.w.cls(h) in POPUPS), None)

    def _read_window(self, loc, name):
        """Reads: the control's window wherever it is in the stack (the invoice for window=None)."""
        if loc.window is None:
            return self._invoice()
        for h, title in self._dialogs():
            if title == loc.window:
                return h
        raise RuntimeError(f"{name} is in {loc.window!r}, which isn't open")

    def _action_window(self, loc, name):
        """Actions: the control's window must be the one on top."""
        if not loc.confirmed:
            raise Refused(f"Refused: {name}'s place isn't confirmed by the probe yet; it is only read.")
        top, title = self._top_dialog()
        if loc.window is None:
            if top:
                raise Refused(f"Refused: {name} is on the invoice, but {title!r} is open on top of it.")
            return self._invoice()
        if title != loc.window:
            raise Refused(f"Refused: {name} is in {loc.window!r}, but the window on top is {title!r}.")
        return top

    def _hwnd(self, name, win=None):
        loc = locate(name, self.controls)
        if not loc.readable:
            raise RuntimeError(f"{name} is a position, not a control that can be read")
        top = win or self._read_window(loc, name)
        return find_control(loc, self.w.controls(top), self.w.text, self.w.rect, self.w.rect(top)), loc

    def _check_window(self):
        h = self._invoice()
        why = window_ok(self.w.rect(h), self.w.zoomed(h))
        if why:
            raise Refused(f"Refused: {why}. Maximize InvoMax on the main screen first.")
        return h

    # --- reads (recipes.py interface)
    def dialog(self):
        return self._top_dialog()[1]

    def text(self, ctl):
        h, loc = self._hwnd(ctl)
        if loc.needs_copyback:
            return self._copyback(ctl)
        return self.w.text(h)

    def checked(self, ctl):
        h, _ = self._hwnd(ctl)
        return self.w.checked(h)

    def combo_items(self, ctl):
        h, _ = self._hwnd(ctl)
        return self.w.combo_items(h)

    def focused(self):
        """-> name of the mapped control with the keyboard focus, else 'Window / Class#n', or None.
        Each open window's controls are listed once per call."""
        f = self.w.focus(self.w.pid(self._invoice()))
        if not f:
            return None
        wins = {None: self._invoice()}
        for h, title in self._dialogs():
            wins.setdefault(title, h)
        listed = {}
        names = {}
        for name, loc in self.controls.items():
            if loc is None or not loc.readable or loc.window not in wins:
                continue
            top = wins[loc.window]
            if top not in listed:
                listed[top] = self.w.controls(top)
            try:
                names[find_control(loc, listed[top], self.w.text, self.w.rect, self.w.rect(top))] = name
            except RuntimeError:
                continue
        h = f
        while h:
            if h in names:
                return names[h]
            h = self.w.parent(h)
        for title, top in wins.items():
            key = next((k for k, hh, _ in listed.get(top) or self.w.controls(top) if hh == f), None)
            if key:
                return f"{title or 'InvoMax'} / {key}"
        return self.w.cls(f)

    def menu_items(self):
        m = self._menu()
        return self.w.menu_items(m) if m else []

    def captions(self):
        top, _ = self._top_dialog()
        win = top or self._invoice()
        return [self.w.text(h).replace("&", "") for _, h, c in self.w.controls(win) if is_button(c)]

    def position(self, ctl):
        loc = self.controls.get(ctl)
        return loc.rel if loc is not None and loc.rel and loc.window is None else None

    def _menu(self):
        return next((h for h in self._tops() if self.w.cls(h) == "#32768"), None)

    # --- guards
    def _emergency(self):
        if self.w.esc_down():
            raise Refused("Refused: emergency stop (Esc is held down).")
        if self.w.in_stop_corner():
            raise Refused("Refused: emergency stop (the mouse is in the top-left corner of the screen).")

    def _recent_input(self):
        """Someone else used the mouse or keyboard in the last RECENT_INPUT_MS: refuse, don't wait."""
        idle = self.w.idle_ms()
        if idle >= RECENT_INPUT_MS:
            return
        ours = None if self._own_input is None else (self.now() - self._own_input) * 1000
        if ours is None or idle + 100 < ours:  # the last input came after our own
            raise Refused(f"Refused: someone used the mouse or keyboard {idle} ms ago.")

    def _guard_point(self, name, pt, top, target=None, under="", double=False):
        """Before a click at screen point pt meant for window top (and control target, if any)."""
        if double and no_double_click(name):
            raise Refused(f"Refused: {name} is never double-clicked.")
        inv = self._check_window()
        if self._popup_open() and self.w.cls(top) != "#32768":
            raise Refused(f"Refused: a menu or dropdown list is open; {name} isn't clicked.")
        tr = self.w.rect(top)
        rel = (pt[0] - tr[0], pt[1] - tr[1])
        if top == inv:  # REFUSED_AREAS and the button row are invoice areas
            why = refused_reason(name, rel)
        else:
            why = dialog_refused_reason(name, self.w.text(top), rel)
        if why:
            raise Refused(f"Refused: {why}.")
        child, root = self.w.at_point(*pt)
        if root != top:  # so a click meant for a dialog can't reach the invoice behind it
            raise Refused(f"Refused: something else is under {name} at {pt} "
                          f"({self.w.cls(root) if root else 'nothing'}), not the window it belongs to.")
        if target is not None:
            if child != target and not self.w.is_child(target, child):
                raise Refused(f"Refused: under {name} at {pt} is {self.w.cls(child)}, not the control itself.")
        elif under:
            if self.w.cls(child) != under:
                raise Refused(f"Refused: under {name} at {pt} is {self.w.cls(child)}, expected {under}.")
        if child and is_never(self._caption(child)):
            raise Refused(f"Refused: {name} at {pt} is on {self._caption(child)!r}.")

    def _caption(self, h):
        """A button's caption; '' for boxes, whose text is what staff typed, not a caption."""
        c = self.w.cls(h)
        return self.w.text(h) if any(x in c for x in ("Button", "Radio", "Check", "Panel")) else ""

    def _guard_typing(self, win, ctl=None, what="typing"):
        """Before keystrokes meant for window win (and its box ctl, if given)."""
        self._check_window()
        fg = self.w.foreground()
        if fg != win:
            raise Refused(f"Refused: the active window isn't the one {what} is meant for.")
        top, title = self._top_dialog()
        if (top or self._invoice()) != win:
            raise Refused(f"Refused: {title!r} is on top, not the window {what} is meant for.")
        popup = self._popup_open()
        if popup:
            raise Refused(f"Refused: a {'menu' if popup == '#32768' else 'dropdown list'} is open.")
        f = self.w.focus(self.w.pid(win))
        if f and "Button" in self.w.cls(f):
            raise Refused(f"Refused: the focus is on a button ({self.w.cls(f)}); a key could press it.")
        if ctl is not None:
            got = self.focused()
            if got != ctl:
                raise Refused(f"Refused: the focus is on {got!r}, not {ctl}.")

    def _do(self, desc, guard, *inputs):
        """Run guard, then each input with every check repeated right before it."""
        self._copied.clear()
        guard()
        self.done.append(desc)
        if self.dry_run:
            self.log(f"DRY RUN, would {desc}")
            return
        self.log(desc)
        for send in inputs:
            self._emergency()
            self._recent_input()
            guard()
            send()
            self._own_input = self.now()

    def _send(self, keys):
        if not (keys in SENDABLE or len(keys) == 1 and keys not in _SPECIAL or esc(keys[1:-1]) == keys
                and len(keys) == 3 and keys[1] in _SPECIAL):
            raise Refused(f"Refused: {keys!r} is never sent (End, Home and Backspace cleared the InvoMax invoice).")
        self.w.type(keys)

    def _type(self, desc, win, ctl, value):
        """Type value in chunks of CHUNK characters, checking before each chunk."""
        guard = lambda: self._guard_typing(win, ctl, desc)
        self._do(desc, guard, *[functools.partial(self._send, esc(c)) for c in chunks(value)])

    def _point(self, name):
        """-> (screen point, top window, target hwnd or None, expected class or '') for a control name."""
        loc = locate(name, self.controls)
        top = self._action_window(loc, name)
        if loc.rel:
            if name not in SPOT_OK:
                raise Refused(f"Refused: {name} is a fixed spot that isn't approved for clicks.")
            return spot_point(loc, self.w.rect(top)), top, None, loc.under
        h = find_control(loc, self.w.controls(top), self.w.text, self.w.rect, self.w.rect(top))
        if is_never(self._caption(h)):
            raise Refused(f"Refused: {name} is captioned {self._caption(h)!r}.")
        return centre(self.w.rect(h)), top, h, ""

    # --- actions (recipes.py interface)
    @_action
    def click(self, ctl, double=False):
        if double and no_double_click(ctl):
            raise Refused(f"Refused: {ctl} is never double-clicked.")
        pt, top, target, under = self._point(ctl)

        def guard():
            if self._point(ctl) != (pt, top, target, under):
                raise Refused(f"Refused: {ctl} moved since it was found.")
            self._guard_point(ctl, pt, top, target, under, double)
        self._do(f"{'double-click' if double else 'click'} {ctl} at {pt}", guard,
                 lambda: self.w.click(*pt, double=double))

    @_action
    def set_text(self, ctl, value, typed):
        if has_control_chars(value):
            raise Refused(f"Refused: the value for {ctl} has a control character.")
        loc = locate(ctl, self.controls)
        if "ComboBox" in (loc.cls or ""):  # End / Shift+Home would change the pick; use pick() for dropdowns
            raise Refused(f"Refused: {ctl} is a dropdown; it is picked from, never typed into.")
        win = self._action_window(loc, ctl)
        clicked = False
        if self.focused() != ctl:
            self.click(ctl)
            clicked = True
            if not self.dry_run:
                start = self.now()
                while self.focused() != ctl:
                    if self.now() - start >= FOCUS_WAIT:
                        raise Refused(f"Refused: clicking {ctl} didn't put the focus in it.")
                    self.sleep(0.05)
        # in a dry run the click didn't happen, so the focus can't be on ctl yet
        want = None if (self.dry_run and clicked) else ctl
        if typed or loc.needs_copyback or loc.cls not in ("TEdit", "Edit", "TMaskEdit"):
            self._type(f"type {value!r} into {ctl}", win, want, value)
        else:
            h, _ = self._hwnd(ctl, win)
            self._do(f"set {ctl} to {value!r}", lambda: self._guard_typing(win, want, f"setting {ctl}"),
                     lambda: self.w.set_edit(h, value))

    @_action
    def key(self, keys):
        if keys not in KEYS:
            raise Refused(f"Refused: key {keys!r}.")
        top, title = self._top_dialog()
        win = top or self._invoice()
        f = self.focused()
        loc = self.controls.get(f) if f else None
        if loc is None or loc.window != title:
            raise Refused(f"Refused: {keys} with the focus on {f!r}, which isn't a mapped box in "
                          f"{title or 'the invoice'}.")
        self._do(f"press {keys} in {f}", lambda: self._guard_typing(win, f, f"the key {keys}"),
                 lambda: self._send(keys))

    @_action
    def pick(self, ctl, text):
        if is_never(text):
            raise Refused(f"Refused: {text!r} is never chosen.")
        loc = locate(ctl, self.controls)
        win = self._action_window(loc, ctl)
        h, _ = self._hwnd(ctl, win)
        items = self.w.combo_items(h)
        if text not in items:
            raise RuntimeError(f"{text!r} isn't in the {ctl} list")
        i = items.index(text)

        def guard():
            self._check_window()
            if self._action_window(loc, ctl) != win:
                raise Refused(f"Refused: {loc.window!r} isn't on top any more.")
            if self._popup_open():
                raise Refused("Refused: a menu or dropdown list is open.")
            if self.w.combo_items(h)[i:i + 1] != [text]:
                raise Refused(f"Refused: the {ctl} list changed.")
        self._do(f"choose {text!r} (item {i}) in {ctl}", guard, lambda: self.w.select_combo(h, i))

    @_action
    def double_click_row(self, ctl, text):
        raise NotMapped(f"{ctl} rows (drawn list, rows can't be read)")

    @_action
    def choose_menu(self, text):
        if is_never(text):
            raise Refused(f"Refused: {text!r} is never chosen.")
        if norm(text) not in MENU_OK or norm(text) not in ALLOWED:
            raise Refused(f"Refused: {text!r} isn't an approved menu item.")
        m = self._menu()
        if not m:
            raise RuntimeError("no popup menu is open")
        items = self.w.menu_items(m)
        hits = [i for i, t in enumerate(items) if norm(t) == norm(text)]
        if len(hits) != 1:
            raise RuntimeError(f"menu has {items}, not exactly one {text!r}")
        pt = centre(self.w.menu_item_rect(m, hits[0]))

        def guard():
            now = self.w.menu_items(m)
            if len(now) <= hits[0] or norm(now[hits[0]]) != norm(text) or is_never(now[hits[0]]):
                raise Refused("Refused: the menu changed.")
            self._guard_point(f"menu item {text!r}", pt, m)
        self._do(f"choose {text!r} in the menu at {pt}", guard, lambda: self.w.click(*pt))

    @_action
    def press(self, caption):
        if is_never(caption):
            raise Refused(f"Refused: {caption!r} is never pressed.")
        top, title = self._top_dialog()
        if (title, norm(caption)) not in PRESS_OK or norm(caption) not in ALLOWED:
            raise Refused(f"Refused: {caption!r} isn't an approved button in {title or 'the invoice'}.")
        win = top or self._invoice()
        if (title, norm(caption)) == ("Confirm", "no"):
            self._guard_confirm_no(top)
        hits = [h for _, h, c in self.w.controls(win) if is_button(c) and norm(self.w.text(h)) == norm(caption)]
        if len(hits) > 1:
            raise RuntimeError(f"{len(hits)} buttons say {caption!r} in {title or 'the invoice'}")
        if hits:
            b = hits[0]
            pt = centre(self.w.rect(b))

            def guard():
                if self._top_dialog()[0] != top or norm(self.w.text(b)) != norm(caption):
                    raise Refused(f"Refused: the {caption!r} button changed.")
                self._guard_point(f"button {caption!r}", pt, win, target=b)
            self._do(f"press {caption!r} at {pt}", guard, lambda: self.w.click(*pt))
            self._last_press = (title, norm(caption))
            return
        key = (title, norm(caption))
        if key not in PRESS_SPOTS:
            raise NotMapped(f"button {caption!r} in {title or 'the invoice'}")
        self.click(PRESS_SPOTS[key])
        self._last_press = key

    def _guard_confirm_no(self, top):
        """No only answers the Yes/No box that Cancel in Vehicles opens ("correct all past history?").
        Other Confirm boxes share the title (Delphi's "Save changes?" has a Cancel too), so check all three."""
        if self._prev_press != ("Vehicles", "cancel"):
            raise Refused("Refused: No is only pressed right after Cancel in Vehicles.")
        if self.w.cls(top) != "TMessageForm":
            raise Refused(f"Refused: the Confirm window is a {self.w.cls(top)}, not a TMessageForm.")
        caps = sorted(norm(self.w.text(h)) for _, h, c in self.w.controls(top) if is_button(c))
        if caps != ["no", "yes"]:
            raise Refused(f"Refused: the Confirm box has buttons {caps}, not just Yes and No.")

    # --- copy-back (off unless the owner agreed: it sends Ctrl+A / Ctrl+C to InvoMax)
    def _copyback(self, ctl):
        if not self.allow_copyback:
            raise NotReadable(f"{ctl} can't be read without copy-back (off: needs the owner's OK)")
        if ctl in self._copied:  # at most one copy-back per step: the result stands until the next action
            return self._copied[ctl]
        if self.focused() != ctl:
            raise NotReadable(f"{ctl} isn't the box being typed in; copy-back only reads the focused box")
        return self._copy_focused(ctl)

    @_action
    def _copy_focused(self, ctl):
        loc = locate(ctl, self.controls)
        win = self._action_window(loc, ctl)
        guard = lambda: self._guard_typing(win, ctl, f"copy-back of {ctl}")
        if self.dry_run:
            guard()
            self.log(f"DRY RUN, would copy-back {ctl} (Ctrl+A, Ctrl+C)")
            raise NotReadable(f"{ctl}: copy-back skipped in dry run")
        formats = self.w.clip_formats()
        if set(formats) - Win32.TEXT_FORMATS:
            raise Refused("Refused: the clipboard holds something other than text; copy-back would lose it.")
        saved = self.w.clip_get() if formats else None
        seq = self.w.clip_seq()
        try:
            self._do(f"copy-back {ctl} (Ctrl+A, Ctrl+C)", guard, lambda: self._send("^a^c"))
            got, start = None, self.now()
            while self.now() - start < 0.5:
                s = self.w.clip_seq()
                if s != seq:
                    txt = self.w.clip_get()
                    self.sleep(0.025)
                    if txt is not None and self.w.clip_seq() == s:
                        got = txt
                        break
                self.sleep(0.025)
            if got is None:
                raise NotReadable(f"{ctl}: Ctrl+C put no text on the clipboard")
            self._copied[ctl] = got
            return got
        finally:
            self._restore_clipboard(saved)

    def _restore_clipboard(self, saved):
        last = None
        for _ in range(5):
            try:
                self.w.clip_set(saved)
                return
            except Exception as e:  # noqa: BLE001 - retry, then say so loudly
                last = e
                self.sleep(0.05)
        self.stopped = self.stopped or "clipboard not restored"
        self.log(f"!!! COPY-BACK COULDN'T PUT THE CLIPBOARD BACK ({last}). What staff had copied is lost; "
                 f"tell the person at the PC.")


# --- the read-only check the owner watches
def check(d=None, out=print):
    """Print what the driver reads right now. Never sends input (no copy-back, no clicks, no keys)."""
    d = d or Driver(dry_run=True, allow_copyback=False, log=out)
    w = d.w
    h = w.invoice()
    if not h:
        out("InvoMax isn't open (no TINVOICESCREEN window).")
        return 1
    r = w.rect(h)
    out(f"invoice window: {r[2] - r[0]} x {r[3] - r[1]} at ({r[0]}, {r[1]}), maximized={w.zoomed(h)}")
    why = window_ok(r, w.zoomed(h))
    out(f"  ready for actions: {'no, ' + why if why else 'yes'}")
    title = d.dialog()
    out(f"dialog(): {title!r}")
    try:
        out(f"focused(): {d.focused()!r}")
    except RuntimeError as e:
        out(f"focused(): ERROR {e}")
    m = d.menu_items()
    if m:
        out(f"menu_items(): {m}")
    out(f"captions(): {d.captions()}")
    try:
        bar = w.menu_bar(h)
        out(f"menu bar ({len(bar)} items; shortcuts shown after a tab):")
        for item in bar:
            if "\t" in item:
                out(f"  {item.replace(chr(9), '   [')}]")
        if not any("\t" in i for i in bar):
            out("  no item has a keyboard shortcut")
    except Exception as e:  # noqa: BLE001 - only informational
        out(f"menu bar: ERROR {e}")
    open_windows = {None} | {t for _, t in d._dialogs()}
    for name, loc in d.controls.items():
        if loc is None:
            out(f"  {name:28} not mapped yet")
            continue
        if not loc.readable:
            out(f"  {name:28} position {loc.rel} in {loc.window or 'invoice'}, not readable")
            continue
        if loc.window not in open_windows:
            continue
        note = "" if loc.confirmed else " (place not confirmed)"
        if loc.needs_copyback:
            try:
                d._hwnd(name)
                out(f"  {name:28} ({loc.cls}, needs copy-back; not read){note}")
            except RuntimeError as e:
                out(f"  {name:28} ERROR {e}")
            continue
        try:
            v = f"checked={d.checked(name)}" if loc.cls == "TRadioButton" else f"text={d.text(name)!r}"
            if "Combo" in loc.cls:
                v += f" items={len(d.combo_items(name))}"
            out(f"  {name:28} {v}{note}")
        except RuntimeError as e:
            out(f"  {name:28} ERROR {e}")
    return 0


# --- retired: the old one-shot fill (app.py's Fill button still calls fill(); recipes replace it)
FIELD_MAP = {}
GRID_START = None
ROW_KEYS = "{code}{{TAB}}{desc}{{TAB}}{qty}{{TAB}}{price}{{ENTER}}"


def row_keys(line):
    return ROW_KEYS.format(code=esc(line.code), desc=esc(line.desc), qty=line.qty, price=f"{line.price:.2f}")


def field_writes(fields):
    """[(key, spec, value)] for mapped fields that have a value. Blank -> untouched in InvoMax."""
    return [(k, spec, fields[k]) for k, specs in FIELD_MAP.items() if fields.get(k) for spec in specs]


def fill(fields, lines):
    """Retired. Filling goes through recipes.run with Driver once the trials (HANDOFF) pass."""
    raise RuntimeError("InvoMax control map isn't set up yet (fill.py FIELD_MAP / GRID_START).")


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        sys.exit(check())
    sys.exit(__doc__)
