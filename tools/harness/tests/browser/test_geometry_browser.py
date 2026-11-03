"""The accept test of the Geometry browser, real keys only once a file is open: two chosen edges take a fillet, a sketch
starts on the top face and on an origin plane, through the list and through the 3D view, and a second file leaks nothing."""

import re

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

OFFSET = "tools/harness/fixtures/offset_box.json"
SLANT = "tools/harness/fixtures/slant_box.json"

# 40 by 30 by 20 about (113.5, -41.25, 37): x 93.5 to 133.5, y -56.25 to -26.25, z 27 to 47.
OFFSET_FACES = [
    ("Flat face", "30 by 20", "facing left", "Crate"),
    ("Flat face", "30 by 20", "facing right", "Crate"),
    ("Flat face", "40 by 20", "facing front", "Crate"),
    ("Flat face", "40 by 20", "facing back", "Crate"),
    ("Flat face", "40 by 30", "facing down", "Crate"),
    ("Flat face", "40 by 30", "facing up", "Crate"),
]
SLANT_FACES = [
    ("Flat face", "25 by 15", "facing left", "Wedge"),
    ("Flat face", "25 by 15", "facing right", "Wedge"),
    ("Flat face", "60 by 15", "tilted 20 degrees from front", "Wedge"),
    ("Flat face", "60 by 15", "tilted 20 degrees from back", "Wedge"),
    ("Flat face", "60 by 25", "tilted 20 degrees from down", "Wedge"),
    ("Flat face", "60 by 25", "tilted 20 degrees from up", "Wedge"),
]

LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => {
    const text = polite.textContent;
    if (text) window.__spoken.push(text);
  });
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""

# The file chooser opens by the menu, so the count starts after it. A press later fails the test.
COUNT_POINTER = """() => {
  window.__pointer = 0;
  if (window.__pointerCount) return;
  window.__pointerCount = () => { window.__pointer += 1; };
  window.addEventListener("pointerdown", window.__pointerCount, true);
}"""

SKETCH = """() => {
  const k = window.sketch;
  const round = (v) => v.toArray().map((x) => Math.round(x * 1000) / 1000 + 0);
  return k.active ? { origin: round(k.plane.origin), normal: round(k.plane.n) } : null;
}"""

FOCUS = """() => {
  const a = document.activeElement;
  return { id: a?.id, role: a?.getAttribute("role"), name: a?.getAttribute("aria-label") };
}"""

# A sketch plane keeps the world origin's foot on it, so x and y stay 0 on a face well off the origin.
TOP_PLANE = {"origin": [0, 0, 47], "normal": [0, 0, 1]}

ROWS = "() => [...document.querySelectorAll('[role=option]')].map((o) => o.getAttribute('aria-label'))"
FILLETS = """() => window.store.document.features.filter((f) => f.type === "fillet").map(({ id, ...f }) => f)"""


def focus(s):
    return s.page.evaluate(FOCUS)


def rows(s):
    return s.page.evaluate(ROWS)


def face_facts(name):
    return (
        re.match(r"\w+ face", name).group(),
        re.search(r"(\d+ by \d+) millimetres", name).group(1),
        re.search(r"facing \w+|tilted \d+ degrees from \w+", name).group(),
        re.search(r"from (\w+)$", name).group(1),
    )


def heard(s, *words):
    s.page.wait_for_function(
        "ws => window.__spoken.some((t) => ws.every((w) => t.includes(w)))", arg=list(words), timeout=15_000
    )


# The readout speaks what changed between two frames, faster keys than a person's would run together.
def next_frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def picked(s):
    v = s.selection(raw=True)
    return {"faces": v["faces"], "edges": v["edges"]}


def tab_until(s, key, role):
    for _ in range(12):
        s.page.keyboard.press(key)
        if focus(s)["role"] == role:
            return
    raise AssertionError(f"{key} never reached a {role}, focus is on {focus(s)}")


