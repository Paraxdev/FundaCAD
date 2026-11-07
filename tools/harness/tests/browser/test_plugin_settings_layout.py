import pytest

from fundacad_harness import Session
from fundacad_harness.screens import close_settings
from test_plugin_panels_rest_a11y import (
    ASK_LINK,
    FAKE_NATIVE,
    gone,
    open_gamepad,
    open_onshape_keys,
    open_spacemouse,
    plugin_settings,
)

pytestmark = [pytest.mark.browser]

RECT = (
    "(el) => { const r = el.getBoundingClientRect();"
    " return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width}; }"
)

# The mapping rows keep the inset the setting cards above them keep, so no box or line of text under them runs past
# where the cards' own controls end, and no axis name in their selects is cut short.
OVERFLOW = """(sel) => {
  const card = document.querySelector(sel + ' .pref-card');
  const edge = card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight);
  const rows = [...document.querySelectorAll(sel + ' .sm-map-row')];
  const out = [];
  const past = (r, what) => {
    if (r.width && r.right > edge + 0.5) out.push(`${what} ends at ${r.right}, the cards' controls at ${edge}`);
  };
  for (const row of rows) {
    for (const el of [row, ...row.querySelectorAll('*')])
      if (!el.closest('.sr-only')) past(el.getBoundingClientRect(), el.className || el.tagName);
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('.sr-only')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      past(range.getBoundingClientRect(), JSON.stringify(n.textContent.trim()));
    }
    for (const v of row.querySelectorAll('.select-value'))
      if (v.scrollWidth > v.clientWidth + 0.5) out.push(`${JSON.stringify(v.textContent.trim())} is cut short`);
  }
  return {rows: rows.length, out};
}"""


@pytest.fixture(scope="module")
def app():
    s = Session(viewport=(1400, 900))
    s.page.evaluate(FAKE_NATIVE)
    try:
        yield s
    finally:
        s.close()


def test_every_gamepad_button_select_has_one_width_and_right_edge(app):
    sel = open_gamepad(app)
    try:
        boxes = [app.page.evaluate(RECT, h) for h in app.page.locator(f"{sel} [role=combobox]").element_handles()]
        assert len(boxes) > 10
        widths = sorted({round(b["width"]) for b in boxes})
        rights = sorted({round(b["right"]) for b in boxes})
        assert widths[-1] - widths[0] <= 1, f"the select widths differ: {widths}"
        assert rights[-1] - rights[0] <= 1, f"the select right edges differ: {rights}"
    finally:
        close_settings(app)


@pytest.mark.parametrize("width", (1400, 1100))
def test_the_spacemouse_axis_mapping_fits_its_section(app, width):
    app.page.set_viewport_size({"width": width, "height": 900})
    app.page.wait_for_timeout(300)
    sel = open_spacemouse(app)
    try:
        found = app.page.evaluate(OVERFLOW, sel)
        assert found["rows"] == 6
        assert not found["out"], "\n".join(found["out"])
    finally:
        close_settings(app)
        app.page.set_viewport_size({"width": 1400, "height": 900})


def test_the_navigation_shortcuts_show_no_alert_on_a_fresh_profile(app):
    sel = plugin_settings("FundaCAD.Navigation")[0](app)
    try:
        radial = app.page.get_by_role("checkbox", name="Radial menu", exact=True)
        if not radial.is_checked():
            radial.click()
        app.page.locator(f"{sel} [data-nav-key]").first.wait_for()
        assert app.page.locator(f'{sel} [role="alert"]').count() == 0
    finally:
        close_settings(app)


def test_the_onshape_keys_section_says_no_keys_are_stored(app):
    sel = open_onshape_keys(app)
    try:
        app.page.locator(f'{sel} [role="status"]:has-text("No keys are stored")').wait_for(timeout=10000)
        assert app.page.locator(f'{sel} [role="alert"]').count() == 0
    finally:
        close_settings(app)


def test_the_onshape_link_field_takes_the_dialog_width_under_its_label(app):
    app.page.evaluate(ASK_LINK)
    dialog = app.page.locator(".onshape-link-dialog")
    dialog.wait_for()
    try:
        well = app.page.locator(".onshape-link-dialog .ui-text-field:has([data-testid=onshape-link])")
        row = app.page.locator(".onshape-link-dialog .ui-field-row:has([data-testid=onshape-link])")
        label = row.locator(".ui-field-label")
        w, r, lab = (app.page.evaluate(RECT, x.element_handle()) for x in (well, row, label))
        assert w["width"] >= r["width"] - 1, f"the link field is {w['width']} wide in a {r['width']} row"
        assert w["top"] >= lab["bottom"] - 0.5, "the link field is not under its label"
        access = app.page.locator(".onshape-link-dialog .ui-text-field:has([data-testid=onshape-access])")
        assert app.page.evaluate(RECT, access.element_handle())["width"] < r["width"] - 1
    finally:
        gone(app, ".onshape-link-dialog")
