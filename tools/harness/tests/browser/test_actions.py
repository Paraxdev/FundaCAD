import pytest

from fundacad_harness.errors import HarnessError

pytestmark = pytest.mark.browser

PLATE = "tools/harness/fixtures/plate.json"
BLOCK = "tools/harness/fixtures/block.json"


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    yield session


@pytest.fixture
def plate(s):
    s.open_file(PLATE)
    s.view("iso")
    return s


@pytest.mark.smoke
def test_a_tool_by_its_label_runs_and_escape_leaves(plate):
    plate.pick_face("top")
    step = plate.tool("Press/Pull")
    assert "mode running" in str(step)
    assert plate.status(raw=True)["prompt"]
    plate.press("Escape")
    assert plate.status(raw=True)["mode"] != "running"


@pytest.mark.smoke
def test_a_tool_inside_a_category_opens_its_flyout_first(s):
    step = s.tool("Revolve")
    assert str(step).startswith('started pick:revolve "Revolve"')


@pytest.mark.smoke
def test_typing_into_the_value_box_shows_the_value_and_enter_commits(plate):
    plate.pick_face("top")
    plate.tool("Press/Pull")
    plate.type("D", "7")
    assert plate.call("fieldValue", target="field:distance")["text"] == "7"
    plate.press("Enter")
    rows = plate.history(raw=True)["rows"]
    assert [r["type"] for r in rows] == ["box", "press-pull"]


def test_menu_opens_preferences_and_panel_closes_it(s):
    s.menu("Edit/Preferences...")
    assert "category:appearance" in s.screen(region="dialog")
    assert str(s.panel("preferences")).startswith("preferences already open")
    s.panel("preferences", open=False)
    assert s.screen(region="dialog") == "nothing on screen"


def test_panel_is_idempotent(s):
    s.panel("history")
    assert "already open" in str(s.panel("history"))
    assert str(s.panel("history", open=False)).startswith("closed")
    assert "already closed" in str(s.panel("history", open=False))
    s.panel("history")


def test_pick_face_selects_that_face(plate):
    step = plate.pick_face("top")
    assert step.data["selection"]["faces"] == [["body1", step.data["index"]]]
    assert "+z" in str(step)


def test_pick_edge_between_two_faces(plate):
    step = plate.pick_edge("between top front")
    assert step.data["selection"]["edges"] == [step.data["edgeId"]]


def test_drag_handle_changes_the_value_box(plate):
    plate.pick_face("top")
    plate.tool("Press/Pull")
    before = plate.call("fieldValue", target="field:distance")["text"]
    step = plate.drag_handle("push", by=40)
    after = plate.call("fieldValue", target="field:distance")["text"]
    assert after != before
    assert f"field:distance {after}" in str(step), "the step says the value it reached"
    plate.press("Escape")


def test_undo_and_redo_change_the_history(plate):
    plate.pick_face("top")
    plate.tool("Press/Pull")
    plate.type("D", "4", enter=True)
    assert plate.history(raw=True)["count"] == 2
    plate.undo()
    assert plate.history(raw=True)["count"] == 1
    plate.redo()
    assert plate.history(raw=True)["count"] == 2


def test_open_file_reads_a_fixture_and_the_rebuild_is_settled(s):
    s.open_file(PLATE)
    assert s.bodies(raw=True)[0]["faces"] == 6
    assert s.history().startswith("history 1 feature")
    assert s.last_error() == "none"


def test_a_view_keeps_a_running_extrude_and_its_typed_depth(plate):
    plate.pick_face("top")
    plate.tool("Extrude")
    plate.type("D", "5")
    assert str(plate.view("front")).startswith("view Front, mode running")
    plate.view("iso")
    plate.press("Enter")
    assert plate.history(raw=True)["count"] == 2


def test_open_file_over_unsaved_changes_opens_the_new_file(plate):
    plate.pick_face("top")
    plate.tool("Press/Pull")
    plate.type("D", "7", enter=True)
    with pytest.raises(HarnessError, match="unsaved changes"):
        plate.open_file(BLOCK, discard=False)
    assert plate.status(raw=True)["doc"] == "plate.json"
    assert plate.screen(region="dialog") == "nothing on screen"
    assert str(plate.open_file(BLOCK)).startswith("opened block.json")
    assert plate.status(raw=True)["doc"] == "block.json"
    assert plate.history(raw=True)["count"] == 1


def test_import_file_drops_a_mesh_and_counts_the_bodies(s, tmp_path):
    import struct
    a, b, c, d = (0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)
    tris = [(a, c, b), (a, b, d), (a, d, c), (b, c, d)]
    stl = tmp_path / "tetra.stl"
    stl.write_bytes(b"\0" * 80 + struct.pack("<I", len(tris)) + b"".join(struct.pack("<12fH", 0, 0, 0, *p, *q, *r, 0) for p, q, r in tris))
    step = s.import_file(stl)
    assert str(step).startswith("dropped tetra.stl, 1 body now")
    assert s.page.locator("input[data-harness-drop]").count() == 0
