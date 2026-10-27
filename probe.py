"""Watch InvoMax and log what changes, so recipes can be written from real use.

Read-only: it never clicks, types, presses Save or deletes anything in InvoMax; the only
file it writes is its own log. It only asks Windows for window
titles, box texts, list selections, check states, the focused box and where the mouse
clicked. Logs hold customer data, so they go to probe/ (git-ignored, stays on this PC).

    python probe.py watch    log changes to probe/watch-YYYY-MM-DD.log until Ctrl+C
    python probe.py map      dump every InvoMax window's controls to probe/map-*.txt
"""
from __future__ import annotations
import ctypes, os, sys, time
from ctypes import wintypes

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
    return f"{text(h) or '(no title)'} [{cls(h)}]"


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


def do_watch():
    os.makedirs(OUT, exist_ok=True)
    u = _user32()
    path = os.path.join(OUT, time.strftime("watch-%Y-%m-%d.log"))
    print(f"Watching InvoMax (read-only). Log: {path}\nClose this window or press Ctrl+C to stop.")
    with open(path, "a", encoding="utf-8") as log:
        def write(line):
            log.write(f"{_stamp()}  {line}\n")
            log.flush()

        write("--- watch started")
        prev, names, pid, last, down = {}, {}, None, 0.0, {}
        while True:
            now = time.monotonic()
            if now - last >= SNAP_EVERY:
                last = now
                main, p = find_invomax()
                if p != pid:
                    write("InvoMax found" if p else "InvoMax not open")
                    pid, prev = p, {}
                if pid:
                    try:
                        cur, names = snapshot(pid)
                    except OSError:
                        cur = prev
                    for line in diff(prev, cur):
                        write(line)
                        if line.startswith("+ window ") and "[#32768]" not in line:
                            top = next((h for h, n in names.items() if line.startswith(f"+ window {n} =")), None)
                            if top:
                                for m in map_lines(top):
                                    write("    " + m)
                    prev = cur
            if pid:
                fg = u.GetForegroundWindow()
                for vk, label in [(VK_LBUTTON, "click")] + list(KEYS.items()):
                    is_down = bool(u.GetAsyncKeyState(vk) & 0x8000)
                    if is_down and not down.get(vk) and pid_of(fg) == pid:
                        if vk == VK_LBUTTON:
                            pt = wintypes.POINT()
                            u.GetCursorPos(ctypes.byref(pt))
                            h = u.WindowFromPoint(pt)
                            top = u.GetAncestor(h, GA_ROOT)
                            if h and pid_of(h) == pid:
                                tr = wintypes.RECT()
                                u.GetWindowRect(top, ctypes.byref(tr))
                                write(f"click at ({pt.x - tr.left},{pt.y - tr.top}) in {names.get(top, win_key(top))}"
                                      f" on {names.get(h, cls(h))}")
                        else:
                            f = focused(pid)
                            write(f"key {label} in {names.get(f, cls(f)) if f else win_key(fg)}")
                    down[vk] = is_down
            time.sleep(TICK)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "watch"
    if mode == "map":
        do_map()
    elif mode == "watch":
        try:
            do_watch()
        except KeyboardInterrupt:
            print("stopped")
    else:
        sys.exit(__doc__)
