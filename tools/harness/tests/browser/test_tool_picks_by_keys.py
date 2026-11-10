"""A waiting tool takes the face or edge lit by the brackets on the 3D view, in both camera rigs, with no pointer event:
Mirror takes a flat face as its plane and says so, a row it cannot use is refused aloud while it keeps waiting, and a
running Fillet adds and takes out edges, and Stress Click faces takes a face for its support."""

import pytest
from fundacad_harness import Session
from test_geometry_browser import FILLETS, OFFSET, SLANT, heard, next_frames, open_doc, to_canvas
from test_geometry_row_pickers import FEATURES, TWO, tree_to

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

MIRROR_ACTIVE = "() => window.__fundacad.mirror.active"
LAST_SPOKEN = "() => window.__spoken.at(-1)"


@pytest.fixture(scope="module", params=["navigator", "classic"])
def rig(request):
    session = Session()
    try:
        if request.param == "classic":
            session.page.goto(session.url + "&nav=legacy", wait_until="domcontentloaded", timeout=60_000)
            session._ensure_page()
        yield session
    finally:
        session.close()


@pytest.fixture
def s(rig):
    rig.press("Escape")
    open_doc(rig, TWO)
    yield rig
    pressed = rig.page.evaluate("() => window.__pointer")
    rig.page.evaluate("() => document.activeElement?.blur()")
    for _ in range(4):
        rig.page.keyboard.press("Escape")
    assert pressed == 0


def mirror_box_2(s):
    tree_to(s, "Box 2")
    s.page.keyboard.press("Space")
    s.command("Mirror")
    s.page.wait_for_function(MIRROR_ACTIVE)
    to_canvas(s)


def step_to(s, key, *words):
    for _ in range(40):
        before = s.page.evaluate("() => window.__spoken.length")
        s.page.keyboard.press(key)
        s.page.wait_for_function("n => window.__spoken.length > n", arg=before, timeout=15_000)
        if s.page.evaluate("ws => ws.every((w) => window.__spoken.at(-1).includes(w))", list(words)):
            return
    raise AssertionError(f"{key} never said {words}, the last said was {s.page.evaluate(LAST_SPOKEN)!r}")


def test_mirror_takes_the_flat_face_lit_by_the_brackets_and_says_so(s):
    mirror_box_2(s)
    step_to(s, "]", "Flat face 2")
    s.page.keyboard.press("Enter")
    heard(s, "Flat face 2", "is the mirror plane")
    s.settle()
    assert s.page.evaluate(MIRROR_ACTIVE)
    assert s.page.evaluate(FEATURES % 3) == []
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
    assert s.page.evaluate("() => window.__pointer") == 0


def test_mirror_refuses_an_edge_aloud_and_keeps_waiting(s):
    mirror_box_2(s)
    s.page.keyboard.press("}")
    heard(s, "Edges")
    step_to(s, "]", "edge")
    s.page.keyboard.press("Enter")
    heard(s, "this step needs")
    s.settle()
    assert s.page.evaluate(MIRROR_ACTIVE)
    assert s.page.evaluate(FEATURES % 3) == []
    assert s.page.evaluate("() => window.__pointer") == 0


def said_after(s, count, *words):
    try:
        s.page.wait_for_function(
            "([n, ws]) => window.__spoken.slice(n).some((t) => ws.every((w) => t.includes(w)))",
            arg=[count, list(words)],
            timeout=15_000,
        )
    except Exception:
        heardlist = s.page.evaluate("n => window.__spoken.slice(n)", count)
        raise AssertionError(f"never said {words}, said {heardlist}") from None


def press_enter_and_hear(s, *words):
    count = s.page.evaluate("() => window.__spoken.length")
    s.page.keyboard.press("Enter")
    said_after(s, count, *words)
    s.settle()


def test_a_running_fillet_adds_and_takes_out_edges_lit_by_the_brackets(s):
    open_doc(s, SLANT)
    s.command("Fillet")
    to_canvas(s)
    s.page.keyboard.press("}")
    heard(s, "Edges")
    step_to(s, "]", "Straight edge 1,")
    press_enter_and_hear(s, "Straight edge 1 of", "added")
    s.page.wait_for_function("() => document.activeElement?.getAttribute('aria-label') === 'R'")
    s.page.keyboard.press("Control+A")
    s.page.keyboard.type("2.5")
    next_frames(s)
    to_canvas(s)
    step_to(s, "]", "Straight edge 2,")
    press_enter_and_hear(s, "Straight edge 2 of", "added")
    to_canvas(s)
    step_to(s, "[", "Straight edge 1,")
    press_enter_and_hear(s, "Straight edge 1 of", "taken out")
    to_canvas(s)
    s.page.keyboard.press("Enter")
    s.settle()
    # The one edge left is the wedge's slanted top edge along y, its middle after the 20 degree turn and the move.
    mid = pytest.approx([-102.5, 15.6848, 51.0477], abs=1e-3)
    edge = {"kind": "edge", "by": "nearest", "point": mid, "body": "body1"}
    assert s.page.evaluate(FILLETS) == [{"type": "fillet", "edges": edge, "radius": 2.5}]
    assert s.page.evaluate("() => window.__pointer") == 0


SUPPORT_FACES = "() => window.store.stressStudy?.supports[0]?.faces ?? null"
PLACING = ".stress-place-support[aria-pressed=true]"


def click_faces_by_keys(s):
    s.command("stress")
    s.page.get_by_role("button", name="Close Stress").wait_for()
    button = s.page.locator(".stress-place-support").first
    button.focus()
    s.page.keyboard.press("Enter")
    s.page.locator(PLACING).wait_for()
    to_canvas(s)


def test_stress_click_faces_takes_the_face_lit_by_the_brackets(s):
    open_doc(s, OFFSET)
    click_faces_by_keys(s)
    step_to(s, "]", "facing up")
    press_enter_and_hear(s, "Flat face 6 of", "picked")
    said_after(s, 0, "support has 1 face")
    s.page.locator(".stress-item .stress-count").first.wait_for()
    assert s.page.locator(".stress-item .stress-count").first.inner_text() == "1 face"
    faces = s.page.evaluate(SUPPORT_FACES)
    # The first triangle of the 40 by 30 top at z 47, so its centre is a third of the way in from its corner.
    point = pytest.approx([120.1667, -46.25, 47], abs=1e-3)
    assert faces == [{"kind": "face", "by": "nearest", "point": point, "body": "body1"}]
    assert not s.page.locator(PLACING).count()
    assert s.page.evaluate("() => window.__pointer") == 0


def test_stress_click_faces_refuses_an_edge_aloud_and_keeps_waiting(s):
    open_doc(s, OFFSET)
    click_faces_by_keys(s)
    s.page.keyboard.press("}")
    heard(s, "Edges")
    step_to(s, "]", "edge")
    press_enter_and_hear(s, "an edge", "needs a face")
    assert s.page.locator(PLACING).count() == 1
    assert s.page.evaluate(SUPPORT_FACES) in (None, [])
    assert s.page.evaluate("() => window.__pointer") == 0
