"""Always-on-top helper next to InvoMax: photo -> review -> Fill."""
import os, sys, traceback, tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from read import parse, Job
from prices import (load_catalog, load_overrides, save_override, match, position, lines_for,
                    DEFAULT_MARKUP)
import fill

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = {}  # loaded in __main__ so a bad parts.csv shows a dialog
OV_PATH = os.path.join(HERE, "overrides.csv")
FIELDS = [("first", "First"), ("last", "Last"), ("phone", "Phone"), ("year_make", "Year Make"),
          ("plate", "Plate"), ("vin", "VIN"), ("odometer", "Odometer"), ("tech", "Tech")]
FLAG_BG = "#fff3b0"


def note_text(it):
    s = it.desc
    if it.price is not None:
        s += f" {it.price:g}$"
    if it.cost is not None:
        s += f" (cost ${it.cost:g})"
    return s


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Ticket Autofill")
        self.attributes("-topmost", True)
        self.overrides = load_overrides(OV_PATH)
        self.jobs, self.items, self.lines, self.make = [], [], [], ""
        self.edits, self.deleted = {}, set()
        self.filled = False

        bar = ttk.Frame(self)
        bar.pack(fill="x")
        ttk.Button(bar, text="Open photo", command=self.open_photo).pack(side="left")
        ttk.Button(bar, text="Paste photo", command=self.paste_photo).pack(side="left")
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
        from ocr import ocr_lines
        try:
            self.jobs = parse(ocr_lines(path))
        except Exception as e:
            self.jobs = []
            messagebox.showwarning("Couldn't read page", str(e))
        if not self.jobs:  # nothing read: show the photo and empty fields for manual entry
            if sys.platform == "win32" and os.path.exists(path):
                os.startfile(path)
            self.jobs = [Job()]
        self.job_box["values"] = [f"{i + 1}: {j.date} {j.fields.get('year_make', '')}"
                                  for i, j in enumerate(self.jobs)]
        self.job_box.current(0)
        self.show_job(0)

    def show_job(self, i):
        job = self.jobs[i]
        for k, v in self.vars.items():
            v.set(job.fields.get(k, ""))
            self.entries[k].config(bg=FLAG_BG if k in job.flags else "white")
        notes = list(job.notes)
        self.make = job.fields.get("make", "")
        self.items = []
        self.edits, self.deleted = {}, set()
        self.filled = False
        for it in job.items:
            code = match(it.desc, CATALOG) or self.ask_code(it.desc)
            if not code:
                notes.append(note_text(it))
                continue
            side = None
            if CATALOG[code].sided and position(it.desc)[1] is None:
                side = self.ask_side(it.desc)
                if not side:
                    notes.append(note_text(it))
                    continue
            self.items.append((it, code, side))
        self.note.delete("1.0", "end")
        self.note.insert("1.0", "\n".join(notes))
        self.reprice()

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
        self.lines = []
        seen = {}
        for it, code, side in self.items:
            for ln in lines_for(it, code, self.make, CATALOG, self.overrides, markup, side):
                k = (code, ln.desc, bool(ln.labor))
                key = k + (seen.get(k, 0),)
                seen[k] = key[3] + 1
                if key in self.deleted:
                    continue
                ln.price = self.edits.get(key, ln.price)
                cost = "" if ln.labor or it.cost is None else f"{it.cost:.2f}"
                q = "?" if it.unsure and it.price is not None and not ln.labor else ""
                iid = self.tree.insert("", "end", values=(ln.code, ln.desc, cost, f"{ln.price:.2f}{q}"))
                self.lines.append((iid, ln, code, key))

    def edit_price(self, event):
        iid = self.tree.identify_row(event.y)
        hit = next((x for x in self.lines if x[0] == iid), None)
        if not hit:
            return
        _, ln, code, key = hit
        new = simpledialog.askfloat("Price", ln.desc, initialvalue=ln.price, minvalue=0, parent=self)
        if new is None:
            return
        ln.price = new
        self.edits[key] = new
        self.tree.set(iid, "price", f"{new:.2f}")
        kind = "labor" if ln.labor else "part"
        if messagebox.askyesno("Keep price?", f"Keep ${new:.2f} {kind} for {code} on {self.make or 'unknown make'}?"):
            save_override(OV_PATH, self.overrides, code, self.make, kind, new)

    def delete_line(self, _event):
        for iid in self.tree.selection():
            hit = next((x for x in self.lines if x[0] == iid), None)
            if hit:
                self.deleted.add(hit[3])
            self.tree.delete(iid)
        self.lines = [x for x in self.lines if self.tree.exists(x[0])]

    def do_fill(self):
        fields = {k: v.get().strip() for k, v in self.vars.items() if v.get().strip()}
        if self.filled and not messagebox.askyesno("Already filled", "Already filled - fill again?"):
            return
        self.withdraw()
        try:
            fill.fill(fields, [x[1] for x in self.lines])
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


if __name__ == "__main__":
    try:
        CATALOG.update(load_catalog(os.path.join(HERE, "parts.csv")))
        app = App()
    except Exception as e:
        tk.Tk().withdraw()
        messagebox.showerror("Couldn't start", str(e))
        sys.exit(1)
    app.mainloop()
