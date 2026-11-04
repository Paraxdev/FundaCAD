import math
import re

import pytest

from test_announcer import heard, listen

pytestmark = [pytest.mark.browser]

LEDGE = "tools/harness/fixtures/overhang_ledge.json"
WEDGE = "tools/harness/fixtures/slant_box.json"
PLATE = "tools/harness/fixtures/plate.json"

ROWS = "() => [...document.querySelectorAll('.printability-finding')].map((e) => e.getAttribute('aria-label'))"
TARGET = "() => window.__fundacad.viewport.cameraTarget().toArray()"
NUMBER = re.compile(r"\d+(?:\.\d+)?")

# The ledge's underside is 17 by 18 mm and 14 mm up. The slant runs 12 out and 9 up, so 15 by 18 mm, leaning
# 90 - atan(9 / 12) = 53 degrees, its middle 12.5 mm up and its low edge 12.5 - 9 / 2 = 8.
LEDGE_ROWS = [("306", "90", "14"), ("270", "53", "8")]
# The underside's middle: x 52.5, y -9 and z 14 in the sketch's frame, moved by (-73.5, 41.25, 9).
LEDGE_MIDDLE = [-21, 32.25, 23]


def facts(row):
    """A row's area, lean and height, and its face number apart, so no wording is pinned.
    An overhang that starts on the bed has no height."""
    assert row.startswith("Overhang"), row
    area, lean, face, *height = NUMBER.findall(row)
    return (area, lean, *height), int(face)


def check(s, path):
    """Open `path`, run a Check, and return the rows and what the polite region said of it."""
    s.open_file(path)
    assert s.page.locator(".printability-panel").count() == 0
    listen(s)
    s.page.evaluate("() => window.__fundacad.handleAction('print-printability')")
    s.page.locator(".printability-panel").wait_for()
    s.page.locator(".printability-run").click()
    s.page.locator(".printability-header").wait_for()
    said = [t for t in heard(s, "Printability:") if t.startswith("Printability:")]
    assert len(said) == 1, said
    return s.page.evaluate(ROWS), NUMBER.findall(said[0])


def close(s):
    s.page.locator(".printability-close").click()
    s.page.locator(".printability-panel").wait_for(state="detached")


def test_a_check_lists_both_overhangs_and_says_the_largest_and_its_face(session):
    s = session
    rows, said = check(s, LEDGE)
    try:
        found = [facts(r) for r in rows]
        assert [f for f, _ in found] == LEDGE_ROWS
        faces = [face for _, face in found]
        assert faces[0] != faces[1]
        # Two things, two overhangs, the largest's area and the face of the first row.
        assert said == ["2", "2", "306", str(faces[0])]

        before = s.page.evaluate(TARGET)
        assert math.dist(before, LEDGE_MIDDLE) > 5, before
        s.page.locator(".printability-close").focus()
        s.press("Tab")
        assert s.page.evaluate("() => document.activeElement.getAttribute('aria-label')") == rows[0]
        s.press("Enter")
        s.page.wait_for_function(
            f"(at) => ({TARGET})().every((v, i) => Math.abs(v - at[i]) < 1e-3)", arg=LEDGE_MIDDLE, timeout=10_000
        )
        current = s.page.evaluate(
            "() => [...document.querySelectorAll('.printability-finding')].map((e) => e.getAttribute('aria-current'))"
        )
        assert current == ["true", None]
        assert not s.page_errors(), s.page_errors()
    finally:
        close(s)


def test_another_document_drops_the_list_and_speaks_only_its_own(session):
    s = session
    rows, _ = check(s, LEDGE)
    assert len(rows) == 2

    # The box is turned 20 degrees about X: its 60 by 25 mm underside leans 70 degrees and starts on the bed.
    rows, said = check(s, WEDGE)
    found = [facts(r) for r in rows]
    assert [f for f, _ in found] == [("1500", "70")]
    assert said == ["1", "1", "1500", str(found[0][1])]

    rows, said = check(s, PLATE)
    assert rows == []
    assert said == []
    assert s.page.locator(".printability-clean").is_visible()
    assert not s.page_errors(), s.page_errors()
    close(s)
