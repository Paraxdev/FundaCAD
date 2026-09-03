"""A sketch's entities, turned into edges, wires and faces.

Split out of builder.py. This is the 2D half of the kernel and it is genuinely
separable: nothing here knows about bodies, booleans or the feature tree. It
takes a sketch feature — the entity list a user drew, plus the parameter
evaluator that turns "w/2" into a number — and answers the two questions the
rest of the rebuild asks of a sketch:

  - what curves are these (_entity_edges, and _text_faces for lettering);
  - which closed area did the user click (_subdivide_faces and the _region_*
    helpers, which cut the drawing into cells and pick the ones a region point
    lands in).

Patterns are expanded here too, because a patterned entity IS entities: the
sketch the kernel sees has the copies in it.

builder.py re-exports every name below.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Align,
    Circle,
    Compound,
    Edge,
    Face,
    FontStyle,
    Polyline,
    Pos,
    Rectangle,
    Rot,
    Text,
    Vector,
    Wire,
)

from face_footprint import split_profile_cells
from geom_select import _bbox_diag
from plane_spec import _plane_of, _sketch_plane_ref
from progress import progress_tick
from shape_util import _wrapped_or_none

def _translate_entity(e, dx, dy, eid, val):
    t = e["type"]
    c = {"construction": True} if e.get("construction") else {}
    if t == "line":
        return {"type": "line", "id": eid, "x1": val(e["x1"]) + dx, "y1": val(e["y1"]) + dy, "x2": val(e["x2"]) + dx, "y2": val(e["y2"]) + dy, **c}
    if t == "rectangle":
        return {"type": "rectangle", "id": eid, "width": val(e["width"]), "height": val(e["height"]), "x": val(e.get("x", 0)) + dx, "y": val(e.get("y", 0)) + dy, **c}
    if t == "circle":
        return {"type": "circle", "id": eid, "radius": val(e["radius"]), "x": val(e.get("x", 0)) + dx, "y": val(e.get("y", 0)) + dy, **c}
    if t == "arc":
        return {"type": "arc", "id": eid, "x1": val(e["x1"]) + dx, "y1": val(e["y1"]) + dy, "x2": val(e["x2"]) + dx, "y2": val(e["y2"]) + dy, "mx": val(e["mx"]) + dx, "my": val(e["my"]) + dy, **c}
    if t == "spline":
        return {"type": "spline", "id": eid, "points": [{"x": val(p["x"]) + dx, "y": val(p["y"]) + dy} for p in e.get("points", [])], **c}
    return {"type": "point", "id": eid, "x": val(e["x"]) + dx, "y": val(e["y"]) + dy, **c}


def _rotate_entity(e, cx, cy, ang, eid, val):
    co, si = math.cos(ang), math.sin(ang)

    def R(x, y):
        ddx, ddy = x - cx, y - cy
        return cx + ddx * co - ddy * si, cy + ddx * si + ddy * co

    t = e["type"]
    c = {"construction": True} if e.get("construction") else {}
    if t == "circle":
        x, y = R(val(e.get("x", 0)), val(e.get("y", 0)))
        return [{"type": "circle", "id": eid, "radius": val(e["radius"]), "x": x, "y": y, **c}]
    if t == "point":
        x, y = R(val(e["x"]), val(e["y"]))
        return [{"type": "point", "id": eid, "x": x, "y": y, **c}]
    if t == "line":
        x1, y1 = R(val(e["x1"]), val(e["y1"]))
        x2, y2 = R(val(e["x2"]), val(e["y2"]))
        return [{"type": "line", "id": eid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, **c}]
    if t == "arc":
        x1, y1 = R(val(e["x1"]), val(e["y1"]))
        x2, y2 = R(val(e["x2"]), val(e["y2"]))
        mx, my = R(val(e["mx"]), val(e["my"]))
        return [{"type": "arc", "id": eid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my, **c}]
    if t == "spline":
        return [{"type": "spline", "id": eid, "points": [dict(zip(("x", "y"), R(val(p["x"]), val(p["y"])))) for p in e.get("points", [])], **c}]
    # A rectangle carries its OWN rotation now, but the pattern/mirror transform R
    # can also shear or reflect, which a width/height/angle triple cannot express.
    # So a transformed copy stays a 4-line loop, as it always has.
    corners = [R(px, py) for px, py in _rect_corners(e, val)]
    return [
        {"type": "line", "id": f"{eid}.{i}", "x1": corners[i][0], "y1": corners[i][1], "x2": corners[(i + 1) % 4][0], "y2": corners[(i + 1) % 4][1], **c}
        for i in range(4)
    ]


def _rect_corners(e, val):
    """A rectangle's four corners CCW (bl, br, tr, tl), about its own centre.

    `angle` is DEGREES, like every other angle field. MIRRORS
    src/sketch/region.ts rectCorners and must keep doing so: the frontend draws
    and picks from that one and the solid is built from this one, so a
    disagreement is a sketch that extrudes into a shape the user did not draw.
    Angle 0 returns the corners untouched rather than through a cos/sin, so every
    rectangle already in a saved document is bit-identical to before."""
    x, y = val(e.get("x", 0)), val(e.get("y", 0))
    hw, hh = val(e["width"]) / 2, val(e["height"]) / 2
    local = ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))
    a = math.radians(val(e.get("angle", 0)))
    if not a:
        return [(x + lx, y + ly) for lx, ly in local]
    c, s = math.cos(a), math.sin(a)
    return [(x + lx * c - ly * s, y + lx * s + ly * c) for lx, ly in local]


def _expand_pattern(pat, by_id, val):
    """Expand a sketch pattern definition into derived entity dicts. Mirrors
    src/sketch/pattern.ts (expandPattern). Derived ids are "<pat.id>#<n>"."""
    out = []
    counter = [0]

    def did():
        counter[0] += 1
        return f"{pat['id']}#{counter[0] - 1}"

    t = pat["type"]
    # pattern sources skip projected reference geometry (fixed/linked, never
    # replicated) — mirrors the `sources` filter in expandPattern
    def srcs_of(ids):
        return [by_id[s] for s in ids if s in by_id and by_id[s].get("type") != "projected"]

    if t == "patternRect":
        cx, cy = max(1, round(val(pat["countX"]))), max(1, round(val(pat["countY"])))
        sx, sy = val(pat["spacingX"]), val(pat["spacingY"])
        srcs = srcs_of(pat.get("sources", []))
        for i in range(cx):
            for j in range(cy):
                if i == 0 and j == 0:
                    continue
                for s in srcs:
                    out.append(_translate_entity(s, i * sx, j * sy, did(), val))
    elif t == "patternCircular":
        count, total = max(1, round(val(pat["count"]))), val(pat["angle"])
        full = total != 0 and abs(abs(total) - 360) < 1e-6
        step = math.radians(total / count if full else total / max(1, count - 1))
        cx, cy = val(pat["cx"]), val(pat["cy"])
        srcs = srcs_of(pat.get("sources", []))
        for k in range(1, count):
            for s in srcs:
                out.extend(_rotate_entity(s, cx, cy, k * step, did(), val))
    elif t == "boltCircle":
        count = max(1, round(val(pat["count"])))
        r, rad = val(pat["bcd"]) / 2, val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        for k in range(count):
            a = (k / count) * 2 * math.pi
            out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + r * math.cos(a), "y": cy + r * math.sin(a)})
    elif t == "gridHoles":
        cx0, cy0 = max(1, round(val(pat["countX"]))), max(1, round(val(pat["countY"])))
        sx, sy, rad = val(pat["spacingX"]), val(pat["spacingY"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        for i in range(cx0):
            for j in range(cy0):
                out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + (i - (cx0 - 1) / 2) * sx, "y": cy + (j - (cy0 - 1) / 2) * sy})
    elif t == "hexHoles":
        rings = max(0, round(val(pat["rings"])))
        s, rad = val(pat["spacing"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        h = s * math.sqrt(3) / 2
        for q in range(-rings, rings + 1):
            for rr in range(max(-rings, -q - rings), min(rings, -q + rings) + 1):
                out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + s * (q + rr / 2), "y": cy + h * rr})
    elif t == "honeycomb":
        rings = max(0, round(val(pat["rings"])))
        s, R = val(pat["spacing"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        h = s * math.sqrt(3) / 2
        for q in range(-rings, rings + 1):
            for rr in range(max(-rings, -q - rings), min(rings, -q + rings) + 1):
                out.extend(_hexagon_lines(cx + s * (q + rr / 2), cy + h * rr, R, did()))
    return out


def _hexagon_lines(cx, cy, R, eid):
    """A pointy-top regular hexagon as 6 line entity dicts (mirrors pattern.ts)."""
    v = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        v.append((cx + R * math.cos(a), cy + R * math.sin(a)))
    return [
        {"type": "line", "id": f"{eid}.{k}", "x1": v[k][0], "y1": v[k][1], "x2": v[(k + 1) % 6][0], "y2": v[(k + 1) % 6][1]}
        for k in range(6)
    ]


_TEXT_FONT_STYLE = {
    "regular": FontStyle.REGULAR, "bold": FontStyle.BOLD,
    "italic": FontStyle.ITALIC, "bolditalic": FontStyle.BOLDITALIC,
}
_TEXT_HALIGN = {"left": Align.MIN, "center": Align.CENTER, "right": Align.MAX}


def _entity_edges(e, val):
    """The boundary edge(s) of one sketch entity, LOCAL to the sketch's XY frame
    (unlocated — the caller applies `plane *`). The ONE construction path shared
    by _build_sketch and projection sources, so a projected sketch curve is
    byte-for-byte the geometry the source sketch builds. Raises on degenerate
    input (per-feature error handling stays with the caller); returns [] for
    entity kinds with no curve boundary (point/text/unknown)."""
    t = e.get("type")
    if t == "line":
        return [Edge.make_line((val(e["x1"]), val(e["y1"]), 0), (val(e["x2"]), val(e["y2"]), 0))]
    if t == "arc":
        return [Edge.make_three_point_arc(
            (val(e["x1"]), val(e["y1"]), 0),
            (val(e["mx"]), val(e["my"]), 0),  # through-point
            (val(e["x2"]), val(e["y2"]), 0))]
    if t == "circle":
        return [Pos(val(e.get("x", 0)), val(e.get("y", 0))) * Edge.make_circle(val(e["radius"]))]
    if t == "spline":
        pts = [(val(p["x"]), val(p["y"]), 0) for p in e.get("points", [])]
        return [Edge.make_spline(pts)] if len(pts) >= 2 else []
    if t == "rectangle":
        c = _rect_corners(e, val)
        return [Edge.make_line((c[k][0], c[k][1], 0), (c[(k + 1) % 4][0], c[(k + 1) % 4][1], 0))
                for k in range(4)]
    if t == "polygon":
        cx, cy = val(e.get("x", 0)), val(e.get("y", 0))
        r = val(e["radius"])
        n = max(3, int(round(val(e["sides"]))))
        ang = math.radians(val(e.get("angle", 0)))  # stored DEGREES (format v2)
        pts = [
            (cx + math.cos(ang + i / n * 2 * math.pi) * r, cy + math.sin(ang + i / n * 2 * math.pi) * r)
            for i in range(n)
        ]
        return [Edge.make_line((pts[i][0], pts[i][1], 0), (pts[(i + 1) % n][0], pts[(i + 1) % n][1], 0))
                for i in range(n)]
    if t == "slot":
        ax, ay = val(e["x1"]), val(e["y1"])
        bx, by = val(e["x2"]), val(e["y2"])
        w = val(e["width"]) / 2  # half-width = cap radius
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1.0
        dx, dy = dx / L, dy / L
        nx, ny = -dy * w, dx * w  # left perpendicular * radius
        a1, a2 = (ax + nx, ay + ny), (ax - nx, ay - ny)
        b1, b2 = (bx + nx, by + ny), (bx - nx, by - ny)
        a_tip = (ax - dx * w, ay - dy * w)
        b_tip = (bx + dx * w, by + dy * w)
        return [
            Edge.make_line((a1[0], a1[1], 0), (b1[0], b1[1], 0)),
            Edge.make_three_point_arc((b1[0], b1[1], 0), (b_tip[0], b_tip[1], 0), (b2[0], b2[1], 0)),
            Edge.make_line((b2[0], b2[1], 0), (a2[0], a2[1], 0)),
            Edge.make_three_point_arc((a2[0], a2[1], 0), (a_tip[0], a_tip[1], 0), (a1[0], a1[1], 0)),
        ]
    if t == "projected":
        # Projected reference geometry: edges from the CACHED ProjectedCurve —
        # plain numbers authored by the projection recompute, consumed verbatim
        # and never val()'d or resolved here.
        cv = e.get("curve") or {}
        ck = cv.get("kind")
        if ck == "line":
            # Zero-length cached line (a view-aligned projection persisted by
            # an older build): reference-only, like the point-like poly below
            if math.hypot(cv["x2"] - cv["x1"], cv["y2"] - cv["y1"]) <= 1e-9:
                return []
            return [Edge.make_line((cv["x1"], cv["y1"], 0), (cv["x2"], cv["y2"], 0))]
        if ck == "circle":
            return [Pos(cv["x"], cv["y"]) * Edge.make_circle(cv["r"])]
        if ck == "arc":
            return [Edge.make_three_point_arc(
                (cv["x1"], cv["y1"], 0),
                (cv["mx"], cv["my"], 0),  # through-point
                (cv["x2"], cv["y2"], 0))]
        if ck == "poly":
            pts = cv.get("pts") or []
            # A view-aligned source edge projects to a POINT: the degenerate
            # poly fallback ("never an error") arrives with coincident samples.
            # Collapse consecutive duplicates and skip point-like remains —
            # reference-only, like a sketch point — instead of feeding OCCT a
            # zero-length line (StdFail → whole sketch red).
            dedup = [p for i, p in enumerate(pts)
                     if i == 0 or math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9]
            if len(dedup) < 2:
                return []
            return list(Polyline(*[(p[0], p[1], 0) for p in dedup]).edges())
        return []
    return []


def _entity_edge(e, val):
    """One build123d edge for a line/arc/circle/spline entity — used as a text path.
    Returns None for non-curve entities or on any construction failure."""
    if e.get("type") not in ("line", "arc", "circle", "spline"):
        return None
    try:
        eds = _entity_edges(e, val)
    except Exception:
        return None
    return eds[0] if eds else None


def _measure_text_width(s, font_size, font_style, font):
    if not s.strip():
        return 0.0
    try:
        kw = {"font_size": font_size, "font_style": font_style}
        if font:
            kw["font"] = font
        bb = Text(s, **kw).bounding_box()
        return bb.max.X - bb.min.X
    except Exception:
        return 1e9  # measurement failed: don't force a break


def _wrap_text(txt, box_w, font_size, font_style, font):
    """Greedy word-wrap `txt` to lines fitting box_w (mm), preserving explicit newlines —
    build123d's single_line_width does NOT wrap, so we do it by measuring. Capped so a
    huge string can't stall the per-keystroke preview."""
    if box_w <= 0 or len(txt) > 400:
        return txt
    lines = []
    for para in txt.split("\n"):
        line = ""
        for word in para.split(" "):
            cand = f"{line} {word}".strip()
            if line and _measure_text_width(cand, font_size, font_style, font) > box_w:
                lines.append(line)
                line = word
            else:
                line = cand
        lines.append(line)
    return "\n".join(lines)


