"""Shell opens every selected face, on one body or across several."""

import json

import pytest

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
TWO = "tools/harness/fixtures/two_boxes.json"
NEAR = "tools/harness/fixtures/near_boxes.json"

SHELLS = "() => window.store.document.features.filter((f) => f.type === 'shell').map((f) => [].concat(f.faces))"


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.view("iso")
    yield session


def pick(s, face, add=False):
    if face.endswith("bottom"):
        s.view("bottom")
    s.pick_face(face, add=add)
    s.view("iso")


def shell(s, thickness="2"):
    s.tool("Shell")
    s.type("field:distance", thickness)
    s.press("Enter")
    return s.page.evaluate(SHELLS)[-1]


def faces_of(s):
    return {b["id"]: b["faces"] for b in s.bodies(raw=True)}


@pytest.mark.parametrize("picks", [["top", "front"], ["top", "front", "right"], ["bottom", "top"]])
def test_every_selected_face_of_one_body_is_opened(s, picks):
    s.open_file(BLOCK)
    for i, p in enumerate(picks):
        pick(s, p, add=i > 0)
    faces = shell(s)
    assert [f["body"] for f in faces] == ["body1"] * len(picks)
    # n faces opened leave 6 - n outer walls, n rims and 6 - n inner walls.
    assert faces_of(s) == {"body1": 12 - len(picks)}


def test_a_face_picked_inside_the_tool_is_opened_too(s):
    s.open_file(BLOCK)
    pick(s, "top")
    s.tool("Shell")
    pick(s, "front", add=True)
    s.type("field:distance", "2")
    s.press("Enter")
    assert len(s.page.evaluate(SHELLS)[-1]) == 2
    assert faces_of(s) == {"body1": 10}


@pytest.mark.parametrize("body", ["body1", "body2"])
def test_a_body_that_is_not_the_active_one_is_shelled(s, body):
    s.open_file(TWO)
    pick(s, f"{body}:top")
    pick(s, f"{body}:front", add=True)
    faces = shell(s)
    assert [f["body"] for f in faces] == [body, body]
    assert faces_of(s)[body] == 10


def test_faces_of_two_bodies_open_on_both(s):
    s.open_file(TWO)
    pick(s, "body1:top")
    pick(s, "body2:top", add=True)
    faces = shell(s)
    assert {f["body"] for f in faces} == {"body1", "body2"}
    assert faces_of(s) == {"body1": 11, "body2": 11}


# A built preview renumbers every face after the first shelled body. body2's top keeps its old id only by chance, every
# other face of it then read as body1's. From the far box the engine refuses that, from the near one it opens a wrong face.
@pytest.mark.parametrize("doc,face", [(TWO, "front"), (NEAR, "right")])
def test_a_built_preview_does_not_move_a_face_to_another_body(s, doc, face):
    s.open_file(doc)
    pick(s, "body1:top")
    pick(s, f"body2:{face}", add=True)
    s.tool("Shell")
    s.type("field:distance", "1")
    s.settle()
    assert faces_of(s) == {"body1": 11, "body2": 11}
    s.press("Enter")
    s.settle()
    shells = s.page.evaluate(SHELLS)
    assert shells, s.page.evaluate("() => document.body.innerText").split("refused")[-1][:200]
    assert [f["body"] for f in shells[-1]] == ["body1", "body2"]
    assert faces_of(s) == {"body1": 11, "body2": 11}


def open_on_two_bodies(s):
    pick(s, "body1:top")
    pick(s, "body2:front", add=True)
    s.tool("Shell")


def shells_after(s):
    return [[f.get("body") for f in faces] for faces in s.page.evaluate(SHELLS)]


def test_a_drag_then_a_typed_value_keep_each_face_on_its_body(s):
    s.open_file(TWO)
    open_on_two_bodies(s)
    s.drag_handle("offset", mm=1)
    s.settle()
    s.type("field:distance", "2", enter=True)
    s.settle()
    assert shells_after(s) == [["body1", "body2"]]
    assert faces_of(s) == {"body1": 11, "body2": 11}


