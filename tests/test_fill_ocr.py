import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fill
from ocr import group_lines
from prices import Line


def box(x, y, w=50, h=20):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def test_group_lines_merges_rows_left_to_right():
    result = [[box(200, 102), "2T1BR32614C809083", .9], [box(10, 100), "VIN:-", .9],
              [box(10, 140), "TAG:-", .9], [box(200, 143), "XKS4827", .9]]
    assert group_lines(result) == ["VIN:- 2T1BR32614C809083", "TAG:- XKS4827"]
    assert group_lines([]) == []


def test_row_keys_escapes_specials():
    keys = fill.row_keys(Line("ACR", "A/C RECHARGE (R) 50%", 60.0))
    assert keys == "ACR{TAB}A/C RECHARGE {(}R{)} 50{%}{TAB}1{TAB}60.00{ENTER}"


def test_blank_fields_untouched():
    fill.FIELD_MAP = {"plate": [{"auto_id": "p"}], "first": [{"auto_id": "f"}],
                      "odometer": [{"auto_id": "o1"}, {"auto_id": "o2"}]}
    writes = fill.field_writes({"plate": "XKS4827", "first": "", "odometer": "98431"})
    assert writes == [({"auto_id": "p"}, "XKS4827"), ({"auto_id": "o1"}, "98431"), ({"auto_id": "o2"}, "98431")]


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
