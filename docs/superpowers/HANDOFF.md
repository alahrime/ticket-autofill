# Handoff — ticket-autofill

**Updated:** 2026-10-26. **Branch:** `main` at `235f357`, pushed. Spec: `specs/2026-10-14-invomax-autofill-design.md`. Plan: `plans/2026-10-14-invomax-autofill.md`.

## State
- **Done:** Plan Tasks 1–4: `read.py`, `prices.py`, `ocr.py` (Qwen2.5-VL 7B through local Ollama), `fill.py` helpers, `app.py` and `run.bat`.
- **Reading off the UI thread:** `app.py` reads the photo on a worker thread (`read_page`). While it reads, Open and Paste are disabled and the title says "reading photo…". The result is polled back on the Tk thread every 200 ms.
- **Not done:**
  - Plan Task 5, the InvoMax control map. `fill.FIELD_MAP` and `GRID_START` are empty, and only the shop's Windows PC can fill them in.
  - Plan Task 6, shop acceptance.
- **Never run end to end on a real page:** no session has checked the OCR against a real page (the pass bar below). No session has opened the window on a real display either. On the Mac, the system Python 3.9 aborts when Tk starts.

## Testing in a cloud session (Linux, no Windows, no InvoMax)
Run each step in order and stop at the first failure.

1. **Unit tests.** Each command prints `ok`.
   ```bash
   pip install -r requirements.txt
   python3 tests/test_read.py && python3 tests/test_prices.py && python3 tests/test_fill_ocr.py
   ```
2. **Ollama and the model.** The model is about 6 GB. Without a GPU, one page takes 1–3 minutes, and `ocr.TIMEOUT` is 600 s.
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   (ollama serve >/tmp/ollama.log 2>&1 &) ; sleep 3
   ollama pull qwen2.5vl:7b
   ```
3. **A sample page.** Real photos are git-ignored, so the repo has none. The user uploads one, which goes in `tests/samples/page1.jpg`. Without a real photo, only the error paths can be tested.
4. **OCR pass bar (plan Task 3, Step 6).**
   ```bash
   python3 -c "from ocr import ocr_lines; from read import parse; ls=ocr_lines('tests/samples/page1.jpg'); print('\n'.join(ls)); [print(j) for j in parse(ls)]"
   ```
   The page passes if:
   - Two jobs are found.
   - Job 1's VIN reads `2T1BR32614C809083`, either exactly or flagged with at most one wrong character.
   - The plate and odometer are correct.
   - At least 3 of job 1's 4 items match a catalog code.

   **If it fails:** save the raw lines as a new case in `tests/test_read.py` and fix the parser or the prompt. Don't add new dependencies.
5. **Error paths.**
   - Stop Ollama (`pkill ollama`), then run step 4 again. Expected: "Can't reach Ollama…".
   - Run `python3 -c "from ocr import load_image; load_image('requirements.txt')"`. Expected: `ValueError … JPG or PNG`.
6. **The window, headless (plan Task 4, Step 3).**
   ```bash
   apt-get install -y python3-tk xvfb
   xvfb-run -a python3 app.py
   ```
   A screenshot needs `xwd` or `import`. Simpler: drive `App` from a script. Call `app.load('tests/samples/page1.jpg')`, then `app.update()` in a loop until the title loses "reading photo…". Then assert on `app.jobs`, the job dropdown and the field values. While a page is reading, the window must keep responding and Open/Paste must be disabled. Clicking Fill must show "control map isn't set up yet".
   - On Linux, **Paste** (`ImageGrab.grabclipboard`) may not work without `xclip`. That doesn't matter, because the shop PC runs Windows.

## Can't be tested in the cloud
- Everything in `fill.fill()`, which needs pywinauto and the InvoMax window.
- Plan Task 5 (control map) and Task 6 (acceptance), which happen on the shop PC.
- Real CPU speed on the shop PC.

## Constraints
- Lightweight and minimal: no new dependencies (`pillow`, and `pywinauto` on Windows only).
- Fully offline at the shop. Ollama stays on `127.0.0.1`.
- Tests are plain `assert` scripts that print `ok`.
- Never commit real photos or customer data.
