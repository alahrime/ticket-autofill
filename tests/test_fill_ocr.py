import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fill
from ocr import load_image, text_lines
from prices import Line




def test_text_lines_drops_fences_and_blanks():
    assert text_lines("```\nVIN:- 2T1BR32614C809083\n\n  TAG:- XKS4827 \n```") == [
        "VIN:- 2T1BR32614C809083", "TAG:- XKS4827"]
    assert text_lines("") == []


def test_load_image():
    import tempfile
    from PIL import Image
    path = os.path.join(tempfile.mkdtemp(), "page.png")
    Image.new("RGB", (3000, 2000), "white").save(path)
    assert load_image(path)[:2] == b"\xff\xd8"  # downscaled JPEG bytes
    try:
        load_image(__file__)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "JPG or PNG" in str(e)


def test_row_keys_escapes_specials():
    keys = fill.row_keys(Line("ACR", "A/C RECHARGE (R) 50%", 60.0))
    assert keys == "ACR{TAB}A/C RECHARGE {(}R{)} 50{%}{TAB}1{TAB}60.00{ENTER}"


def test_blank_fields_untouched():
    old = fill.FIELD_MAP
    fill.FIELD_MAP = {"plate": [{"auto_id": "p"}], "first": [{"auto_id": "f"}],
                      "odometer": [{"auto_id": "o1"}, {"auto_id": "o2"}]}
    try:
        writes = fill.field_writes({"plate": "XKS4827", "first": "", "odometer": "98431"})
    finally:
        fill.FIELD_MAP = old
    assert writes == [("plate", {"auto_id": "p"}, "XKS4827"), ("odometer", {"auto_id": "o1"}, "98431"),
                      ("odometer", {"auto_id": "o2"}, "98431")]


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
