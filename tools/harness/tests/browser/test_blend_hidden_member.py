"""In the Fillet tool, a member hidden behind a visible edge on the same screen line no longer takes the click: from
below, a click on a box's bottom back edge adds it, where the top back member behind it was dropped. A member in
plain view still drops on a click."""

import pytest

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
EDGES = "() => window.edgeFeature.memberRows().length"


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        yield session
    finally:
        session.close()


def click_world(s: Session, w: tuple[float, float, float]) -> None:
    p = s.call("worldPoint", x=w[0], y=w[1], z=w[2])
    s.page.mouse.click(p["x"], p["y"])
    s.settle()
    s.page.wait_for_timeout(300)


def fillet_top_back(s: Session) -> None:
    for _ in range(3):
        s.press("Escape")
    s.open_file(BLOCK, discard=True)
    s.view("iso")
    s.tool("Fillet")
    click_world(s, (0, 10, 15))
    s.type("field:radius", "2")
    s.settle()
    assert s.page.evaluate(EDGES) == 1


def test_from_below_the_visible_bottom_back_edge_is_added_over_the_hidden_member(s):
    fillet_top_back(s)
    s.view("bottom")
    s.settle()
    click_world(s, (3, 10, -15))
    assert s.page.evaluate(EDGES) == 2


def test_a_member_in_plain_view_still_drops_on_a_click(s):
    fillet_top_back(s)
    s.view("back")
    s.settle()
    click_world(s, (3, 10, 15))
    assert s.page.evaluate(EDGES) == 0
