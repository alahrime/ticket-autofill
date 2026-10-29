import contextlib, io, json, os, shutil, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vehicles


def row(make, model):
    return {"Make_ID": 1, "Make_Name": make, "Model_ID": 2, "Model_Name": model, "VehicleTypeName": "Passenger Car"}


def test_merge():
    got = vehicles.merge([
        ("TOYOTA", 2001, [row("TOYOTA", "Camry"), row("Toyota", "  land  cruiser ")]),
        ("TOYOTA", 1995, [row("TOYOTA", "camry")]),
        ("TOYOTA", 2010, [row("TOYOTA", "CAMRY"), row("TOYOTA", "Camry")]),  # passenger car and MPV both list it
        ("TOYOTA", 1999, [row("TOYOTA", "Land Cruiser"), row("TOYOTA", ""), row("TOYOTA", None)]),
        ("RAM", 2012, [row("RAM", "1500"), row("RAMIREZ TRAILERS", "FLATBED")]),  # vPIC matches make names loosely
        ("SMART", 2008, [row("FORTWO SMART CARS", "X")]),
        ("ACURA", 1990, []),
        ("TOYOTA", 2005, [row("TOYOTA", "Scion tC")]), ("TOYOTA", 2016, [row("TOYOTA", "Scion tC")]),
    ])
    assert got == {"RAM": {"1500": [2012, 2012]}, "SCION": {"TC": [2005, 2016]},
                   "TOYOTA": {"CAMRY": [1995, 2010], "LAND CRUISER": [1999, 2001]}}
    assert list(got) == ["RAM", "SCION", "TOYOTA"] and list(got["TOYOTA"]) == ["CAMRY", "LAND CRUISER"]
    assert vehicles.merge([]) == {}


def test_merge_drops_and_fixes():
    keep = {"FORD": ["F-150", "F-250", "E-350", "MUSTANG", "B-750"], "MERCEDES-BENZ": ["300", "SPRINTER", "C-CLASS"],
            "ISUZU": ["NPR", "NQR", "RODEO"], "CHEVROLET": ["SILVERADO", "EXPRESS"], "VOLVO": ["XC90", "S60"],
            "BMW": ["M235I", "B7", "X5"], "HYUNDAI": ["XG300", "SONATA"], "NISSAN": ["NV200", "NISSAN Z"]}
    drop = {"FORD": ["'34", "L9000", "LTS9000", "CF7000", "FT900", "B600", "P700", "A8513", "C800", "MOTORHOME CHASSIS",
                     "RECREATIONAL VEHICLE"],
            "MERCEDES-BENZ": ["L1013", "LPS1525", "LP1219"], "VOLVO": ["VS", "VT", "F6 W/F7 CAB", "CAB OVER ENGINE HT",
                                                                       "CAB BEHIND ENGINE"],
            "CHEVROLET": ["C5", "C6", "C7", "P - SERIES", "HEARSE/LIMO", "CUTAWAY CHASSIS", "R CONVENTIONAL"],
            "DODGE": ["RAM CHASSIS CAB"], "HYUNDAI": ["XCIENT"],
            "ISUZU": ["F6", "F7", "FRR", "FSR", "FTR/FVR", "H-SERIES", "T6F", "T7F", "T8F"]}
    got = vehicles.merge([(mk, 2010, [row(mk, m) for m in keep.get(mk, []) + drop.get(mk, [])]) for mk in {*keep, *drop}])
    assert {mk: set(v) for mk, v in got.items()} == {mk: set(v) for mk, v in keep.items()}

    got = vehicles.merge([
        ("BMW", 2015, [row("BMW", "650i, Alpina B6"), row("BMW", "650I")]), ("BMW", 2019, [row("BMW", "650I, B6")]),
        ("TOYOTA", 2021, [row("TOYOTA", "RAV4 Prime (PHEV)"), row("TOYOTA", "Prius Prime (PHEV)")]),
        ("ALFA ROMEO", 2017, [row("ALFA ROMEO", "Giulia (952)")]),
        ("SUBARU", 2005, [row("SUBARU", "Outback")]), ("SUBARU", 2015, [row("SUBARU", "WRX")]),
        ("SUBARU", 1990, [row("SUBARU", "Legacy")]),
    ])
    assert got == {"ALFA ROMEO": {"GIULIA": [2017, 2017]}, "BMW": {"650I": [2015, 2019]},
                   "SUBARU": {"LEGACY": [1990, 1990], "OUTBACK": [1995, 2005], "WRX": [2002, 2015]},
                   "TOYOTA": {"PRIUS PRIME": [2021, 2021], "RAV4 PRIME": [2021, 2021]}}
    assert vehicles.merge([("SUBARU", 2010, [row("SUBARU", "Forester")])]) == {"SUBARU": {"FORESTER": [2010, 2010]}}


