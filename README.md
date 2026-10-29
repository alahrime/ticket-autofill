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

## Shop tickets (desk iPad + mechanic phones)
Double-click `shop.bat` on the shop PC; it serves on port 8081. Open `http://<shop PC's address>:8081` on the iPad and the phones and type the PIN once (it is in `shop_pin.txt`, made at first start; edit it and restart to change it, which logs every device out).
- **Desk (iPad, `/desk`):** **New ticket** takes the customer's first and last name, phone, year / make / model, plate (optional) and what they want done. The board shows Waiting / Working / Review / Approved. A ticket in Review shows the mechanic's parts and labor with totals: fix anything, then **Send back** (with a note) or **Approve**. Approved tickets are "Ready for InvoMax"; click **Mark filled** once it is on the InvoMax invoice. The invoice is printed from InvoMax as usual (company copy signed by the customer, plus the customer's copy).
- **Mechanic (phone, `/tech`):** pick your name once (names come from `mechanics.txt`, one per line). **Accept** a waiting job, add each part (description, qty, price, and the labor to install it; part names from `parts.csv` pop up as hints) or a labor-only line, the odometer and notes. **Finish job** sends it to the desk for review.
- Year / make / model suggestions on the desk come from `vehicles.json` (from NHTSA, committed; the server stays offline). Once a year, for the new model year, run `python vehicles.py` (needs the internet; re-run it if it lists failed requests) and restart `shop.bat`.
- Tickets are kept in `tickets.db` on this PC (customer names and phones; git-ignored). Nothing is deleted.
- An approved ticket becomes an InvoMax draft with `tickets.to_draft(ticket, catalog)`; the InvoMax fill itself is still being built (see `docs/superpowers/HANDOFF.md`).

Online (phones on cellular), done by the owner once: add an ingress rule `- hostname: shop.japaneseautoservice1.com` / `service: http://localhost:8081` above the catch-all in `%USERPROFILE%\.cloudflared\inspection.yml`, run `cloudflared tunnel --config %USERPROFILE%\.cloudflared\inspection.yml route dns <inspection id> shop.japaneseautoservice1.com`, restart `phone.bat`, and turn on "Always Use HTTPS" for that hostname in Cloudflare. The tunnel runs from `phone.bat`, so both must be running.

## Tests
Test data is made up. Real sample photos go in `tests/samples/` (git-ignored, never committed).

`python tests/test_read.py`, `python tests/test_prices.py`, `python tests/test_ocr.py`, `python tests/test_invomax.py`, `python tests/test_probe.py`, `python tests/test_draft.py`, `python tests/test_recipes.py`, `python tests/test_report.py`, `python tests/test_phone.py`, `python tests/test_tickets.py`, `python tests/test_shop.py`, `python tests/test_vehicles.py` — each prints `ok`.
