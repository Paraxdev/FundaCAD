"""A face a Geometry row lights is hatched and a face picked from the list is a flat tint, so the two never draw the
same, in the dark theme and in High Contrast Light, read off the pixels of the face itself."""

import base64
import statistics

import pytest

from fundacad_harness.screens import close_settings, open_settings, pick

pytestmark = [pytest.mark.browser]

OFFSET = "tools/harness/fixtures/offset_box.json"
THEMES = ["FundaCAD Noir", "High Contrast Light"]

# The top face of offset_box, 40 by 30 at height 47, sampled on a grid well inside its edges.
FACE_POINTS = """() => {
  const cam = window.viewport.camera;
  const r = document.getElementById("canvas").getBoundingClientRect();
  const V = cam.position.constructor;
  const out = [];
  for (let i = 0; i <= 24; i++)
    for (let j = 0; j <= 24; j++) {
      const p = new V(93.5 + 40 * (0.2 + 0.6 * i / 24), -56.25 + 30 * (0.2 + 0.6 * j / 24), 47).project(cam);
      out.push([r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height]);
    }
  return out;
}"""

READ_PIXELS = """async ({ png, pts }) => {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  return pts.map(([x, y]) => {
    const i = (Math.round(y) * bmp.width + Math.round(x)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  });
}"""

LABEL = "() => document.activeElement?.getAttribute('aria-label') ?? ''"


def frames(s, n=4):
    s.page.evaluate(
        "n => new Promise((r) => { const f = (k) => k ? requestAnimationFrame(() => f(k - 1)) : r(); f(n); })",
        n,
    )


def face_pixels(s):
    s.settle()
    frames(s)
    png = base64.b64encode(s.page.screenshot()).decode()
    return s.page.evaluate(
        READ_PIXELS, {"png": png, "pts": s.page.evaluate(FACE_POINTS)}
    )


def luma(px):
    return [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px]


def to_row(s, words):
    for _ in range(12):
        if words in s.page.evaluate(LABEL):
            return
        s.page.keyboard.press("ArrowDown")
        frames(s, 2)
    raise AssertionError(f"no row says {words}")


# The Accessibility tab takes focus off the theme field first, or Escape may only close its list.
def use_theme(s, label):
    open_settings(s, "Appearance")
    pick(s, "#prefs-theme", label)
    s.page.get_by_role("tab", name="Accessibility", exact=True).click()
    close_settings(s)


def states(s, theme):
    """The top face lit, picked and lit, then picked with the light gone to the hidden bottom face."""
    s.press("Escape")
    use_theme(s, theme)
    s.open_file(OFFSET)
    s.settle()
    s.command("Browse Faces and Edges")
    s.page.wait_for_function(
        "() => document.activeElement?.getAttribute('role') === 'option'",
        timeout=15_000,
    )
    to_row(s, "facing up")
    shots = {"lit": face_pixels(s)}
    s.page.keyboard.press("Enter")
    shots["both"] = face_pixels(s)
    s.page.keyboard.press("ArrowUp")
    assert "facing down" in s.page.evaluate(LABEL)
    shots["selected"] = face_pixels(s)
    assert s.selection(raw=True)["faces"], "Enter picked nothing"
    s.page.keyboard.press("Escape")
    return shots


@pytest.mark.parametrize("theme", THEMES)
def test_a_lit_face_and_a_picked_face_draw_apart(session, theme):
    shots = states(session, theme)
    lit, both, picked = (luma(shots[k]) for k in ("lit", "both", "selected"))
    spread = {
        k: statistics.pstdev(v)
        for k, v in (("lit", lit), ("both", both), ("selected", picked))
    }
    # Stripes spread the face's lightness, a tint leaves it flat.
    assert spread["lit"] > 3 * spread["selected"] + 6, spread
    # Over the tint the stripes are a lighter or darker shade of it, so they spread less.
    assert spread["both"] > 2 * spread["selected"] + 6, spread
    differ = sum(abs(a - b) > 24 for a, b in zip(lit, picked)) / len(lit)
    assert differ > 0.2, f"only {differ:.0%} of the face differs between lit and picked"
