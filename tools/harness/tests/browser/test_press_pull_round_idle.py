"""A Press/Pull radius drag on a round face leaves the view idle once the hand stops (4g6g19j9)."""

import pytest

pytestmark = pytest.mark.browser

FILLETED = "tools/harness/fixtures/filleted_box.json"
FILLET_FACE = "near=43.59,24.29,34.75"
IDLE = "() => window.viewport.renderIdle"


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(FILLETED)
    session.view("iso")
    session.settle()
    yield session
    session.press("Escape")


def test_radius_drags_on_the_fillet_face_leave_the_view_idle(s):
    s.tool("Press/Pull")
    s.pick_face(FILLET_FACE)
    assert "radius" in s.call("status")["prompt"]
    for mm in (8.8, 7, -2):
        s.drag_handle("push", mm=mm)
        assert "settled" in s.settle(timeout=10)
        assert s.page.evaluate(IDLE) is True
