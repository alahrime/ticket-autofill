# Ticket Autofill

Reads a photo of a handwritten notebook page and fills the open InvoMax invoice. Runs fully offline.

## Shop PC setup (Windows, once)
1. Install Python 3.11+ (tick "Add to PATH").
2. Install Ollama for Windows from ollama.com, then run: `ollama pull qwen2.5vl:7b` (~6 GB).
3. In this folder: `pip install -r requirements.txt`
4. Map InvoMax's fields (plan Task 5) in `fill.py`.

## Use
Double-click `run.bat` (starts Ollama if it isn't running, then the app). Open or paste a photo, pick the job, check yellow fields and prices, click **Fill InvoMax**.

## Learning InvoMax (probe)
Double-click `probe.bat`: a small window opens. Click **▶ Start watching**, then use InvoMax as usual; **⏸ Pause** / **▶ Resume** at any time. It only watches: it never clicks, types or saves anything in InvoMax. It logs what changes (windows opening, box contents, where clicks land) to `probe/watch-YYYY-MM-DD.log`, and saves a picture of each InvoMax pop-up it can't read (choice boxes, Yes/No boxes, menus) to `probe/shots/`. The log holds customer data, so `probe/` is git-ignored and stays on this PC. Close the probe window to stop. `python probe.py map` dumps InvoMax's controls once.

## Tests
Test data is made up. Real sample photos go in `tests/samples/` (git-ignored, never committed).

`python tests/test_read.py`, `python tests/test_prices.py`, `python tests/test_fill_ocr.py`, `python tests/test_probe.py` — each prints `ok`.
