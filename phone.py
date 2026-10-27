"""Phone page behind a PIN (online through the Cloudflare tunnel, or on the shop Wi-Fi).

Each photo is read while the phone waits (Windows OCR only, under a second) and the row comes back in the same reply;
the rows live only on the phone. "Make Word file" sends the rows and gets the .docx back to share from the phone. Nothing is kept on the
PC and nothing runs in the background.
"""
from __future__ import annotations
import hashlib, hmac, io, json, os, re, secrets, subprocess, sys, threading, time
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote
import report
from inspection import read_receipt, Row

PORT = 8080
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_PHOTO = 25 * 1024 * 1024
PIN_FILE = os.path.join(HERE, "phone_pin.txt")  # the PIN; edit to change it (git-ignored)
LOG = os.path.join(HERE, "phone.log")  # one line per request: time, path, status, seconds (no customer data)
MAX_TRIES, LOCKOUT = 5, 600  # wrong PINs allowed per 10 minutes, from anyone
FIELDS = ("date", "car", "vin6", "miles")
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TUNNEL = ["cloudflared", "tunnel", "--config", os.path.expanduser(r"~\.cloudflared\inspection.yml"),
          "--logfile", os.path.join(HERE, "cloudflared.log"), "run"]


def load_pin(path=PIN_FILE):
    """The PIN in path; makes a random 6-digit one the first time."""
    try:
        with open(path, encoding="utf8") as f:
            pin = f.read().strip()
    except OSError:
        pin = ""
    if not pin:
        pin = f"{secrets.randbelow(10 ** 6):06d}"
        with open(path, "w", encoding="utf8") as f:
            f.write(pin + "\n")
    return pin


def read_photo(data, reader=read_receipt):
    """Photo bytes -> row dict for the phone. The photo is only ever in memory. No model fallback: what OCR can't
    read comes back flagged, and the phone shows the photo to fill it in by hand."""
    row, err = reader(io.BytesIO(data), slow=False)
    return {**{k: getattr(row, k) for k in FIELDS}, "flags": row.flags, "error": err or ""}


