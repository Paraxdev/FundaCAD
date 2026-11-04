"""Waiting pickers take a face or edge row from the Geometry list by keys alone: Section, Mirror, Press/Pull and a
mechanism joint, a refusal is spoken and the pick keeps waiting, and a second file leaves no pick behind."""

import math

import pytest

from test_geometry_browser import (
    OFFSET,
    SLANT,
    browse,
    down_to,
    focus,
    heard,
    list_kind,
    next_frames,
    open_doc,
    picked,
    rows,
    to_canvas,
)

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

# The slanted box's centre, the up face lies 7.5 mm from it along the face normal.
SLANT_CENTRE = [-72.5, 18.25, 44]
TWO = "tools/harness/fixtures/two_boxes.json"

SECTION = "() => window.store.sectionView"
WAITING = "() => window.section.picking"
FEATURES = "() => window.store.document.features.slice(%d).map(({ id, ...f }) => f)"


@pytest.fixture
def s(session):
    session.press("Escape")
    open_doc(session, OFFSET)
    yield session
    session.page.evaluate("() => document.activeElement?.blur()")
    for _ in range(4):
        session.page.keyboard.press("Escape")


def tree_to(s, name):
    s.command("Go to Items")
    for _ in range(14):
        a = s.page.evaluate("() => [document.activeElement?.getAttribute('role'), document.activeElement?.textContent.trim()]")
        if a[0] == "treeitem":
            break
        s.page.keyboard.press("ArrowLeft" if a == ["tab", "Geometry"] else "Tab")
    for _ in range(12):
        now = s.page.evaluate("() => document.activeElement?.querySelector('.tree-label')?.textContent.trim()")
        if now == name:
            return
        s.page.keyboard.press("ArrowDown")
    raise AssertionError(name)


BODY_BOX = """() => {
  const a = document.activeElement;
  return a?.getAttribute("role") === "combobox" && document.getElementById(a.getAttribute("aria-labelledby")?.split(" ")[0])?.textContent.trim() === "Body";
}"""


# The Geometry list shows one body at a time, so a second body's rows come after the Body box.
def list_body(s, name):
    for _ in range(14):
        s.page.keyboard.press("Shift+Tab")
        if s.page.evaluate(BODY_BOX):
            break
    assert s.page.evaluate(BODY_BOX)
    s.page.keyboard.type(name[0])
    for _ in range(6):
        if s.page.evaluate("() => document.querySelector('.opt-row.is-active')?.textContent?.trim()") == name:
            break
        s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function(
        "n => [...document.querySelectorAll('[role=option]')].every((o) => o.getAttribute('aria-label').includes(`, ${n},`))",
        arg=name,
    )
    s.page.wait_for_selector("[role=option][tabindex='0']")
    for _ in range(30):
        s.page.keyboard.press("Tab")
        if focus(s)["role"] == "option":
            return
    raise AssertionError(f"Tab never reached the rows, focus is on {focus(s)}")


def choose_by_keys(s, label):
    s.page.wait_for_function("() => document.querySelector('[role=alertdialog]')")
    for _ in range(8):
        if s.page.evaluate("() => document.activeElement?.textContent?.trim()") == label:
            s.page.keyboard.press("Enter")
            return
        s.page.keyboard.press("ArrowRight")
    raise AssertionError(f"no choice {label}")


def start_section(s):
    s.command("Section")
    s.page.wait_for_function("() => document.querySelector('[role=alertdialog]')")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function(WAITING)


def test_section_cuts_along_a_slanted_face_row(s):
    open_doc(s, SLANT)
    start_section(s)
    browse(s)
    assert "tilted 20 degrees from up" in down_to(s, "Flat face 6,")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => !window.section.picking")
    cut = s.page.evaluate(SECTION)
    n = [0, -math.sin(math.radians(20)), math.cos(math.radians(20))]
    assert cut["normal"] == pytest.approx(n, abs=1e-4)
    assert cut["origin"][0] == pytest.approx(SLANT_CENTRE[0])
    on_plane = sum(a * b for a, b in zip(cut["origin"], n))
    assert on_plane == pytest.approx(sum(a * b for a, b in zip(SLANT_CENTRE, n)) + 7.5, abs=1e-4)
    assert (cut["offset"], cut["side"]) == (0, 1)
    assert s.page.evaluate("() => window.section.phase") == "editing"


