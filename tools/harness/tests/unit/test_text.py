import pytest

from fundacad_harness import text
from fundacad_harness.bridge import DRIVER_API, check_api, unwrap
from fundacad_harness.errors import Ambiguous, DriverMismatch, HarnessError, NotFound


def test_screen_text():
    v = {
        "lines": [
            [0, "titlebar", "region", "", []],
            [1, "#undo-btn", "button", "Undo (Ctrl+Z)", []],
            [1, "#redo-btn", "button", "Redo (Ctrl+Y)", ["disabled"]],
            [0, "items", "region", "", []],
            [1, "", "more", "12 more", []],
        ],
        "truncated": 3,
    }
    assert text.screen(v).splitlines() == [
        "titlebar",
        '  #undo-btn                button "Undo (Ctrl+Z)"',
        '  #redo-btn                button "Redo (Ctrl+Y)" disabled',
        "items",
        "  ... 12 more",
        "... 3 more lines, ask for one region with region=",
    ]


def test_history_and_bodies_text():
    h = {"count": 2, "at": "at end", "rows": [
        {"id": "s1", "name": "Sketch 1", "type": "sketch", "state": ""},
        {"id": "e1", "name": "Extrude 1", "type": "extrude", "state": "error: the profile is open"},
    ]}
    assert text.history(h).splitlines() == [
        "history 2 features, at end",
        "  s1  Sketch 1   sketch",
        "  e1  Extrude 1  extrude  error: the profile is open",
    ]
    b = [{"id": "body1", "name": "Plate", "faces": 6, "visible": True, "fault": None},
         {"id": "body2", "name": "Boss", "faces": 3, "visible": False, "fault": None}]
    assert text.bodies(b).splitlines() == ["bodies 2", "  body1  Plate  6 faces  visible", "  body2  Boss   3 faces  hidden"]


def test_status_text():
    v = {"mode": "selection", "tool": None, "workspace": "model", "doc": "Untitled", "dirty": True,
         "undo": True, "redo": False, "prompt": "Pick a face to draft", "selection": "1 face",
         "recent": {"seq": 4, "level": "info", "text": "Saved", "at": 1000_000}, "error": None}
    assert text.status(v, now=1002).splitlines() == [
        'mode selection | tool none | workspace model | doc "Untitled" dirty | undo yes redo no',
        "prompt: Pick a face to draft",
        "selection: 1 face",
        'recent: info "Saved" 2 s ago',
        "error: none",
    ]


def test_selection_text():
    assert text.selection({"bodies": [], "faces": [], "edges": [], "readout": ""}) == "nothing selected"
    v = {"bodies": [], "faces": [["body1", 3]], "edges": [], "readout": "1 face"}
    assert text.selection(v) == "faces body1:index=3 (1 face)"


def test_api_check():
    check_api(DRIVER_API)
    with pytest.raises(DriverMismatch, match="no harness driver"):
        check_api(None)
    with pytest.raises(DriverMismatch, match="speaks api 2, this package needs 1"):
        check_api(2)


def test_unwrap_maps_error_kinds():
    assert unwrap({"ok": True, "value": 5}) == 5
    with pytest.raises(NotFound) as e:
        unwrap({"ok": False, "error": {"kind": "NotFound", "message": 'no visible control "Extrud"', "candidates": ["pick:extrude"]}})
    assert str(e.value) == 'no visible control "Extrud": did you mean pick:extrude'
    with pytest.raises(Ambiguous):
        unwrap({"ok": False, "error": {"kind": "Ambiguous", "message": "two", "candidates": []}})
    with pytest.raises(HarnessError):
        unwrap("nonsense")