def _text_faces(e, val, path_edge=None):
    """build123d faces for a `text` sketch entity (2D, on the sketch's local XY),
    anchored at (x, y), rotated, aligned; text-on-path when `path_edge` is set. Shared
    by the solid build and the preview op so glyphs match exactly. Best-effort: returns
    [] on empty/whitespace text or ANY font/glyph failure (one bad font can't fail the
    whole rebuild)."""
    txt = e.get("text") or ""
    if not txt.strip():
        return []
    try:
        kw = {
            "font_size": val(e["height"]),
            "font_style": _TEXT_FONT_STYLE.get(e.get("style", "regular"), FontStyle.REGULAR),
            "align": (_TEXT_HALIGN.get(e.get("align", "left"), Align.MIN), Align.CENTER),
            "rotation": val(e.get("angle", 0) or 0),
        }
        if e.get("font"):
            kw["font"] = e["font"]
        if path_edge is not None:
            kw["path"] = path_edge
            if e.get("positionOnPath") is not None:
                kw["position_on_path"] = val(e["positionOnPath"])
        box_w = e.get("boxWidth")
        if box_w is not None and path_edge is None:
            txt = _wrap_text(txt, val(box_w), kw["font_size"], kw["font_style"], e.get("font"))
        text = Text(txt, **kw)
        # text-on-path is already positioned by the path; a free text is anchored at (x,y)
        located = text if path_edge is not None else Pos(val(e.get("x", 0) or 0), val(e.get("y", 0) or 0)) * text
        return list(located.faces())
    except Exception:
        return []


