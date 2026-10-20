import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.errors import HarnessError

REPO = Path(__file__).resolve().parents[4]
FACE = {"x": 10, "y": 20, "body": "body1", "index": 3, "what": "face body1:index=3 +z area 800"}
EDGE = {"x": 5, "y": 6, "edgeId": "e7", "what": "edge e7 length 20"}


class Canvas:
    """A click on the point selects `lands` (a Ctrl click toggles it), or nothing when it is None."""

    def __init__(self, lands, selected=None):
        self.lands, self.sel = lands, {"faces": [], "edges": [], "bodies": [], **(selected or {})}
        self.clicks: list[tuple] = []
        self.held: list[str] = []

    def call(self, method, **args):
        if method in ("seq", "settle"):
            return 0
        if method == "messages":
            return {"seq": 0, "rows": []}
        if method == "status":
            return {"mode": "model"}
        if method == "facePoint":
            return dict(FACE)
        if method == "edgePoint":
            return dict(EDGE)
        if method == "selection":
            return {k: list(v) for k, v in self.sel.items()}
        raise AssertionError(method)

    def click(self, x, y, button="left"):
        self.clicks.append((x, y, tuple(self.held)))
        if self.lands is None:
            if "Control" not in self.held:
                self.sel = dict(faces=[], edges=[], bodies=[])
            return
        kind, item = self.lands
        have = self.sel[kind]
        if "Control" in self.held:
            have.remove(item) if item in have else have.append(item)
        else:
            self.sel = dict(faces=[], edges=[], bodies=[])
            self.sel[kind] = [item]
            if kind == "faces":
                self.sel["bodies"] = [item[0]]


def session(app):
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False)
    s.bridge = app
    s.page = types.SimpleNamespace(
        mouse=types.SimpleNamespace(move=lambda *a, **k: None, click=app.click),
        keyboard=types.SimpleNamespace(down=app.held.append, up=app.held.remove),
        wait_for_timeout=lambda ms: None,
    )
    s.settle = lambda *a, **k: "settled"
    return s


def test_a_face_pick_checks_the_face_is_selected():
    s = session(Canvas(("faces", ["body1", 3])))
    assert str(s.pick_face("top")).startswith("picked face body1:index=3")
    s.close()


def test_a_face_pick_that_selects_something_else_says_what_it_got():
    s = session(Canvas(("faces", ["body1", 5])))
    with pytest.raises(HarnessError, match=r"clicked face body1:index=3 \+z area 800 but the selection is \[\['body1', 5\]\]"):
        s.pick_face("top")
    s.close()


def test_an_edge_pick_checks_the_edge_is_selected():
    s = session(Canvas(("edges", "e7")))
    assert str(s.pick_edge("longest")).startswith("picked edge e7")
    s = session(Canvas(None))
    with pytest.raises(HarnessError, match="clicked edge e7 length 20 but the selection is empty"):
        s.pick_edge("longest")
    s.close()


def test_adding_a_face_that_is_already_selected_keeps_it_without_a_click():
    app = Canvas(("faces", ["body1", 3]), {"faces": [["body1", 3]], "bodies": ["body1"]})
    s = session(app)
    assert str(s.pick_face("top", add=True)).startswith("kept face body1:index=3 +z area 800, it was already selected")
    assert app.clicks == [] and app.sel["faces"] == [["body1", 3]]
    s.close()


def test_adding_a_face_holds_ctrl_and_keeps_the_others():
    app = Canvas(("faces", ["body1", 3]), {"faces": [["body1", 1]], "bodies": ["body1"]})
    s = session(app)
    assert str(s.pick_face("top", add=True)).startswith("picked face body1:index=3")
    assert app.clicks == [(10, 20, ("Control",))] and app.sel["faces"] == [["body1", 1], ["body1", 3]]
    s.close()
