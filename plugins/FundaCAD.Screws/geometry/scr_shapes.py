"""Solids for fastener parts, in millimetres, on the Z axis.

Screws hang from the XY plane: the head's bearing face is at z=0 with the head above it, the shank
runs down to z=-length. A countersunk head is the exception that proves the point, its top is at
z=0 so the screw sits flush. Nuts and washers stand on z=0. An insert's top is at z=0 and it goes
down into the part. Placed on a face with +Z along the face normal, each lands the way it is used.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see sidecar/font_guard.py
from build123d import Axis, Compound, Edge, Face, Location, Solid, Vector, Wire

TAN30 = math.tan(math.radians(30))


def revolve_rz(points):
    """A solid of revolution about Z from a closed (r, z) outline."""
    wire = Wire.make_polygon([Vector(r, 0, z) for r, z in points], close=True)
    return Solid.revolve(Face(wire), 360, Axis.Z)


def revolve_edges(edges):
    return Solid.revolve(Face(Wire(edges)), 360, Axis.Z)


def prism(points_xy, z0, height):
    wire = Wire.make_polygon([Vector(x, y, z0) for x, y in points_xy], close=True)
    return Solid.extrude(Face(wire), Vector(0, 0, height))


def hexagon(across_flats):
    r = across_flats / math.sqrt(3)
    return [(r * math.cos(math.radians(60 * i)), r * math.sin(math.radians(60 * i))) for i in range(6)]


def square(side):
    h = side / 2
    return [(-h, -h), (h, -h), (h, h), (-h, h)]


def star(outer, inner, teeth):
    """Straight knurl ribs. An even count puts a rib on both ends of each axis, so the knurl measures
    its full diameter."""
    teeth += teeth % 2
    pts = []
    for i in range(teeth * 2):
        a = math.pi * i / teeth
        r = outer if i % 2 == 0 else inner
        pts.append((r * math.cos(a), r * math.sin(a)))
    return pts


def cylinder(r, z0, z1):
    return revolve_rz([(0, z0), (r, z0), (r, z1), (0, z1)])


def box(x0, x1, y0, y1, z0, z1):
    return prism([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1 - z0)


def one(shape):
    """build123d hands a boolean's result back as a ShapeList when it is several pieces, or
    sometimes even when it is one."""
    if isinstance(shape, list):
        return shape[0] if len(shape) == 1 else Compound(list(shape))
    return shape


def fuse(*shapes):
    out = one(shapes[0])
    for s in shapes[1:]:
        out = one(out.fuse(one(s)))
    return one(out.clean())


def cut(a, *tools):
    out = one(a)
    for t in tools:
        out = one(out.cut(one(t)))
    return one(out.clean())


def intersect(a, b):
    return one(one(a).intersect(one(b)))


def chamfered_hex(across_flats, z0, z1, top=True, bottom=False):
    """A hex prism with the 30 degree bearing-face chamfers a pressed hex has."""
    body = prism(hexagon(across_flats), z0, z1 - z0)
    big = across_flats / math.sqrt(3) * 1.05
    rw = across_flats / 2 * 0.95
    drop = (big - rw) * TAN30
    lo = [(rw, z0), (big, z0 + drop)] if bottom else [(big, z0)]
    hi = [(big, z1 - drop), (rw, z1)] if top else [(big, z1)]
    return intersect(body, revolve_rz([(0, z0), *lo, *hi, (0, z1)]))


# --- the axisymmetric outline of a screw --------------------------------------------------------


def head_outline(head, shank_r):
    """(r, z) from the top of the axis outward and down to the shank at z=0, or None when the head
    is not a solid of revolution (hex, flange, knurl) and is fused on separately. Also returns the
    z of the head's top face, where a drive recess starts."""
    t = head["type"]
    if t in ("socketCap", "lowHead", "cheese"):
        R, k = head["diameter"] / 2, head["height"]
        c = min(k * (0.15 if t == "cheese" else 0.1), R * 0.08)
        return [(0, k), (R - c, k), (R, k - c), (R, 0), (shank_r, 0)], k
    if t == "countersunk":
        R, k = head["diameter"] / 2, head["height"]
        return [(0, 0), (R, 0), (shank_r, -k)], 0.0
    if t == "none":
        return [(0, 0)], 0.0
    return None, head.get("height", 0.0)


def curved_head(head, shank_r):
    """Edges for the domed heads, which need arcs: (edges from the axis top to (shank_r, 0))."""
    t = head["type"]
    if t not in ("button", "pan"):
        return None
    R, k = head["diameter"] / 2, head["height"]
    if t == "button":
        h0 = k * 0.18
        rise = k - h0
        rs = (R * R + rise * rise) / (2 * rise)
        theta = math.asin(min(1.0, R / rs))
        mid = (rs * math.sin(theta / 2), k - rs + rs * math.cos(theta / 2))
        return [
            Edge.make_three_point_arc(Vector(0, 0, k), Vector(mid[0], 0, mid[1]), Vector(R, 0, h0)),
            Edge.make_line(Vector(R, 0, h0), Vector(R, 0, 0)),
            Edge.make_line(Vector(R, 0, 0), Vector(shank_r, 0, 0)),
        ]
    if t == "pan":
        rf = min(k * 0.45, R * 0.35)
        cx, cz = R - rf, k - rf
        a = math.radians(45)
        return [
            Edge.make_line(Vector(0, 0, k), Vector(cx, 0, k)),
            Edge.make_three_point_arc(Vector(cx, 0, k), Vector(cx + rf * math.sin(a), 0, cz + rf * math.cos(a)), Vector(R, 0, cz)),
            Edge.make_line(Vector(R, 0, cz), Vector(R, 0, 0)),
            Edge.make_line(Vector(R, 0, 0), Vector(shank_r, 0, 0)),
        ]
    return None


