"""Pointer target sizes as hit testing sees them, so a grown ::before area counts and a covered centre shows."""

from __future__ import annotations

from typing import Any

ROLES = (
    "button", "checkbox", "switch", "slider", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "radio", "treeitem", "link", "spinbutton", "combobox",
)
NATIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, .sketch-glyph'

_PROBE = r"""
({reach, roles, native}) => {
  const ROLES = new Set(roles);
  const interactive = (el) => {
    if (el.matches(native)) return true;
    const r = el.getAttribute('role');
    return !!r && ROLES.has(r.trim().split(/\s+/)[0]);
  };
  const owner = (n) => {
    for (; n; n = n.parentElement) if (interactive(n)) return n;
    return null;
  };
  // A visually hidden input inside its label is pressed through the label.
  const inside = (el, hit) => el.contains(hit) || [...(el.labels || [])].some((l) => l.contains(hit));
  const part = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const t = el.getAttribute('data-testid');
    if (t) return s + '[data-testid="' + t + '"]';
    const cls = [...el.classList].slice(0, 2);
    return cls.length ? s + '.' + cls.join('.') : s;
  };
  const path = (el) => {
    const out = [];
    for (let n = el; n && n !== document.body && out.length < 3; n = n.parentElement) {
      out.unshift(part(n));
      if (n.id) break;
    }
    return out.join(' > ');
  };
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const name = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const ref = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(' ') : '';
    const lab = [...(el.labels || [])].map((l) => l.textContent).join(' ');
    return text(el.getAttribute('aria-label') || ref || lab || el.textContent || el.getAttribute('title')
      || el.getAttribute('placeholder') || el.value);
  };
  const box = (r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
  const at = (x, y) => document.elementFromPoint(x, y);
  const extent = (el, cx, cy, dx, dy, lim) => {
    let n = 0;
    for (let d = 1; d <= lim; d++) {
      const h = at(cx + dx * d, cy + dy * d);
      if (!h || !inside(el, h)) break;
      n = d;
    }
    return n;
  };
  const sel = native + ', ' + [...ROLES].map((r) => '[role="' + r + '"]').join(', ');
  const within = (el, x, y) => [el, ...(el.labels || [])].some((n) => {
    const b = n.getBoundingClientRect();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  });
  // A point 1 px inside each edge that another control takes with its grown area, not with its own box.
  const stolen = (el, r, cx, cy) => {
    const sides = [['left', r.left + 1, cy], ['right', r.right - 1, cy], ['top', cx, r.top + 1],
      ['bottom', cx, r.bottom - 1]];
    const out = [];
    for (const [side, x, y] of sides) {
      const h = at(x, y), by = h && !inside(el, h) && owner(h);
      if (by && !by.contains(el) && !within(by, x, y)) out.push({side, by: path(by), byName: name(by)});
    }
    return out;
  };
  const out = {targets: [], covered: [], occluded: [], stolen: [], offscreen: 0};
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.pointerEvents === 'none' || el.closest('[inert]')) continue;
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) { out.offscreen++; continue; }
    const base = {sel: path(el), name: name(el), role: el.getAttribute('role') || el.tagName.toLowerCase(),
      box: box(r), disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'};
    const hit = at(cx, cy);
    if (!hit || !inside(el, hit)) {
      const by = hit && owner(hit);
      if (by) out.covered.push({...base, by: path(by), byName: name(by)});
      else out.occluded.push({...base, by: hit ? path(hit) : ''});
      continue;
    }
    for (const s of stolen(el, r, cx, cy)) out.stolen.push({...base, ...s});
    const limX = Math.min(Math.ceil(r.width / 2) + 24, reach), limY = Math.min(Math.ceil(r.height / 2) + 24, reach);
    const left = extent(el, cx, cy, -1, 0, limX), right = extent(el, cx, cy, 1, 0, limX);
    const up = extent(el, cx, cy, 0, -1, limY), down = extent(el, cx, cy, 0, 1, limY);
    const capped = [left, right].includes(reach) || [up, down].includes(reach);
    out.targets.push({...base, hit: [left + right + 1, up + down + 1], capped});
  }
  return out;
}
"""


def probe(page: Any, reach: int = 48) -> dict:
    """Every visible interactive element: its visual box, and its hit width and height along the centre lines.

    The walk stops reach px from the centre, so a hit size of 2 * reach + 1 means at least that much (capped).
    """
    return page.evaluate(_PROBE, {"reach": reach, "roles": list(ROLES), "native": NATIVE})


def under(report: dict, min_px: float, enabled_only: bool = False) -> list[dict]:
    return [
        t
        for t in report["targets"]
        if (t["hit"][0] < min_px or t["hit"][1] < min_px) and not (enabled_only and t["disabled"])
    ]


def line(t: dict) -> str:
    w, h = t["box"][2], t["box"][3]
    size = f"hit {t['hit'][0]}x{t['hit'][1]} " if "hit" in t else ""
    by = f" under {t['by']}" if t.get("by") else ""
    return f"{t['sel']} \"{t['name']}\" {size}box {w}x{h}{by}"
