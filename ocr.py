"""Photo -> text lines, offline: a local vision model (Qwen2.5-VL 7B) served by Ollama on this PC."""
from __future__ import annotations
import base64, io, json, urllib.error, urllib.request

MODEL = "qwen2.5vl:7b"  # "qwen2.5vl:3b" is ~3x faster but merged jobs and dropped costs on the sample page
URL = "http://127.0.0.1:11434/api/generate"
TIMEOUT = 600  # seconds; CPU-only PCs can take minutes per page
KEEP_ALIVE = "30m"  # keep the model loaded between photos: loading it takes minutes on a CPU-only PC
PROMPT = ("Transcribe this handwritten auto-shop notebook page exactly, one output line per written line, "
          "top to bottom. Keep labels like VIN:-, TAG:-, MIL:-, Car:-, the * bullets, $ signs and every "
          "digit/letter exactly as written. VINs and plates are uppercase letters and digits. "
          "Output only the transcription, no commentary.")


def open_image(src):
    """Path, file object or PIL image -> upright RGB image (phone EXIF rotation applied). Clear error if unreadable."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    if isinstance(src, Image.Image):
        return src
    try:
        return ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    except (UnidentifiedImageError, OSError) as e:
        name = src if isinstance(src, str) else "the photo"
        raise ValueError(f"Can't read {name}. Save the photo as JPG or PNG and try again.") from e


def load_image(src):
    """Downscaled JPEG bytes for the model."""
    img = open_image(src).copy()
    img.thumbnail((1280, 1280))  # enough for the model; bigger is slower, not better
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def text_lines(text):
    """Model reply -> non-empty lines, without markdown code fences."""
    return [l for l in (s.strip() for s in text.splitlines()) if l and not l.startswith("```")]


def ocr_lines(src, prompt=PROMPT):
    body = json.dumps({"model": MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0}, "keep_alive": KEEP_ALIVE,
                       "images": [base64.b64encode(load_image(src)).decode()]}).encode()
    req = urllib.request.Request(URL, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return text_lines(json.load(r)["response"])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError(f"The reading model isn't installed. Run: ollama pull {MODEL}") from e
        raise RuntimeError(f"Ollama error {e.code}: {e.read().decode(errors='replace')}") from e
    except (urllib.error.URLError, ConnectionError) as e:
        raise RuntimeError("Can't reach Ollama. Start the Ollama app (or run: ollama serve) and try again.") from e