def _wire_polyline(wire):
    """Sample a glyph-contour wire to a closed 2D polyline [[x,y], ...] in edge order."""
    pts = []
    for ed in wire.edges():
        try:
            n = max(2, min(24, int((ed.length or 1) / 0.3) + 2))
        except Exception:
            n = 8
        for i in range(n):
            p = ed.position_at(i / n)
            pts.append([round(p.X, 4), round(p.Y, 4)])
    if pts:
        pts.append(list(pts[0]))  # close the loop
    return pts


def _num_or(x, default=0.0):
    if isinstance(x, (int, float)):
        return x
    try:
        return float(x)
    except Exception:
        return default


def tessellate_text(entity, path_entity=None):
    """Per-glyph 2D outlines for a text entity: {"faces": [{"outer": [[x,y]...],
    "holes": [[[x,y]...]]}]} in FINAL sketch-2D coords (anchor/rotation/align/path
    applied). Uses _text_faces so the preview matches the extruded solid exactly.
    Stateless/read-only; entity fields are already resolved numbers from the client."""
    def v(x):
        return _num_or(x, 0.0)
    path_edge = _entity_edge(path_entity, v) if path_entity else None
    out = []
    for fc in _text_faces(entity, v, path_edge):
        out.append({
            "outer": _wire_polyline(fc.outer_wire()),
            "holes": [_wire_polyline(w) for w in fc.inner_wires()],
        })
    return {"faces": out}