def browse(s):
    s.command("Browse Faces and Edges")
    s.page.wait_for_function("() => document.activeElement?.getAttribute('role') === 'option'", timeout=15_000)


# Walks the radios by arrows as a person does, then Tab comes back to the list.
def list_kind(s, label):
    tab_until(s, "Shift+Tab", "radio")
    for _ in range(3):
        if s.page.get_by_role("radio", name=label).is_checked():
            break
        s.page.keyboard.press("ArrowRight")
    assert s.page.get_by_role("radio", name=label).is_checked()
    tab_until(s, "Tab", "option")


def down_to(s, start):
    for _ in range(40):
        now = focus(s)["name"] or ""
        if now.startswith(start):
            return now
        s.page.keyboard.press("ArrowDown")
        s.page.wait_for_function("was => document.activeElement?.getAttribute('aria-label') !== was", arg=now)
    raise AssertionError(f"no row starts {start}, the rows are {rows(s)}")


def to_canvas(s):
    for _ in range(8):
        s.page.keyboard.press("F6")
        if focus(s)["id"] == "canvas":
            return
    raise AssertionError(f"F6 never reached the canvas, focus is on {focus(s)}")


def give_radius(s, radius):
    s.page.wait_for_function("() => document.activeElement?.getAttribute('aria-label') === 'R'")
    s.page.keyboard.press("Control+A")
    s.page.keyboard.type(str(radius))
    next_frames(s)
    s.page.keyboard.press("Enter")
    s.settle()


def open_doc(s, path):
    assert s.page.evaluate("() => window.__pointer ?? 0") == 0
    s.open_file(path)
    s.settle()
    s.page.evaluate(LISTEN)
    s.page.evaluate(COUNT_POINTER)


def fillet_on(*points):
    edges = [{"kind": "edge", "by": "nearest", "point": p, "body": "body1"} for p in points]
    return [{"type": "fillet", "edges": edges, "radius": 2.5}]


def body_faces(s):
    return [(b["id"], b["faces"], b["fault"]) for b in s.bodies(raw=True)]


@pytest.fixture
def s(session):
    session.press("Escape")
    open_doc(session, OFFSET)
    yield session
    pressed = session.page.evaluate("() => window.__pointer")
    session.page.evaluate("() => document.activeElement?.blur()")
    for _ in range(4):
        session.page.keyboard.press("Escape")
    assert pressed == 0


def test_the_pointer_count_sees_a_real_press(s):
    s.page.mouse.click(600, 400)
    assert s.page.evaluate("() => window.__pointer") == 1
    s.page.evaluate("() => { window.__pointer = 0; }")


def test_a_face_row_holds_its_type_size_facing_and_owner(s):
    browse(s)
    names = rows(s)
    assert [face_facts(n) for n in names] == OFFSET_FACES
    assert "at height 27 millimetres" in names[4]
    assert "at height 47 millimetres" in names[5]


def test_the_list_fillets_two_chosen_edges(s):
    browse(s)
    list_kind(s, "Edges")
    assert "30 millimetres, between face 1 and face 6" in down_to(s, "Straight edge 2,")
    s.page.keyboard.press("Enter")
    down_to(s, "Straight edge 10,")
    s.page.keyboard.press("Space")
    assert picked(s) == {"faces": [], "edges": ["e1", "e9"]}
    s.command("Fillet")
    give_radius(s, 2.5)
    assert s.page.evaluate(FILLETS) == fillet_on([93.5, -41.25, 47], [113.5, -56.25, 47])
    assert body_faces(s) == [("body1", 8, None)]


