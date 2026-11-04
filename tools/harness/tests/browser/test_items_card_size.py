"""The Items card at each larger interface size in the 1400 by 900 window: it ends inside the window in both of its
tabs, with its foot and the Geometry pager on screen and its list scrolling inside it, and when a bigger size folds it
into a drawer, focus that was in it goes to the Items switch rather than the page."""

import pytest

pytestmark = [pytest.mark.browser]

OFFSET = "tools/harness/fixtures/offset_box.json"
STEPS = (100, 110, 125, 150, 175, 200)

# What share of the element the window shows, in the window's own pixels, so it holds under the root zoom.
SHOWN = """sel => new Promise((done) => {
  const el = sel ? document.querySelector(sel) : document.activeElement;
  if (!el) return done(null);
  const io = new IntersectionObserver(([e]) => {
    io.disconnect();
    done(Math.round(e.intersectionRatio * 1000) / 1000);
  });
  io.observe(el);
})"""
FOCUS = """() => {
  const a = document.activeElement;
  return { tag: a?.tagName, name: a?.getAttribute("aria-label"), inCard: !!a?.closest("#browser") };
}"""


def size_to(s, pct):
    s.page.keyboard.press("Control+0")
    for _ in range(STEPS.index(pct) - STEPS.index(100)):
        s.page.keyboard.press("Control+Equal")
    zoom = "" if pct == 100 else f"{pct / 100:g}"
    s.page.wait_for_function("z => document.documentElement.style.zoom === z", arg=zoom)
    frames(s)


def frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def narrow(s):
    return s.page.evaluate("() => document.getElementById('stage').classList.contains('narrow')")


def show_card(s):
    if narrow(s) and not s.page.locator("#browser").count():
        s.page.locator("#viewcontrols button[aria-label='Items']").click()
    s.page.locator("#browser").wait_for()


def tab(s, name):
    s.page.locator("#browser [role=tab]").filter(has_text=name).click()
    frames(s)


def shown(s, sel):
    return s.page.evaluate(SHOWN, sel)


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(OFFSET)
    session.settle()
    yield session
    session.page.keyboard.press("Control+0")
    session.page.wait_for_function("() => document.documentElement.style.zoom === ''")
    frames(session)


@pytest.mark.parametrize("pct", [110, 125, 150, 175, 200])
def test_the_card_ends_inside_the_window_with_its_foot_and_pager_in_both_tabs(s, pct):
    size_to(s, pct)
    show_card(s)
    tab(s, "Items")
    got = {"items card": shown(s, "#browser"), "items foot": shown(s, "#browser .float-card-foot")}
    tab(s, "Geometry")
    s.page.locator("#browser .geometry-pager").wait_for()
    got["geometry card"] = shown(s, "#browser")
    got["geometry pager"] = shown(s, "#browser .geometry-pager")
    s.page.locator("#browser [role=option]").first.focus()
    s.page.keyboard.press("End")
    frames(s)
    got["last row after End"] = shown(s, None)
    tab(s, "Items")
    assert all(v is not None and v >= 0.99 for v in got.values()), f"at {pct} percent the window shows {got}"


@pytest.mark.parametrize("page", ["Items", "Geometry"])
def test_a_fold_into_the_drawer_hands_focus_to_the_items_switch_and_back(s, page):
    size_to(s, 150)
    show_card(s)
    assert not narrow(s)
    tab(s, page)
    row = "#browser [role=treeitem]" if page == "Items" else "#browser [role=option]"
    s.page.locator(row).first.focus()
    s.page.keyboard.press("Control+Equal")
    s.page.wait_for_function("() => document.getElementById('stage').classList.contains('narrow')")
    frames(s)
    folded = s.page.evaluate(FOCUS)
    s.page.keyboard.press("Control+Minus")
    s.page.wait_for_function("() => !document.getElementById('stage').classList.contains('narrow')")
    frames(s)
    unfolded = s.page.evaluate(FOCUS)
    tab(s, "Items")
    assert folded["tag"] == "BUTTON" and folded["name"] == "Items", f"after the fold focus is on {folded}"
    assert unfolded["inCard"], f"after the card comes back focus is on {unfolded}"