def word_page(rows, customer, page):
    """Up to report.PER_PAGE row dicts -> (file name, .docx bytes)."""
    if not rows or len(rows) > report.PER_PAGE:
        raise ValueError(f"1 to {report.PER_PAGE} rows per page.")
    customer = re.sub(r'[\\/:*?"<>|]', "", customer).strip() or "C&G"
    rows = sorted((Row(**{k: str(r.get(k, "")) for k in FIELDS}) for r in rows), key=Row.sort_key)
    buf = io.BytesIO()
    report.write_page(rows, customer, page, buf)
    return f"{customer} P{page}.docx", buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    reader = staticmethod(read_receipt)
    read_lock = threading.Lock()  # one photo at a time; each takes a fraction of a second
    pin = ""  # set by serve()
    fails, fails_lock = [], threading.Lock()  # times of recent wrong PINs (all callers look alike behind the tunnel)

    def log_message(self, *args):  # pythonw has no console; reply() logs instead
        pass

    def log(self, code):
        try:
            with open(LOG, "a", encoding="utf8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.command} {self.path} {code} "
                        f"{time.time() - getattr(self, 'started', time.time()):.1f}s\n")
        except OSError:
            pass

    def reply(self, code, body=b"", ctype="application/json", headers=()):
        self.log(code)
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for h in headers:
            self.send_header(*h)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_PHOTO:
            raise ValueError("Photo too big.")
        return self.rfile.read(n)

    def token(self):  # the cookie value; changing the PIN logs every phone out
        return hashlib.sha256(f"ticket-autofill:{self.pin}".encode()).hexdigest()

    def authed(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return bool(self.pin) and "pin" in c and hmac.compare_digest(c["pin"].value, self.token())

    def login(self):
        pin = parse_qs(self.body().decode(errors="replace")).get("pin", [""])[0].strip()
        with self.fails_lock:
            now = time.time()
            self.fails[:] = [t for t in self.fails if now - t < LOCKOUT]
            if len(self.fails) >= MAX_TRIES:
                return self.reply(429, login_page("Too many wrong PINs. Wait 10 minutes."), "text/html; charset=utf-8")
            if not hmac.compare_digest(pin.encode(), self.pin.encode()):
                self.fails.append(now)
                return self.reply(401, login_page("Wrong PIN."), "text/html; charset=utf-8")
            self.fails.clear()
        self.reply(303, b"", "text/plain", [("Location", "/"), ("Set-Cookie",
                   f"pin={self.token()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict")])

    def do_GET(self):
        if self.path != "/":
            return self.reply(404, {"error": "not found"})
        self.reply(200, PAGE.encode() if self.authed() else login_page(), "text/html; charset=utf-8")

    def do_POST(self):
        self.started = time.time()
        try:
            if self.path == "/login":
                return self.login()
            if not self.authed():
                return self.reply(401, {"error": "PIN needed"})
            if self.path == "/read":
                data = self.body()
                with self.read_lock:
                    return self.reply(200, read_photo(data, self.reader))
            if self.path == "/word":
                d = json.loads(self.body() or b"{}")
                name, data = word_page(d.get("rows") or [], str(d.get("customer", "")), int(d.get("page", 1)))
                return self.reply(200, data, DOCX, [("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")])
            self.reply(404, {"error": "not found"})
        except (ValueError, TypeError, OSError) as e:  # urllib errors from Ollama are OSErrors too
            self.reply(400, {"error": str(e)})


def keep_tunnel():
    """Run the Cloudflare tunnel with no window and start it again whenever it stops (crash, network drop)."""
    while True:
        try:
            subprocess.run(TUNNEL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError:
            pass
        time.sleep(5)


def serve(port=PORT, tunnel=False):
    Handler.pin = load_pin()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # opened first: a second copy fails here, before tunnelling
    if tunnel:
        threading.Thread(target=keep_tunnel, daemon=True).start()
    server.serve_forever()


def login_page(msg=""):
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspection report</title>
<style>body{{font:16px system-ui,sans-serif;margin:0;padding:40px 16px;background:#f4f4f4;color:#222;text-align:center}}
input,button{{font:inherit;font-size:22px;padding:12px;border-radius:8px;width:100%;max-width:280px;box-sizing:border-box}}
input{{border:1px solid #ccc;text-align:center;letter-spacing:4px;margin:12px 0}} button{{border:0;background:#1f5fbf;color:#fff}}
p{{color:#b00}}</style></head><body>
<h1>Inspection report</h1>
<form method="post" action="/login"><input type="password" name="pin" inputmode="numeric" autocomplete="current-password"
placeholder="PIN" autofocus required><br><button>Open</button></form><p>{msg}</p>
</body></html>""".encode()


PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspection report</title>
<style>
body{font:16px system-ui,sans-serif;margin:0;padding:12px 12px 170px;background:#f4f4f4;color:#222}
h1{font-size:20px;margin:4px 0 10px}
button{font:inherit;padding:12px 16px;border:0;border-radius:8px;background:#1f5fbf;color:#fff}
button.light{background:#ddd;color:#222}
button:disabled{opacity:.5}
#status{margin:8px 0;color:#555}
.card{background:#fff;border-radius:10px;padding:10px;margin:8px 0;display:grid;grid-template-columns:1fr 1fr;gap:6px;position:relative}
.card.flag{background:#fff3b0}
.card.bad{background:#fde2e2}
.card label{font-size:12px;color:#666;display:block}
.card input{font:inherit;width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:6px}
.card .why{grid-column:1/3;font-size:13px;color:#8a5a00}
.card .del{position:absolute;top:4px;right:4px;padding:2px 10px;background:none;color:#999;font-size:22px}
.card.reading{display:block;color:#777}
.card.waiting{display:flex;gap:10px;align-items:center;color:#555}
.card.waiting img{width:56px;height:56px;object-fit:cover;border-radius:6px}
.card .retry{margin-top:6px;padding:6px 12px}
.card .tools{grid-column:1/3;display:flex;gap:8px;align-items:center}
.card .thumb{width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid #ccc}
#viewer{position:fixed;inset:0;background:#000;z-index:9;overflow:auto;-webkit-overflow-scrolling:touch}
#viewer img{width:100%;display:block}
#viewer button{position:fixed;top:12px;right:12px;background:#fff;color:#000}
#bottom{position:fixed;left:0;right:0;bottom:0;background:#fff;padding:10px 12px;box-shadow:0 -2px 6px #0002}
#bottom .line{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
#bottom input{font:inherit;padding:6px;border:1px solid #ccc;border-radius:6px;width:5em}
#files a{margin-right:12px}
</style></head><body>
<h1>Inspection report</h1>
<input type="file" id="pick" accept="image/*" multiple hidden>
<button id="add">Add receipt photos</button> <button id="go" hidden></button>
<div id="status"></div><div id="list"></div>
<div id="viewer" hidden><button id="close">Close</button><img id="big" alt="Receipt photo"></div>
<div id="bottom">
 <div class="line">Customer <input id="customer"> Page <input id="page" type="number" min="1"></div>
 <div class="line"><button id="make">Make Word file</button><button id="share" hidden>Share / Email</button>
  <button id="clear" class="light">Clear rows</button></div>
 <div class="line" id="files"></div>
</div>
<script>
// Rows live only on this phone (saved in the browser so a reload keeps them).
const $ = id => document.getElementById(id);
const COLS = [["date","Date"],["car","Year Make"],["vin6","Last 6 VIN"],["miles","Mileage"]];
const KEY = "inspection-report";
let st = {rows: [], customer: "C&G", page: 1, next: 1};
try{ st = Object.assign(st, JSON.parse(localStorage.getItem(KEY)) || {}); }catch(e){}
st.rows = st.rows.filter(r => !r.reading && !r.waiting);  // photos aren't kept across a reload; add those again
const photos = {};  // row id -> photo, kept to view or Retry until the page closes (not saved across reloads)
const urls = {};  // row id -> object URL of that photo
let files = [], busy = false;
function changed(){  // rows changed after a Word file was made: the next one replaces it, under the same page numbers
  files = [];
  if (st.made){ st.page = st.made; $("page").value = st.page; }
}

function save(){ try{ localStorage.setItem(KEY, JSON.stringify(st)); }catch(e){} }
const dateKey = d => { const m = /^(\\d\\d)\\/(\\d\\d)\\/(\\d{4})$/.exec(d || ""); return m ? m[3] + m[1] + m[2] : "9"; };
const sorted = () => [...st.rows].sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)) || a.id - b.id);

async function shrink(file){  // phone photos are huge; the reader only needs ~1600px
  try{
    const bmp = await createImageBitmap(file, {imageOrientation:"from-image"});
    const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));  // the PC tries 1600, 2400 and 1200
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  }catch(e){ return file; }
}

async function read(row){  // one photo, one request: the reply is the row
  row.reading = true; row.error = ""; render();
  try{
    const r = await fetch("/read", {method:"POST", headers:{"Content-Type":"image/jpeg"}, body: photos[row.id]});
    if (r.status === 401) return location.reload();
    if (!r.ok) throw Object.assign(new Error(r.status >= 500 ? "The PC didn't answer in time. Tap Retry." : "Error " + r.status), {http: true});
    Object.assign(row, await r.json());
  }catch(e){ row.error = e.http ? e.message : "Couldn't reach the PC (connection dropped). Tap Retry."; row.failed = true; }
  row.reading = false; if (!row.error) row.failed = false;
  save(); render();
}

function photoUrl(id){ return urls[id] || (urls[id] = URL.createObjectURL(photos[id])); }
function forget(id){ if (urls[id]) URL.revokeObjectURL(urls[id]); delete urls[id]; delete photos[id]; }
$("close").onclick = () => { $("viewer").hidden = true; };
$("add").onclick = () => $("pick").click();
$("pick").onchange = async e => {  // photos just line up; nothing is read until "Read all photos"
  const picked = [...e.target.files]; e.target.value = "";
  for (const f of picked){
    const row = {id: st.next++, date:"", car:"", vin6:"", miles:"", flags:{}, error:"", waiting:true};
    photos[row.id] = await shrink(f);
    st.rows.push(row); changed(); render();
  }
};
$("go").onclick = async () => {  // one photo at a time; photos added meanwhile join the line
  busy = true; render();
  for (let r; (r = st.rows.find(y => y.waiting)); ){ r.waiting = false; await read(r); }
  busy = false; render();
};

function card(r){
  const d = document.createElement("div");
  if (r.reading){ d.className = "card reading"; d.textContent = "Reading…"; return d; }
  if (r.waiting){
    d.className = "card waiting";
    const img = document.createElement("img"); img.src = photoUrl(r.id);
    const t = document.createElement("span"); t.textContent = busy ? "In line" : "Ready to read";
    const x = document.createElement("button"); x.className = "del"; x.textContent = "×";
    x.onclick = () => { st.rows = st.rows.filter(y => y !== r); forget(r.id); render(); };
    d.append(img, t, x); return d;
  }
  const flags = Object.keys(r.flags || {});
  d.className = "card" + (r.failed ? " bad" : flags.length ? " flag" : "");
  for (const [k, label] of COLS){
    const w = document.createElement("div"), l = document.createElement("label"), i = document.createElement("input");
    l.textContent = label + (r.flags[k] ? " ⚠" : ""); i.value = r[k] || "";
    i.inputMode = k === "miles" ? "numeric" : "text";
    i.onchange = () => { r[k] = i.value.toUpperCase().trim().replace(/\\s+/g, " "); delete r.flags[k]; changed(); save(); render(); };
    w.append(l, i); d.append(w);
  }
  const why = Object.values(r.flags).concat(r.error ? [r.error] : []);
  if (why.length){ const p = document.createElement("div"); p.className = "why"; p.textContent = why.join(" · "); d.append(p); }
  if (photos[r.id] && (r.failed || flags.length)){  // the photo, to check by eye, and Retry for a failed read
    const t = document.createElement("div"); t.className = "tools";
    const img = document.createElement("img"); img.className = "thumb"; img.src = photoUrl(r.id);
    img.onclick = () => { $("big").src = photoUrl(r.id); $("viewer").hidden = false; };
    t.append(img);
    if (r.failed){
      const b = document.createElement("button"); b.className = "retry"; b.textContent = "Retry";
      b.onclick = () => { r.failed = false; r.error = ""; r.waiting = true; render(); if (!busy) $("go").onclick(); };  // joins the line
      t.append(b);
    }
    d.append(t);
  }
  const x = document.createElement("button"); x.className = "del"; x.textContent = "×";
  x.onclick = () => { if (confirm("Remove this row?")){ st.rows = st.rows.filter(y => y !== r); forget(r.id); changed(); save(); render(); } };
  d.append(x);
  return d;
}

function render(){
  if (!document.activeElement || !$("list").contains(document.activeElement)) $("list").replaceChildren(...sorted().map(card));
  const waiting = st.rows.filter(r => r.waiting).length, done = st.rows.filter(r => !r.waiting && !r.reading);
  const yellow = done.filter(r => Object.keys(r.flags || {}).length || r.failed).length;
  $("go").hidden = busy || !waiting; $("go").textContent = `Read all photos (${waiting})`;
  $("status").textContent = busy ? `Reading… ${waiting + 1} left. Keep this page open; you can add more photos.` :
    waiting ? `${waiting} photos ready. Add more, or tap Read all photos.` :
    st.rows.length ? `${st.rows.length} rows` + (yellow ? ` · ${yellow} to check (yellow/red)` : "") :
    "Add photos of the printed inspection receipts.";
  $("make").disabled = busy || waiting > 0;
  $("share").hidden = !(files.length && navigator.canShare && navigator.canShare({files}));
  $("files").replaceChildren(...files.map(f => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = "⬇ " + f.name; return a; }));
}

$("customer").value = st.customer; $("page").value = st.page;
$("customer").onchange = () => { st.customer = $("customer").value.trim() || "C&G"; save(); };
$("page").onchange = () => { st.page = parseInt($("page").value) || 1; st.made = 0; save(); };  // typed by hand: use it as is

$("make").onclick = async () => {
  const rows = sorted().filter(r => !r.reading && !r.waiting);
  if (!rows.length) return alert("Add photos first.");
  const check = rows.filter(r => Object.keys(r.flags || {}).length || r.failed).length;
  if (check && !confirm(check + " rows still need a check. Make the file anyway?")) return;
  $("make").disabled = true; files = [];
  try{
    for (let i = 0, page = st.page; i < rows.length; i += 20, page++){
      const r = await fetch("/word", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({customer: st.customer, page, rows: rows.slice(i, i + 20)})});
      if (r.status === 401) return location.reload();
      if (!r.ok) throw new Error((await r.json()).error);
      files.push(new File([await r.blob()], `${st.customer} P${page}.docx`,
        {type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}));
    }
    st.made = st.page; st.page += files.length; $("page").value = st.page; save();
  }catch(e){ alert("Couldn't make the file: " + e.message); }
  $("make").disabled = false; render();
};
$("share").onclick = () => navigator.share({files}).catch(() => {});  // files are ready: iOS needs share() right on the tap
$("clear").onclick = () => { if (confirm("Clear all rows? Make and share the Word file first.")){ st.rows.forEach(r => forget(r.id)); st.rows = []; files = []; st.made = 0; save(); render(); } };  // batch done: numbering moves on
render();
</script></body></html>
"""

if __name__ == "__main__":
    print(f"Serving on port {PORT}; PIN is in {PIN_FILE}")
    serve(tunnel="--tunnel" in sys.argv)
