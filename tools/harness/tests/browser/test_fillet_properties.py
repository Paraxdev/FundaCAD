"""A fillet's History properties: the Include Tangent Edges label is whole, wrapping before its switch moves under it, the
switch stays in the value column under the Radius box, and a plain Round fillet's Profile reads 0 and writes nothing at
0, in both themes and in Comfortable text."""

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import close_settings, open_settings, out_dir, set_theme

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
ADD = """() => window.store.addFeature({ id: 'fl', type: 'fillet', radius: 3,
  edges: [{ kind: 'edge', by: 'nearest', point: [0, -10, 15], body: 'body1' }] })"""
READ = """() => {
  const row = (f) => document.querySelector(`#timeline .param-row[data-field="${f}"]`);
  const box = (e) => e.getBoundingClientRect();
  const t = row('tangentEdges');
  const lab = t.querySelector(':scope > label');
  const sw = t.querySelector('[role=switch]');
  const radius = box(row('radius').querySelector('.param-value'));
  const l = box(lab), s = box(sw);
  return {
    label: lab.textContent,
    whole: lab.scrollWidth <= lab.clientWidth + 1 && lab.scrollHeight <= lab.clientHeight + 1,
    beside: s.top < l.bottom - 1 && s.bottom > l.top + 1,
    switch_left: s.left,
    value_left: radius.left,
    profile: row('profile').querySelector('input').value,
  };
}"""
PROFILE_KEY = "() => Object.prototype.hasOwnProperty.call(window.store.document.features.find((f) => f.id === 'fl'), 'profile')"
PROFILE = "() => window.store.document.features.find((f) => f.id === 'fl').profile ?? null"


def frames(s: Session) -> None:
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def shoot(s: Session, name: str) -> None:
    frames(s)
    s.page.locator("#timeline").screenshot(path=str(out_dir() / f"fillet_properties_{name}.png"))


def show(s: Session) -> dict:
    # A click on the chip of an open feature folds its properties away.
    if not s.page.locator('#timeline .param-row[data-field="radius"]').count():
        s.click("feature:fl")
        s.settle()
    frames(s)
    return s.page.evaluate(READ)


def commit_profile(s: Session, text: str) -> None:
    box = s.page.locator('#timeline .param-row[data-field="profile"] input')
    box.click()
    s.page.keyboard.press("Control+A")
    s.page.keyboard.type(text)
    s.page.keyboard.press("Enter")
    s.settle()


def comfortable(s: Session, on: bool) -> None:
    open_settings(s, "Accessibility")
    box = s.page.locator("#prefs-comfortable-text")
    if box.is_checked() != on:
        box.click()
    close_settings(s)


@pytest.fixture(scope="module")
def seen():
    s = Session(settle_timeout=120)
    found: dict = {}
    try:
        s.dismiss_start()
        s.open_file(BLOCK)
        s.view("iso")
        s.page.evaluate(ADD)
        s.settle()
        s.panel("History", open=True)
        s.settle()
        for theme in ("light", "dark"):
            set_theme(s, theme)
            close_settings(s)
            found[("plain", theme)] = show(s)
            shoot(s, theme)
        comfortable(s, True)
        found[("comfortable", "dark")] = show(s)
        shoot(s, "comfortable_dark")
        set_theme(s, "light")
        close_settings(s)
        found[("comfortable", "light")] = show(s)
        shoot(s, "comfortable_light")
        comfortable(s, False)
        show(s)
        commit_profile(s, "0")
        found["kept absent at 0"] = not s.page.evaluate(PROFILE_KEY)
        commit_profile(s, "0.5")
        found["written off 0"] = s.page.evaluate(PROFILE)
        commit_profile(s, "0")
        found["dropped at 0"] = not s.page.evaluate(PROFILE_KEY)
        found["errors"] = s.page_errors()
    finally:
        s.close()
    return found


CASES = [("plain", "light"), ("plain", "dark"), ("comfortable", "dark"), ("comfortable", "light")]


@pytest.mark.parametrize("text,theme", CASES)
def test_the_include_tangent_edges_label_is_whole_beside_its_switch(seen, text, theme):
    got = seen[(text, theme)]
    assert got["label"] == "Include Tangent Edges"
    assert got["whole"], got
    assert got["beside"], got


@pytest.mark.parametrize("text,theme", CASES)
def test_the_switch_lines_up_with_the_radius_box_above(seen, text, theme):
    got = seen[(text, theme)]
    assert abs(got["switch_left"] - got["value_left"]) <= 1, got


@pytest.mark.parametrize("text,theme", CASES)
def test_a_plain_round_fillet_reads_profile_0(seen, text, theme):
    assert seen[(text, theme)]["profile"] == "0"


def test_profile_0_is_never_written_into_the_document(seen):
    assert seen["kept absent at 0"] is True
    assert seen["written off 0"] == 0.5
    assert seen["dropped at 0"] is True
    assert seen["errors"] == []
