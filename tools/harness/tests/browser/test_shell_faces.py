"""Shell opens every selected face, on one body or across several."""

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
    assert len(faces) == len(picks)
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
