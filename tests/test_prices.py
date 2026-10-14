import os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from prices import load_catalog, load_overrides, save_override, match, lines_for, markup_price, tier
from read import Item

CAT = load_catalog(os.path.join(ROOT, "parts.csv"))


def test_match_aliases():
    assert match("Front brake pads", CAT) == "FBP"
    assert match("Rear brake pads", CAT) == "RBP"
    assert match("oil chng", CAT) == "OIL"
    assert match("Left front Axle", CAT) == "AXL"
    assert match("Left brake light", CAT) == "BBLB"
    assert match("oil filter", CAT) == "OFL"  # longest alias wins
    assert match("flux capacitor", CAT) is None


def test_written_price_and_labor_like_invomax():
    lines = lines_for(Item("Front brake pads", 100), "FBP", "subaru", CAT, {})
    assert [(l.code, l.desc, l.price) for l in lines] == [
        ("FBP", "FRONT BRAKE PADS", 100), ("INSTALL-PART", "Remove & Install: FRONT BRAKE PADS", 100)]


def test_sided_part_takes_position_from_text():
    part, labor = lines_for(Item("Left front Axle", 200, 81), "AXL", "subaru", CAT, {})
    assert part.desc == "AXLE ASSEMBLY    FRONT/LEFT" and part.price == 200  # written price beats cost
    assert labor.desc == "Remove & Install: AXLE ASSEMBLY    FRONT/LEFT" and labor.labor


def test_both_sides_expands_to_two_pairs():
    lines = lines_for(Item("mirror"), "MIR", "honda", CAT, {}, side="BOTH")
    assert [l.desc for l in lines if not l.labor] == ["SIDE MIRROR    LEFT", "SIDE MIRROR    RIGHT"]
    assert len(lines) == 4


def test_price_precedence():
    ov = {("FBP", "bmw", "part"): 333, ("FBP", "bmw", "labor"): 120}
    assert lines_for(Item("pads", 90), "FBP", "bmw", CAT, ov)[0].price == 90            # written
    assert lines_for(Item("pads", None, 81), "FBP", "bmw", CAT, ov)[0].price == 205      # cost x markup
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, ov)[0].price == 333                # override
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, ov)[1].price == 120
    assert lines_for(Item("pads"), "FBP", "bmw", CAT, {})[0].price == 160                # 100 x 1.6
    assert lines_for(Item("pads"), "FBP", "unknownmake", CAT, {})[0].price == 100


def test_flat_service_has_no_labor_line():
    assert len(lines_for(Item("oil chng", 30), "OIL", "nissan", CAT, {})) == 1


def test_markup_and_tiers():
    assert markup_price(81) == 205
    assert markup_price(80, 2.0) == 160
    assert (tier("Honda"), tier("ford"), tier("BMW"), tier(None)) == (1.0, 1.15, 1.6, 1.0)


def test_overrides_round_trip():
    path = os.path.join(tempfile.mkdtemp(), "overrides.csv")
    ov = load_overrides(path)
    assert ov == {}
    save_override(path, ov, "AXL", "subaru", "labor", 275.0)
    assert load_overrides(path) == {("AXL", "subaru", "labor"): 275.0}


def test_both_on_non_sided_part_is_single_pass():
    lines = lines_for(Item("both front brake pads", 100), "FBP", "honda", CAT, {}, side="BOTH")
    assert [l.code for l in lines] == ["FBP", "INSTALL-PART"] and len(lines) == 2


def test_make_casing_is_normalized():
    path = os.path.join(tempfile.mkdtemp(), "overrides.csv")
    ov = load_overrides(path)
    save_override(path, ov, "AXL", "Subaru", "labor", 275.0)
    assert lines_for(Item("Left front Axle", 200), "AXL", "subaru", CAT, load_overrides(path))[1].price == 275
    save_override(path, ov, "AXL", "subaru", "labor", 280.0)
    assert lines_for(Item("Left front Axle", 200), "AXL", " SUBARU ", CAT, load_overrides(path))[1].price == 280


def test_markup_price_float_edge():
    assert markup_price(25, 2.2) == 55


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
