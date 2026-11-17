import json

import pytest
from test_a11y import FLOWS, RESET_BUDGET, SCREENS

from fundacad_harness import Session
from fundacad_harness.a11y import fresh_page, walk
from fundacad_harness.layout import clipped_controls, cut_labels, small_text
from fundacad_harness.screens import close_settings, open_settings, out_dir, pick, settled

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


# A fallback wider than the shipped face, as DejaVu Sans on a Linux runner is, so a layout with no slack shows here too.
WIDE = ':root { --ui: Verdana, "DejaVu Sans", sans-serif !important; }'


PSEUDO_TAG = "en-XA"


def speak(s: Session, code: str) -> None:
    """Switches the page's language without the UI. The flows name controls in English, so a screen is shown in English
    and read in Pseudo."""
    s.page.evaluate("async (code) => (await import('/src/i18n/index.ts')).setLanguage(code)", code)
    settled(s)


def pick_pseudo_and_back(s: Session) -> str:
    """Picks Pseudo in Preferences, Appearance as a person would, reads the page language, then picks English again."""
    open_settings(s, "Appearance")
    pick(s, "#prefs-language", "Pseudo")
    settled(s)
    tag = s.page.evaluate("() => document.documentElement.lang")
    pick(s, "#prefs-language", "English")
    settled(s)
    close_settings(s)
    return tag


def scan_screens(wide: bool, pseudo: bool = False) -> dict:
    tag = "pseudo" if pseudo else "wide" if wide else "text"

    def scan(s: Session, name: str) -> dict:
        settled(s)
        if wide:
            s.page.add_style_tag(content=WIDE)
            settled(s)
        if pseudo:
            speak(s, "pseudo")
        try:
            found = {
                "comfortable": s.page.evaluate("() => document.documentElement.dataset.text || ''"),
                "lang": s.page.evaluate("() => document.documentElement.lang"),
                "small": small_text(s.page),
                "cut": cut_labels(s.page) + clipped_controls(s.page),
            }
            try:
                s.screenshot(out_dir() / f"{tag}_{name}.png")
            except Exception as e:
                found["shot"] = str(e).splitlines()[0]
        finally:
            if pseudo:
                speak(s, "en")
        return found

    s = Session(viewport=(1366, 768))
    try:
        open_settings(s, "Accessibility")
        s.page.locator("#prefs-comfortable-text").click()
        close_settings(s)
        picked = pick_pseudo_and_back(s) if pseudo else ""
        if pseudo:
            speak(s, "pseudo")
        try:
            state = bait(s)
        finally:
            if pseudo:
                speak(s, "en")
        found = walk(s, FLOWS, scan, fresh_page, reset_budget=RESET_BUDGET)
    finally:
        s.close()
    name = {"pseudo": "text_size_pseudo.json", "wide": "text_size_wide.json", "text": "text_size.json"}[tag]
    state = {**state, "picked": picked} if pseudo else state
    (out_dir() / name).write_text(json.dumps({"found": found, "state": state}, indent=1), encoding="utf-8")
    return {"found": found, "state": state}


@pytest.fixture(scope="module")
def scans():
    """The A1 screens with Comfortable text on, picked in Settings as a person would."""
    return scan_screens(False)


@pytest.fixture(scope="module")
def wide_scans():
    return scan_screens(True)


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


@pytest.mark.parametrize("screen", SCREENS)
def test_comfortable_text_cuts_no_base_control_in_a_wider_font(wide_scans, screen):
    found = wide_scans["found"].get(screen, "the walk never reached it")
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    assert found["cut"] == [], f"{screen}, shot in {out_dir()}:" + chr(10) + chr(10).join(found["cut"])


@pytest.fixture(scope="module")
def pseudo_scans():
    """Every screen read in Pseudo, about 1.7 times as long as English, with Comfortable text on."""
    return scan_screens(False, pseudo=True)


def test_pseudo_is_picked_in_appearance_and_the_checks_still_find_faults(pseudo_scans):
    assert pseudo_scans["state"]["picked"] == PSEUDO_TAG, pseudo_scans["state"]
    assert len(pseudo_scans["state"]["small"]) == 1, pseudo_scans["state"]
    assert len(pseudo_scans["state"]["cut"]) == 1, pseudo_scans["state"]


@pytest.mark.parametrize("screen", SCREENS)
def test_comfortable_text_cuts_no_base_control_in_pseudo(pseudo_scans, screen):
    found = pseudo_scans["found"].get(screen, "the walk never reached it")
    assert not isinstance(found, str), f"{screen} did not open: {found}"
    assert found["lang"] == PSEUDO_TAG, f"{screen} was not read in Pseudo"
    assert found["comfortable"] == "comfortable", f"Comfortable text was off on {screen}"
    assert found["small"] == [], f"{screen}, shot in {out_dir()}:" + chr(10) + chr(10).join(found["small"])
    assert found["cut"] == [], f"{screen}, shot in {out_dir()}:" + chr(10) + chr(10).join(found["cut"])
