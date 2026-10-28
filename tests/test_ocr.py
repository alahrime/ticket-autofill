import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ocr import load_image, text_lines


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

if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