def list_fonts():
    """Available system font families (OCCT Font_FontMgr, fontconfig-backed). Read-only."""
    try:
        from OCP.Font import Font_FontMgr
        from OCP.TColStd import TColStd_SequenceOfHAsciiString

        mgr = Font_FontMgr.GetInstance_s()
        seq = TColStd_SequenceOfHAsciiString()
        mgr.GetAvailableFontsNames(seq)
        return {"families": sorted({seq.Value(i).ToCString() for i in range(1, seq.Length() + 1)})}
    except Exception:
        return {"families": []}


def _build_sketch(f, val, datums=None, plane=None):
    """Build a 2D sketch and locate it onto its plane (algebra mode).

    Returns {"sketch": union, "faces": [located per-loop faces]}. The union is the
    whole profile (revolve/loft/whole-extrude); `faces` keeps each closed loop as
    its own located Face so region selection can recover nested profiles (a ring,
    an inner disk) that the union collapses.

    Primitives (rectangle/circle) become faces directly. Free-form `line`
    segments are assembled into closed wires and turned into faces, so an
    interactively-drawn polyline profile can be extruded like in mainstream MCAD.
    """
    # `plane` is the face-anchored placement the handler resolved, when there is
    # one. Without it the sketch falls back to its own reference, which is a datum
    # id or the cached spec.
    plane = _plane_of(plane or _sketch_plane_ref(f), datums)
    faces = []
    edges = []  # free-form line + arc edges, assembled into faces below
    all_edges = []  # EVERY entity's boundary as local edges, for planar subdivision

    # Associative patterns: expand each definition into its derived entities and
    # append them, so a patterned hole/array builds like hand-drawn geometry. The
    # math mirrors src/sketch/pattern.ts so frontend preview and build agree.
    entities = list(f.get("entities", []))
    if f.get("patterns"):
        by_id = {e["id"]: e for e in entities if e.get("id")}
        for pat in f["patterns"]:
            entities.extend(_expand_pattern(pat, by_id, val))
    by_id_all = {e["id"]: e for e in entities if e.get("id")}  # text pathRef lookup
    text_local = []  # glyph faces (2D local); integrated into faces + located_faces below

    for e in entities:
        if e.get("construction"):
            continue  # construction geometry is reference-only, not a profile
        et = e["type"]
        # Degenerate primitives must be caught HERE, by name. A zero-radius circle
        # is a point, not a wire, so build123d's make_face fails its coplanarity
        # probe and reports "Cannot build face(s): wires not planar" — a message
        # that sends the user hunting for a tilted sketch that does not exist.
        # This was a real field bug (docs/EDGE-CASES.md §1): a ring whose inner
        # circle had collapsed to r=0.
        if et == "circle" and not (val(e["radius"]) > 0):
            raise ValueError(
                f"a circle in this sketch has a radius of {val(e['radius']):g} — "
                "give it a radius greater than 0, or delete it"
            )
        if et == "rectangle" and not (val(e["width"]) > 0 and val(e["height"]) > 0):
            raise ValueError(
                "a rectangle in this sketch has a zero width or height — "
                "give it a size, or delete it"
            )
        if et == "rectangle":
            faces.append(
                Pos(val(e.get("x", 0)), val(e.get("y", 0)))
                * Rot(0, 0, val(e.get("angle", 0)))
                * Rectangle(val(e["width"]), val(e["height"]))
            )
            all_edges.extend(_entity_edges(e, val))
        elif et == "circle":
            faces.append(Pos(val(e.get("x", 0)), val(e.get("y", 0))) * Circle(val(e["radius"])))
            all_edges.extend(_entity_edges(e, val))
        elif et in ("line", "arc", "spline", "polygon", "slot"):
            # free-form curves + parametric outlines: boundary edges join the
            # loop assembly AND the planar arrangement (one construction path —
            # _entity_edges — shared with sketch-curve projection sources)
            for ed in _entity_edges(e, val):
                edges.append(ed)
                all_edges.append(ed)
        elif et == "point":
            continue  # a sketch point is reference/snap-only, never part of a profile
        elif et == "projected":
            # Projected reference geometry: edges come from the CACHED curve via
            # _entity_edges (plain numbers, never resolved here — _build_sketch
            # stays geometry-free; the checkpoint sketch-replay invariant
            # depends on it). A cached circle also contributes its FACE,
            # mirroring the native circle branch; degenerate curves (zero-length
            # line, point-like poly) yield no edges: reference-only.
            if (e.get("curve") or {}).get("kind") == "circle":
                cv = e["curve"]
                faces.append(Pos(cv["x"], cv["y"]) * Circle(cv["r"]))
                all_edges.extend(_entity_edges(e, val))
            else:
                for ed in _entity_edges(e, val):
                    edges.append(ed)
                    all_edges.append(ed)
        elif et == "text":
            ref = e.get("pathRef")
            path_edge = _entity_edge(by_id_all[ref], val) if ref and ref in by_id_all else None
            # glyph CONTOURS deliberately never enter all_edges — feeding them to
            # _subdivide_faces' splitter would fragment overlapping profiles + explode cost
            text_local.extend(_text_faces(e, val, path_edge))

    if edges:
        faces.extend(_faces_from_edges(edges))
    faces.extend(text_local)  # glyph faces union into the whole-sketch profile (extrude)

    # the located open/closed path wire from the free edges (for sweep paths)
    path_wire = _path_wire(edges, plane)

    # Region-pick faces = the planar ARRANGEMENT of every sketch edge: a line
    # crossing a profile carves it into separately-selectable sub-areas (mainstream MCAD
    # parity), and touching/overlapping loops split at the shared boundaries. This
    # mirrors the frontend arrangement (src/sketch/region.ts).
    located_faces = _subdivide_faces(all_edges, plane)
    for tf in text_local:  # each glyph is separately region-selectable in mixed geometry
        located_faces.extend((plane * tf).faces())

    if faces:
        # Union the loop faces into the whole-sketch profile in ONE OCCT boolean
        # (build123d's multi-arg fuse) rather than N sequential pairwise fuses: the
        # old `sk = sk + fc` loop was O(N^2) and cost SECONDS on a honeycomb of a few
        # hundred cells. The batch fuse is ~70x faster and yields the identical union
        # (verified: same area, same extrude+cut volume/face count). This one stays
        # on build123d's PARALLEL path deliberately: it fuses planar FACES, not the
        # many-small-disjoint-SOLID class where _serial_bool's serial win applies.
        sk = faces[0].fuse(*faces[1:]) if len(faces) > 1 else faces[0]
        # Disjoint loops (e.g. a honeycomb of many hexagons) make `sk` a ShapeList,
        # which `plane * sk` rejects — normalize to one Compound first.
        if _wrapped_or_none(sk) is None:
            sk = Compound(list(sk))
        sk = plane * sk  # locate the 2D sketch onto its plane
        if not located_faces:  # fall back to per-loop faces (degenerate arrangement)
            for fc in faces:
                for face in (plane * fc).faces():
                    located_faces.append(face)
    elif located_faces:
        # Crossing-only sketch (e.g. an "X", or free lines that only close by
        # crossing): no clean per-loop face, but the arrangement recovers the
        # profile. Union the located cells for the whole-sketch (revolve/loft/whole
        # extrude) target.
        sk = located_faces[0].fuse(*located_faces[1:]) if len(located_faces) > 1 else located_faces[0]
        if _wrapped_or_none(sk) is None:
            sk = Compound(list(sk))
    else:
        return {"sketch": None, "faces": [], "wire": path_wire, "plane": plane}

    # `plane` rides along for _region_cells: a consuming feature has to cut these
    # cells where the model under them ends, and needs to know which plane that
    # model has to lie in.
    return {"sketch": sk, "faces": located_faces, "wire": path_wire, "plane": plane}


