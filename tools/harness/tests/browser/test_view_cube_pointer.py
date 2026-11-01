"""A real mouse click on the view cube, in Auto, ends orthographic and on the clicked axis even with the eye inside
the model, in both camera rigs. Arrow steps from there, and a click on an edge or corner, stay perspective inside."""

import math
import time
from pathlib import Path

import pytest
from fundacad_harness import Session
from fundacad_harness.launch import find_repo

pytestmark = pytest.mark.browser

ROOM = "tests/fixtures/closed_room.funda"
# The room is 400 wide around the origin, the eye is a few degrees off the front axis.
INSIDE = [30, -150, 15, 0, 0, 0]
OUTSIDE = [200, -1500, 100, 0, 0, 0]
ON_AXIS = math.cos(math.radians(1))

CUBE_POINTS = """async (kind) => {
  const v = window.viewport;
  const m = await import("/src/viewport/viewCube.ts");
  const r = v.canvas.getBoundingClientRect();
  const size = m.cubeSize();
  const left = r.right - size - m.MARGIN - v.cube.rightInset;
  const top = r.top + m.MARGIN;
  const cx = left + size / 2, cy = top + size / 2;
  let best = null;
  for (let y = top + 2; y < top + size; y += 2) {
    for (let x = left + 2; x < left + size; x += 2) {
      if (!v.cube.hitsRegion(x, y)) continue;
      const p = v.cube.pickExact(x, y);
      if (!p || p.kind !== kind) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { d, x, y, kind: p.kind, dir: [p.dir.x, p.dir.y, p.dir.z] };
    }
  }
  return best;
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


def norm(d):
    n = math.sqrt(sum(c * c for c in d))
    return [c / n for c in d]


def on_axis(d):
    return max(abs(c) for c in norm(d)) >= ON_AXIS


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


def place(s, eye):
    s.page.evaluate(PLACE, eye)
    return landed(s)


def click_cube(s, kind):
    pt = s.page.evaluate(CUBE_POINTS, kind)
    assert pt, f"no {kind} under the cube"
    s.page.mouse.move(pt["x"], pt["y"])
    s.page.wait_for_timeout(100)
    s.page.mouse.click(pt["x"], pt["y"])
    return pt


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


def test_a_click_on_a_cube_face_from_inside_ends_orthographic_on_that_axis(rig):
    start = place(rig, INSIDE)
    assert not start["ortho"] and not on_axis(start["dir"])
    pt = click_cube(rig, "face")
    end = landed(rig)
    assert end["ortho"]
    want = [-c for c in pt["dir"]]
    assert sum(a * b for a, b in zip(norm(end["dir"]), norm(want))) > ON_AXIS


def test_b_the_same_click_from_outside_ends_orthographic(rig):
    start = place(rig, OUTSIDE)
    assert not on_axis(start["dir"])
    pt = click_cube(rig, "face")
    end = landed(rig)
    assert end["ortho"]
    want = [-c for c in pt["dir"]]
    assert sum(a * b for a, b in zip(norm(end["dir"]), norm(want))) > ON_AXIS


@pytest.mark.parametrize("kind", ["edge", "corner"])
def test_c_a_click_on_a_cube_edge_or_corner_from_inside_stays_perspective_off_axis(rig, kind):
    start = place(rig, INSIDE)
    assert not start["ortho"]
    click_cube(rig, kind)
    end = landed(rig)
    assert not end["ortho"]
    assert not on_axis(end["dir"])


def test_d_arrow_steps_after_a_cube_click_go_perspective_and_stay_so_on_the_next_axis(rig):
    place(rig, INSIDE)
    click_cube(rig, "face")
    assert landed(rig)["ortho"]
    rig.page.keyboard.press("ArrowLeft")
    first = landed(rig)
    assert not first["ortho"] and not on_axis(first["dir"])
    axes = 0
    for _ in range(24):
        rig.page.keyboard.press("ArrowLeft")
        p = landed(rig)
        if on_axis(p["dir"]):
            axes += 1
            assert not p["ortho"]
            if axes == 2:
                break
    assert axes >= 1
