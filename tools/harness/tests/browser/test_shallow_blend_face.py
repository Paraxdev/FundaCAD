"""A fillet between faces that meet at a shallow angle turns its round too little to tell from the faces it joins by
direction, yet a click on that round still says it comes from this fillet, and a face it only trimmed still says no
edge is there."""

import json
import math

import pytest

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

RADIUS = 12
# The top face and a 45 degree chamfer meet along y = -2 on the top, so the round between them turns 45 degrees.
DOC = {
    "version": 10,
    "parameters": {},
    "features": [
        {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 20},
        {
            "id": "c",
            "type": "chamfer",
            "distance": 8,
            "edges": {"kind": "edge", "by": "nearest", "point": [0, -10, 10], "body": "body1"},
        },
    ],
}


@pytest.fixture(scope="module")
def s(tmp_path_factory):
    path = tmp_path_factory.mktemp("shallow") / "shallow.json"
    path.write_text(json.dumps(DOC), encoding="utf-8")
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.open_file(path, discard=True)
        session.view("iso")
        session.tool("Fillet")
        click_world(session, (0, -2, 10))
        session.type("field:radius", str(RADIUS))
        session.settle()
        yield session
    finally:
        session.close()


def prompt(s: Session) -> str:
    return s.status(raw=True).get("prompt") or ""


def click_world(s: Session, w: tuple[float, float, float]) -> str:
    p = s.call("worldPoint", x=w[0], y=w[1], z=w[2])
    s.page.mouse.click(p["x"], p["y"])
    s.settle()
    s.page.wait_for_timeout(300)
    return prompt(s)


def on_round(t: float, x: float = 0) -> tuple[float, float, float]:
    """A point on the round, `t` degrees from where it meets the top face."""
    half = math.radians(22.5)
    cy, cz = -2 + RADIUS * math.tan(half), 10 - RADIUS
    a = math.radians(t)
    return (x, cy - RADIUS * math.sin(a), cz + RADIUS * math.cos(a))


def rows(s: Session) -> int:
    return s.page.evaluate("() => window.edgeFeature.memberRows().length")


# Clear of both rims and of the edge the round replaces, which runs over its middle on screen.
@pytest.mark.parametrize("t", [10, 35])
def test_a_click_on_the_shallow_round_says_it_comes_from_this_fillet(s, t):
    said = click_world(s, on_round(t, 5))
    assert said == "That face comes from this fillet, click an edge of the model before it · Esc"
    assert rows(s) == 1


# The top and the chamfer's flat, both trimmed by the round, and the front it never touched.
@pytest.mark.parametrize("face", [(5, 6, 10), (5, -8, 4), (5, -10, -3)])
def test_a_face_the_model_had_still_says_no_edge_is_there(s, face):
    assert click_world(s, face).startswith("No edge there, 1 edge kept")
    assert rows(s) == 1