def test_an_edge_row_is_refused_aloud_and_section_keeps_waiting(s):
    start_section(s)
    browse(s)
    list_kind(s, "Edges")
    s.page.keyboard.press("Enter")
    heard(s, "edge", "flat face")
    assert s.page.evaluate(WAITING)
    assert s.page.evaluate(SECTION) is None
    list_kind(s, "Faces")
    down_to(s, "Flat face 1,")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => !window.section.picking")
    assert s.page.evaluate(SECTION)["normal"] == [-1, 0, 0]


def test_mirror_takes_its_plane_from_a_face_row(s):
    open_doc(s, TWO)
    tree_to(s, "Box 2")
    s.page.keyboard.press("Space")
    browse(s)
    down_to(s, "Flat face 2,")
    s.command("Mirror")
    s.page.keyboard.press("Enter")
    next_frames(s)
    to_canvas(s)
    s.page.keyboard.press("Enter")
    s.settle()
    assert s.page.evaluate(FEATURES % 3) == [
        {
            "type": "datumPlane",
            "plane": {"origin": [75, 0, 0], "normal": [1, 0, 0], "xdir": [0, 0, 1]},
            "offset": 0,
            "face": {"kind": "face", "by": "nearest", "point": pytest.approx([75, -5, -20 / 3]), "body": "body2"},
            "name": "Mirror plane",
        },
        {"type": "mirror", "plane": {"name": "f4"}, "bodies": ["body2"]},
    ]


def test_press_pull_started_with_nothing_picked_takes_a_face_row_and_a_typed_distance(s):
    browse(s)
    down_to(s, "Flat face 6,")
    s.command("Press/Pull")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => document.activeElement?.getAttribute('aria-label') === 'D'")
    s.page.keyboard.type("12.5")
    next_frames(s)
    s.page.keyboard.press("Enter")
    s.settle()
    assert s.page.evaluate(FEATURES % 1)[1:] == [
        {
            "type": "press-pull",
            "face": {"kind": "face", "by": "nearest", "point": pytest.approx([120.1667, -46.25, 47], abs=1e-3)},
            "distance": 12.5,
            "operation": "join",
            "body": "body1",
        }
    ]
    s.page.wait_for_function("() => document.activeElement?.getAttribute('role') === 'option'")
    assert any("at height 59.5" in r for r in rows(s))


def test_a_joint_takes_a_row_on_each_of_two_bodies(s):
    open_doc(s, TWO)
    s.command("Mechanism")
    tree_to(s, "Box")
    s.page.keyboard.press("Space")
    choose_by_keys(s, "Rigid")
    browse(s)
    down_to(s, "Flat face 2,")
    s.page.keyboard.press("Enter")
    list_body(s, "Box 2")
    down_to(s, "Flat face 1,")
    s.page.keyboard.press("Enter")
    choose_by_keys(s, "Done")
    s.settle()
    face = lambda body, point: {"kind": "face", "by": "nearest", "point": pytest.approx(point), "body": body}
    assert s.page.evaluate(FEATURES % 3) == [
        {
            "type": "mechanism",
            "ground": "body1",
            "joints": [
                {
                    "id": "weld1",
                    "mode": "rigid",
                    "a": {"body": "body1", "axis": face("body1", [10, -10 / 3, -5])},
                    "b": {"body": "body2", "axis": face("body2", [45, -5, -20 / 3])},
                }
            ],
        }
    ]


def test_a_second_file_leaves_no_pick_waiting(s):
    start_section(s)
    browse(s)
    open_doc(s, SLANT)
    assert not s.page.evaluate(WAITING)
    browse(s)
    down_to(s, "Flat face 2,")
    s.page.keyboard.press("Enter")
    next_frames(s)
    assert picked(s) == {"faces": [["body1", 1]], "edges": []}
    assert s.page.evaluate(SECTION) is None
    assert s.page.evaluate("() => window.section.phase") == "off"