def test_the_3d_view_fillets_two_chosen_edges(s):
    to_canvas(s)
    s.page.keyboard.press("}")
    next_frames(s)
    s.page.keyboard.press("[")
    heard(s, "Straight edge 12", "40 millimetres", "from Crate")
    s.page.keyboard.press("Enter")
    next_frames(s)
    s.page.keyboard.press("[")
    heard(s, "Straight edge 11", "from Crate")
    s.page.keyboard.press("Space")
    next_frames(s)
    assert picked(s) == {"faces": [], "edges": ["e11", "e10"]}
    s.page.keyboard.press("f")
    give_radius(s, 2.5)
    assert s.page.evaluate(FILLETS) == fillet_on([113.5, -26.25, 47], [113.5, -26.25, 27])
    assert body_faces(s) == [("body1", 8, None)]


def test_the_list_starts_a_sketch_on_the_top_face(s):
    browse(s)
    assert "facing up" in down_to(s, "Flat face 6,")
    s.page.keyboard.press("Enter")
    assert picked(s) == {"faces": [["body1", 5]], "edges": []}
    s.command("Sketch")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH) == TOP_PLANE


def test_the_3d_view_starts_a_sketch_on_the_top_face(s):
    to_canvas(s)
    s.page.keyboard.press("[")
    heard(s, "Flat face 6", "facing up", "at height 47", "from Crate")
    s.page.keyboard.press("Enter")
    next_frames(s)
    assert picked(s) == {"faces": [["body1", 5]], "edges": []}
    s.page.keyboard.press("s")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH) == TOP_PLANE


def test_the_list_starts_a_sketch_on_an_origin_plane(s):
    browse(s)
    list_kind(s, "Planes")
    down_to(s, "YZ plane")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH) == {"origin": [0, 0, 0], "normal": [1, 0, 0]}


def test_the_3d_view_starts_a_sketch_on_an_origin_plane(s):
    to_canvas(s)
    s.page.keyboard.press("}")
    next_frames(s)
    s.page.keyboard.press("}")
    next_frames(s)
    s.page.keyboard.press("]")
    heard(s, "XY plane")
    next_frames(s)
    s.page.keyboard.press("]")
    heard(s, "XZ plane")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH) == {"origin": [0, 0, 0], "normal": [0, -1, 0]}


def test_a_slanted_face_says_tilted_with_its_number_and_a_sketch_lies_on_it(s):
    open_doc(s, SLANT)
    browse(s)
    assert [face_facts(n) for n in rows(s)] == SLANT_FACES
    down_to(s, "Flat face 6,")
    s.page.keyboard.press("Enter")
    s.command("Sketch")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH)["normal"] == [0, -0.342, 0.94]


def test_a_second_file_shows_its_own_rows_and_nothing_of_the_first(s):
    browse(s)
    list_kind(s, "Edges")
    s.page.keyboard.press("Enter")
    assert picked(s) == {"faces": [], "edges": ["e0"]}
    s.command("Fillet")
    give_radius(s, 2.5)
    assert body_faces(s) == [("body1", 7, None)]
    browse(s)
    list_kind(s, "Faces")
    assert len(rows(s)) == 7
    s.page.keyboard.press("Shift+Tab")
    s.page.keyboard.type("35")
    s.page.wait_for_function("() => document.querySelectorAll('[role=option]').length === 4")
    # A fillet's build numbers the faces anew.
    assert sorted(face_facts(n)[2] for n in rows(s)) == ["facing back", "facing down", "facing front", "facing up"]

    open_doc(s, SLANT)
    assert picked(s) == {"faces": [], "edges": []}
    browse(s)
    assert s.page.get_by_role("radio", name="Faces").is_checked()
    assert s.page.get_by_label("Size at least").input_value() == ""
    assert [face_facts(n) for n in rows(s)] == SLANT_FACES
    # The focused row is where the brackets go on from.
    to_canvas(s)
    s.page.keyboard.press("]")
    heard(s, "Flat face 2", "from Wedge")
    s.page.keyboard.press("Escape")
    assert not s.page.evaluate("() => window.__spoken.some((t) => t.includes('Crate'))")

    open_doc(s, OFFSET)
    browse(s)
    assert [face_facts(n) for n in rows(s)] == OFFSET_FACES
    assert body_faces(s) == [("body1", 6, None)]