def _path_wire(edges, plane):
    """Combine a sketch's free line/arc/spline edges into ONE located wire (open or
    closed) for use as a sweep path. Picks the longest wire if the edges form
    several; returns None when there are no free edges."""
    if not edges:
        return None
    try:
        wires = Wire.combine(edges)
    except Exception:
        return None
    if not wires:
        return None
    longest = max(wires, key=lambda w: w.length)
    return plane * longest


def _region_cells(entry, ctx):
    """The (face, bbox) pairs a saved region point picks from, cut where the model
    under the sketch ends.

    A sketch drawn on a face routinely runs off it, and the two halves are
    separate areas on screen — the part with material behind it can cut into the
    body or add flush to it, the overhanging part has nothing behind it and can
    only add. `_build_sketch` cannot know that: it sees the sketch alone. So a
    feature naming the overhang by its interior point resolved it to the whole
    profile, and joined or cut the half the user had deliberately not selected.
    See face_footprint.py, and src/sketch/faceFootprint.ts for the same rule on
    the frontend, which is where those areas come from in the first place.

    The bboxes are precomputed once here because region picking runs per selected
    point (see _region_face_at) — and the split runs once for the same reason.
    """
    faces = entry.get("faces") or []
    plane = entry.get("plane")
    shapes = [b["shape"] for b in ctx.bodies if b.get("shape") is not None]
    if plane is not None and shapes and faces:
        progress_tick()
        model = shapes[0] if len(shapes) == 1 else Compound(list(shapes))
        faces = split_profile_cells(
            faces, plane.origin, plane.z_dir, shapes, _bbox_diag(model), tick=progress_tick
        )
    return [(fc, fc.bounding_box()) for fc in faces]


