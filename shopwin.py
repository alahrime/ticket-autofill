"""Shop tickets on the shop PC: approved tickets from tickets.db -> the InvoMax entry sheet to type in, then Mark filled.
Read-only apart from Mark filled; never touches InvoMax."""
from __future__ import annotations
import tkinter as tk
from datetime import datetime
from tkinter import ttk, messagebox
import tickets, shop
from prices import load_catalog

REFRESH_MS = 4000
FILLED_CAP = 200  # newest filled tickets looked at for "Show filled (today)"
HEADER = (("first", "First name"), ("last", "Last name"), ("phone", "Phone"), ("year_make", "Year/Make"),
          ("model", "Model"), ("plate", "Plate"), ("odometer", "Odometer"), ("tech", "Mechanic"), ("date", "Date"))
COLS = (("id", "#", 45), ("name", "Name", 140), ("vehicle", "Vehicle", 170), ("total", "Total", 75), ("age", "Age", 50))
TOTALS_HEAD = "Ticket totals (before tax — InvoMax adds tax and supplies; take deposits off InvoMax's total)"


def usd(v):
    return f"{'-' if v < 0 else ''}${abs(v):,.2f}"  # as tickets.dollars


def plain(v):
    """A price to type into InvoMax: 45.00 (no $ or comma)."""
    return f"{v or 0:.2f}"


def invomax_plate(p):
    """InvoMax keeps plates with a hyphen after the 3rd character for 6- and 7-character plates (spec 5.1a):
    XKS4827 -> XKS-4827. Other lengths as typed."""
    bare = "".join(c for c in (p or "").upper() if c.isalnum())
    return f"{bare[:3]}-{bare[3:]}" if len(bare) in (6, 7) else (p or "")


def total_rows(totals):
    """totals dict -> [(label, text)] in dict order; numbers as $0.00 (a *rate as a percent)."""
    out = []
    for k, v in totals.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            v = f"{v * 100:g}%" if "rate" in k else usd(v)
        out.append((k.replace("_", " ").capitalize(), str(v)))
    return out


def age(created, now=None):
    """ISO time -> '5m', '3h', '2d' ('' if unreadable)."""
    try:
        s = ((now or datetime.now()) - datetime.fromisoformat(created)).total_seconds()
    except (TypeError, ValueError):
        return ""
    s = max(s, 0)
    return f"{int(s // 60)}m" if s < 3600 else f"{int(s // 3600)}h" if s < 86400 else f"{int(s // 86400)}d"


def list_row(t, now=None):
    """Ticket -> (id, name, vehicle, total, age) for the list."""
    return (t.id, tickets.squash(f"{t.first} {t.last}"), tickets.squash(f"{t.year} {t.make} {t.model}"),
            usd(tickets.totals(t)["total"]), "filled" if t.status == "filled" else age(t.created, now))


def header_rows(draft):
    v = lambda k: draft.header[k].value if k in draft.header else ""
    return [(label, invomax_plate(v(k)) if k == "plate" else v(k)) for k, label in HEADER]


def line_text(ln):
    pad = "    " if ln.kind == "labor" else ""
    return f"{pad}{ln.code or '(no code)'}  {ln.desc}  qty {ln.qty:g}  {usd(ln.price or 0)} each  {ln.kind}"


def app_fields(draft, keys):
    """Draft header -> {key: text} for the Ticket Autofill fields (plate as InvoMax keeps it; missing -> "")."""
    v = lambda k: draft.header[k].value if k in draft.header else ""
    return {k: invomax_plate(v(k)) if k == "plate" else v(k) for k in keys}


def app_row(ln):
    """Draft line -> (code, desc, qty, cost, price) for the main window's list; labor indented as on the sheet."""
    return (ln.code, ("    " if ln.kind == "labor" else "") + ln.desc, f"{ln.qty:g}", "", plain(ln.price))


def entry_sheet(ticket, draft, totals):
    """The plain-text InvoMax entry sheet."""
    out = [f"Ticket #{ticket.id} ({ticket.status})"]
    out += [f"{label}: {v}" for label, v in header_rows(draft)]
    out += ["", "Lines:"] + [line_text(ln) for ln in draft.lines]
    if draft.notes:
        out += ["", "Notes:"] + draft.notes
    out += ["", TOTALS_HEAD] + [f"{label}: {v}" for label, v in total_rows(totals)]
    return "\n".join(out) + "\n"


def shown(store, filled_today=False, today=None):
    """Approved tickets, oldest first; plus, when asked, those of the newest FILLED_CAP filled ones filled today."""
    out = store.list(["approved"])[::-1]
    if filled_today:
        day = (today or datetime.now().date()).isoformat()
        with store.lock:  # Store.list has no limit: read only the newest filled rows
            rows = store.db.execute("SELECT id, status, data FROM tickets WHERE status = 'filled' "
                                    "ORDER BY id DESC LIMIT ?", (FILLED_CAP,)).fetchall()
        out += [t for t in map(store._ticket, rows[::-1]) if t.updated.startswith(day)]
    return out


