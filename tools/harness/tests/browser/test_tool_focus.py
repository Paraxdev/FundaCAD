"""Focus after a tool started from the Geometry list, real keys only: a Fillet and a sketch give focus back to the row,
and a pick in the 3D view leaves focus there."""

import pytest

# s is the fixture that opens the offset box with a pointer press count.
from test_geometry_browser import browse, down_to, focus, give_radius, list_kind, next_frames, s, to_canvas  # noqa

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

IN_LIST = "() => document.activeElement?.closest('[role=listbox]') !== null"


def focus_in_list(s, start=None):
    s.page.wait_for_function(IN_LIST, timeout=15_000)
    now = focus(s)
    assert now["role"] == "option", now
    if start:
        assert now["name"].startswith(start), now


def test_a_fillet_from_an_edge_row_gives_focus_back_to_the_list(s):
    browse(s)
    list_kind(s, "Edges")
    down_to(s, "Straight edge 2,")
    s.page.keyboard.press("Enter")
    s.command("Fillet")
    give_radius(s, 2.5)
    # The fillet build renumbers the edges, so the list's tab stop may stand in for the row.
    focus_in_list(s)
    assert s.page.evaluate("() => window.store.document.features.some((f) => f.type === 'fillet')")


def test_a_sketch_from_a_plane_row_goes_to_the_view_and_back_to_the_row(s):
    browse(s)
    list_kind(s, "Planes")
    down_to(s, "XY plane")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    s.page.wait_for_function("() => document.activeElement?.id === 'canvas'")
    s.page.keyboard.press("Escape")
    next_frames(s)
    s.page.keyboard.press("Escape")
    s.page.wait_for_function("() => !window.sketch.active")
    focus_in_list(s, "XY plane")


def test_a_pick_in_the_view_after_a_fillet_and_an_undo_leaves_focus_on_the_view(s):
    browse(s)
    s.page.keyboard.press("Home")
    s.page.keyboard.press("Enter")
    s.command("Fillet")
    give_radius(s, 2)
    focus_in_list(s)
    s.page.keyboard.press("Control+Z")
    s.settle()
    focus_in_list(s)
    to_canvas(s)
    s.page.keyboard.press("]")
    next_frames(s)
    s.page.keyboard.press("Enter")
    next_frames(s)
    s.page.wait_for_timeout(500)
    assert focus(s)["id"] == "canvas"
