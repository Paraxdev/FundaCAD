"""A refused Fillet or Chamfer names the largest size that fits, in English and in German with its decimal comma, in the
tool's prompt, and the History row's problem line names it too."""

import re

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import out_dir

pytestmark = [pytest.mark.browser]

BLOCK = "tools/harness/fixtures/block.json"
FITS = re.compile(r"fits up to ([0-9.]+)mm")
WIDER = "() => window.store.updateFeature('bx', { width: 21.5 })"


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        yield session
    finally:
        session.close()


def language(s: Session, lang: str) -> None:
    s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
    s.page.wait_for_timeout(300)


def prompt(s: Session) -> str:
    return s.status(raw=True).get("prompt") or ""


def chamfer_two_edges(s: Session, distance: str, enter: bool = False) -> None:
    """A chamfer on the top front and top back edges of a block 21.5 deep, where the two meet past 10.75."""
    for _ in range(3):
        s.press("Escape")
    s.open_file(BLOCK, discard=True)
    s.page.evaluate(WIDER)
    s.settle()
    s.view("iso")
    s.tool("Chamfer")
    s.pick_edge("between top front", via="edge")
    s.settle()
    s.type("field:distance", "2")
    s.settle()
    s.pick_edge("between top back", via="edge")
    s.settle()
    s.type("field:distance", distance, enter=enter)
    s.settle()


def refused_chamfer(s: Session) -> str:
    chamfer_two_edges(s, "15")
    message = ""
    for _ in range(20):
        message = s.page.evaluate("() => window.edgeFeature.refusal?.message ?? window.store.previewError") or ""
        if message:
            break
        s.page.wait_for_timeout(250)
    found = FITS.search(message)
    assert found, message
    return found.group(1)


@pytest.mark.parametrize("lang", ["en", "de"])
def test_a_refused_chamfer_names_the_largest_size_that_fits(s, lang):
    language(s, lang)
    try:
        fits = refused_chamfer(s)
        assert "." in fits, fits
        shown = fits.replace(".", ",") if lang == "de" else fits
        said = prompt(s)
        s.screenshot(out_dir() / f"chamfer_refused_prompt_{lang}.png")
        if lang == "en":
            assert said == (
                f"Distance too large for the faces around these edges, it fits up to {shown} mm"
                " · type a smaller distance · Esc"
            )
        else:
            assert said == (
                f"Abstand zu groß für die Flächen an diesen Kanten, es passen höchstens {shown} mm"
                " · geben Sie einen kleineren Abstand ein · Esc"
            )
    finally:
        for _ in range(3):
            s.press("Escape")
        language(s, "en")


def test_the_history_row_of_a_refused_chamfer_names_the_size_too(s):
    language(s, "en")
    chamfer_two_edges(s, "2", enter=True)
    fid = s.page.evaluate("() => window.store.document.features.at(-1).id")
    s.panel("History", open=True)
    box = s.page.locator('#timeline .param-row[data-field="distance"] input')
    if not box.count():
        s.click(f"feature:{fid}")
        s.settle()
    box.click()
    s.page.keyboard.press("Control+A")
    s.page.keyboard.type("15")
    message = ""
    for _ in range(20):
        s.page.wait_for_timeout(250)
        message = s.page.evaluate("() => window.store.previewError") or ""
        if message:
            break
    s.settle()
    found = FITS.search(message)
    assert found, message
    problem = s.page.locator('#timeline .param-row[data-field="distance"] .param-problem').inner_text()
    s.screenshot(out_dir() / "chamfer_refused_history_row.png")
    s.page.keyboard.press("Escape")
    assert f"{found.group(1)}mm" in problem or f"{found.group(1)} mm" in problem, problem