def test_a_face_added_over_a_built_preview_keeps_each_face_on_its_body(s):
    s.open_file(TWO)
    open_on_two_bodies(s)
    s.type("field:distance", "1")
    s.settle()
    s.pick_face("body1:front", add=True)
    s.settle()
    s.type("field:distance", "2", enter=True)
    s.settle()
    assert shells_after(s) == [["body1", "body2", "body1"]]
    assert faces_of(s) == {"body1": 10, "body2": 11}


@pytest.mark.parametrize("steps", [["Undo"], ["Undo", "Redo"]])
def test_undo_and_redo_with_the_tool_open_keep_each_face_on_its_body(s, steps):
    s.open_file(TWO)
    pick(s, "body1:right")
    shell(s, "1")
    s.press("Escape")
    open_on_two_bodies(s)
    s.type("field:distance", "2")
    s.settle()
    for step in steps:
        s.menu(f"Edit/{step}")
        s.settle()
    s.type("field:distance", "3", enter=True)
    s.settle()
    assert shells_after(s)[-1] == ["body1", "body2"]
    assert faces_of(s)["body2"] == 11


def test_a_redo_that_renumbers_the_faces_with_the_tool_open_keeps_each_face_on_its_body(s):
    s.open_file(TWO)
    pick(s, "body1:right")
    shell(s, "1")
    s.press("Escape")
    s.menu("Edit/Undo")
    s.settle()
    open_on_two_bodies(s)
    s.menu("Edit/Redo")
    s.settle()
    s.type("field:distance", "2", enter=True)
    s.settle()
    assert shells_after(s)[-1] == ["body1", "body2"]
    assert faces_of(s)["body2"] == 11


def test_a_face_added_by_editing_a_saved_shell_opens_on_its_own_body(s):
    s.open_file(TWO)
    open_on_two_bodies(s)
    s.type("field:distance", "1", enter=True)
    s.settle()
    s.page.locator(".target-edit").first.click(timeout=5000)
    s.settle()
    s.pick_face("body1:front")
    s.settle()
    s.press("Enter")
    s.settle()
    assert shells_after(s) == [["body1", "body2", "body1"]]
    assert faces_of(s) == {"body1": 10, "body2": 11}


def test_a_face_of_another_body_added_inside_the_tool_opens_on_that_body(s):
    s.open_file(TWO)
    pick(s, "body1:top")
    s.tool("Shell")
    pick(s, "body2:top", add=True)
    s.type("field:distance", "2")
    s.press("Enter")
    s.settle()
    assert shells_after(s) == [["body1", "body2"]]
    assert faces_of(s) == {"body1": 11, "body2": 11}


def open_doc(s, tmp_path, features):
    path = tmp_path / "doc.json"
    path.write_text(json.dumps({"version": 10, "parameters": {}, "features": features}))
    s.open_file(path.as_posix())
    s.settle()


def box(fid, operation=None):
    new = {"operation": operation} if operation else {}
    return {"id": fid, "type": "box", "length": 20, "width": 20, "height": 30, **new}


