"""Shell opens every selected face, on one body or across several."""

import pytest

pytestmark = pytest.mark.browser

BLOCK = "tools/harness/fixtures/block.json"
TWO = "tools/harness/fixtures/two_boxes.json"

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
