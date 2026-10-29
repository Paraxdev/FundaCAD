"""Layout checks over a harness page: controls a person cannot see whole, at any interface size."""

from __future__ import annotations

from typing import Any

CONTROLS = (
    "button, a[href], input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role=button],"
    " [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=checkbox], [role=switch],"
    " [role=radio], [role=combobox], [role=slider], [role=spinbutton], [role=option], [role=treeitem],"
    ' [tabindex]:not([tabindex="-1"])'
)

# The roots of the base components in src/components/ui, the controls Comfortable text must never cut.
BASE = (
    ".btn, .icon-btn, .chip, .key-chip, .ui-checkbox, .opt-row, .ui-field-row, .ui-field, .ui-list-row,"
    " .ui-menu-item, .rail-btn, .ui-segment, .select-value, .ui-slider, .ui-switch-row, .ui-tab, .ui-unit-chip,"
    " .float-card-head, .ui-panel-head"
)

# Only the ancestors on the containing block chain clip a box, so an absolute or fixed popover escapes the overflow
# of the panel it sits in. A scrolling ancestor can bring a box into view, so the box moves into its scrollport.
_WHY = r"""
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
const rendered = (el) => {
  if (el.closest('[inert], [aria-hidden="true"], .sr-only, [hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2 && getComputedStyle(el).visibility === 'visible';
};
const why = (el, slack, cover) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const box = { x: [r.left, r.right], y: [r.top, r.bottom] };
  let pos = cs.position;
  let moved = false;
  let out = '';
  for (let a = el.parentElement; a && a !== document.documentElement && !out; a = a.parentElement) {
    const acs = getComputedStyle(a);
    if (+acs.opacity === 0) return `hidden by ${name(a)}`;
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
        const start = Math.min(Math.max(b[0], lo), hi - size);
        if (Math.abs(start - b[0]) > slack) moved = true;
        box[axis] = [start, start + size];
      } else if (b[0] < lo - slack || b[1] > hi + slack) {
        out = out ? `${out} and ${axis}` : `cut by ${name(a)} in ${axis}`;
      }
    }
  }
  if (out) return out;
  if (box.x[0] < -slack || box.x[1] > innerWidth + slack) return 'off screen in x';
  if (box.y[0] < -slack || box.y[1] > innerHeight + slack) return 'off screen in y';
  // A box a scroll would move is reachable by that scroll, whatever lies over its place now.
  if (!cover || moved || cs.pointerEvents === 'none') return '';
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  const hit = document.elementFromPoint(cx, cy);
  return hit && !el.contains(hit) && !hit.contains(el)
    ? `covered by ${name(hit)} at ${Math.round(cx)},${Math.round(cy)}` : '';
};
"""

_CLIPPED = (
    "([sel, slack, cover]) => {" + _WHY + "const out = [];"
    " for (const el of document.querySelectorAll(sel)) { if (!rendered(el)) continue;"
    " const w = why(el, slack, cover); if (w) out.push(`${name(el)}: ${w}`); } return out; }"
)

# The first stop is marked, so a walk ends when focus comes back to it even if another control has the same name.
_STOP = (
    "(slack) => {" + _WHY + "const el = document.activeElement;"
    " if (!el || el === document.body) return null;"
    " const first = document.querySelector('[data-walk-first]');"
    " if (first === el) return { name: name(el), again: true };"
    " if (!first) el.setAttribute('data-walk-first', '');"
    " return { name: name(el), again: false, why: rendered(el) ? why(el, slack, true) : 'focused but not rendered' }; }"
)

# A scroller that hides its scrollbar has to show a named cue for each way it can still scroll.
_CUELESS = r"""
() => {
  const out = [];
  const cue = (scroller, way) => [...scroller.parentElement.querySelectorAll('button, [role=button]')].some((b) => {
    if (scroller.contains(b) || !(b.getAttribute('aria-label') || '').trim().endsWith(` ${way}`)) return false;
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return !!hit && b.contains(hit);
  });
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.scrollbarWidth !== 'none' || !/auto|scroll/.test(cs.overflowY + cs.overflowX)) continue;
    if (el.closest('[inert], [aria-hidden="true"], [hidden]') || el.getBoundingClientRect().height < 2) continue;
    const id = el.id ? '#' + el.id : '.' + [...el.classList].join('.');
    if (/auto|scroll/.test(cs.overflowY)) {
      if (el.scrollTop > 1 && !cue(el, 'above')) out.push(`${id}: scrolls up with no cue`);
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 1 && !cue(el, 'below')) out.push(`${id}: scrolls down with no cue`);
    }
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) out.push(`${id}: scrolls sideways with no cue`);
  }
  return out;
}
"""


def clipped_controls(page: Any, slack: float = 1, cover: bool = False) -> list[str]:
    """Every rendered control outside the viewport or cut by an ancestor that clips, one line each. With `cover`,
    also every one that another box lies over where no scroll would move it."""
    return page.evaluate(_CLIPPED, [CONTROLS, slack, cover])


