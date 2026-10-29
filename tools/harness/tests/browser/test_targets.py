"""Pointer targets on the A1 screens: at least 24 px each way, about 32 with Larger click targets, same layout."""

import json

import pytest

from fundacad_harness import Session
from fundacad_harness.a11y import fresh_page, walk
from fundacad_harness.targets import line, probe, under
from test_a11y import FLOWS, RESET_BUDGET, SCREENS, _settled, out_dir

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

MIN = 24
LARGE_MIN = 32
# The panels with native text and number fields and the dimension box are left to the 24 px check.
LARGE_SCREENS = [s for s in SCREENS if s not in ("extrude", "render", "stress")]
# Larger click targets only grows insets, so it stops short where neighbours sit closer than 32 px.
# (selector part, axis 0 width or 1 height, the size it still reaches, why)
LARGE_SHORT = (
    (
        "div.timeline-transport > button",
        0,
        26,
        "the transport buttons are 24 px wide with 2 px gaps, a wider area would cover the next one",
    ),
    (
        "div.timeline-track > div.timeline-item > div.timeline-node",
        1,
        29,
        "the History strip scrolls, so it clips a grown hit area to the step's own height",
    ),
    (
        "div.feature-row.tree-child > input",
        1,
        24,
        "the Extra Parameters fields are text inputs, which draw no ::before, and a taller box would show",
    ),
)
# The range input grows its own box to --hit-min under a negative margin, so only its centre and width stay put.
OWN_BOX = ("ui-slider-input",)

_LARGE = "() => { document.documentElement.dataset.targets = 'large' }"
_DEFAULT = "() => { delete document.documentElement.dataset.targets }"
_FRAME = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
# A dialog caught in its entrance scale would move between the two probes, endless spinners never finish.
_STILL = """() => Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}))),
  new Promise((r) => setTimeout(r, 3000)),
])"""
_SCROLLERS = """() => [...document.querySelectorAll('*')]
  .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowX + getComputedStyle(el).overflowY))
  .map((el) => [
    el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join(''),
    el.scrollWidth, el.scrollHeight,
  ])
  .concat([['document', document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight]])"""


@pytest.fixture(scope="module")
def reports():
    """Each screen probed as it opens and again with Larger click targets on, the page put back after."""
    out = out_dir()

    def scan(s, name):
        _settled(s)
        s.page.evaluate(_STILL)
        found = {"default": probe(s.page), "scroll": [s.page.evaluate(_SCROLLERS)]}
        try:
            s.page.evaluate(_LARGE)
            s.page.evaluate(_FRAME)
            found["large"] = probe(s.page)
            found["scroll"].append(s.page.evaluate(_SCROLLERS))
        finally:
            s.page.evaluate(_DEFAULT)
        (out / f"targets_{name}.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
        return found

    s = Session(viewport=(1400, 900))
    try:
        return walk(s, FLOWS, scan, fresh_page, reset_budget=RESET_BUDGET)
    finally:
        s.close()


def report(reports, screen):
    found = reports[screen]
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    return found


def boxes(rep):
    """Every probed element's visual box by selector path and name, covered or not."""
    out: dict[tuple, list] = {}
    for t in rep["targets"] + rep["covered"] + rep["occluded"]:
        b = t["box"]
        if any(p in t["sel"] for p in OWN_BOX):
            b = [b[0], round(b[1] + b[3] / 2, 1), b[2]]
        out.setdefault((t["sel"], t["name"]), []).append(b)
    return {k: sorted(v) for k, v in out.items()}


def under_large(rep):
    out = []
    for t in under(rep, LARGE_MIN):
        lacking = [axis for axis in (0, 1) if t["hit"][axis] < LARGE_MIN]
        allowed = [
            axis
            for axis in lacking
            if any(p in t["sel"] and a == axis and t["hit"][axis] >= f for p, a, f, _ in LARGE_SHORT)
        ]
        if lacking != allowed:
            out.append(t)
    return out


@pytest.mark.parametrize("screen", SCREENS)
def test_no_control_is_under_24_px(reports, screen):
    small = under(report(reports, screen)["default"], MIN)
    assert not small, f"{screen} has controls under {MIN} by {MIN} px:\n" + "\n".join(line(t) for t in small)


@pytest.mark.parametrize("screen", SCREENS)
@pytest.mark.parametrize("mode", ["default", "large"])
def test_no_hit_area_covers_another_controls_centre(reports, screen, mode):
    covered = report(reports, screen)[mode]["covered"]
    assert not covered, f"{screen} ({mode}) has controls whose centre another one takes:\n" + "\n".join(
        line(t) for t in covered
    )


@pytest.mark.parametrize("screen", SCREENS)
@pytest.mark.parametrize("mode", ["default", "large"])
def test_no_hit_area_takes_the_edge_of_another_controls_box(reports, screen, mode):
    stolen = report(reports, screen)[mode]["stolen"]
    assert not stolen, f"{screen} ({mode}) has controls whose own edge a neighbour's hit area takes:\n" + "\n".join(
        f"{line({**t, 'by': ''})} at its {t['side']} edge, by {t['by']} \"{t['byName']}\"" for t in stolen
    )


@pytest.mark.parametrize("screen", LARGE_SCREENS)
def test_larger_click_targets_reach_32_px(reports, screen):
    small = under_large(report(reports, screen)["large"])
    assert not small, f"{screen} with Larger click targets has controls under {LARGE_MIN} px:\n" + "\n".join(
        line(t) for t in small
    )


@pytest.mark.parametrize("screen", SCREENS)
def test_larger_click_targets_keep_every_box_and_scroll_size(reports, screen):
    found = report(reports, screen)
    off, on = boxes(found["default"]), boxes(found["large"])
    moved = sorted(
        f'{k[0]} "{k[1]}" {off.get(k)} -> {on.get(k)}' for k in off.keys() | on.keys() if off.get(k) != on.get(k)
    )
    assert not moved, f"{screen}: Larger click targets moved or resized controls:\n" + "\n".join(moved)
    before, after = found["scroll"]
    assert len(before) == len(after), f"{screen}: Larger click targets added or removed a scroller"
    grown = [f"{a} -> {b}" for a, b in zip(before, after) if a != b]
    assert not grown, f"{screen}: Larger click targets changed a scroll size:\n" + "\n".join(grown)


def test_a_short_large_target_needs_a_listed_reason():
    t = {"sel": "div.timeline-transport > button.icon-btn", "name": "Step", "hit": [26, 34], "box": [0, 0, 24, 24]}
    assert under_large({"targets": [t]}) == []
    assert under_large({"targets": [{**t, "hit": [25, 34]}]}) != []
    assert under_large({"targets": [{**t, "hit": [26, 30]}]}) != []
    assert under_large({"targets": [{**t, "sel": "nav#menubar > button"}]}) != []
    assert all(reason for *_, reason in LARGE_SHORT)
