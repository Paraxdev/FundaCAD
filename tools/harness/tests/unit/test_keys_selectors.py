import pytest

from fundacad_harness import selectors
from fundacad_harness.errors import BadArgs
from fundacad_harness.keys import key, modifiers


def test_keys_map_to_playwright_names():
    assert key("Enter") == "Enter"
    assert key("esc") == "Escape"
    assert key("Ctrl+Z") == "Control+Z"
    assert key("ctrl+shift+z") == "Control+Shift+z"
    assert key("Shift+H") == "Shift+H"
    assert key("Cmd+S") == "Meta+S"
    assert key("f2") == "F2"
    assert key("up") == "ArrowUp"
    assert key("Ctrl++") == "Control++"
    assert modifiers(["Ctrl", "shift"]) == ["Control", "Shift"]
    with pytest.raises(ValueError):
        key("Hyper+Z")


def test_face_selectors_normalise():
    assert selectors.face("top") == "top"
    assert selectors.face("body1:Top") == "body1:top"
    assert selectors.face("Plate:normal=0, 0.71, 0.71") == "Plate:normal=0,0.71,0.71"
    assert selectors.face("largest  curved") == "largest curved"
    assert selectors.face("index=3") == "index=3"
    assert selectors.face("near=10,0,-15") == "near=10,0,-15"
    with pytest.raises(BadArgs):
        selectors.face("sideways")
    with pytest.raises(BadArgs):
        selectors.face("near=1,2")


def test_edge_selectors_normalise():
    assert selectors.edge("between top front") == "between top front"
    assert selectors.edge("body2:between +z -y") == "body2:between +z -y"
    assert selectors.edge("near=1, 2, 3") == "near=1,2,3"
    assert selectors.edge("longest") == "longest"
    with pytest.raises(BadArgs):
        selectors.edge("between top")
    with pytest.raises(BadArgs):
        selectors.edge("between top sideways")


def test_refs_labels_and_canvas_targets_are_told_apart():
    assert selectors.is_ref("#undo-btn")
    assert selectors.is_ref("action:offer:draft")
    assert selectors.is_ref("menu:File/Open…")
    assert not selectors.is_ref("Draft")
    assert not selectors.is_ref("Press/Pull")
    assert selectors.canvas_target("face:body1:top") == ("face", "body1:top")
    assert selectors.canvas_target("edge:between top front") == ("edge", "between top front")
    assert selectors.canvas_target("Draft") is None
