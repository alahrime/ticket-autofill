"""Photo of a printed Virginia State Police inspection receipt -> one report row."""
from __future__ import annotations
import datetime, re
from dataclasses import dataclass, field
from read import fix_vin

FEE = "20.00"  # the state inspection fee is always $20
PROMPT = ("Read this printed vehicle inspection receipt. Output exactly these five lines, values exactly as "
          "printed:\nInspection Date: 01/31/2026\nMake: HONDA\nVIN: 17 letters and digits\nYear Built: 2024\n"
          "Odometer Reading: 12345\nOutput only those lines, no commentary.")
LABELS = ["Inspection Date", "Sticker Number", "Month Insert", "Station", "Inspector", "License No", "VIN",
          "Make", "Year Built", "Body Type", "Odometer Reading", "Inspection Fee", "Related Charges",
          "Total Charges", "Comments", "Printed", "ID"]
LABEL_RE = re.compile(r"\b(" + "|".join(re.escape(l) for l in LABELS) + r")\b\s*:?", re.I)
DATE_RE = re.compile(r"(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{4})")
# VIN 10th character -> model year (2010-2039 cycle; letters I, O, Q, U, Z and 0 are never used)
_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789"


@dataclass
class Row:
    date: str = ""
    car: str = ""   # "24 TOYOTA"
    vin6: str = ""
    miles: str = ""
    amount: str = FEE
    flags: dict = field(default_factory=dict)  # column -> reason to double-check
    photo: str = ""

    def sort_key(self):
        m = DATE_RE.fullmatch(self.date)
        return (m.group(3), m.group(1), m.group(2)) if m else ("9999",)


def labelled(text):
    """'Label: value' text (any layout, even two labels per line) -> {label lowercased: value}."""
    text = re.sub(r"^\s*(?:Label|Value)\s*:\s*", "", text, flags=re.I | re.M)  # 'Label: VIN' / 'Value: ...' replies
    out, hits = {}, list(LABEL_RE.finditer(text))
    for h, nxt in zip(hits, hits[1:] + [None]):
        value = text[h.end():nxt.start() if nxt else len(text)].strip(" :$\t\r\n")
        out.setdefault(h.group(1).lower(), value.splitlines()[0].strip() if value else "")
    return out


def vin_year(vin):
    i = _YEAR_CODES.find(vin[9]) if len(vin) == 17 else -1
    if i < 0:
        return ""
    year = 2010 + i
    return str(year - 30 if year > datetime.date.today().year + 1 else year)


def parse(lines):
    f, row = labelled("\n".join(lines)), Row()
    # not "Printed:" at the bottom: that's when the receipt was printed. OCR can read a "/" as 1, l, I or |.
    d = re.sub(r"\b(\d\d)[1lI|](\d\d)(?=\s*/)", r"\1/\2", f.get("inspection date", ""))
    d = re.sub(r"(/\s*\d\d)[1lI|](\d{4})\b", r"\1/\2", d)
    m = DATE_RE.search(d)
    if m and 1 <= int(m.group(1)) <= 12 and 1 <= int(m.group(2)) <= 31:
        row.date = f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    else:
        row.flags["date"] = "date not found"
    vin, ok = fix_vin(f.get("vin", ""))
    row.vin6 = vin[-6:]
    if not ok:
        row.flags["vin6"] = (f"the VIN on the receipt has {len(vin)} characters, not 17 (typo on the receipt?): "
                             "last 6 copied as printed" if vin and len(vin) != 17 else
                             "a VIN letter or digit may be misread: compare the last 6 with the receipt")
    year = re.sub(r"\D", "", f.get("year built", ""))
    if len(year) != 4 and ok:
        year = vin_year(vin)
    if len(year) != 4:
        row.flags["car"] = "year not found"
    elif ok and vin_year(vin) != year:
        row.flags["car"] = f"VIN says {vin_year(vin)}"
    make = " ".join(f.get("make", "").upper().split())
    if not make:
        row.flags["car"] = "make not found"
    row.car = f"{year[-2:]} {make}".strip()
    row.miles = re.sub(r"[^\d]", "", f.get("odometer reading", ""))
    if not row.miles:
        row.flags["miles"] = "mileage not found"
    return row


OCR_SIZES = (1600, 2400, 1200)  # longest side; 1600 reads best, the others rescue a few photos it misreads


def windows_ocr(img, size=1600):
    """Windows' built-in OCR: a printed receipt in a fraction of a second (the vision model takes 20 s to minutes)."""
    import asyncio, winocr
    if max(img.size) > size:  # full-size phone photos read worse (a "/" became "1"), and slower
        img = img.copy()
        img.thumbnail((size, size))

    async def run():
        return await winocr.recognize_pil(img, "en")
    return [line.text for line in asyncio.run(run()).lines]


def fast_read(img):
    """Windows OCR at a few sizes until one passes every check; else the one with fewest flags."""
    best = None
    for size in OCR_SIZES:
        if size > max(img.size) and size != OCR_SIZES[0]:
            continue  # nothing new to see at a size the photo doesn't have
        row = parse(windows_ocr(img, size))
        if best is None or len(row.flags) < len(best.flags):
            best = row
        if not best.flags:
            break
    return best


def read_receipt(src, slow=True):
    """Photo (path or file object) -> (Row, error message or None). Safe to run off the Tk thread.
    Windows OCR first; then, if slow, the vision model when that leaves something to check (keeping whichever has
    fewer flags). The phone page passes slow=False: a minute-long model read stalls every photo queued behind it."""
    from ocr import open_image, ocr_lines  # here so parse() tests run without Ollama
    photo = src if isinstance(src, str) else ""
    try:
        img = open_image(src)
    except ValueError as e:
        return Row(photo=photo, flags={"date": "couldn't read photo"}), str(e)
    try:
        row = fast_read(img)
    except Exception:  # no Windows OCR here: the model does it all
        row = parse([])
    err = None
    if row.flags and slow:
        try:
            slow = parse(ocr_lines(img, PROMPT))
            if len(slow.flags) < len(row.flags):
                row = slow
        except Exception as e:
            err = None if row.vin6 or row.miles else str(e)  # only worth showing if OCR found nothing either
    row.photo = photo
    return row, err
