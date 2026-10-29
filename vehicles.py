"""Builds vehicles.json (year / make / model lists for the desk page) from NHTSA's public vPIC API. Run by hand,
needs the internet: `python vehicles.py` (about once a year, for the new model year). The shop server only reads
the JSON, so it stays offline. Output: {"MAKE": {"MODEL": [first year, last year]}}.
"""
from __future__ import annotations
import datetime, json, os, re, sys, threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "vehicles.json")
API = "https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/{}/modelyear/{}/vehicletype/{}?format=json"
TYPES = ("passenger car", "multipurpose passenger vehicle (mpv)", "truck")  # no motorcycles, buses, trailers
FIRST = 1990
MAKES = (  # spelled as NHTSA spells them: every Japanese make sold in the US since 1990 first, then the common others
    "ACURA", "HONDA", "INFINITI", "NISSAN", "LEXUS", "TOYOTA", "SCION", "MAZDA", "MITSUBISHI", "SUBARU", "SUZUKI", "ISUZU",
    "FORD", "CHEVROLET", "GMC", "BUICK", "CADILLAC", "CHRYSLER", "DODGE", "JEEP", "RAM", "LINCOLN", "MERCURY", "PONTIAC",
    "SATURN", "OLDSMOBILE", "HYUNDAI", "KIA", "GENESIS", "VOLKSWAGEN", "AUDI", "BMW", "MINI", "MERCEDES-BENZ", "VOLVO",
    "LAND ROVER", "JAGUAR", "PORSCHE", "FIAT", "ALFA ROMEO", "TESLA", "SMART", "HUMMER", "SAAB")
WORKERS, TIMEOUT, TRIES, PAUSE = 4, 30, 4, 0.25  # vPIC answers 403 for a while when asked too fast
MAX_STREAK = 20  # failures in a row: vPIC is down or blocking us, stop asking
# Medium / heavy-duty trucks and bare chassis vPIC lists as trucks; a car shop never sees them.
DROP_WORDS = ("CHASSIS", "MOTORHOME", "RECREATIONAL", "HEARSE", "LIMO", "CONVENTIONAL", "CUTAWAY", "CAB OVER", "CAB BEHIND",
              "W/F7 CAB")
DROP = {"FORD": {"'34"}, "VOLVO": {"VS", "VT"}, "HYUNDAI": {"XCIENT"}, "GMC": {"P TRUCK FORWARD"},
        "CHEVROLET": {"C5", "C6", "C7", "P - SERIES", "B7", "S6", "S7", "P6S"},
        "ISUZU": {"F6", "F7", "FRR", "FSR", "FTR/FVR", "FTR/FVR/EVR", "H-SERIES", "T6F", "T7F", "T8F"}}
HEAVY = re.compile(r"[A-Z]{1,4}[0-9]{3,4}")  # Ford / Mercedes-Benz truck codes: L9000, LTS9000, CF7000, LPS1525
HEAVY_MAKES = {"FORD", "MERCEDES-BENZ"}
RENAME = {"PRIUS PRIME (PHEV)": "PRIUS PRIME", "RAV4 PRIME (PHEV)": "RAV4 PRIME", "GIULIA (952)": "GIULIA"}
OVERRIDES = {("SUBARU", "OUTBACK"): 1995, ("SUBARU", "WRX"): 2002}  # first year; vPIC files earlier ones as LEGACY / IMPREZA


def squash(s):
    return " ".join(str(s or "").split()).upper()


