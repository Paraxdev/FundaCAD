import sys
import types
from pathlib import Path

from fundacad_harness import Session

REPO = Path(__file__).resolve().parents[4]


class One:
    def __init__(self, hit):
        self.hit = hit

    def call(self, method, **args):
        if method == "seq":
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "model"}
        if method == "locate":
            return {"marker": "m", **self.hit}
        raise AssertionError(method)


def clicked(target, hit):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = One(hit)
    s.page = types.SimpleNamespace(locator=lambda sel: types.SimpleNamespace(click=lambda **k: None))
    s.settle = lambda *a, **k: "settled"
    try:
        return str(s.click(target))
    finally:
        s.close()


def test_a_label_click_says_where_the_control_is():
    line = clicked("Sketch", {"ref": "feature:f1", "label": "Sketch", "region": "history"})
    assert line.startswith('clicked feature:f1 "Sketch" in history, mode model')


def test_a_label_that_only_starts_a_control_name_says_so():
    line = clicked("Sketch", {"ref": "folder:f:Sketches", "label": "Sketches", "region": "items"})
    assert 'clicked folder:f:Sketches "Sketches" in items, no control is named "Sketch"' in line


def test_a_key_hint_or_case_is_still_the_same_name():
    line = clicked("extrude#1", {"ref": "action:extrude", "label": "Extrude (E)", "region": "toolrail"})
    assert line.startswith('clicked action:extrude "Extrude (E)" in toolrail, mode')


def test_a_ref_click_says_nothing_more():
    line = clicked("#undo-btn", {"ref": "#undo-btn", "label": "Undo", "region": "titlebar"})
    assert line.startswith('clicked #undo-btn "Undo", mode')
