import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import BadArgs

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


def test_type_into_a_button_is_refused_before_anything_is_clicked():
    class NoField(One):
        def call(self, method, **args):
            if method == "fieldValue":
                raise BadArgs('text:"Display" "Display" is not a value field, no value box is open')
            return super().call(method, **args)

    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = NoField({"ref": 'text:"Display"', "label": "Display", "region": "titlebar"})
    clicks = []
    s.page = types.SimpleNamespace(locator=lambda sel: types.SimpleNamespace(click=lambda **k: clicks.append(sel)))
    s.settle = lambda *a, **k: "settled"
    with pytest.raises(BadArgs, match="no value box is open"):
        s.type("D", "10")
    assert clicks == []
    s.close()


def test_type_with_enter_says_when_the_app_refused_the_value():
    from fundacad_harness.errors import StepFailed
    said = 'Size: "M12" is not a size, type M5 or a diameter'

    class Refusing(One):
        reads = 0

        def call(self, method, **args):
            if method == "fieldValue":
                self.reads += 1
                return {"text": "M12", "typed": True, "problem": said if self.reads > 2 else ""}
            return super().call(method, **args)

    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = Refusing({"ref": "field:size", "label": "Size", "region": "valuebox"})
    keys = types.SimpleNamespace(press=lambda k: None, type=lambda t: None)
    s.page = types.SimpleNamespace(locator=lambda sel: types.SimpleNamespace(click=lambda **k: None),
                                   keyboard=keys, evaluate=lambda js: None)
    s.settle = lambda *a, **k: "settled"
    with pytest.raises(StepFailed, match=r'field:size "Size" did not take "M12" on Enter: Size: "M12" is not a size'):
        s.type("Size", "M12", enter=True)
    s.close()
