"""The Hole feature: holes drilled into a flat face along its normal.

Each hole is one revolved profile (bore, counterbore step, countersink cone,
insert lead-in, drill point), placed at its position and cut from the body in a
single boolean. The standard size tables mirror src/features/holeStandards.ts;
tests/test_hole_feature.py and tests/features/holeStandards.test.ts pin both.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from build123d import Axis, Face, GeomType, Plane, Vector, Wire, revolve

from errors import BAD_REQUEST, REFERENCE_NOT_FOUND, GeomError
from geom_select import _face_normal, resolve_faces
from shape_util import _as_compound

SIZES = ("M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10")

# ISO 273 clearance holes: close, normal, loose.
CLEARANCE = {
    "M2": (2.2, 2.4, 2.6),
    "M2.5": (2.7, 2.9, 3.1),
    "M3": (3.2, 3.4, 3.6),
    "M4": (4.3, 4.5, 4.8),
    "M5": (5.3, 5.5, 5.8),
    "M6": (6.4, 6.6, 7.0),
    "M8": (8.4, 9.0, 10.0),
    "M10": (10.5, 11.0, 12.0),
}

# Tap drill for the coarse pitch.
TAP_DRILL = {
    "M2": 1.6, "M2.5": 2.05, "M3": 2.5, "M4": 3.3,
    "M5": 4.2, "M6": 5.0, "M8": 6.8, "M10": 8.5,
}

# ISO 4762 socket head cap screw: counterbore diameter and depth.
COUNTERBORE = {
    "M2": (4.4, 2.4),
    "M2.5": (5.5, 2.9),
    "M3": (6.5, 3.4),
    "M4": (8.0, 4.4),
    "M5": (10.0, 5.4),
    "M6": (11.0, 6.4),
    "M8": (15.0, 8.6),
    "M10": (18.0, 10.6),
}

# ISO 10642 90 degree countersunk head: countersink diameter at the face.
COUNTERSINK = {
    "M2": 4.4, "M2.5": 5.5, "M3": 6.9, "M4": 9.2,
    "M5": 11.5, "M6": 13.7, "M8": 18.3, "M10": 22.7,
}

# Brass heat-set inserts: bore diameter and depth.
INSERT = {
    "M2": (3.2, 4.0),
    "M2.5": (3.6, 5.0),
    "M3": (4.0, 6.0),
    "M4": (5.6, 9.0),
    "M5": (6.4, 10.0),
}

FITS = ("close", "normal", "loose")
HOLE_TYPES = ("simple", "counterbore", "countersink", "insert")
DRILL_POINT_DEG = 118.0
INSERT_LEAD_IN = 0.5


def standard_dims(hole_type, standard, size, fit):
    """The dimensions a hole type and size default to, keyed like the feature's
    own fields. Only the keys the standard defines are present."""
    out = {}
    if hole_type == "insert":
        if size in INSERT:
            out["diameter"], out["depth"] = INSERT[size]
        out["leadIn"] = INSERT_LEAD_IN
        return out
    if standard == "tap" and size in TAP_DRILL:
        out["diameter"] = TAP_DRILL[size]
    elif standard in (None, "clearance") and size in CLEARANCE:
        i = FITS.index(fit) if fit in FITS else 1
        out["diameter"] = CLEARANCE[size][i]
    if hole_type == "counterbore" and size in COUNTERBORE:
        out["cbDiameter"], out["cbDepth"] = COUNTERBORE[size]
    if hole_type == "countersink" and size in COUNTERSINK:
        out["csDiameter"] = COUNTERSINK[size]
        out["csAngle"] = 90.0
    return out


def _dims(f, val):
    hole_type = f.get("holeType") or "simple"
    if hole_type not in HOLE_TYPES:
        raise GeomError(f"Hole: unknown hole type {hole_type!r}", BAD_REQUEST)
    size = f.get("size")
    if size is not None and size not in SIZES:
        raise GeomError(f"Hole: unknown size {size!r}, expected one of {', '.join(SIZES)}",
                        BAD_REQUEST)
    std = standard_dims(hole_type, f.get("standard"), size, f.get("fit"))

    def num(key):
        v = f.get(key)
        if v is None:
            v = std.get(key)
        return None if v is None else float(val(v))

    d = num("diameter")
    if d is None:
        what = "heat-set insert preset" if hole_type == "insert" else "standard size"
        raise GeomError(f"Hole: give a diameter or a {what}", BAD_REQUEST)
    if not d > 0:
        raise GeomError(f"Hole: diameter must be greater than 0 (got {d:g})", BAD_REQUEST)
    through = f.get("extent") == "through" and hole_type != "insert"
    depth = None if through else num("depth")
    if not through:
        if depth is None:
            depth = 2 * d
        if not depth > 0:
            raise GeomError(f"Hole: depth must be greater than 0 (got {depth:g})", BAD_REQUEST)
    dims = {"type": hole_type, "r": d / 2, "depth": depth,
            "drillPoint": bool(f.get("drillPoint")) and not through}
    if hole_type == "counterbore":
        cbd, cbh = num("cbDiameter"), num("cbDepth")
        if cbd is None or cbh is None:
            raise GeomError("Hole: a counterbore needs a counterbore diameter and depth, "
                            "or a standard size", BAD_REQUEST)
        if not cbd > d:
            raise GeomError(f"Hole: the counterbore diameter ({cbd:g}) must be larger "
                            f"than the hole ({d:g})", BAD_REQUEST)
        if not cbh > 0 or (depth is not None and cbh >= depth):
            raise GeomError(f"Hole: the counterbore depth ({cbh:g}) must be greater than 0 "
                            "and less than the hole depth", BAD_REQUEST)
        dims.update(cbR=cbd / 2, cbDepth=cbh)
    elif hole_type == "countersink":
        csd, ang = num("csDiameter"), num("csAngle")
        ang = 90.0 if ang is None else ang
        if csd is None:
            raise GeomError("Hole: a countersink needs a countersink diameter, "
                            "or a standard size", BAD_REQUEST)
        if not csd > d:
            raise GeomError(f"Hole: the countersink diameter ({csd:g}) must be larger "
                            f"than the hole ({d:g})", BAD_REQUEST)
        if not 0 < ang < 180:
            raise GeomError(f"Hole: the countersink angle must be between 0 and 180 "
                            f"degrees (got {ang:g})", BAD_REQUEST)
        sink = (csd - d) / 2 / math.tan(math.radians(ang / 2))
        if depth is not None and sink >= depth:
            raise GeomError("Hole: the countersink is deeper than the hole", BAD_REQUEST)
        dims.update(csR=csd / 2, csDepth=sink)
    elif hole_type == "insert":
        lead = num("leadIn") or 0.0
        if lead < 0:
            raise GeomError(f"Hole: the lead-in must not be negative (got {lead:g})", BAD_REQUEST)
        if depth is not None and lead >= depth:
            raise GeomError("Hole: the lead-in is deeper than the hole", BAD_REQUEST)
        dims["leadIn"] = lead
    return dims


def _profile(dims, lift, through_depth):
    """(radius, z) corners of the half section, z = 0 on the face and negative
    into the material. `lift` runs the mouth a little proud of the face so the
    cut never shares a surface with it."""
    r = dims["r"]
    depth = dims["depth"] if dims["depth"] is not None else through_depth
    t = dims["type"]
    pts = [(0.0, lift)]
    if t == "counterbore":
        pts += [(dims["cbR"], lift), (dims["cbR"], -dims["cbDepth"]), (r, -dims["cbDepth"])]
    elif t == "countersink":
        pts += [(dims["csR"], lift), (dims["csR"], 0.0), (r, -dims["csDepth"])]
    elif t == "insert" and dims["leadIn"] > 0:
        lead = dims["leadIn"]
        pts += [(r + lead, lift), (r + lead, 0.0), (r, -lead)]
    else:
        pts.append((r, lift))
    pts.append((r, -depth))
    if dims["drillPoint"]:
        pts.append((0.0, -depth - r / math.tan(math.radians(DRILL_POINT_DEG / 2))))
    else:
        pts.append((0.0, -depth))
    return pts


def _tool_solid(dims, lift, through_depth):
    pts = [Vector(x, 0, z) for x, z in _profile(dims, lift, through_depth)]
    return revolve(Face(Wire.make_polygon(pts, close=True)), Axis.Z, 360)


def _pick_body(f, ctx, sel, point):
    bid = f.get("body") or (sel.get("body") if isinstance(sel, dict) else None)
    if bid:
        body = ctx.find_body(bid)
        if body is None or body.get("shape") is None:
            raise GeomError("Hole: the target body no longer exists", REFERENCE_NOT_FOUND)
        return body
    live = [b for b in ctx.bodies if b.get("shape") is not None]
    if not live:
        raise GeomError("Hole needs an existing body", BAD_REQUEST)
    if point is None:
        return live[-1]
    p = Vector(*point)
    return min(live, key=lambda b: b["shape"].distance_to(p))


def _sketch_points(f, ctx):
    sid = f.get("sketch")
    if not sid:
        return None, []
    entry = ctx.sketches.get(sid)
    if entry is None:
        raise GeomError(f"Hole: the sketch it takes positions from ({sid}) did not build, "
                        "fix that sketch first", REFERENCE_NOT_FOUND)
    return entry.get("plane"), list(entry.get("points") or [])


def handle_hole(f, ctx):
    val = ctx.val
    dims = _dims(f, val)
    sel = f.get("face")
    sk_plane, sk_points = _sketch_points(f, ctx)
    points = []
    for p in f.get("points") or []:
        if not (isinstance(p, (list, tuple)) and len(p) == 3):
            raise GeomError(f"Hole: a position must be [x, y, z] (got {p!r})", BAD_REQUEST)
        points.append(Vector(*(float(val(c)) for c in p)))
    points += sk_points
    if not points:
        raise GeomError("Hole: no positions, click the face or name a sketch with points",
                        BAD_REQUEST)

    if sel:
        if not isinstance(sel, dict):
            raise GeomError("Hole: `face` must be one face selector", BAD_REQUEST)
        anchor = sel.get("point") if sel.get("by") == "nearest" else None
        body = _pick_body(f, ctx, sel, anchor)
        try:
            faces = resolve_faces(body["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        except (KeyError, TypeError, AttributeError) as ex:
            raise GeomError(f"Hole: the face selector is malformed ({ex})", BAD_REQUEST)
        if not faces:
            raise GeomError("Hole: the face to drill is no longer in the model", REFERENCE_NOT_FOUND)
        face = faces[0]
        if face.geom_type != GeomType.PLANE:
            raise GeomError("Hole: the face must be flat, a hole is drilled along a flat "
                            "face's normal", BAD_REQUEST)
        origin = face.center()
        normal = _face_normal(face)
    elif sk_plane is not None:
        body = _pick_body(f, ctx, None, tuple(points[0]))
        origin, normal = sk_plane.origin, sk_plane.z_dir
    else:
        raise GeomError("Hole: pick a flat face to drill into", BAD_REQUEST)
    if normal.length < 1e-9:
        raise GeomError("Hole: the face has no usable normal", BAD_REQUEST)
    normal = normal.normalized()
    if f.get("flip"):
        normal = -normal

    shape = body["shape"]
    bb = shape.bounding_box()
    diag = (bb.max - bb.min).length
    lift = max(0.01, 1e-3 * diag)
    x_dir = normal.cross(Vector(0, 0, 1) if abs(normal.Z) < 0.9 else Vector(1, 0, 0)).normalized()

    tools = []
    for p in points:
        on_plane = p - normal * (p - origin).dot(normal)
        # Through all reaches past the far side of the body from wherever the face is.
        through_depth = abs((on_plane - bb.center()).dot(normal)) + diag + 1.0
        solid = _tool_solid(dims, lift, through_depth)
        tools.append(Plane(origin=on_plane, x_dir=x_dir, z_dir=normal) * solid)

    before = shape.volume
    cut = shape.cut(*tools)
    if not _as_compound(cut).solids():
        raise GeomError("Hole: the holes removed the whole body", BAD_REQUEST)
    body["shape"] = cut
    if abs(before - cut.volume) < 1e-9 and ctx.diagnostics is not None:
        ctx.diagnostics.append({
            "feature_id": f.get("id"), "kind": "hole", "resolved": 0, "confidence": 0.0,
            "lossy": False, "reason": "the holes miss the body, nothing was cut",
        })
