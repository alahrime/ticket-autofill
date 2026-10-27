import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from probe import clip, diff, name_controls


def test_name_controls_counts_per_class():
    assert name_controls(["TLMDEdit", "TEdit", "TLMDEdit"]) == ["TLMDEdit#0", "TEdit#0", "TLMDEdit#1"]


def test_clip_joins_lines_and_truncates():
    assert clip("a\r\nb\nc") == "a⏎b⏎c"
    assert clip(None) == ""
    assert clip("x" * 250) == "x" * 200 + "…"


def test_diff_lists_added_changed_removed():
    prev = {"window Customers [TForm]": "open", "InvoMax / TLMDEdit#0": ""}
    cur = {"InvoMax / TLMDEdit#0": "JANE", "window Vehicles [TForm]": "open"}
    assert diff(prev, cur) == ["+ window Vehicles [TForm] = 'open'",
                               "~ InvoMax / TLMDEdit#0: '' -> 'JANE'",
                               "- window Customers [TForm]"]
    assert diff(cur, cur) == []


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
