import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import invomax
from draft import Line


def test_row_keys_escapes_specials():
    keys = invomax.row_keys(Line("ACR", "A/C RECHARGE (R) 50%", 60.0))
    assert keys == "ACR{TAB}A/C RECHARGE {(}R{)} 50{%}{TAB}1{TAB}60.00{ENTER}"


def test_blank_fields_untouched():
    old = invomax.FIELD_MAP
    invomax.FIELD_MAP = {"plate": [{"auto_id": "p"}], "first": [{"auto_id": "f"}],
                      "odometer": [{"auto_id": "o1"}, {"auto_id": "o2"}]}
    try:
        writes = invomax.field_writes({"plate": "XKS4827", "first": "", "odometer": "98431"})
    finally:
        invomax.FIELD_MAP = old
    assert writes == [("plate", {"auto_id": "p"}, "XKS4827"), ("odometer", {"auto_id": "o1"}, "98431"),
                      ("odometer", {"auto_id": "o2"}, "98431")]

if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
