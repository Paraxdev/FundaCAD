"""Ctrl+2 in Auto from a perspective view lands on the back view, orthographic, and a screen reader hears it so, in both
camera rigs: the line is spoken once the projection has landed, never the perspective it left. An arrow step from
there goes perspective and is heard so. The view summary, read when the view takes focus, is written once it has landed
too."""

import math
import time
from pathlib import Path

import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from fundacad_harness import Session
from fundacad_harness.launch import find_repo

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

ROOM = "tests/fixtures/closed_room.funda"
OUTSIDE = [200, -1500, 100, 0, 0, 0]

# The polite region holds only its latest sentence, so every text it is given is kept for the test to read.
LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => {
    const text = polite.textContent;
    if (text) window.__spoken.push(text);
  });
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""

WATCH_SUMMARY = """() => {
  const summary = document.getElementById("view-summary");
  window.__summaries = [];
  if (window.__summaryObserver) window.__summaryObserver.disconnect();
  window.__summaryObserver = new MutationObserver(() => window.__summaries.push(summary.textContent));
  window.__summaryObserver.observe(summary, { childList: true, characterData: true, subtree: true });
}"""

POSE = """() => {
  const rig = window.viewport.rig;
  const d = rig.viewDirection();
  return { ortho: !!rig.active.isOrthographicCamera, dir: [d.x, d.y, d.z], flying: rig.isFlying(), version: rig.poseVersion() };
}"""

PLACE = """(c) => {
  const v = window.viewport;
  const V = v.camera.position.constructor;
  v.rig.setLookAt(new V(c[0], c[1], c[2]), new V(c[3], c[4], c[5]), false);
}"""


def landed(s, quiet=0.4, timeout=10.0):
    """The pose once no flight runs and nothing has moved for a moment."""
    end = time.monotonic() + timeout
    last, since = None, time.monotonic()
    while time.monotonic() < end:
        p = s.page.evaluate(POSE)
        key = (p["version"], p["ortho"], p["flying"])
        if key != last:
            last, since = key, time.monotonic()
        elif not p["flying"] and time.monotonic() - since >= quiet:
            return p
        s.page.wait_for_timeout(50)
    raise AssertionError(f"the view never settled, last {p}")


def camera_lines(s):
    return [t for t in s.page.evaluate("() => window.__spoken") if "orthographic" in t or "perspective" in t]


def heard(s, want):
    try:
        s.page.wait_for_function(
            "want => window.__spoken.some((t) => t.includes(want))", arg=want, timeout=15_000
        )
    except PlaywrightTimeout:
        raise AssertionError(f"never heard {want!r}, heard {s.page.evaluate('() => window.__spoken')}") from None


@pytest.fixture(scope="module", params=["navigator", "classic"])
def rig(request):
    s = Session()
    try:
        if request.param == "classic":
            s.page.goto(s.url + "&nav=legacy", wait_until="domcontentloaded", timeout=60_000)
            s._ensure_page()
        s.open_file(str(Path(find_repo()) / ROOM))
        s.settle()
        assert s.page.evaluate("window.viewport.rig.projectionMode()") == "auto"
        want = "legacy" if request.param == "classic" else "v2"
        assert s.page.evaluate("new URLSearchParams(location.search).get('nav') ?? 'v2'") == want
        yield s
    finally:
        s.close()


def test_ctrl_2_from_perspective_is_heard_as_the_back_view_orthographic(rig):
    rig.page.evaluate(PLACE, OUTSIDE)
    start = landed(rig)
    assert not start["ortho"]
    rig.page.evaluate("() => document.activeElement?.blur()")
    rig.page.evaluate(LISTEN)
    rig.page.keyboard.press("Control+2")
    end = landed(rig)
    assert end["ortho"]
    d = end["dir"]
    assert d[1] < -math.cos(math.radians(1)) * math.hypot(*d)
    heard(rig, "Back view, orthographic")
    rig.page.wait_for_timeout(600)
    assert camera_lines(rig) == ["Back view, orthographic"]


def test_an_arrow_step_from_there_is_heard_as_perspective(rig):
    assert landed(rig)["ortho"]
    rig.page.evaluate(LISTEN)
    rig.page.keyboard.press("ArrowLeft")
    end = landed(rig)
    assert not end["ortho"]
    heard(rig, "perspective")
    rig.page.wait_for_timeout(600)
    lines = camera_lines(rig)
    assert len(lines) == 1 and lines[0].startswith("Back, 15° toward ") and lines[0].endswith(", perspective"), lines


def test_the_view_summary_is_written_once_the_view_has_landed(rig):
    rig.page.evaluate(PLACE, OUTSIDE)
    assert not landed(rig)["ortho"]
    rig.page.evaluate("() => document.activeElement?.blur()")
    rig.page.evaluate(WATCH_SUMMARY)
    rig.page.keyboard.press("Control+2")
    assert landed(rig)["ortho"]
    try:
        rig.page.wait_for_function(
            "() => window.__summaries.some((t) => t.includes('Back view, orthographic'))", timeout=15_000
        )
    except PlaywrightTimeout:
        written = rig.page.evaluate("() => window.__summaries")
        raise AssertionError(f"the summary never named the back view, it was written {written}") from None
    rig.page.wait_for_timeout(600)
    written = rig.page.evaluate("() => window.__summaries")
    assert len(written) == 1, written
