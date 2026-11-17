"""Fillet and Chamfer read a click on their own preview: a click on the round's curved face or the chamfer's flat, away
from its rims, says to pick an edge of the model before it, as a rim click does, and adds nothing. A click on a face the
model had before still says no edge is there."""

import math

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import out_dir

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
SIZE = 5


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        yield session
    finally:
        session.close()


def language(s: Session, lang: str) -> None:
    s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
    s.page.wait_for_timeout(300)


def prompt(s: Session) -> str:
    return s.status(raw=True).get("prompt") or ""


def rows(s: Session) -> int:
    return s.page.evaluate("() => window.edgeFeature.memberRows().length")


def open_two_edges(s: Session, tool: str) -> None:
    for _ in range(3):
        s.press("Escape")
    s.open_file(BLOCK, discard=True)
    s.view("iso")
    s.tool(tool)
    s.pick_edge("between top front", via="edge")
    s.settle()
    s.type("field:radius" if tool == "Fillet" else "field:distance", str(SIZE))
    s.settle()
    s.pick_edge("between top right", via="edge")
    s.settle()
    assert rows(s) == 2


def click_world(s: Session, w: tuple[float, float, float]) -> str:
    p = s.call("worldPoint", x=w[0], y=w[1], z=w[2])
    s.page.mouse.click(p["x"], p["y"])
    s.settle()
    s.page.wait_for_timeout(300)
    return prompt(s)


def on_round(deg: float) -> tuple[float, float, float]:
    """A point on the top front round, `deg` up from the front face."""
    a = math.radians(deg)
    return (0, -10 + SIZE - SIZE * math.cos(a), 15 - SIZE + SIZE * math.sin(a))


# Low on each round, the edge each one replaces runs over its upper half on screen and a click there takes that edge out.
@pytest.mark.parametrize("side", ["front", "right"])
def test_a_click_on_the_rounds_curved_face_says_to_pick_an_edge_of_the_model_before_it(s, side):
    language(s, "en")
    open_two_edges(s, "Fillet")
    x, y, z = on_round(15)
    said = click_world(s, (x, y, z) if side == "front" else (-y, x, z))
    s.screenshot(out_dir() / f"fillet_curved_face_prompt_{side}.png")
    assert said == "That face comes from this fillet, click an edge of the model before it · Esc"
    assert rows(s) == 2
    assert s.page.evaluate("() => window.store.document.features.map((f) => f.type)") == ["box"]


def test_a_click_on_the_chamfers_own_flat_says_to_pick_an_edge_of_the_model_before_it(s):
    language(s, "en")
    open_two_edges(s, "Chamfer")
    said = click_world(s, (0, -10 + SIZE / 2, 15 - SIZE / 2))
    s.screenshot(out_dir() / "chamfer_flat_prompt.png")
    assert said == "That face comes from this chamfer, click an edge of the model before it · Esc"
    assert rows(s) == 2


def test_a_rim_and_a_face_the_model_had_keep_their_own_words(s):
    language(s, "en")
    open_two_edges(s, "Fillet")
    assert click_world(s, (0, -10, 15 - SIZE)) == (
        "That edge comes from this fillet, click an edge of the model before it · Esc"
    )
    for face in [(0, -10, -5), (0, 0, 15), (10, 0, 0)]:
        assert click_world(s, face).startswith("No edge there, 2 edges kept"), face
    assert rows(s) == 2