def run_main(fetch):
    """main() with a fake fetch and a temp OUT holding an old list -> (exit code, file contents, printed text)."""
    d, saved = tempfile.mkdtemp(), (vehicles.fetch, vehicles.OUT)
    vehicles.OUT, vehicles.fetch = os.path.join(d, "vehicles.json"), fetch
    try:
        with open(vehicles.OUT, "w", encoding="utf8") as f:
            f.write('{"OLD": {"CAR": [1990, 1990]}}')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = vehicles.main()
        with open(vehicles.OUT, encoding="utf8") as f:
            return code, json.load(f), out.getvalue(), os.listdir(d)
    finally:
        vehicles.fetch, vehicles.OUT = saved
        shutil.rmtree(d)


def test_main_writes_only_clean_runs():
    old = {"OLD": {"CAR": [1990, 1990]}}
    code, data, text, files = run_main(lambda mk, y, t: [row(mk, "CAR " + t[:5])])
    assert code == 0 and len(data) == len(vehicles.MAKES) and data["ACURA"]["CAR TRUCK"][0] == vehicles.FIRST
    assert files == ["vehicles.json"] and "WARNING" not in text

    def down(*a):
        raise OSError("HTTP Error 403: Forbidden")
    code, data, text, _ = run_main(down)
    assert code == 2 and data == old and "left unchanged" in text  # the probe failed: nothing else asked

    calls = []
    def blocked(mk, y, t):  # the probe works, then vPIC blocks everything
        calls.append(mk)
        if len(calls) > 1:
            raise OSError("HTTP Error 403: Forbidden")
        return []
    code, data, text, _ = run_main(blocked)
    assert code == 1 and data == old and "left unchanged" in text and len(calls) < 40  # the circuit breaker

    def one_bad(mk, y, t):
        if (mk, y, t) == ("HONDA", 2000, "truck"):
            raise OSError("timed out")
        return [row(mk, "CAR")] if mk != "SAAB" else []
    code, data, text, _ = run_main(one_bad)
    assert code == 1 and data == old and "HONDA 2000 truck" in text and "WARNING: no models for SAAB" in text

    code, data, text, _ = run_main(lambda mk, y, t: [])
    assert code == 1 and data == old  # nothing at all: keep the old list


def test_dump():
    data = {"ACURA": {"MDX": [2001, 2027]}, "TOYOTA": {"CAMRY": [1990, 2027]}}
    text = vehicles.dump(data)
    assert json.loads(text) == data and len(text.splitlines()) == 4 and ", " not in text


def test_makes():
    assert len(set(vehicles.MAKES)) == len(vehicles.MAKES) and all(m == vehicles.squash(m) for m in vehicles.MAKES)
    assert {"TOYOTA", "HONDA", "SCION", "ISUZU", "MERCEDES-BENZ", "LAND ROVER"} <= set(vehicles.MAKES)


def test_json_file():  # the committed list, when built
    if not os.path.exists(vehicles.OUT):
        return
    with open(vehicles.OUT, encoding="utf8") as f:
        data = json.load(f)
    for make, models in data.items():
        assert make == vehicles.squash(make)
        for model, (a, b) in models.items():
            assert model == vehicles.squash(model) and vehicles.FIRST <= a <= b and "," not in model


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
