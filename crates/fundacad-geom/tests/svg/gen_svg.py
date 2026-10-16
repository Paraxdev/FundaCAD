"""Writes the SVG fixtures tests/import_svg.rs reads, synthetic shapes only.

    python crates/fundacad-geom/tests/svg/gen_svg.py

svg_letter_o.svg        an evenodd O: circles r10 and r5 drawn with A arcs, 20 x 20 mm
svg_letter_a_same.svg   a nonzero A whose counter runs the same way as the outline, so it fills
svg_letter_a_opposite.svg  the same A with the counter reversed, so it is a hole
svg_gap.svg             a filled 50 x 50 square whose end misses its start by 0.01 mm
svg_figure8.svg         a nonzero bow tie crossing itself at (10, 10), two 100 mm2 lobes
svg_overlap.svg         a 20 mm square drawn twice and a third square overlapping it by 100 mm2
svg_icon.svg            40 mm wide, viewBox in px (4 per mm), two Inkscape layers:
  Base    a rounded rect 140 x 40 rx 8 with a gradient fill, a text, an image, a
          filtered and a clipped shape, and a display none rect
  Marks   under translate(0,60) scale(2): a circle under rotate, an ellipse, a skewX
          rect, a triangle under matrix, a use of a defs square, a filled polyline,
          a polygon, and a stroked line
"""

from pathlib import Path

OUT = Path(__file__).resolve().parents[4] / "tests" / "fixtures"
HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'


def svg(body, w="20mm", h="20mm", vb="0 0 20 20", extra=""):
    return (HEAD + f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'{extra}width="{w}" height="{h}" viewBox="{vb}">\n{body}</svg>\n')


def signed_area(pts):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def poly_d(pts):
    return "M" + " L".join(f"{x:g},{y:g}" for x, y in pts) + " Z"


A_OUTER = [(0, 20), (8, 0), (12, 0), (20, 20), (14, 20), (12.5, 15), (7.5, 15), (6, 20)]
A_COUNTER = [(8.5, 11), (10, 5), (11.5, 11)]


def letter_a(same):
    counter = A_COUNTER if (signed_area(A_COUNTER) > 0) == (signed_area(A_OUTER) > 0) else A_COUNTER[::-1]
    if not same:
        counter = counter[::-1]
    return svg(f'<path fill="#222" d="{poly_d(A_OUTER)} {poly_d(counter)}"/>\n')


ICON = """<defs>
  <linearGradient id="grad"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
  <filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>
  <clipPath id="clip"><rect x="0" y="0" width="5" height="5"/></clipPath>
  <path id="d" d="M0,0 h8 v8 h-8 z"/>
</defs>
<g inkscape:groupmode="layer" inkscape:label="Base" id="layer1">
  <rect x="10" y="10" width="140" height="40" rx="8" fill="url(#grad)"/>
  <text x="20" y="30">LOGO</text>
  <image x="0" y="0" width="10" height="10" href="data:image/png;base64,AAAA"/>
  <rect x="20" y="20" width="4" height="4" fill="#fff" filter="url(#blur)"/>
  <rect x="30" y="20" width="4" height="4" fill="#fff" clip-path="url(#clip)"/>
  <rect x="0" y="0" width="500" height="500" style="display:none"/>
</g>
<g inkscape:groupmode="layer" inkscape:label="Marks" id="layer2" transform="translate(0,60) scale(2)">
  <g transform="rotate(30 10 10)"><circle cx="10" cy="10" r="5"/></g>
  <ellipse cx="30" cy="10" rx="6" ry="3"/>
  <rect x="45" y="5" width="10" height="10" transform="skewX(20)" style="fill:#000"/>
  <g transform="matrix(1,0.5,0,1,60,0)"><polygon points="0,0 8,0 0,8"/></g>
  <use xlink:href="#d" x="5" y="25"/>
  <polyline points="25,25 35,25 30,35"/>
  <polygon points="45,25 55,25 55,35 45,35"/>
  <line x1="60" y1="25" x2="70" y2="35" stroke="#000" fill="none"/>
</g>
"""

FILES = {
    "svg_letter_o.svg": svg('<path fill-rule="evenodd" d="M20,10 A10,10 0 0 1 0,10 A10,10 0 0 1 20,10 Z '
                            'M15,10 A5,5 0 0 1 5,10 A5,5 0 0 1 15,10 Z"/>\n'),
    "svg_letter_a_same.svg": letter_a(True),
    "svg_letter_a_opposite.svg": letter_a(False),
    "svg_gap.svg": svg('<path d="M0,0 L50,0 L50,50 L0,50 L0,0.01"/>\n', "50mm", "50mm", "0 0 50 50"),
    "svg_figure8.svg": svg('<path fill-rule="nonzero" d="M0,0 L20,20 L20,0 L0,20 Z"/>\n'),
    "svg_overlap.svg": svg('<rect x="0" y="0" width="20" height="20"/>\n<path d="M0,0 h20 v20 h-20 z"/>\n'
                           '<rect x="10" y="10" width="20" height="20"/>\n', "30mm", "30mm", "0 0 30 30"),
    "svg_icon.svg": svg(ICON, "40mm", "40mm", "0 0 160 160",
                        'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '),
}

if __name__ == "__main__":
    for name, text in FILES.items():
        (OUT / name).write_text(text, encoding="utf-8", newline="\n")
        print(name)