class ShopWindow(tk.Toplevel):
    def __init__(self, master, catalog=None):
        super().__init__(master)
        self.title("Shop tickets")
        self.attributes("-topmost", True)
        self.catalog = catalog or load_catalog(shop.CATALOG)
        self.store = tickets.Store(shop.DB)  # shop.py has it open too; sqlite waits up to 5 s for its lock
        self.tickets, self.current, self.sheet, self.job = {}, None, "", None
        self.protocol("WM_DELETE_WINDOW", self.close)

        left = ttk.Frame(self)
        left.pack(side="left", fill="y")
        self.status = ttk.Label(left, text="")
        self.status.pack(anchor="w")
        self.filled = tk.BooleanVar()
        ttk.Checkbutton(left, text="Show filled (today)", variable=self.filled, command=self.refresh).pack(anchor="w")
        self.tree = ttk.Treeview(left, columns=[c[0] for c in COLS], show="headings", height=20, selectmode="browse")
        for c, label, w in COLS:
            self.tree.heading(c, text=label)
            self.tree.column(c, width=w, anchor="e" if c in ("id", "total", "age") else "w")
        self.tree.tag_configure("filled", foreground="gray")
        self.tree.pack(fill="y", expand=True)
        self.tree.bind("<<TreeviewSelect>>", lambda e: self.show())
        self.tree.bind("<Double-1>", lambda e: self.load(self.tickets.get(self.tree.identify_row(e.y))))

        right = ttk.Frame(self)
        right.pack(side="left", fill="both", expand=True)
        btns = ttk.Frame(right)
        btns.pack(side="bottom", fill="x")
        ttk.Button(btns, text="Copy everything", command=lambda: self.copy(self.sheet)).pack(side="left", fill="x", expand=True)
        self.fill_btn = ttk.Button(btns, text="Mark filled", command=self.mark_filled)
        self.fill_btn.pack(side="left", fill="x", expand=True)
        self.load_btn = ttk.Button(btns, text="Load into Ticket Autofill", command=lambda: self.load(self.current))
        self.load_btn.pack(side="left", fill="x", expand=True)
        canvas = tk.Canvas(right, width=720, height=560, highlightthickness=0)
        bar = ttk.Scrollbar(right, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=bar.set)
        bar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        self.body = ttk.Frame(canvas)
        canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.body.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        self.canvas = canvas
        self.refresh()

    def close(self):
        if self.job:
            self.after_cancel(self.job)
        self.store.close()
        self.destroy()

    def copy(self, s):
        self.clipboard_clear()
        self.clipboard_append(s)

    # --- list
    def refresh(self):
        if self.job:
            self.after_cancel(self.job)
        self.job = self.after(REFRESH_MS, self.refresh)
        try:
            ts = shown(self.store, self.filled.get())
        except Exception as e:  # e.g. database locked for longer than the timeout: try again next tick
            return self.status.config(text=f"Couldn't read tickets: {e}")
        sel = self.tree.selection()
        self.tickets = {str(t.id): t for t in ts}
        if list(self.tree.get_children()) == list(self.tickets):  # same rows: update in place, keep the scroll
            for t in ts:
                self.tree.item(str(t.id), values=list_row(t), tags=(t.status,))
        else:
            self.tree.delete(*self.tree.get_children())
            for t in ts:
                self.tree.insert("", "end", iid=str(t.id), values=list_row(t), tags=(t.status,))
        if sel and sel[0] in self.tickets and self.tree.selection() != sel:
            self.tree.selection_set(sel[0])  # fires <<TreeviewSelect>>; show() skips an unchanged ticket
        n = sum(t.status == "approved" for t in ts)
        self.status.config(text=f"{n} ready for InvoMax   Updated {datetime.now():%H:%M:%S}")
        mine = getattr(self.master, "ticket", None)  # the ticket in the main window: tell it if it changed here
        if mine:
            try:
                fresh = self.store.get(mine.id)
            except Exception:
                fresh = None
            if fresh and (fresh.version != mine.version or fresh.status != mine.status):
                self.master.ticket_changed(fresh)
        self.show()  # redraws only if the selected ticket changed

    # --- entry sheet
    def show(self):
        sel = self.tree.selection()
        t = self.tickets.get(sel[0]) if sel else None
        key = lambda x: x and (x.id, x.version, x.status)
        prev = self.current
        if self.body.winfo_children() and key(t) == key(prev):
            return
        same = bool(t and prev and t.id == prev.id)
        top = self.canvas.yview()[0] if same else 0.0
        self.current, self.sheet = None, ""
        self.fill_btn.state(["disabled"])
        self.load_btn.state(["disabled"])
        for w in self.body.winfo_children():
            w.destroy()
        if not t:
            return ttk.Label(self.body, text="Pick a ticket on the left.").grid(row=0, column=0, sticky="w")
        try:
            draft, tot = tickets.to_draft(t, self.catalog), tickets.totals(t)
            sheet = entry_sheet(t, draft, tot)
            self.draw(t, draft, tot, same and t.version != prev.version and t.status == prev.status)
        except Exception as e:
            for w in self.body.winfo_children():
                w.destroy()
            return ttk.Label(self.body, text=f"Can't show ticket #{t.id}: {e}", foreground="red",
                             wraplength=600).grid(row=0, column=0, sticky="w")
        self.current, self.sheet = t, sheet
        for b in (self.fill_btn, self.load_btn):
            b.state(["!disabled" if t.status == "approved" else "disabled"])
        self.update_idletasks()
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        self.canvas.yview_moveto(top)  # same ticket, new version: stay where the reader was

    def draw(self, t, draft, tot, changed):
        r = 0
        font, bold = ("Segoe UI", 10), ("Segoe UI", 10, "bold")

        def copy_btn(parent, value, row, col):
            ttk.Button(parent, text="Copy", width=5, command=lambda: self.copy(value)).grid(row=row, column=col, padx=(2, 8))

        def row(label, value="", copy=None, f=font):
            nonlocal r
            ttk.Label(self.body, text=label, font=f).grid(row=r, column=0, sticky="nw", padx=(4, 8))
            ttk.Label(self.body, text=value, font=f, wraplength=420).grid(row=r, column=1, sticky="w")
            if copy:
                copy_btn(self.body, copy, r, 2)
            r += 1

        if changed:
            ttk.Label(self.body, text=f"Ticket #{t.id} changed at {t.updated[11:16]} — check the lines again", font=bold,
                      foreground="white", background="#c0392b", padding=4).grid(row=r, column=0, columnspan=3, sticky="ew")
            r += 1
        row(f"Ticket #{t.id}", t.status, f=bold)
        for label, v in header_rows(draft):
            row(label, v, v)
        row("Lines", f=bold)
        grid = ttk.Frame(self.body)
        grid.grid(row=r, column=0, columnspan=3, sticky="w", padx=4)
        r += 1
        for i, label in enumerate(("Code", "Description", "Qty", "Price", "")):
            ttk.Label(grid, text=label, font=bold).grid(row=0, column=i * 2, sticky="w")
        for n, ln in enumerate(draft.lines, 1):
            pad = 16 if ln.kind == "labor" else 0
            ttk.Label(grid, text=ln.code or "(no code)", font=font,
                      foreground="black" if ln.code else "gray").grid(row=n, column=0, sticky="w", padx=(pad, 0))
            if ln.code:
                copy_btn(grid, ln.code, n, 1)
            ttk.Label(grid, text=ln.desc, font=font, wraplength=260).grid(row=n, column=2, sticky="w", padx=(pad, 0))
            copy_btn(grid, ln.desc, n, 3)
            ttk.Label(grid, text=f"{ln.qty:g}", font=font).grid(row=n, column=4, sticky="e")
            copy_btn(grid, f"{ln.qty:g}", n, 5)
            ttk.Label(grid, text=f"{usd(ln.price or 0)} each", font=font).grid(row=n, column=6, sticky="e")
            copy_btn(grid, plain(ln.price), n, 7)
            ttk.Label(grid, text=ln.kind, font=font).grid(row=n, column=8, sticky="w")
        if draft.notes:
            row("Notes", "\n".join(draft.notes), "\n".join(draft.notes))
        ttk.Label(self.body, text=TOTALS_HEAD, font=bold, wraplength=600).grid(row=r, column=0, columnspan=3,
                                                                              sticky="w", padx=4, pady=(6, 0))
        r += 1
        for label, v in total_rows(tot):
            row(label, v, f=bold if label == "Total" else font)

    def load(self, t):
        """Approved ticket -> the main window's fields, lines and notes (App.load_ticket), then bring that window up."""
        if not t:
            return
        if t.status != "approved":
            return self.status.config(text=f"Ticket #{t.id} is {t.status}: only approved tickets load into Ticket Autofill")
        try:
            draft = tickets.to_draft(t, self.catalog)
        except Exception as e:
            return messagebox.showwarning("Can't load", f"Ticket #{t.id}: {e}", parent=self)
        self.master.deiconify()  # it may be minimized (or withdrawn during a fill)
        if self.master.load_ticket(t, draft):
            self.master.lift()
            self.master.focus_force()

    def mark_filled(self):
        t = self.current
        if not t or not messagebox.askyesno("Mark filled", f"Ticket #{t.id} {t.first} {t.last}: typed into InvoMax?\n"
                                            "It leaves the Ready for InvoMax list.", parent=self):
            return
        try:
            fresh = self.store.get(t.id)
            if fresh is None:
                raise KeyError(f"ticket #{t.id} is gone")
            self.store.save(tickets.move(fresh, "filled"), t.version)  # Stale if it changed since it was shown
        except tickets.Stale:
            messagebox.showwarning("Changed", "This ticket was changed on another device. Check it again.", parent=self)
        except (tickets.Refused, KeyError) as e:
            messagebox.showwarning("Not filled", str(e), parent=self)
        except Exception as e:  # sqlite3.Error (locked too long), disk trouble...
            messagebox.showerror("Not filled", f"Couldn't save, try again: {e}", parent=self)
        finally:
            for w in self.body.winfo_children():  # force a redraw
                w.destroy()
            self.refresh()
