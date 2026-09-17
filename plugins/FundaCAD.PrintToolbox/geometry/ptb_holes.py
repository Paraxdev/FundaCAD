"""Teardrop and roof bridge: reshape the top of a sideways hole so it prints without supports.

Both cut a prism along the hole's axis whose cross section lies above the hole's centre, measured
toward the build direction projected perpendicular to the axis. Everything below the centre is
already the hole's own air, which is why the section may start at the centre line.
"""

import math

import ptb_occ as g
from ptb_read import end_is_open, holes_from_faces, picked_faces
from shape_util import _wrap_topods

# A hole within this angle of the build direction prints round on its own.
_ALONG_BUILD_DEG = 1.0


def roof_frame(hole, bdir, label):
    """(up, side) unit vectors in the hole's cross section, `up` pointing toward the build direction."""
    a = hole["axis"]
    up = g.sub(bdir, g.mul(a, g.dot(bdir, a)))
    if g.norm(up) < math.sin(math.radians(_ALONG_BUILD_DEG)):
        raise ValueError(
            f"{label}: this hole runs along the build direction, so it already prints round. "
            "Pick a hole that lies across the build direction."
        )
    up = g.unit(up)
    return up, g.cross(a, up)


def swept_span(shape, hole):
    """(start, length) along the axis, reaching a little past each end that opens into air.

    The overshoot keeps the cut from ending exactly on the part's outer face, and a blind end is
    left exact so the cut never reaches past the hole's floor into material.
    """
    r = hole["radius"]
    probe = max(0.01, 0.05 * r)
    over = max(0.05, 0.25 * r)
    start = hole["t0"] - (over if end_is_open(shape, hole, True, probe) else 0.0)
    end = hole["t1"] + (over if end_is_open(shape, hole, False, probe) else 0.0)
    return start, end - start


def teardrop_section(center, up, side, r, angle_deg, flat_height=None):
    """The cut's cross section: the kite over the circle, optionally cut flat at `flat_height` above the centre.

    The two roof lines are tangent to the circle and lean `angle_deg` from `up`, so they meet at
    r / sin(angle) above the centre.
    """
    th = math.radians(angle_deg)
    s, c = math.sin(th), math.cos(th)
    tip = r / s
    p1 = g.lin(center, (r * s, up), (r * c, side))
    p2 = g.lin(center, (r * s, up), (-r * c, side))
    if flat_height is None or flat_height >= tip - 1e-9:
        return [center, p1, g.lin(center, (tip, up)), p2]
    t = (flat_height - r * s) / (tip - r * s)
    q1 = g.add(p1, g.mul(g.sub(g.lin(center, (tip, up)), p1), t))
    q2 = g.add(p2, g.mul(g.sub(g.lin(center, (tip, up)), p2), t))
    return [center, p1, q1, q2, p2]


def bridge_section(center, up, side, r, extra):
    top = r + extra
    return [
        g.lin(center, (-r, side)),
        g.lin(center, (r, side)),
        g.lin(center, (r, side), (top, up)),
        g.lin(center, (-r, side), (top, up)),
    ]


def _apply(f, ctx, label, section_for):
    bdir = g.build_dir(f, label)
    staged = []
    for body, faces in picked_faces(f, ctx, label):
        shape = body["shape"]
        tools = []
        for hole in holes_from_faces(shape, faces, label):
            up, side = roof_frame(hole, bdir, label)
            start, length = swept_span(shape, hole)
            center = g.lin(hole["origin"], (start, hole["axis"]))
            pts = section_for(center, up, side, hole["radius"])
            tools.append(g.prism(pts, g.mul(hole["axis"], length)))
        staged.append((body, g.cut(shape.wrapped, tools, label)))
    for body, out in staged:
        body["shape"] = _wrap_topods(out)


def handle_teardrop(f, ctx):
    label = "Teardrop"
    angle = float(ctx.val(f.get("angle", 45)))
    if not 10.0 <= angle <= 80.0:
        raise ValueError(f"{label}: the roof angle must be between 10 and 80 degrees (got {angle:g})")
    roof = f.get("roof") or "pointed"
    if roof not in ("pointed", "flat"):
        raise ValueError(f"{label}: unknown roof {roof!r}")
    extra = float(ctx.val(f.get("flatHeight", 0)))
    if roof == "flat" and extra < 0:
        raise ValueError(f"{label}: the flat roof cannot sit below the top of the hole")

    def section(center, up, side, r):
        return teardrop_section(center, up, side, r, angle, r + extra if roof == "flat" else None)

    _apply(f, ctx, label, section)


def handle_roof_bridge(f, ctx):
    label = "Roof bridge"
    extra = float(ctx.val(f.get("height", 0)))
    if extra < 0:
        raise ValueError(f"{label}: the extra height cannot be negative")
    _apply(f, ctx, label, lambda center, up, side, r: bridge_section(center, up, side, r, extra))