def merge(results):
    """(make, year, [vPIC result rows]) triples -> {"MAKE": {"MODEL": [first, last]}}, sorted. Rows of another make
    (vPIC matches make names loosely), blank models and heavy trucks (DROP*, HEAVY) are dropped. Scions, which vPIC
    files under Toyota ("SCION TC"), go under SCION ("TC"); "650I, ALPINA B6" keeps its first name; RENAME and OVERRIDES
    fix a few odd names and spans."""
    out = {}
    for make, year, rows in results:
        make = squash(make)
        for r in rows:
            mk, model = make, squash(squash(r.get("Model_Name")).split(",")[0])
            model = RENAME.get(model, model)
            if (squash(r.get("Make_Name")) != make or not model or any(w in model for w in DROP_WORDS)
                    or model in DROP.get(mk, ()) or (mk in HEAVY_MAKES and HEAVY.fullmatch(model))):
                continue
            if mk == "TOYOTA" and model.startswith("SCION "):
                mk, model = "SCION", model[6:]
            span = out.setdefault(mk, {}).setdefault(model, [year, year])
            span[0], span[1] = min(span[0], year), max(span[1], year)
    for (mk, model), first in OVERRIDES.items():
        if model in out.get(mk, {}):
            out[mk][model][0] = min(out[mk][model][0], first)
    return {m: dict(sorted(models.items())) for m, models in sorted(out.items())}


def fetch(make, year, vtype):
    """vPIC rows for one make / year / type; raises after TRIES failures."""
    url = API.format(*(urllib.parse.quote(str(x), safe="") for x in (make, year, vtype)))
    for i in range(TRIES):
        time.sleep(PAUSE)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ticket-autofill vehicles.py (one-off list build)"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)["Results"] or []
        except (OSError, ValueError, KeyError) as e:
            if i == TRIES - 1:
                raise
            time.sleep((30 if getattr(e, "code", 0) in (403, 429) else 2) * (i + 1))  # blocked: wait it out


def dump(data):
    """Compact JSON, one make per line."""
    return "{\n" + ",\n".join(json.dumps(m) + ":" + json.dumps(v, separators=(",", ":")) for m, v in data.items()) + "\n}\n"


def main():
    """Asks vPIC for everything; writes vehicles.json only after a clean run, so a bad run keeps the old file."""
    year = datetime.date.today().year
    try:
        fetch("TOYOTA", year, "passenger car")  # one first: no point in 5000 requests if vPIC is down or blocking
    except Exception as e:  # noqa: BLE001
        print(f"vPIC isn't answering ({e}); vehicles.json left unchanged")
        return 2
    jobs = [(m, y, t) for m in MAKES for y in range(FIRST, year + 2) for t in TYPES]
    results, failed, skipped, streak, lock = [], [], [], [0], threading.Lock()

    def one(job):
        if streak[0] >= MAX_STREAK:
            return job, None
        try:
            got = fetch(*job)
        except Exception as e:  # noqa: BLE001 - listed, the run is repeated
            got = e
        with lock:
            streak[0] = streak[0] + 1 if isinstance(got, Exception) else 0
        return job, got

    with ThreadPoolExecutor(WORKERS) as pool:
        for n, (job, got) in enumerate(pool.map(one, jobs), 1):
            if got is None:
                skipped.append(job)
            elif isinstance(got, Exception):
                failed.append((job, got))
            else:
                results.append((job[0], job[1], got))
            if n % 500 == 0:
                print(f"{n}/{len(jobs)} requests", flush=True)
    data = merge(results)
    print(f"{len(data)} makes, {sum(map(len, data.values()))} models, {len(failed)} failed, {len(skipped)} skipped")
    for (m, y, t), e in failed:
        print(f"  failed: {m} {y} {t}: {e}")
    if skipped:
        print(f"  stopped asking after {MAX_STREAK} failures in a row")
    if set(MAKES) - set(data):
        print("!" * 60 + "\nWARNING: no models for " + ", ".join(sorted(set(MAKES) - set(data))) + "\n" + "!" * 60)
    if failed or skipped or not data:
        print("vehicles.json left unchanged; run it again later")
        return 1
    with open(OUT + ".tmp", "w", encoding="utf8", newline="\n") as f:
        f.write(dump(data))
    os.replace(OUT + ".tmp", OUT)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
