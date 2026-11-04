"""A long menu, a popover, the narrow drawers and the boxes a sketch places by the cursor at the larger interface sizes
in the 1400 by 900 window: each ends inside the window, under the browser build's root zoom, which scales vh and vw
with everything else and leaves the cursor and the window size in window pixels."""

import pytest
from test_sketch_keys import to_items_plane

pytestmark = [pytest.mark.browser]

OFFSET = "tools/harness/fixtures/offset_box.json"
STEPS = (100, 110, 125, 150, 175, 200)

# Boxes in the window's own pixels, which the root zoom leaves alone, so the window is innerWidth by innerHeight.
BOX = """sel => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0)
    ?? document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const round = (v) => Math.round(v * 10) / 10;
  return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),
           scrolls: el.scrollHeight > el.clientHeight + 1, w: innerWidth, h: innerHeight };
}"""
SHOWN = """el => new Promise((done) => {
  const io = new IntersectionObserver(([e]) => {
    io.disconnect();
    done(Math.round(e.intersectionRatio * 1000) / 1000);
  });
  io.observe(el);
})"""


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


def box(s, sel):
    return s.page.evaluate(BOX, sel)


def inside(b):
    return b is not None and b["left"] >= 0 and b["top"] >= 0 and b["right"] <= b["w"] and b["bottom"] <= b["h"]


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(OFFSET)
    session.settle()
    yield session
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Control+0")
    session.page.wait_for_function("() => document.documentElement.style.zoom === ''")
    frames(session)


@pytest.mark.parametrize("pct", [110, 175])
def test_a_menu_longer_than_the_window_ends_inside_it_with_its_last_row_on_screen(s, pct):
    size_to(s, pct)
    s.page.locator("#titlebar .menubar button").filter(has_text="View").first.click()
    s.page.locator(".ui-menu .menubar-rows").wait_for()
    frames(s)
    menu, rows = box(s, ".ui-menu"), box(s, ".ui-menu .menubar-rows")
    last = s.page.locator(".ui-menu [role^=menuitem]").last
    last.focus()
    frames(s)
    shown = last.evaluate(SHOWN)
    assert rows["scrolls"], f"at {pct} percent the View menu fits the window, so it tests no cap: {rows}"
    assert inside(menu) and inside(rows), f"at {pct} percent the View menu runs out of the window: {menu}, rows {rows}"
    assert shown >= 0.99, f"at {pct} percent the window shows {shown} of the View menu's last row"


@pytest.mark.parametrize("pct", [110, 175])
def test_the_display_popover_ends_inside_the_window(s, pct):
    size_to(s, pct)
    s.page.locator("#viewcontrols button[aria-label='Display']").click()
    s.page.locator(".float-popover").wait_for()
    frames(s)
    pop = box(s, ".float-popover")
    assert inside(pop), f"at {pct} percent the Display popover runs out of the window: {pop}"


@pytest.mark.parametrize("pct", [175, 200])
@pytest.mark.parametrize("drawer", ["Items", "History"])
def test_a_drawer_stretched_past_the_window_stops_inside_it(s, drawer, pct):
    size_to(s, pct)
    assert narrow(s), f"at {pct} percent the 1400 wide stage is still wide"
    sel = ".float-left-stack" if drawer == "Items" else "#timeline"
    if not s.page.locator("#browser" if drawer == "Items" else "#timeline").count():
        s.page.locator(f"#viewcontrols button[aria-label='{drawer}']").click()
    s.page.locator(sel).wait_for()
    s.page.locator(sel).evaluate("el => { el.style.width = '5000px'; }")
    frames(s)
    stretched = box(s, sel)
    s.page.locator(sel).evaluate("el => { el.style.width = ''; }")
    assert inside(stretched), f"at {pct} percent the {drawer} drawer stretched past the window runs out: {stretched}"


CURSOR = (1000, 600)


def gap_to(b, x, y):
    return max(b["left"] - x, x - b["right"], b["top"] - y, y - b["bottom"], 0)


@pytest.fixture
def sk(s):
    # By the Items list, as the drawers the tests above leave open can cover the plane in the view.
    to_items_plane(s)
    yield s
    for _ in range(5):
        if not s.page.evaluate("() => window.sketch.active"):
            break
        s.page.keyboard.press("Escape")
        frames(s)


def test_the_constrain_flyout_wraps_into_columns_inside_the_window(sk):
    size_to(sk, 175)
    sk.page.locator("[data-family='fam:constrain']").click(button="right")
    sk.page.locator(".float-popover.rail-flyout").wait_for()
    frames(sk)
    fly = box(sk, ".float-popover.rail-flyout")
    assert inside(fly) and not fly["scrolls"], f"at 175 percent the Constrain flyout runs out of the window: {fly}"


def test_the_sketch_value_box_stays_by_the_cursor_inside_the_window(sk):
    sk.tool("Line")
    size_to(sk, 175)
    sk.page.mouse.click(600, 450)
    sk.page.mouse.move(*CURSOR, steps=8)
    sk.page.wait_for_function("() => [...document.querySelectorAll('.dim-input')].some((e) => e.offsetWidth)")
    frames(sk)
    dim = box(sk, ".dim-input")
    assert inside(dim), f"at 175 percent the value box runs out of the window: {dim}"
    assert gap_to(dim, *CURSOR) <= 48, f"at 175 percent the value box is away from the cursor at {CURSOR}: {dim}"


def test_the_text_form_opens_inside_the_window(sk):
    sk.tool("Text")
    size_to(sk, 175)
    sk.page.mouse.click(*CURSOR)
    sk.page.locator(".text-tool-panel").wait_for()
    frames(sk)
    form = box(sk, ".text-tool-panel")
    assert inside(form), f"at 175 percent the text form opened at {CURSOR} runs out of the window: {form}"


def test_the_toasts_sit_just_above_the_tool_prompt(sk):
    sk.tool("Line")
    size_to(sk, 175)
    sk.page.locator("#prompt:not(.hidden)").wait_for()
    frames(sk)
    frames(sk)
    prompt, stack = box(sk, "#prompt"), box(sk, ".toast-stack")
    assert stack["bottom"] <= prompt["top"] + 1, f"at 175 percent the toasts sit over the prompt: {stack}, {prompt}"
    assert prompt["top"] - stack["bottom"] <= 40 * 1.75, f"at 175 percent the toasts float above it: {stack}, {prompt}"