def _region_target(pts, entry, ctx):
    """The profile a feature's selected areas add up to, or None when it selected
    none (the caller then falls back to the whole sketch).

    A ring keeps its hole and several areas union, which is why this combines
    faces rather than handing back a list.
    """
    if not pts:
        return None
    cells = _region_cells(entry, ctx)
    sel = []
    for p in pts:
        rf = _region_face_at(cells, Vector(*p))
        if rf is not None:
            sel.append(rf)
    if not sel:
        raise ValueError("no profile found under the selected area")
    target = sel[0]
    for s in sel[1:]:
        target = target + s
    return target


def _region_face_at(cells, P):
    """Pick the planar arrangement cell whose material contains point P.

    `cells` is a list of (face, bounding_box) pairs — the caller precomputes the
    bboxes ONCE because region picking runs per selected point, and OCCT `is_inside`
    is far too slow to call on every face (38 honeycomb points × 160 cells of
    is_inside + a per-nested-face boolean was ~2.8 s). A bbox pre-filter cuts the
    point-in-face tests down to the 1-2 cells whose box actually contains P.

    Arrangement cells (from `_subdivide_faces`) already carry their holes natively, so
    the smallest containing cell IS the region — no nested-hole subtraction needed.
    Falls back to the nearest cell by center when P isn't inside any (tessellation
    drift / degenerate geometry)."""
    if not cells:
        return None
    best = None
    for fc, bb in cells:
        if not (bb.min.X - 1e-6 <= P.X <= bb.max.X + 1e-6
                and bb.min.Y - 1e-6 <= P.Y <= bb.max.Y + 1e-6
                and bb.min.Z - 1e-6 <= P.Z <= bb.max.Z + 1e-6):
            continue
        if _face_contains(fc, P) and (best is None or fc.area < best.area):
            best = fc
    if best is not None:
        return best
    return min((fc for fc, _ in cells), key=lambda fc: (fc.center() - P).length)


