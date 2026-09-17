"""One fastener solid from a spec. Conventions for where it sits are in scr_shapes.py.

A simplified thread is a plain cylinder at the NOMINAL (major) diameter, for screws and for the
bores of nuts and inserts alike, so a screw in its nut shows no interference and a clearance hole
checked against it is checked against the real outside of the thread. A modelled thread cuts the
helix into that cylinder; a modelled internal thread bores at the minor diameter and cuts outward.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see sidecar/font_guard.py
from build123d import Edge, Vector

import scr_shapes as S
import scr_thread as T
from scr_spec import checked


def _single_solid(shape, name):
    solids = shape.solids()
    if len(solids) != 1:
        raise ValueError(f"Fastener: {name} came out as {len(solids)} pieces instead of one solid")
    return solids[0]


def _screw(spec):
    head, drive, thread, point = spec["head"], spec["drive"], spec["thread"], spec["point"]
    d, pitch, L = thread["diameter"], thread["pitch"], spec["length"]
    shoulder = spec.get("shoulder")
    r = d / 2
    htype = head["type"]
    modelled = thread["modelled"]

    body_r = shoulder["diameter"] / 2 if shoulder else r
    z_end = -(L + thread["length"]) if shoulder else -L
    z_neck = -L if shoulder else (-head["height"] if htype == "countersunk" else 0.0)
    tip = S.point_outline(point, r, z_end, pitch, -z_end)

    if modelled:
        thread_top = -L if shoulder else min(z_end + thread["length"], z_neck)
        if thread_top < z_neck - 1e-9:
            tail = [(body_r, thread_top), (0.0, thread_top)]
        else:
            tail = [(body_r, z_neck), (0.0, z_neck)] if shoulder else [(0.0, z_neck)]
    else:
        thread_top = None
        tail = [(body_r, -L), (r, -L), *tip] if shoulder else tip
    open_neck = len(tail) == 1

    outline, z_top = S.head_outline(head, body_r)
    curved = S.curved_head(head, body_r)
    if curved is not None:
        pts = [(body_r, 0.0), *tail]
        edges = list(curved)
        for a, b in zip(pts, pts[1:]):
            edges.append(Edge.make_line(Vector(a[0], 0, a[1]), Vector(b[0], 0, b[1])))
        edges.append(Edge.make_line(Vector(0, 0, tail[-1][1]), Vector(0, 0, head["height"])))
        body = S.revolve_edges(edges)
        z_top = head["height"]
    elif htype == "none":
        top = _set_screw_top(r, pitch)
        body = None if (modelled and open_neck) else S.revolve_rz(top + tail) if not modelled else S.revolve_rz([(0.0, 0.0), (r, 0.0), *tail])
    elif outline is not None:
        body = S.revolve_rz([*outline, *tail])
    else:
        z_top = head["height"]
        if htype == "hexFlange":
            c = head["flangeThickness"]
            rf = head["flangeDiameter"] / 2
            shank = S.revolve_rz([(0.0, c), (rf, c), (rf, 0.0), (body_r, 0.0), *tail])
            body = S.fuse(shank, S.chamfered_hex(head["acrossFlats"], c, head["height"]))
        elif htype == "hex":
            hexhead = S.chamfered_hex(head["acrossFlats"], 0.0, head["height"])
            body = hexhead if open_neck else S.fuse(S.revolve_rz([(0.0, 0.0), (body_r, 0.0), *tail]), hexhead)
        elif htype == "knurled":
            rc, kc = head["collarDiameter"] / 2, head["collarHeight"]
            R, k = head["diameter"] / 2, head["height"]
            teeth = max(18, int(round(math.pi * 2 * R / max(0.8, R * 0.2))))
            knurl = S.prism(S.star(R, R * 0.93, teeth), kc, k - kc)
            body = S.fuse(S.revolve_rz([(0.0, kc), (rc, kc), (rc, 0.0), (body_r, 0.0), *tail]), knurl)
        else:
            raise ValueError(f"Fastener: unknown head type {htype!r}")

    tool = S.drive_tool(drive, z_top, head.get("acrossFlats") or head.get("diameter") or d)
    if tool is not None and body is not None and htype != "none":
        body = S.cut(body, tool)

    if modelled:
        seg = T.cut_external(S.cylinder(r, z_end, thread_top), d, pitch, z_end, thread_top,
                             left=thread["hand"] == "left")
        body = seg if body is None else S.fuse(body, seg)
        body = S.cut(body, S.revolve_rz([(r + pitch, tip[0][1]), *tip, (0.0, z_end - pitch), (r + pitch, z_end - pitch)]))
        if htype == "none":
            (_, _), (rc, _), (_, zc) = _set_screw_top(r, pitch)
            body = S.cut(body, S.revolve_rz([(rc, 0.0), (r, zc), (r + pitch, zc), (r + pitch, pitch), (rc, pitch)]))
            if tool is not None:
                body = S.cut(body, tool)
    elif htype == "none" and tool is not None:
        body = S.cut(body, tool)
    return _single_solid(body, spec["name"])


def _set_screw_top(r, pitch):
    c = min(pitch * 0.6134 * 0.8, r * 0.3)
    return [(0.0, 0.0), (r - c, 0.0), (r, -c)]


def _bore(body, spec, z0, z1):
    thread = spec["thread"]
    d, pitch = thread["diameter"], thread["pitch"]
    if thread["modelled"]:
        body = S.cut(body, S.cylinder(T.minor_radius(d, pitch), z0 - 1, z1 + 1))
        return T.cut_internal(body, d, pitch, z0, z1, left=thread["hand"] == "left")
    return S.cut(body, S.cylinder(d / 2, z0 - 1, z1 + 1))


def _nut(spec):
    nut = spec["nut"]
    t, s, h = nut["type"], nut["acrossFlats"], nut["height"]
    if t == "hex":
        body = S.chamfered_hex(s, 0.0, h, top=True, bottom=True)
    elif t == "square":
        body = S.prism(S.square(s), 0.0, h)
    elif t == "nyloc":
        hh = nut["hexHeight"]
        rc = s / 2 * 0.92
        cc = min((h - hh) * 0.4, rc * 0.2)
        collar = S.revolve_rz([(0.0, hh), (rc, hh), (rc, h - cc), (rc - cc, h), (0.0, h)])
        body = S.fuse(S.chamfered_hex(s, 0.0, hh, top=False, bottom=True), collar)
    elif t == "flange":
        c, rf = nut["flangeThickness"], nut["flangeDiameter"] / 2
        body = S.fuse(S.cylinder(rf, 0.0, c), S.chamfered_hex(s, c, h, top=True, bottom=False))
    else:
        raise ValueError(f"Fastener: unknown nut type {t!r}")
    return _single_solid(_bore(body, spec, 0.0, h), spec["name"])


def _washer(spec):
    w = spec["washer"]
    ri, ro, th = w["inner"] / 2, w["outer"] / 2, w["thickness"]
    body = S.revolve_rz([(ri, 0.0), (ro, 0.0), (ro, th), (ri, th)])
    if w["type"] == "spring":
        gap = max(th * 0.8, (ro - ri) * 0.3)
        body = S.cut(body, S.box(ri * 0.5, ro + 1, -gap / 2, gap / 2, -1, th + 1))
    return _single_solid(body, spec["name"])


def _insert(spec):
    ins = spec["insert"]
    R, length = ins["outer"] / 2, ins["length"]
    depth = max(0.08, R * 0.08)
    inner = R - depth
    lead = min(length * 0.2, R * 0.6)
    band = (length - lead) * 0.42
    teeth = max(12, int(round(2 * math.pi * R / max(0.5, R * 0.35))))
    core = S.cylinder(inner, -length, 0.0)
    lower = S.prism(S.star(R, inner, teeth), -length + lead, band)
    upper = S.prism(S.star(R, inner, teeth), -band, band)
    body = S.fuse(core, lower, upper)
    return _single_solid(_bore(body, spec, -length, 0.0), spec["name"])


BUILDERS = {"screw": _screw, "shoulderScrew": _screw, "nut": _nut, "washer": _washer, "insert": _insert}


def build(params):
    spec = checked(params)
    return BUILDERS[spec["kind"]](spec)