def focus_stop(page: Any, slack: float = 1) -> dict | None:
    """The focused control: its name, whether a walk is back at its first stop, and why it is not whole and on top."""
    return page.evaluate(_STOP, slack)


def tab_walk(page: Any, limit: int = 200, key: str = "Tab") -> list[dict]:
    """Presses `key` from the current focus until focus comes back to the first stop, one entry per stop."""
    page.evaluate("() => document.querySelectorAll('[data-walk-first]').forEach((e) => e.removeAttribute('data-walk-first'))")
    stops: list[dict] = []
    for _ in range(limit):
        page.keyboard.press(key)
        # Scroll events and the cues they show land a frame after the key.
        page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
        stop = focus_stop(page)
        if stop is None:
            continue
        if stop["again"]:
            return stops
        stops.append(stop)
    stops.append({"name": "(walk)", "again": False, "why": f"focus never came back to the first stop in {limit}"})
    return stops


def cueless_scrollers(page: Any) -> list[str]:
    """Every rendered scroller with a hidden scrollbar and content past an edge that no visible cue names."""
    return page.evaluate(_CUELESS)


# SVG text is drawn at its font size times the scale of its user space.
_SMALL = (
    "(floor) => {" + _WHY + r"""
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.data.trim()) continue;
    seen.add(el);
    const er = el.getBoundingClientRect();
    if (er.width < 2 || er.height < 2 || el.closest('.sr-only, script, style, noscript, [hidden]')) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    let px = parseFloat(getComputedStyle(el).fontSize);
    const m = el instanceof SVGGraphicsElement ? el.getScreenCTM() : null;
    if (m) px *= Math.hypot(m.a, m.b);
    if (px < floor - 0.01) out.push(`${name(el)}: ${+px.toFixed(2)}px`);
  }
  return out;
}"""
)

_CUT = (
    "(base) => {" + _WHY + r"""
  const out = [];
  for (const root of document.querySelectorAll(base)) {
    if (!rendered(root) || !root.checkVisibility({ opacityProperty: true })) continue;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!el.textContent.trim() || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      // A visually hidden word is a 1 px box by design.
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      const x = cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
      const y = cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1;
      if (x || y) out.push(`${name(el)}: cuts its text in ${[x && 'x', y && 'y'].filter(Boolean).join(' and ')}`);
    }
  }
  return [...new Set(out)];
}"""
)


def small_text(page: Any, floor: float = 11) -> list[str]:
    """Every element whose rendered text in the viewport is under `floor` CSS px, one line each."""
    return page.evaluate(_SMALL, floor)


def cut_labels(page: Any, base: str = BASE) -> list[str]:
    """Every box in a rendered base control that cuts its own text, by an ellipsis or a fixed size."""
    return page.evaluate(_CUT, base)

# The part of each box its clipping ancestors on the containing block chain leave, so a tool scrolled out of a rail
# overlaps nothing.
_OVERLAPS = (
    "([items, cards, slack]) => {" + _WHY + r"""
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    const b = { x: [r.left, r.right], y: [r.top, r.bottom] };
    let pos = getComputedStyle(el).position;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (!contains(acs, pos)) continue;
      pos = acs.position;
      const ar = a.getBoundingClientRect();
      if (acs.overflowX !== 'visible') b.x = [Math.max(b.x[0], ar.left), Math.min(b.x[1], ar.right)];
      if (acs.overflowY !== 'visible') b.y = [Math.max(b.y[0], ar.top), Math.min(b.y[1], ar.bottom)];
    }
    return b;
  };
  const shown = (sel) => [...document.querySelectorAll(sel)]
    .filter((el) => rendered(el) && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    .map((el) => ({ el, b: seen(el) }));
  const out = [];
  const mine = shown(items);
  const others = [...mine, ...shown(cards).filter((c) => !mine.some((m) => m.el === c.el))];
  for (const [i, m] of mine.entries()) {
    for (const [j, o] of others.entries()) {
      // A pair of items is checked once.
      if (j <= i || o.el.contains(m.el) || m.el.contains(o.el)) continue;
      const w = Math.min(m.b.x[1], o.b.x[1]) - Math.max(m.b.x[0], o.b.x[0]);
      const h = Math.min(m.b.y[1], o.b.y[1]) - Math.max(m.b.y[0], o.b.y[0]);
      if (w > slack && h > slack) out.push(`${name(m.el)} overlaps ${name(o.el)} by ${Math.round(w)} x ${Math.round(h)}`);
    }
  }
  return out;
}"""
)


def overlapping(page: Any, items: str, cards: str, slack: float = 1) -> list[str]:
    """Every rendered box matching `items` that overlaps another one, or a box matching `cards`, by more than
    `slack` px each way, one line per pair."""
    return page.evaluate(_OVERLAPS, [items, cards, slack])
