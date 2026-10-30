import json

import pytest
from test_a11y import FLOWS, RESET_BUDGET, SCREENS

from fundacad_harness import Session
from fundacad_harness.a11y import fresh_page, walk
from fundacad_harness.layout import clipped_controls, cut_labels, small_text
from fundacad_harness.screens import close_settings, open_settings, out_dir, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

BAIT = """() => {
  const wrap = document.createElement('div');
  wrap.id = 'text-bait';
  wrap.style.cssText = 'position:fixed;left:40px;top:40px;z-index:2147483647';
  wrap.innerHTML = '<span style="font-size:9px">Tiny print</span>'
    + '<button class="btn" style="width:40px;overflow:hidden;white-space:nowrap">A label far too long</button>';
  document.body.append(wrap);
}"""


def bait(s: Session) -> dict:
    """Both checks on a page that has small text and a cut label, so neither passes vacuously."""
    s.page.evaluate(BAIT)
    seen = {
        "small": [t for t in small_text(s.page) if '"Tiny print"' in t],
        "cut": [t for t in cut_labels(s.page) if '"A label far too long"' in t],
    }
    s.page.evaluate("() => document.getElementById('text-bait').remove()")
    return seen


@pytest.fixture(scope="module")
def scans():
    """The A1 screens with Comfortable text on, picked in Settings as a person would."""

    def scan(s: Session, name: str) -> dict:
        settled(s)
        found = {
            "comfortable": s.page.evaluate("() => document.documentElement.dataset.text || ''"),
            "small": small_text(s.page),
            "cut": cut_labels(s.page) + clipped_controls(s.page),
        }
        try:
            s.screenshot(out_dir() / f"text_{name}.png")
        except Exception as e:
            found["shot"] = str(e).splitlines()[0]
        return found

    s = Session(viewport=(1366, 768))
    try:
        state = bait(s)
        open_settings(s, "Accessibility")
        s.page.locator("#prefs-comfortable-text").click()
        close_settings(s)
        found = walk(s, FLOWS, scan, fresh_page, reset_budget=RESET_BUDGET)
    finally:
        s.close()
    (out_dir() / "text_size.json").write_text(json.dumps({"found": found, "state": state}, indent=1), encoding="utf-8")
    return {"found": found, "state": state}


def test_the_checks_find_small_text_and_a_cut_label(scans):
    assert len(scans["state"]["small"]) == 1, scans["state"]
    assert len(scans["state"]["cut"]) == 1, scans["state"]


@pytest.mark.parametrize("screen", SCREENS)
def test_no_text_is_under_the_floor(scans, screen):
    found = scans["found"].get(screen, "the walk never reached it")
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    assert found["small"] == [], f"{screen}, shot in {out_dir()}:\n" + "\n".join(found["small"])


@pytest.mark.parametrize("screen", SCREENS)
def test_comfortable_text_cuts_no_base_control(scans, screen):
    found = scans["found"].get(screen, "the walk never reached it")
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    assert found["comfortable"] == "comfortable", f"Comfortable text was off on {screen}"
    assert found["cut"] == [], f"{screen}, shot in {out_dir()}:\n" + "\n".join(found["cut"])
