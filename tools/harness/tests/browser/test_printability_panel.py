import base64

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


MAKE_JPEG = """() => {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  g.fillStyle = '#ff8800';
  g.fillRect(0, 0, 1280, 720);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(640, 360, 300, 0, 2 * Math.PI);
  g.fill();
  return c.toDataURL('image/jpeg').split(',')[1];
}"""

# Set after the app has started, since it reads this global at startup to choose its desktop paths.
FAKE_NATIVE = """() => {
  const registry = JSON.stringify([
    { id: 'printer1', name: 'Test', host: '192.168.0.2', port: 7125, kind: 'Moonraker', webcam_port: 80 },
  ]);
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === 'plugin_data_adopt') return false;
      if (cmd === 'plugin_data_read') return args.name === 'printers.json' ? registry : null;
      if (cmd !== 'plugin_local_request') throw `no ${cmd} in this test`;
      const blob = await (await fetch('/test-camera-frame.jpg')).blob();
      const url = await new Promise((done) => {
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.readAsDataURL(blob);
      });
      return { status: 200, contentType: 'image/jpeg', text: null, base64: url.split(',')[1] };
    },
  };
}"""

# The extent of the bright picture in a shot of the image box, whose own background is near black.
PICTURE_EXTENT = """async (png) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let left = img.width, right = -1, top = img.height, bottom = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (d[(y * img.width + x) * 4] > 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return { width: right - left + 1, height: bottom - top + 1 };
}"""


@pytest.mark.parametrize("window", WINDOWS)
def test_camera_picture_keeps_its_aspect(plate, window):
    s = plate
    jpeg = base64.b64decode(s.page.evaluate(MAKE_JPEG))
    s.page.route("**/test-camera-frame.jpg", lambda r: r.fulfill(body=jpeg, content_type="image/jpeg"))
    s.page.evaluate(FAKE_NATIVE)
    place(s, window)
    s.page.evaluate(SET_CAMERA)
    try:
        s.page.wait_for_function("() => document.querySelector('.camera-frame')?.naturalWidth === 1280")
        s.page.wait_for_timeout(100)
        shot = s.page.locator(".camera-frame").screenshot()
        shown = s.page.evaluate(PICTURE_EXTENT, base64.b64encode(shot).decode())
        assert shown["width"] / shown["height"] == pytest.approx(16 / 9, abs=0.03), shown
        assert not s.page_errors(), s.page_errors()
    finally:
        s.page.evaluate(CLEAR_CAMERA)
        s.page.locator(".camera-frame").wait_for(state="detached")
        s.page.evaluate("() => { delete window.__TAURI_INTERNALS__; }")
        s.page.unroute("**/test-camera-frame.jpg")
        place(s, (1400, 900))
