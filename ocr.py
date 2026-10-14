"""Photo -> text lines, offline (RapidOCR: ONNX models, no internet)."""
from __future__ import annotations

_engine = None


def load_image(path):
    """Open, apply phone EXIF rotation, return RGB numpy array. Clear error for unreadable files."""
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError(f"Can't read {path}. Save the photo as JPG or PNG and try again.") from e
    img.thumbnail((2500, 2500))  # phone photos are huge; OCR doesn't need more
    return np.array(img)


def group_lines(result):
    """result: [[box (4 points), text, score], ...]. Merge boxes on the same row, left to right."""
    boxes = sorted((sum(p[1] for p in b) / 4, b[0][0], abs(b[2][1] - b[0][1]), t) for b, t, _ in result)
    rows = []
    for y, x, h, t in boxes:
        if rows and abs(y - rows[-1][0]) < max(h, rows[-1][1]) * 0.5:
            rows[-1][2].append((x, t))
        else:
            rows.append([y, h, [(x, t)]])
    return [" ".join(t for _, t in sorted(r[2])) for r in rows]


def ocr_lines(path):
    global _engine
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    if _engine is None:
        name = "microsoft/trocr-small-handwritten"
        _engine = (RapidOCR(), TrOCRProcessor.from_pretrained(name), VisionEncoderDecoderModel.from_pretrained(name))
    det, proc, model = _engine
    arr = load_image(path)
    boxes = det(arr)[0] or []  # reuse RapidOCR boxes, replace their text
    img = Image.fromarray(arr)
    result = []
    for b, _, score in boxes:
        xs, ys = [p[0] for p in b], [p[1] for p in b]
        crop = img.crop((min(xs), min(ys), max(xs), max(ys)))
        ids = model.generate(proc(images=crop, return_tensors="pt").pixel_values, max_new_tokens=32)
        result.append([b, proc.batch_decode(ids, skip_special_tokens=True)[0], score])
    return group_lines(result)
