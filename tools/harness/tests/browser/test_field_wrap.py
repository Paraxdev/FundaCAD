import json

import pytest
from test_a11y import escape, escape_twice, leave_geometry, show_extrude, show_geometry, show_stress
from test_plugin_panels_a11y import LIBRARY, closed, open_custom, open_library

from fundacad_harness import Session
from fundacad_harness.screens import close_settings, open_settings, out_dir, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

LONG = "Wide label for wrapping, " * 3

# Each family: the rows, the label inside a row and the control beside it.
FAMILIES = {
    "param": (".param-row", ":scope > label", ":scope > .param-value"),
    "inline": (".geometry-filters .ui-field-row-inline", ".ui-field-label", ".ui-field-control"),
    "stress": (".stress-field", ":scope > .measure-k:first-child", ":scope > :not(.measure-k:first-child)"),
    "fixed": (".scr-form .param-row", ":scope > label", ":scope > .param-value"),
}
# A plugin row with a fixed label column keeps its control beside, and a long label wraps inside the column.
FIXED = {"fixed"}

# Measures every visible row of a family as it is, or the first one with its label lengthened to `text`.
MEASURE = """({ row, label, control, text }) => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const clipper = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') return p;
    }
    return document.documentElement;
  };
  const rows = [...document.querySelectorAll(row)].filter((e) => e.getClientRects().length > 0);
  const one = (e) => {
    const lab = e.querySelector(label);
    const ctl = e.querySelector(control);
    if (!lab || !ctl) return null;
    const saved = lab.textContent;
    if (text) lab.textContent = text;
    const r = box(e), l = box(lab), c = box(ctl), out = box(clipper(e));
    const found = {
      label: saved,
      same_line: c.t < l.b - 1 && c.b > l.t + 1,
      under: c.t >= l.b - 1,
      right_gap: Math.abs(c.r - r.r),
      left_gap: Math.abs(c.l - r.l),
      label_whole: lab.scrollWidth <= lab.clientWidth + 1,
      label_width: Math.round(l.r - l.l),
      control_left: Math.round(c.l),
      inside: r.r <= out.r + 1 && r.l >= out.l - 1,
    };
    if (text) lab.textContent = saved;
    return found;
  };
  const list = text ? rows.slice(0, 1) : rows;
  return list.map(one).filter((x) => x !== null);
}"""


def measure(s: Session, family: str, text: str = "") -> list[dict]:
    row, label, control = FAMILIES[family]
    return s.page.evaluate(MEASURE, {"row": row, "label": label, "control": control, "text": text})


def scan(s: Session, family: str) -> dict:
    return {"rows": measure(s, family), "long": measure(s, family, LONG)}


@pytest.fixture(scope="module")
def found():
    out = out_dir()
    s = Session(viewport=(1366, 768))
    res: dict[str, dict] = {}
    try:
        show_extrude(s)
        res["param"] = scan(s, "param")
        escape_twice(s)
        show_geometry(s)
        res["inline"] = scan(s, "inline")
        leave_geometry(s)
        show_stress(s)
        res["stress"] = scan(s, "stress")
        escape(s)
        open_library(s)
        open_custom(s)
        res["fixed"] = scan(s, "fixed")
        closed(s, LIBRARY)
        open_settings(s, "Accessibility")
        s.page.locator("#prefs-comfortable-text").click()
        settled(s)
        close_settings(s)
        show_extrude(s)
        res["param comfortable"] = scan(s, "param")
        try:
            s.screenshot(out / "field_wrap_extrude.png")
        except Exception as e:
            res["shot"] = {"missed": str(e).splitlines()[0]}
    finally:
        s.close()
    (out / "field_wrap.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    return res


def families():
    return ["param", "inline", "stress", "fixed", "param comfortable"]


@pytest.mark.parametrize("name", families())
def test_a_row_that_fits_keeps_its_control_beside_the_label(found, name):
    rows = found[name]["rows"]
    assert rows, f"no {name} row was on the screen"
    off = [r["label"] for r in rows if not r["same_line"]]
    assert off == [], f"controls under their label: {off}"
    # A stress row can hold several controls, so only the other families end at the row's edge.
    if name != "stress":
        assert [r["label"] for r in rows if r["right_gap"] > 1] == []
    if name in FIXED:
        assert len({r["control_left"] for r in rows}) == 1, rows


@pytest.mark.parametrize("name", families())
def test_a_long_label_sends_the_control_to_its_own_line(found, name):
    rows = found[name]["long"]
    assert len(rows) == 1, f"no {name} row to lengthen"
    r = rows[0]
    assert r["label_whole"], r
    assert r["inside"], r
    if name in FIXED:
        assert r["same_line"], r
        assert r["label_width"] == found[name]["rows"][0]["label_width"], r
        return
    assert r["under"], r
    assert r["left_gap"] <= 1, r