def point_outline(point, r, z_end, pitch, length):
    """(r, z) from the shank radius at the start of the point down to the axis at z_end."""
    t = point["type"]
    c = min(pitch * 0.6134, r * 0.4, length * 0.2)
    if t == "flat":
        rp = min(point["diameter"] / 2, r * 0.98)
        c = min(r - rp, length * 0.3)
        return [(r, z_end + c), (r - c, z_end), (0, z_end)]
    if t == "cone":
        tip = r * 0.12
        h = min((r - tip) / math.tan(math.radians(59)), length * 0.4)
        return [(r, z_end + h), (tip, z_end), (0, z_end)]
    if t == "cup":
        rc = min(point["diameter"] / 2, r * 0.9)
        c = min(r - rc, length * 0.3)
        return [(r, z_end + c), (rc, z_end), (0, z_end + min(rc * 0.55, length * 0.25))]
    if t == "tapping":
        h = min(2 * pitch, length * 0.5)
        return [(r, z_end + h), (r * 0.35, z_end), (0, z_end)]
    return [(r, z_end + c), (r - c, z_end), (0, z_end)]


# --- drive recesses, as tools to cut, from z_top downward ----------------------------------------


def _cone_tip(r, z_top_of_cone, angle=118):
    h = r / math.tan(math.radians(angle / 2))
    return revolve_rz([(0, z_top_of_cone - h), (r, z_top_of_cone), (0, z_top_of_cone)])


def drive_tool(drive, z_top, head_room):
    t = drive["type"]
    if t == "none":
        return None
    s, depth = drive["size"], drive["depth"]
    above = max(1.0, depth)
    if t == "hex":
        body = prism(hexagon(s), z_top - depth, depth + above)
        return fuse(body, _cone_tip(s / math.sqrt(3), z_top - depth))
    if t == "square":
        body = prism(square(s), z_top - depth, depth + above)
        return fuse(body, _cone_tip(s / math.sqrt(2), z_top - depth))
    if t == "slot":
        half = head_room / 2 + 1
        return box(-half, half, -s / 2, s / 2, z_top - depth, z_top + above)
    if t == "torx":
        return fuse(torx_prism(s, z_top - depth, depth + above), _cone_tip(s * 0.36, z_top - depth))
    if t in ("phillips", "pozidriv"):
        return cross_recess(s, depth, z_top, above, pozi=(t == "pozidriv"))
    raise ValueError(f"Fastener: unknown drive type {t!r}")


def torx_prism(a, z0, height):
    """A hexalobular recess: six rounded lobes, point to point `a`."""
    from build123d import Circle, Pos

    ro = a / 2
    b = a * 0.72 / 2
    ri = a * 0.175
    shape = Circle(ro)
    for i in range(6):
        ang = math.radians(30 + 60 * i)
        dist = b + ri
        shape = shape - Pos(dist * math.cos(ang), dist * math.sin(ang)) * Circle(ri)
    face = shape.faces()[0]
    solid = Solid.extrude(face, Vector(0, 0, height))
    return solid.moved(Location((0, 0, z0)))


def cross_recess(m, depth, z_top, above, pozi=False):
    w = m * 0.2
    half = m / 2
    arms = fuse(
        box(-half, half, -w / 2, w / 2, z_top - depth, z_top + above),
        box(-w / 2, w / 2, -half, half, z_top - depth, z_top + above),
    )
    taper = revolve_rz([(0, z_top - depth), (w * 0.55, z_top - depth), (half, z_top), (half, z_top + above), (0, z_top + above)])
    tool = intersect(arms, taper)
    centre = revolve_rz([(0, z_top - depth), (m * 0.24, z_top), (m * 0.24, z_top + above), (0, z_top + above)])
    tool = fuse(tool, centre)
    if pozi:
        from build123d import Rot

        tick = box(-half * 0.8, half * 0.8, -w * 0.18, w * 0.18, z_top - depth * 0.45, z_top + above)
        ticks = fuse(Rot(0, 0, 45) * tick, Rot(0, 0, -45) * tick)
        shallow = revolve_rz([(0, z_top - depth * 0.45), (half * 0.3, z_top - depth * 0.45), (half * 0.8, z_top), (half * 0.8, z_top + above), (0, z_top + above)])
        tool = fuse(tool, intersect(ticks, shallow))
    return tool
