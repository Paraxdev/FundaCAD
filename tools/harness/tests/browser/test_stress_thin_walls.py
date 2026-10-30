"""Stress on four hollow standoffs on a 2 mm plate: 1.3 and 1.2 mm walls run by themselves on a finer mesh, 1.0 mm walls stop at
one button, no message talks about element size, and Ctrl+Z in the open panel still takes back a setup step."""

import re

import pytest

pytestmark = [pytest.mark.browser]

WALL_1_3 = "tools/harness/fixtures/standoff_plate_1_3.json"
WALL_1_2 = "tools/harness/fixtures/standoff_plate_1_2.json"
WALL_1_0 = "tools/harness/fixtures/standoff_plate_1_0.json"
# The two tops of the standoffs on the far side from the held end, off their holes.
TOPS = [(-34.6, -20, 8), (-34.6, 20, 8)]
RUN_WAIT_S = 240


def panel_text(s):
    return s.page.locator(".stress-panel").inner_text()


def place_load(s):
    s.page.locator(".stress-item").filter(has_text="Load 1").get_by_role("button", name="Click faces").click()
    s.settle()
    for world in TOPS:
        p = s._space_point(world=world)
        s._mouse_click(p["x"], p["y"], mods=["Shift"])
        s.settle()
    s.press("Escape")
    s.settle()


def set_up(s, fixture):
    s.open_file(fixture)
    s.view("iso")
    s.command("stress")
    s.page.get_by_role("button", name="Close Stress").wait_for()
    # Clear the sides so the part is centred, and keep the panel off the standoffs.
    for name in ("History", "Items"):
        s.panel(name, open=False)
    box = s.page.locator(".stress-panel").bounding_box()
    s.drag((box["x"] + 60, box["y"] + 14), (box["x"] + 480, box["y"] + 14), space="screen")
    s.view("right")
    s.pick_face("right")
    s.view("iso")
    s.page.locator(".stress-set-support").first.click()
    s.settle()
    s.view("top")
    place_load(s)
    s.page.locator(".stress-force input").first.fill("100")
    s.page.keyboard.press("Enter")
    s.settle()
    assert s.page.locator(".stress-item .stress-count").all_inner_texts() == ["1 face", "2 faces"]


def close_stress(s):
    s.page.get_by_role("button", name="Close Stress").click()
    s.settle()


def test_thick_enough_walls_run_without_a_button(session):
    s = session
    set_up(s, WALL_1_3)
    s.page.locator(".stress-run").click()
    s.page.locator(".stress-results").wait_for(timeout=RUN_WAIT_S * 1000)
    assert not s.page.locator(".stress-finer").count()
    s.page.locator(".stress-stale").wait_for(state="detached", timeout=60000)
    s.page.locator(".stress-results").get_by_text("Details", exact=True).first.click()
    text = panel_text(s)
    assert re.search(r"Mesh\n\d+ elements, [\d.]+ mm", text), text
    assert "Mesh detail" in text and "Refinement" not in text, text
    assert not re.search(r"element size|mesh size", text, re.I), text
    assert not s.page_errors(), s.page_errors()

    before = s.history(raw=True)["count"]
    mark = s.messages(raw=True)["seq"]
    s.press("Ctrl+Z")
    s.settle()
    said = [r["text"] for r in s.messages(since=mark, raw=True)["rows"]]
    assert any(t.startswith("Undid: ") for t in said), said
    assert s.history(raw=True)["count"] == before, "Ctrl+Z in Stress leaves the model alone"
    close_stress(s)


def test_walls_of_1_2_mm_run_by_themselves_and_say_the_result_is_rough(session):
    s = session
    set_up(s, WALL_1_2)
    s.page.locator(".stress-run").click()
    s.page.locator(".stress-results").wait_for(timeout=RUN_WAIT_S * 1000)
    assert not s.page.locator(".stress-finer").count()
    s.page.locator(".stress-stale").wait_for(state="detached", timeout=60000)
    s.page.locator(".stress-results").get_by_text("Details", exact=True).first.click()
    text = panel_text(s)
    assert "The mesh is coarse for the thinnest walls" in text, text
    assert not re.search(r"element size|mesh size|maxElements", text, re.I), text
    assert not s.page_errors(), s.page_errors()
    close_stress(s)


def test_the_stale_notice_stays_away_while_the_colours_are_drawn(session):
    s = session
    set_up(s, WALL_1_3)
    s.page.locator(".stress-run").click()
    s.page.locator(".stress-results").wait_for(timeout=RUN_WAIT_S * 1000)
    assert not s.page.locator(".stress-stale").count(), "colours are pending, the model has not changed"
    close_stress(s)


def test_thinner_walls_offer_one_button_and_no_size_words(session):
    s = session
    set_up(s, WALL_1_0)
    s.page.locator(".stress-run").click()
    s.page.locator(".stress-finer").wait_for(timeout=RUN_WAIT_S * 1000)
    label = s.page.locator(".stress-finer").inner_text().strip()
    assert re.fullmatch(r"Run with finer detail \(about \d+ (seconds|min)\)", label), label
    error = s.page.locator(".stress-error").inner_text()
    assert "thin walls" in error and not re.search(r"element size|mesh size|maxElements", error, re.I), error
    assert not s.page.locator(".stress-results").count()
    assert s.page.locator(".stress-finer").count() == 1
    close_stress(s)
