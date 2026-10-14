import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from read import parse, fix_vin

PAGE1 = """10/14/26
VIN:- 2T1BR32614C809083
TAG:- XKS4827
MIL:- 98431
Car:- 2004 Subaru Forester.
*oil chng. 30$
*Front brake pads 100$
*Rear brake pads. 100$
$81 *Left front Axle 200$
________________
10/14/26
TAG:- JTW2648
MIL:- 142087
Car: 1994 Nissan Altima.
(R) 4Q *oil chng. 20$
*Left brake light 30$""".splitlines()


def test_splits_jobs_and_reads_fields():
    a, b = parse(PAGE1)
    assert a.date == "10/14/26"
    assert a.fields["vin"] == "2T1BR32614C809083"
    assert a.fields["plate"] == "XKS4827"
    assert a.fields["odometer"] == "98431"
    assert a.fields["year_make"] == "2004 Subaru Forester"
    assert a.fields["make"] == "subaru"
    assert "vin" not in b.fields and "first" not in b.fields  # missing stays missing
    assert b.fields["plate"] == "JTW2648"


def test_items_cost_price_and_notes():
    a, b = parse(PAGE1)
    assert [(i.desc, i.price) for i in a.items] == [
        ("oil chng", 30), ("Front brake pads", 100), ("Rear brake pads", 100), ("Left front Axle", 200)]
    assert a.items[3].cost == 81
    assert b.items[0].desc == "oil chng" and b.items[0].price == 20
    assert b.notes == ["(R) 4Q"]


def test_name_phone_when_present():
    (j,) = parse(["10/14/26", "Jane Doe", "Ph: 555 010 0123", "Mil: 12,000"])
    assert (j.fields["first"], j.fields["last"]) == ("Jane", "Doe")
    assert j.fields["phone"] == "(555)010-0123"
    assert j.fields["odometer"] == "12000"


def test_label_variants():
    (j,) = parse(["ViN;- 2T1BR32614C809083", "Odo - 99", "plate: abc 123"])
    assert j.fields["vin"] == "2T1BR32614C809083"
    assert j.fields["odometer"] == "99"
    assert j.fields["plate"] == "ABC123"


def test_vin_fixes():
    assert fix_vin("2T1BR326I4C8O9083") == ("2T1BR32614C809083", True)  # I/O normalised
    assert fix_vin("2T1BR326L4C809083") == ("2T1BR32614C809083", True)  # unique lookalike swap
    assert fix_vin("2T1BR32G14C809083") == ("2T1BR32G14C809083", False)  # two swaps validate -> don't guess
    assert fix_vin("2T1BR32614C80908") == ("2T1BR32614C80908", False)   # too short


def test_flags():
    (j,) = parse(["VIN: 12345", "TAG: XKS4827", "MIL: 12a45", "Ph: 555"])
    assert set(j.flags) == {"vin", "plate", "odometer", "phone"}


def test_garbage_does_not_crash():
    assert parse([]) == []
    (j,) = parse(["???", "*", "$ *", "Car: Honda"])
    assert j.fields["year_make"] == "Honda" and j.fields["make"] == "honda"


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
