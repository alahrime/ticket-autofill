import os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from draft import from_job, needs, note_text, line_by_id
from prices import load_catalog
from read import parse

CAT = load_catalog(os.path.join(ROOT, "parts.csv"))
PAGE = """10/14/26
VIN:- 2T1BR32614C809083
TAG:- XKS4827
MIL:- 98,431
Car:- 2004 Subaru Forester.
*oil chng. 30$
$81 *Left front Axle 200$
*side mirror 90
*flux capacitor 500$""".splitlines()


def test_header_values_from_page():
    d = from_job(parse(PAGE)[0], CAT, {}, 2.5)
    assert d.header["vin"].value == "2T1BR32614C809083" and d.header["vin"].source == "page"
    assert d.header["date"].value == "10/14/26"
    assert d.header["odometer"].value == "98431"
    assert "first" not in d.header  # missing stays missing
    assert d.make == "subaru"


def test_lines_ids_cost_and_labor_covers():
    d = from_job(parse(PAGE)[0], CAT, {}, 2.5, sides={2: "LEFT"})
    assert [(ln.id, ln.code, ln.kind) for ln in d.lines] == [
        (1, "OIL", "part"), (2, "AXL", "part"), (3, "INSTALL-PART", "labor"), (4, "MIR", "part"), (5, "INSTALL-PART", "labor")]
    axle, labor = line_by_id(d, 2), line_by_id(d, 3)
    assert axle.price == 200 and axle.cost == 81 and labor.covers == [2]
    assert line_by_id(d, 4).unsure  # "90" without $
    assert not d.lines[0].unsure


def test_missing_code_and_side_go_to_notes():
    job = parse(PAGE)[0]
    assert needs(job, CAT) == [(2, "side"), (3, "code")]
    d = from_job(job, CAT, {}, 2.5)
    assert d.unmatched == [(2, "side"), (3, "code")]
    assert d.notes == ["side mirror 90$", "flux capacitor 500$"]
    d = from_job(job, CAT, {}, 2.5, codes={3: "OIL"}, sides={2: "BOTH"})
    assert d.unmatched == [] and d.notes == []
    assert [ln.desc for ln in d.lines if ln.code == "MIR"] == ["SIDE MIRROR    LEFT", "SIDE MIRROR    RIGHT"]


def test_ids_stable_when_markup_changes():
    job = parse(PAGE)[0]
    a = from_job(job, CAT, {}, 2.5, sides={2: "LEFT"})
    b = from_job(job, CAT, {}, 3.0, sides={2: "LEFT"})
    assert [(ln.id, ln.desc) for ln in a.lines] == [(ln.id, ln.desc) for ln in b.lines]


def test_note_text():
    item = parse(["$81 *Left front Axle 200$"])[0].items[0]
    assert note_text(item) == "Left front Axle 200$ (cost $81)"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
