"""The command palette's search box keeps the text keys a text field has: Ctrl+A selects what was typed, and Ctrl+Z
undoes typing there rather than a step of the model."""

import pytest

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

FIELD = ".cmdk-card input"
WIDTH = "() => window.store.document.features[0].width"
WIDER = "() => window.store.updateFeature('bx', { width: 21.5 })"


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.open_file("tools/harness/fixtures/block.json", discard=True)
        session.settle()
        yield session
    finally:
        session.close()


def open_palette(s: Session) -> None:
    s.page.keyboard.press("Control+K")
    s.page.locator(FIELD).wait_for(timeout=5000)


def test_ctrl_a_selects_the_typed_text_so_typing_replaces_it(s):
    open_palette(s)
    s.page.keyboard.type("abc")
    s.page.keyboard.press("Control+A")
    s.page.keyboard.type("x")
    assert s.page.locator(FIELD).input_value() == "x"
    s.page.keyboard.press("Escape")


def test_ctrl_z_in_the_search_box_leaves_the_model_alone(s):
    s.page.evaluate(WIDER)
    s.settle()
    assert s.page.evaluate(WIDTH) == 21.5
    open_palette(s)
    s.page.keyboard.type("fil")
    s.page.keyboard.press("Control+Z")
    s.page.wait_for_timeout(500)
    assert s.page.evaluate(WIDTH) == 21.5
    s.page.keyboard.press("Escape")
