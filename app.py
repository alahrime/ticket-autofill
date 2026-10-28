"""Always-on-top helper next to InvoMax: photo -> review -> Fill."""
import os, sys, threading, traceback, tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from read import read_photo, Job
from prices import load_catalog, load_overrides, save_override, position, DEFAULT_MARKUP
from draft import from_job, needs, line_by_id
from inspection import read_receipt
import report
import invomax

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = {}  # loaded in __main__ so a bad parts.csv shows a dialog
OV_PATH = os.path.join(HERE, "overrides.csv")
FIELDS = [("first", "First"), ("last", "Last"), ("phone", "Phone"), ("year_make", "Year Make"),
          ("plate", "Plate"), ("vin", "VIN"), ("odometer", "Odometer"), ("tech", "Tech")]
FLAG_BG = "#fff3b0"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Ticket Autofill")
        self.attributes("-topmost", True)
        self.overrides = load_overrides(OV_PATH)
        self.jobs, self.job, self.draft, self.shown = [], None, None, []
        self.codes, self.sides, self.edits, self.deleted = {}, {}, {}, set()
        self.filled = False

        bar = ttk.Frame(self)
        bar.pack(fill="x")
        self.photo_btns = [ttk.Button(bar, text="Open photo", command=self.open_photo),
                           ttk.Button(bar, text="Paste photo", command=self.paste_photo)]
        for b in self.photo_btns:
            b.pack(side="left")
        self.job_box = ttk.Combobox(bar, state="readonly", width=28)
        self.job_box.pack(side="left")
        self.job_box.bind("<<ComboboxSelected>>", lambda e: self.show_job(self.job_box.current()))
        ttk.Label(bar, text=" Markup ×").pack(side="left")
        self.markup = tk.StringVar(value=str(DEFAULT_MARKUP))
        sp = ttk.Spinbox(bar, from_=1, to=5, increment=0.1, width=4, textvariable=self.markup,
                         command=self.reprice)
        sp.pack(side="left")
        sp.bind("<Return>", self.reprice)
        sp.bind("<FocusOut>", self.reprice)
        ttk.Button(bar, text="Inspection report", command=lambda: ReportWindow(self)).pack(side="right")

        form = ttk.Frame(self)
        form.pack(fill="x")
        self.vars, self.entries = {}, {}
        for r, (k, label) in enumerate(FIELDS):
            ttk.Label(form, text=label).grid(row=r, column=0, sticky="w")
            self.vars[k] = tk.StringVar()
            self.entries[k] = tk.Entry(form, textvariable=self.vars[k], width=32)
            self.entries[k].grid(row=r, column=1, sticky="w")

        self.tree = ttk.Treeview(self, columns=("code", "desc", "cost", "price"), show="headings", height=10)
        for c, w in (("code", 100), ("desc", 320), ("cost", 60), ("price", 70)):
            self.tree.heading(c, text=c.title())
            self.tree.column(c, width=w)
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<Double-1>", self.edit_price)
        self.tree.bind("<Delete>", self.delete_line)
        ttk.Label(self, text="Notes (copied for InvoMax Note):").pack(anchor="w")
        self.note = tk.Text(self, height=3)
        self.note.pack(fill="x")
        ttk.Button(self, text="Fill InvoMax", command=self.do_fill).pack(fill="x")

    # --- photo -> jobs
    def open_photo(self):
        p = filedialog.askopenfilename(filetypes=[("Images", "*.jpg *.jpeg *.png *.webp")])
        if p:
            self.load(p)

    def paste_photo(self):
        from PIL import ImageGrab
        img = ImageGrab.grabclipboard()
        if isinstance(img, list):  # a copied file
            return self.load(img[0])
        if img is None:
            return messagebox.showinfo("Paste", "No image on the clipboard.")
        p = os.path.join(HERE, "_pasted.png")
        img.save(p)
        self.load(p)

    def load(self, path):
        # Reading can take minutes on a CPU-only PC: do it on a worker thread, poll from Tk.
        result = []
        threading.Thread(target=lambda: result.append(read_photo(path)), daemon=True).start()
        for b in self.photo_btns:
            b.state(["disabled"])
        self.title("Ticket Autofill — reading photo…")
        self.after(200, self.finish_load, path, result)

    def finish_load(self, path, result):
        if not result:
            return self.after(200, self.finish_load, path, result)
        for b in self.photo_btns:
            b.state(["!disabled"])
        self.title("Ticket Autofill")
        self.jobs, err = result[0]
        if err:
            messagebox.showwarning("Couldn't read page", err)
        if not self.jobs:  # nothing read: show the photo and empty fields for manual entry
            if sys.platform == "win32" and os.path.exists(path):
                os.startfile(path)
            self.jobs = [Job()]
        self.job_box["values"] = [f"{i + 1}: {j.date} {j.fields.get('year_make', '')}"
                                  for i, j in enumerate(self.jobs)]
        self.job_box.current(0)
        self.show_job(0)

    def show_job(self, i):
        self.job = job = self.jobs[i]
        for k, v in self.vars.items():
            v.set(job.fields.get(k, ""))
            self.entries[k].config(bg=FLAG_BG if k in job.flags else "white")
        self.codes, self.sides, self.edits, self.deleted = {}, {}, {}, set()
        self.filled = False
        for n, what in needs(job, CATALOG):
            desc = job.items[n].desc
            if what == "code":
                code = self.ask_code(desc)
                if code:
                    self.codes[n] = code
                    if not (CATALOG[code].sided and position(desc)[1] is None):
                        continue
                else:
                    continue
            self.sides[n] = self.ask_side(desc)
        self.reprice()
        self.note.delete("1.0", "end")
        self.note.insert("1.0", "\n".join(self.draft.notes))

    def ask_code(self, desc):
        while True:
            c = simpledialog.askstring("Unknown item", f"No catalog match for:\n{desc}\n\n"
                                       "Item code? (blank = put it in the note)", parent=self)
            if not c:
                return None
            if c.strip().upper() in CATALOG:
                return c.strip().upper()

    def ask_side(self, desc):
        while True:
            s = simpledialog.askstring("Which side?", f"{desc}\nLEFT, RIGHT or BOTH?",
                                       initialvalue="LEFT", parent=self)
            if s is None:
                return None
            if s.strip().upper() in ("LEFT", "RIGHT", "BOTH"):
                return s.strip().upper()

    def report_callback_exception(self, *exc):
        messagebox.showerror("Error", "".join(traceback.format_exception_only(exc[0], exc[1])))

    # --- lines
    def reprice(self, _event=None):
        try:
            markup = float(self.markup.get())
            if markup <= 0:
                raise ValueError
        except ValueError:
            markup = DEFAULT_MARKUP
            self.markup.set(str(DEFAULT_MARKUP))
        self.tree.delete(*self.tree.get_children())
        self.draft = from_job(self.job, CATALOG, self.overrides, markup, self.codes, self.sides)
        self.shown = []
        for ln in self.draft.lines:
            if ln.id in self.deleted:
                continue
            ln.price = self.edits.get(ln.id, ln.price)
            cost = "" if ln.cost is None else f"{ln.cost:.2f}"
            iid = self.tree.insert("", "end", values=(ln.code, ln.desc, cost, f"{ln.price:.2f}{'?' if ln.unsure else ''}"))
            self.shown.append((iid, ln))

    def edit_price(self, event):
        iid = self.tree.identify_row(event.y)
        ln = next((x[1] for x in self.shown if x[0] == iid), None)
        if not ln:
            return
        new = simpledialog.askfloat("Price", ln.desc, initialvalue=ln.price, minvalue=0, parent=self)
        if new is None:
            return
        ln.price = new
        self.edits[ln.id] = new
        self.tree.set(iid, "price", f"{new:.2f}")
        code = line_by_id(self.draft, ln.covers[0]).code if ln.labor else ln.code  # overrides are keyed by part code
        make = self.draft.make
        if messagebox.askyesno("Keep price?", f"Keep ${new:.2f} {ln.kind} for {code} on {make or 'unknown make'}?"):
            save_override(OV_PATH, self.overrides, code, make, ln.kind, new)

    def delete_line(self, _event):
        for iid in self.tree.selection():
            hit = next((x for x in self.shown if x[0] == iid), None)
            if hit:
                self.deleted.add(hit[1].id)
            self.tree.delete(iid)
        self.shown = [x for x in self.shown if self.tree.exists(x[0])]

    def do_fill(self):
        fields = {k: v.get().strip() for k, v in self.vars.items() if v.get().strip()}
        if self.filled and not messagebox.askyesno("Already filled", "Already filled - fill again?"):
            return
        self.withdraw()
        try:
            invomax.fill(fields, [x[1] for x in self.shown])
        except Exception as e:
            return messagebox.showerror("Fill stopped", str(e))
        finally:
            self.deiconify()
        self.filled = True
        note = self.note.get("1.0", "end").strip()
        if note:
            self.clipboard_clear()
            self.clipboard_append(note)
        messagebox.showinfo("Filled", "Check the invoice in InvoMax." + (" Notes are on the clipboard for the Note box." if note else ""))