def move(body, dx):
    return {"id": f"move{dx}", "type": "move", "dx": dx, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": [body]}


def shell_at(point, body=None):
    bound = {"body": body} if body else {}
    return {"id": "s", "type": "shell", "thickness": 1, "faces": {"kind": "face", "by": "nearest", "point": point, **bound}}


def edit_saved_shell(s):
    s.page.locator("#timeline [role=list] [tabindex]").last.click(timeout=5000)
    s.settle()
    s.page.locator(".target-edit").first.click(timeout=5000)
    s.settle()


def test_a_saved_shell_with_no_body_opens_for_edit_and_takes_a_face_on_another_body(s, tmp_path):
    open_doc(s, tmp_path, [box("a"), box("b", "new"), move("body2", 60), shell_at([60, 0, 15])])
    assert faces_of(s) == {"body1": 6, "body2": 11}
    edit_saved_shell(s)
    s.pick_face("body1:front")
    s.settle()
    s.press("Enter")
    s.settle()
    assert shells_after(s) == [[None, "body1"]]
    assert faces_of(s) == {"body1": 11, "body2": 11}


def test_the_row_highlights_a_touching_face_on_the_body_its_selector_names(s, tmp_path):
    open_doc(s, tmp_path, [box("a"), box("b", "new"), move("body2", 20), shell_at([10, 0, 0], "body2")])
    assert faces_of(s) == {"body1": 6, "body2": 11}
    edit_saved_shell(s)
    assert [body for body, _ in s.selection(raw=True)["faces"]] == ["body2"]


# A shell names its body in a one-body document too, as every other face and edge pick does. A body added later cannot
# move it, an unbound one would go to the new active body. The price is a clear refusal once its body id is gone.
def test_a_one_body_shell_stays_on_its_body_when_a_body_is_added_before_it(s, tmp_path):
    open_doc(s, tmp_path, [box("a"), box("b", "new"), move("body2", 60), shell_at([0, 0, 15], "body1")])
    assert faces_of(s) == {"body1": 11, "body2": 6}


def test_a_shell_whose_body_id_is_gone_is_refused_and_does_not_open_another_body(s, tmp_path):
    open_doc(s, tmp_path, [box("a"), shell_at([0, 0, 15], "body2")])
    assert faces_of(s) == {"body1": 6}
    assert s.page.evaluate("() => window.store.buildState.errorMessage") == "Shell: the target body no longer exists"


def sized(fid, side):
    return {**box(fid, "new"), "length": side, "width": side, "height": side * 1.5}


def remove_step(s, fid):
    s.page.evaluate("(id) => window.store.removeFeature(id)", fid)
    s.settle()


def build_error(s):
    return s.page.evaluate("() => window.store.buildState.errorMessage")


@pytest.mark.parametrize(
    "later,left",
    [
        ([sized("b", 40)], {"body2": 11}),
        ([sized("b", 40), sized("c", 60)], {"body2": 11, "body3": 6}),
    ],
)
def test_deleting_an_earlier_body_step_leaves_a_shell_on_its_body(s, tmp_path, later, left):
    open_doc(s, tmp_path, [box("a"), *later, shell_at([0, 0, 30], "body2")])
    remove_step(s, "a")
    assert faces_of(s) == left
    assert build_error(s) is None
    saved = tmp_path / "saved.funda"
    s.save_as(saved.as_posix())
    s.open_file(saved.as_posix())
    s.settle()
    assert faces_of(s) == left
    assert build_error(s) is None


def test_a_deleted_body_is_refused_and_a_later_body_does_not_take_its_number(s, tmp_path):
    open_doc(s, tmp_path, [box("a"), sized("b", 40), sized("c", 60), shell_at([0, 0, 30], "body3")])
    remove_step(s, "c")
    assert faces_of(s) == {"body1": 6, "body2": 6}
    assert build_error(s) == "Shell: the target body no longer exists"

    doc = s.page.evaluate("() => JSON.parse(JSON.stringify(window.store.document))")
    doc["features"].insert(0, sized("d", 80))
    path = tmp_path / "added.json"
    path.write_text(json.dumps({"version": 10, **doc}))
    s.open_file(path.as_posix())
    s.settle()
    assert faces_of(s) == {"body4": 6, "body1": 6, "body2": 6}
    assert build_error(s) == "Shell: the target body no longer exists"


def ctrl_click_world(s, x, y, z):
    p = s.bridge.call("worldPoint", x=x, y=y, z=z)
    s._mouse_click(p["x"], p["y"], mods=["Ctrl"])
    s.settle()


def open_top_with_preview(s):
    s.open_file(BLOCK)
    s.pick_face("top")
    s.tool("Shell")
    s.type("field:distance", "1")
    s.settle()
    assert faces_of(s) == {"body1": 11}


def commit_shell_faces(s):
    s.type("field:distance", "1", enter=True)
    s.settle()
    return s.page.evaluate(SHELLS)[-1]


@pytest.mark.parametrize("through", [(0, 0, 15), (3, -3, 15), (9.5, 0, 15)], ids=["hole-centre", "hole-off-centre", "rim"])
def test_a_ctrl_click_through_the_previews_opening_adds_no_face(s, through):
    open_top_with_preview(s)
    ctrl_click_world(s, *through)
    assert len(commit_shell_faces(s)) == 1
    assert faces_of(s) == {"body1": 11}


def test_a_real_wall_is_still_added_over_the_preview(s):
    open_top_with_preview(s)
    ctrl_click_world(s, 0, -10, 0)
    assert len(commit_shell_faces(s)) == 2
    assert faces_of(s) == {"body1": 10}