def _face_contains(face, p):
    try:
        return bool(face.is_inside(p))
    except Exception:
        return False


def _subdivide_faces(edges, plane):
    """Planar arrangement of all sketch edges into minimal faces, located onto the
    sketch plane. This is what lets a curve CROSSING a profile carve it into
    separately-selectable sub-areas (MCAD parity), and touching/overlapping loops
    split at their shared boundaries.

    Uses OCCT's 2D face splitter: split a padded cover face by every sketch edge,
    then keep only the ENCLOSED cells (those not touching the cover boundary). Real
    curved edges are preserved (smooth extrude) and faces with holes come out
    natively, so `_region_face_at` needs no change. Mirrors the frontend arrangement
    in src/sketch/region.ts (planarize + traceLoops). Returns [] on empty/failure so
    the caller falls back to per-loop faces — this is a 2D edge split, unlike the
    reverted 3D UnifySameDomain, and stays well under ~30 ms even for dense grids."""
    if not edges:
        return []
    try:
        from OCP.BOPAlgo import BOPAlgo_Splitter
        from OCP.TopoDS import TopoDS
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopTools import TopTools_ListOfShape

        xs, ys = [], []
        for e in edges:
            bb = e.bounding_box()
            xs += [bb.min.X, bb.max.X]
            ys += [bb.min.Y, bb.max.Y]
        spanx, spany = max(xs) - min(xs), max(ys) - min(ys)
        pad = (spanx + spany) * 0.1 + 1.0
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        w, h = spanx + 2 * pad, spany + 2 * pad
        cover = Pos(cx, cy) * Rectangle(w, h)

        sp = BOPAlgo_Splitter()
        args = TopTools_ListOfShape()
        args.Append(cover.wrapped)
        tools = TopTools_ListOfShape()
        for e in edges:
            tools.Append(e.wrapped)
        sp.SetArguments(args)
        sp.SetTools(tools)
        sp.Perform()
        res = sp.Shape()

        bx0, bx1 = cx - w / 2, cx + w / 2
        by0, by1 = cy - h / 2, cy + h / 2

        def on_cover(face):
            for vtx in face.vertices():
                if (abs(vtx.X - bx0) < 1e-6 or abs(vtx.X - bx1) < 1e-6
                        or abs(vtx.Y - by0) < 1e-6 or abs(vtx.Y - by1) < 1e-6):
                    return True
            return False

        cells = []
        exp = TopExp_Explorer(res, TopAbs_FACE)
        while exp.More():
            fc = Face(TopoDS.Face_s(exp.Current()))
            if not on_cover(fc):  # drop the cover's own exterior cells
                for face in (plane * fc).faces():
                    cells.append(face)
            exp.Next()
        return cells
    except Exception:
        return []