class ReportWindow(tk.Toplevel):
    """Inspection receipt photos -> one row each -> Word pages (report.py)."""
    COLS = (("date", "Date", 95), ("car", "Year Make", 140), ("vin6", "Last 6 VIN", 90),
            ("miles", "Mileage", 80), ("amount", "Amount", 70))

    def __init__(self, master):
        super().__init__(master)
        self.title("Inspection report")
        self.attributes("-topmost", True)
        self.rows, self.queue, self.done = {}, [], []  # rows: tree iid -> Row
        state = report.load_state()
        bar = ttk.Frame(self)
        bar.pack(fill="x")
        self.add_btn = ttk.Button(bar, text="Add photos", command=self.add_photos)
        self.add_btn.pack(side="left")
        ttk.Label(bar, text=" Customer").pack(side="left")
        self.customer = tk.StringVar(value=state.get("customer", "C&G"))
        ttk.Entry(bar, textvariable=self.customer, width=10).pack(side="left")
        ttk.Label(bar, text=" Page").pack(side="left")
        self.page = tk.StringVar(value=str(state.get("page", 0) + 1))
        ttk.Spinbox(bar, from_=1, to=999, width=4, textvariable=self.page).pack(side="left")
        self.status = ttk.Label(self, text="Add photos of inspection receipts. Double-click a cell to fix it.")
        self.status.pack(anchor="w")
        self.tree = ttk.Treeview(self, columns=[c[0] for c in self.COLS], show="headings", height=20)
        for c, label, w in self.COLS:
            self.tree.heading(c, text=label)
            self.tree.column(c, width=w)
        self.tree.tag_configure("flag", background=FLAG_BG)
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<Double-1>", self.edit_cell)
        self.tree.bind("<Delete>", self.delete_rows)
        ttk.Button(self, text="Save Word file", command=self.save).pack(fill="x")

    def add_photos(self):
        paths = filedialog.askopenfilenames(parent=self, filetypes=[("Images", "*.jpg *.jpeg *.png *.webp")])
        if not paths:
            return
        self.queue += paths
        self.add_btn.state(["disabled"])  # one reader thread at a time
        threading.Thread(target=self.read_all, daemon=True).start()
        self.after(200, self.poll)

    def read_all(self):  # worker thread: one photo at a time, results handed to Tk via self.done
        while self.queue:
            self.done.append(read_receipt(self.queue[0]))
            self.queue.pop(0)

    def poll(self):
        reading = bool(self.queue)  # checked first: the worker adds to done before it pops the queue
        while self.done:
            row, err = self.done.pop(0)
            if err:
                messagebox.showwarning("Couldn't read photo", f"{os.path.basename(row.photo)}\n{err}", parent=self)
            self.show(row)
        if reading:
            self.status.config(text=f"Reading photos… ({len(self.queue)} left)")
            return self.after(200, self.poll)
        self.add_btn.state(["!disabled"])
        self.status.config(text=f"{len(self.rows)} rows. Yellow = check against the receipt.")

    def show(self, row, iid=None):
        values = [getattr(row, c[0]) for c in self.COLS]
        tags = ("flag",) if row.flags else ()
        if iid:
            self.tree.item(iid, values=values, tags=tags)
        else:
            self.rows[self.tree.insert("", "end", values=values, tags=tags)] = row

    def edit_cell(self, event):
        iid, col = self.tree.identify_row(event.y), self.tree.identify_column(event.x)
        if iid not in self.rows or not col:
            return
        key, label, _ = self.COLS[int(col[1:]) - 1]
        row = self.rows[iid]
        why = row.flags.get(key, "")
        new = simpledialog.askstring(label, f"{os.path.basename(row.photo)}\n{why}".strip(),
                                     initialvalue=getattr(row, key), parent=self)
        if new is None:
            return
        setattr(row, key, " ".join(new.upper().split()))
        row.flags.pop(key, None)
        self.show(row, iid)

    def delete_rows(self, _event):
        for iid in self.tree.selection():
            self.rows.pop(iid, None)
            self.tree.delete(iid)

    def save(self):
        if self.queue:
            return messagebox.showinfo("Still reading", "Wait until all photos are read.", parent=self)
        if not self.rows:
            return messagebox.showinfo("No rows", "Add photos first.", parent=self)
        flagged = sum(1 for r in self.rows.values() if r.flags)
        if flagged and not messagebox.askyesno("Check rows", f"{flagged} yellow rows not checked. Save anyway?", parent=self):
            return
        customer = self.customer.get().strip() or "C&G"
        try:
            page = int(self.page.get())
        except ValueError:
            return messagebox.showerror("Page", "Page must be a number.", parent=self)
        path = filedialog.asksaveasfilename(parent=self, defaultextension=".docx", initialfile=f"{customer} P{page}.docx",
                                            filetypes=[("Word", "*.docx")])
        if not path:
            return
        files = report.write_report(list(self.rows.values()), customer, page, path)
        report.save_state({"customer": customer, "page": page + len(files) - 1})
        self.page.set(str(page + len(files)))
        if sys.platform == "win32":
            os.startfile(files[0])
        messagebox.showinfo("Saved", "\n".join(os.path.basename(f) for f in files), parent=self)


if __name__ == "__main__":
    try:
        CATALOG.update(load_catalog(os.path.join(HERE, "parts.csv")))
        app = App()
    except Exception as e:
        tk.Tk().withdraw()
        messagebox.showerror("Couldn't start", str(e))
        sys.exit(1)
    app.mainloop()
