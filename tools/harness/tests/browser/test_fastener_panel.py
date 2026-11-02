import pytest

pytestmark = [pytest.mark.browser]

WINDOWS = ((1100, 800), (1280, 800), (1400, 950), (1500, 950), (1920, 1080))
FORM_TEXT = ".scr-form .measure-hint, .scr-form .scr-problems"

# The harness engine has no installed Screws plugin, so its preview refuses every spec and Save stays disabled: a real
# click cannot land on it here. e2e/fastener_library.cjs clicks it for real, with the geometry, at these same windows.
HITS = """(sel) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  const dx = Math.min(3, r.width / 4);
  const dy = Math.min(3, r.height / 4);
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + dx, r.top + dy],
    [r.right - dx, r.top + dy],
    [r.left + dx, r.bottom - dy],
    [r.right - dx, r.bottom - dy],
  ];
  return points.flatMap(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    if (hit && el.contains(hit)) return [];
    return [`${Math.round(x)},${Math.round(y)} is ${hit ? hit.getAttribute('aria-label') || hit.className || hit.tagName : 'off the window'}`];
  });
}"""

OUTSIDE = """() => {
  const panel = document.querySelector('.scr-panel');
  const box = panel.getBoundingClientRect();
  return [panel, ...panel.querySelectorAll('.scr-library, .scr-library *')].flatMap((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return [];
    if (r.left >= box.left - 1 && r.right <= box.right + 1) return [];
    return [`${el.tagName}.${el.className} runs ${Math.round(r.left)} to ${Math.round(r.right)}`];
  });
}"""


ROOM = """() => {
  const box = (sel) => document.querySelector(sel).getBoundingClientRect();
  const fields = box('.scr-form > :first-child');
  const below = box('.scr-form > :last-child');
  const preview = box('.scr-form .scr-preview');
  const title = box('.scr-library .measure-title');
  const close = box('.scr-close');
  return {
    fields: fields.height,
    preview: preview.height,
    overlap: below.left < fields.right ? fields.bottom - below.top : 0,
    closeOnFirstRow: close.top < title.bottom && close.bottom > title.top,
  };
}"""


def open_library(s) -> None:
    s.page.evaluate("() => window.__fundacad.handleAction('fasteners')")
    s.page.locator(".scr-library").wait_for()


def place(s, window) -> None:
    s.page.set_viewport_size({"width": window[0], "height": window[1]})
    # The panel places itself a frame or two after a resize.
    s.page.wait_for_timeout(300)


def assert_form_reachable(s, scrolls: bool = False) -> None:
    s.page.locator(".scr-tab-custom").click()
    s.page.locator(".scr-new").click()
    s.page.locator(".scr-form").wait_for()
    s.page.wait_for_timeout(300)
    assert s.page.evaluate(OUTSIDE) == []
    if scrolls:
        s.page.locator(".scr-save").scroll_into_view_if_needed()
    assert s.page.evaluate(HITS, ".scr-save") == []
    assert s.page.locator(FORM_TEXT).count() > 0
    if scrolls:
        s.page.locator(".scr-form button:not(.scr-save)").scroll_into_view_if_needed()
    assert s.page.evaluate(HITS, ".scr-form button:not(.scr-save)") == []
    s.page.locator(".scr-form button:not(.scr-save)").click()
    s.page.locator(".scr-new").wait_for()


@pytest.fixture(scope="module")
def opened(session):
    session.open_file("tools/harness/fixtures/whole_sketch_extrude.json")
    return session


@pytest.fixture
def library(opened):
    s = opened
    open_library(s)
    yield s
    # The library keeps its tab and a half made form across a close.
    s.page.evaluate(
        """() => {
          const form = document.querySelector('.scr-form');
          form && [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click();
        }"""
    )
    s.page.evaluate("() => document.querySelector('.scr-close')?.click()")
    s.page.locator(".scr-library").wait_for(state="detached")
    place(s, (1400, 900))


@pytest.mark.parametrize("window", WINDOWS)
def test_custom_form_save_is_reachable_beside_history(library, window):
    s = library
    if not s.page.locator("#float-layer .timeline-shell").count():
        s.panel("history")
    place(s, window)
    assert_form_reachable(s)
    assert not s.page_errors(), s.page_errors()


@pytest.mark.parametrize("window", WINDOWS)
def test_custom_form_save_is_reachable_with_history_closed(library, window):
    s = library
    if s.page.locator("#float-layer .timeline-shell").count():
        s.panel("history")
    place(s, window)
    assert_form_reachable(s)


@pytest.mark.parametrize("window", WINDOWS)
def test_custom_form_save_is_reachable_beside_the_render_dock(library, window):
    s = library
    s.page.click('[data-workspace="render"]')
    s.page.locator("#renderdock").wait_for()
    place(s, window)
    try:
        # The dock leaves a short shelf at some windows, where the panel scrolls.
        assert_form_reachable(s, scrolls=True)
    finally:
        s.page.click('[data-workspace="model"]')
        s.page.locator("#renderdock").wait_for(state="detached")


@pytest.mark.parametrize("window", ((1100, 600), (1400, 600)))
def test_custom_form_save_scrolls_into_reach_in_a_short_window(library, window):
    s = library
    place(s, window)
    assert_form_reachable(s, scrolls=True)


@pytest.mark.parametrize("history", (True, False))
@pytest.mark.parametrize("window", WINDOWS + ((1100, 600),))
def test_custom_form_gives_the_fields_more_height_than_the_preview(library, window, history):
    s = library
    if bool(s.page.locator("#float-layer .timeline-shell").count()) != history:
        s.panel("history")
    place(s, window)
    s.page.locator(".scr-tab-custom").click()
    s.page.locator(".scr-new").click()
    s.page.locator(".scr-form").wait_for()
    s.page.wait_for_timeout(300)
    room = s.page.evaluate(ROOM)
    assert room["fields"] > room["preview"], room
    assert room["overlap"] <= 0, room
    assert room["closeOnFirstRow"], room


def test_custom_form_preview_draws_at_its_new_size_after_the_panel_stacks(library):
    s = library
    place(s, (1500, 950))
    s.page.locator(".scr-tab-custom").click()
    s.page.locator(".scr-new").click()
    drawn = ".scr-form .scr-preview"
    s.page.locator(drawn).wait_for()
    wide = s.page.locator(drawn).evaluate("(c) => [c.width, c.clientWidth]")
    assert wide[0] == wide[1], wide
    place(s, (1100, 800))
    s.page.wait_for_timeout(300)
    narrow = s.page.locator(drawn).evaluate("(c) => [c.width, c.clientWidth]")
    assert narrow[1] < wide[1], narrow
    assert narrow[0] == narrow[1], narrow


@pytest.mark.parametrize("window", WINDOWS)
def test_catalogue_stays_inside_the_panel(library, window):
    s = library
    place(s, window)
    s.page.locator(".scr-tab-catalogue").click()
    s.page.locator(".scr-search").fill("M3")
    s.page.locator(".scr-row[data-key='iso4762|M3']").click()
    s.page.locator(".scr-insert").wait_for()
    s.page.wait_for_timeout(300)
    assert s.page.evaluate(OUTSIDE) == []
    s.page.locator(".scr-insert").scroll_into_view_if_needed()
    assert s.page.evaluate(HITS, ".scr-insert") == []
