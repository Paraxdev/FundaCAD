"""A body selection raises Move, whose value box has focus: the command search still opens and keeps its typing (mcbc01y5)."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

NEAR = "tools/harness/fixtures/near_boxes.json"


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(NEAR)
    session.settle()
    yield session
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")


def raise_move(s):
    s.page.evaluate("() => viewport.setSelectedBodies(['body2'])")
    box = s.page.locator(".dim-input input").first
    expect(box).to_be_focused()
    return box


def test_ctrl_f_from_moves_box_opens_the_search_and_the_typing_stays_there(s):
    box = raise_move(s)
    s.page.keyboard.press("Control+F")
    search = s.page.get_by_role("combobox", name="Search commands")
    expect(search).to_be_focused()
    s.page.keyboard.type("Accessibility Settings")
    expect(search).to_have_value("Accessibility Settings")
    assert "Settings" not in box.input_value()


def test_a_command_runs_from_the_search_with_move_raised(s):
    raise_move(s)
    s.command("Accessibility Settings")
    expect(s.page.locator("#prefs-single-keys")).to_be_visible()
