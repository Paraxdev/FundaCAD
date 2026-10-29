"""Layout checks over a harness page: controls a person cannot see whole, at any interface size."""

from __future__ import annotations

from typing import Any

CONTROLS = (
    "button, a[href], input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role=button],"
    " [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=checkbox], [role=switch],"
    " [role=radio], [role=combobox], [role=slider], [role=spinbutton], [role=option], [role=treeitem],"
    ' [tabindex]:not([tabindex="-1"])'
)

# Only the ancestors on the containing block chain clip a box, so an absolute or fixed popover escapes the overflow
# of the panel it sits in. A scrolling ancestor can bring a box into view, so the box moves to its start in that axis.
_CLIPPED = r"""
([sel, slack]) => {
  const out = [];
  const contains = (cs, pos) => {
    if (pos === 'static' || pos === 'relative' || pos === 'sticky') return true;
    const own = cs.transform !== 'none' || cs.filter !== 'none' || /paint|layout|strict|content/.test(cs.contain);
    return pos === 'fixed' ? own : own || cs.position !== 'static';
  };
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
    const id = el.id ? '#' + el.id : el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : '';
    return `${el.tagName.toLowerCase()}${id} "${t.replace(/\s+/g, ' ').slice(0, 40)}"`;
  };
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[inert], [aria-hidden="true"], .sr-only, [hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') continue;
    const box = { x: [r.left, r.right], y: [r.top, r.bottom] };
    let pos = cs.position;
    let why = '';
    for (let a = el.parentElement; a && a !== document.documentElement && !why; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (+acs.opacity === 0) { why = `hidden by ${name(a)}`; break; }
      if (!contains(acs, pos)) continue;
      pos = acs.position;
      const ar = a.getBoundingClientRect();
      // Under CSS zoom the client sizes stay unzoomed while the rects are zoomed.
      const sx = a.offsetWidth ? ar.width / a.offsetWidth : 1;
      const sy = a.offsetHeight ? ar.height / a.offsetHeight : 1;
      for (const axis of ['x', 'y']) {
        const flow = axis === 'x' ? acs.overflowX : acs.overflowY;
        if (flow === 'visible') continue;
        const lo = axis === 'x' ? ar.left + a.clientLeft * sx : ar.top + a.clientTop * sy;
        const hi = lo + (axis === 'x' ? a.clientWidth * sx : a.clientHeight * sy);
        const b = box[axis];
        if (/auto|scroll/.test(flow)) {
          const size = Math.min(b[1] - b[0], hi - lo);
          box[axis] = [lo, lo + size];
        } else if (b[0] < lo - slack || b[1] > hi + slack) {
          why = why ? `${why} and ${axis}` : `cut by ${name(a)} in ${axis}`;
        }
      }
    }
    if (!why) {
      if (box.x[0] < -slack || box.x[1] > innerWidth + slack) why = 'off screen in x';
      else if (box.y[0] < -slack || box.y[1] > innerHeight + slack) why = 'off screen in y';
    }
    if (why) out.push(`${name(el)}: ${why}`);
  }
  return out;
}
"""


def clipped_controls(page: Any, slack: float = 1) -> list[str]:
    """Every rendered control outside the viewport or cut by an ancestor that clips, one line each."""
    return page.evaluate(_CLIPPED, [CONTROLS, slack])
