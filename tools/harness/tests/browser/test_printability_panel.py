import pytest

pytestmark = [pytest.mark.browser]

WINDOWS = ((1100, 800), (1280, 800), (1500, 950))

# Everything drawn in the panel, and every scroller in it that scrolls sideways, that is not inside its box.
OUTSIDE = """(sel) => {
  const panel = document.querySelector(sel).closest('.measure-panel');
  const box = panel.getBoundingClientRect();
  const found = [];
  for (const el of [panel, ...panel.querySelectorAll('*')]) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const name = `${el.tagName}.${el.className}`;
    if (r.left < box.left - 1 || r.right > box.right + 1)
      found.push(`${name} runs ${Math.round(r.left)} to ${Math.round(r.right)}, panel ${Math.round(box.left)} to ${Math.round(box.right)}`);
    else if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
      found.push(`${name} scrolls sideways, ${el.scrollWidth} in ${el.clientWidth}`);
  }
  return found;
}"""

SET_CAMERA = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  state.cameraPanel.value = 'printer1';
}"""
CLEAR_CAMERA = """async () => {
  const state = await import('/plugins/FundaCAD.Printing/state.ts');
  state.cameraPanel.value = null;
}"""


def place(s, window) -> None:
    s.page.set_viewport_size({"width": window[0], "height": window[1]})
    # The panel places itself a frame or two after a resize.
    s.page.wait_for_timeout(300)


def assert_inside(s, window, sel) -> None:
    place(s, window)
    assert s.page.evaluate(OUTSIDE, sel) == []
    assert not s.page_errors(), s.page_errors()


@pytest.fixture(scope="module")
def plate(session):
    session.open_file("tools/harness/fixtures/plate_width.json")
    return session


@pytest.fixture
def printability(plate):
    s = plate
    s.page.evaluate("() => window.__fundacad.handleAction('print-printability')")
    s.page.locator(".printability-panel").wait_for()
    yield s
    s.page.locator(".printability-close").click()
    s.page.locator(".printability-panel").wait_for(state="detached")
    place(s, (1400, 900))


@pytest.mark.parametrize("window", WINDOWS)
def test_printability_content_stays_inside_the_panel(printability, window):
    assert_inside(printability, window, ".printability-panel .printability-nozzle")
    assert_inside(printability, window, ".printability-panel .printability-layflat")


@pytest.mark.parametrize("window", WINDOWS)
def test_printability_result_stays_inside_the_panel(printability, window):
    s = printability
    s.page.locator(".printability-run").click()
    s.page.locator(".printability-header").wait_for()
    assert_inside(s, window, ".printability-panel .printability-header")


@pytest.mark.parametrize("window", WINDOWS)
def test_parameter_setup_stays_inside_the_panel(plate, window):
    s = plate
    s.page.evaluate("() => window.__fundacad.handleAction('parameter-setup')")
    s.page.locator(".xp-setup-panel .xp-kind").wait_for()
    try:
        assert_inside(s, window, ".xp-setup-panel .xp-kind")
    finally:
        s.page.keyboard.press("Escape")
        s.page.locator(".xp-setup-panel").wait_for(state="detached")
        place(s, (1400, 900))


@pytest.mark.parametrize("window", WINDOWS)
def test_camera_frame_stays_inside_the_panel(plate, window):
    s = plate
    s.page.evaluate(SET_CAMERA)
    s.page.locator(".camera-frame").wait_for()
    try:
        assert_inside(s, window, ".camera-frame")
    finally:
        s.page.evaluate(CLEAR_CAMERA)
        s.page.locator(".camera-frame").wait_for(state="detached")
        place(s, (1400, 900))