def _faces_from_edges(edges):
    """Assemble line/arc edges into faces from their closed loops.

    The faces come back facing +Z, which is the sketch plane's own normal in the
    2D local space every caller works in. A face inherits its orientation from
    the direction its wire happens to run, and a loop wound clockwise therefore
    produces a face pointing the other way — which an extrude then follows,
    pushing the profile out of the BACK of the plane it was drawn on. Every
    primitive is wound anticlockwise by construction, so this only ever bit the
    free-form branch: a hand-drawn polyline traced clockwise, and a `slot`,
    whose edges are emitted right-side-first and so are clockwise EVERY time.
    That is why a slot on a base plane looked fine and the same slot on a face
    cut nothing — the wrong direction still reaches a body centred on the
    origin."""
    if not edges:
        return []
    try:
        wires = Wire.combine(edges)
    except Exception:
        return []

    out = []
    for w in wires:
        closed = w.is_closed
        if callable(closed):
            closed = closed()
        if not closed:
            continue
        face = _face_from_wire(w)
        if face is not None:
            out.append(_facing_up(face))
    return out


def _facing_up(face):
    """`face` if it already points along +Z, otherwise the same face reversed."""
    from OCP.TopoDS import TopoDS

    try:
        if face.normal_at().Z >= 0:
            return face
        return Face(TopoDS.Face_s(face.wrapped.Reversed()))
    except Exception:
        return face  # a surface with no normal to read stays as it is


def _face_from_wire(w):
    """Make a Face from a closed wire, across build123d API variants."""
    try:
        return Face(w)
    except Exception:
        pass
    try:
        return Face.make_from_wires(w)
    except Exception:
        return None


# --- projection (Project/Include geometry) -----------------------------------
# Math + the projectGeometry aux-op behind the Fusion-style Project command:
# turn a 3D edge (a body edge, a face-boundary edge, a located sketch curve)
# into a 2D ProjectedCurve on a target sketch plane. The REBUILD never calls
# this from _build_sketch — projected entities carry a cached curve, and
# refreshing that cache is a rebuild-handler concern (see the plan). Numbers
# are rounded to 6 decimals HERE so the persisted document is byte-stable.

# sampled-poly density: one sample per 0.5 mm of edge length, clamped
_POLY_MIN_SEGS, _POLY_MAX_SEGS, _POLY_MM_PER_SEG = 16, 128, 0.5
