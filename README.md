# Ticket Autofill

Reads a photo of a handwritten notebook page and fills the open InvoMax invoice. Runs fully offline.

## Shop PC setup (Windows, once)
1. Install Python 3.11+ (tick "Add to PATH").
2. Install Ollama for Windows from ollama.com, then run: `ollama pull qwen2.5vl:7b` (~6 GB).
3. In this folder: `pip install -r requirements.txt`
4. Map InvoMax's fields (plan Task 5) in `invomax.py`.

## Use
Double-click `run.bat` (starts Ollama if it isn't running, then the app). Open or paste a photo, pick the job, check yellow fields and prices, click **Fill InvoMax**.

## Inspection report (Word)
Click **Inspection report**, then **Add photos** and pick photos of the printed state inspection receipts (the top half is enough; about a second each). Each receipt becomes one row: date, 2-digit year + make, last 6 of the VIN, mileage, 20.00. Yellow rows need a look (VIN check digit failed, year doesn't match the VIN, something missing): double-click a cell to fix it, Delete removes a row. Set the customer and page number, then **Save Word file**: rows are sorted by date and written into `report_template.docx`, 20 per file (`C&G P4.docx`, `C&G P5.docx`, ...), each with its PAGE label and TOTAL. The next page number is remembered in `report.json`.

## Inspection report on a phone
Open **https://inspect.japaneseautoservice1.com** on the phone and type the PIN once (Safari: Share → Add to Home Screen for an icon). Tap **Add receipt photos** as often as you like (select several at a time); they line up without being read. Then tap **Read all photos**: they are read one at a time on the shop PC (under a second each with Windows' built-in text recognition, tried at a few sizes; the slow vision model is never used from the phone). Yellow and red cards show the photo: tap it to see it full screen and fill in what's missing; Retry re-reads a red one; × removes a card. Photos are kept only until the page is closed. Then **Make Word file** and **Share / Email** (or the ⬇ link). Rows are kept in date order, only on the phone; nothing is stored on the PC and photos are only held in memory while being read. The shop PC must be on with `phone.bat` running (it starts Ollama and `phone.py`, which runs the Cloudflare tunnel with no window and restarts it within seconds if it stops; tunnel log in `cloudflared.log`; to start it at boot, put a shortcut to `phone.bat` in `shell:startup`). If the phone shows Cloudflare error 1033, `phone.bat` isn't running: double-click it.

One-time setup (done 2026-10-27): `cloudflared tunnel create inspection`; its config is `%USERPROFILE%\.cloudflared\inspection.yml` (tunnel id, credentials file, `inspect.japaneseautoservice1.com` → `http://localhost:8080`). The default `config.yml` there belongs to the older `station-api` tunnel and silently wins, so always pass `--config` with `inspection.yml`, also for `cloudflared tunnel route dns --overwrite-dns <inspection id> inspect.japaneseautoservice1.com`. The page asks for a PIN once per phone (kept for a year). The PIN is in `phone_pin.txt` (made at first start, git-ignored); edit it and restart `phone.bat` to change it, which logs every phone out. After 5 wrong PINs in 10 minutes the page refuses all PINs for 10 minutes.

## Learning InvoMax (probe)
Double-click `probe.bat`: a small window opens. Click **▶ Start watching**, then use InvoMax as usual; **⏸ Pause** / **▶ Resume** at any time. It only watches: it never clicks, types or saves anything in InvoMax. It logs what changes (windows opening, box contents, where clicks land) to `probe/watch-YYYY-MM-DD.log`, and saves a picture of each InvoMax pop-up it can't read (choice boxes, Yes/No boxes, menus) to `probe/shots/`. The log holds customer data, so `probe/` is git-ignored and stays on this PC. Close the probe window to stop. `python probe.py map` dumps InvoMax's controls once.

## Shop tickets (check-in iPad, mechanic phones, admin)
Three links on **https://shop.japaneseautoservice1.com**, each with its own sign-in:
- **`/checkin` — customer check-in (shop iPad).** The customer types their first and last name, phone, year / make / model, plate (optional) and what they need. They see nothing else; the screen thanks them and clears itself. To set an iPad up: sign in on it at `/admin`, open **Mechanics & admins**, tap **Use this iPad for check-in** (don't let Safari save your password there; turn on Guided Access to keep customers on the page). **Sign out all check-in iPads** undoes it.
- **`/tech` — mechanics (own phones).** Sign in with your name and your own 6–8 digit PIN. **Accept** a waiting job, add each part (description, qty, price, and the labor to install it; part names from `parts.csv` pop up as hints) or a labor-only line, the odometer and notes; prices and labor can be changed any time while the job is yours. **Finish job** sends it to the admin for review. A mechanic only sees waiting jobs and their own.
- **`/admin` — owner.** Sign in with your username and password. Board (Waiting / Working / Review / Approved), new tickets, review: fix anything, **Send back** (with a note) or **Approve**. Approved tickets are "Ready for InvoMax" and stay editable until **Mark filled** (if you change prices after typing the invoice, change them in InvoMax too). The invoice is printed from InvoMax as usual (company copy signed by the customer, plus the customer's copy). **Mechanics & admins** adds a mechanic (name + PIN) or another admin (password of 10+ characters), resets a PIN or password (that also signs them out and unlocks their name) and turns accounts off or on.

Running it: `shop.bat` (the server, on 127.0.0.1:8081) and `phone.bat` (the Cloudflare tunnel for both `inspect.` and `shop.`) must both run on the shop PC; put shortcuts to both in `shell:startup` to start them at boot. The tunnel config is `%USERPROFILE%\.cloudflared\inspection.yml` (ingress `shop.japaneseautoservice1.com` → `http://localhost:8081`, added 2026-10-29).

First admin: on the first start with no admin, the server writes a one-time code to `setup_code.txt` (valid 24 h, deleted once used). Open `https://shop.japaneseautoservice1.com/setup`, type the code and choose your username and password. Or, at the PC: `python shop.py admin <username>` (also resets a forgotten admin password).

Sign-in limits: 5 wrong tries for a name lock it for 10 minutes, 20 in a day lock it for 24 hours, and 20 wrong tries from one connection lock that connection for 10 minutes. An admin's PIN reset unlocks a mechanic; a locked admin name is cleared by restarting `shop.bat`.

Data: tickets and accounts are in `tickets.db` on this PC (customer names and phones, hashed PINs and passwords; git-ignored). Nothing is deleted. `shop_pin.txt`, `shop_secret.txt` and `mechanics.txt` from the earlier single-PIN version are no longer used and can be deleted.

Year / make / model suggestions come from `vehicles.json` (from NHTSA, committed; the server stays offline). Once a year, for the new model year, run `python vehicles.py` (needs the internet; re-run it if it lists failed requests) and restart `shop.bat`. An approved ticket becomes an InvoMax draft with `tickets.to_draft(ticket, catalog)`; the InvoMax fill itself is still being built (see `docs/superpowers/HANDOFF.md`).

## Tests
Test data is made up. Real sample photos go in `tests/samples/` (git-ignored, never committed).

`python tests/test_read.py`, `python tests/test_prices.py`, `python tests/test_ocr.py`, `python tests/test_invomax.py`, `python tests/test_probe.py`, `python tests/test_draft.py`, `python tests/test_recipes.py`, `python tests/test_report.py`, `python tests/test_phone.py`, `python tests/test_tickets.py`, `python tests/test_shop.py`, `python tests/test_accounts.py`, `python tests/test_vehicles.py` — each prints `ok`.
