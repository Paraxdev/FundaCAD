"""Layer-height tricks: counterbore bridges and sacrificial layers."""

import math

from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace

import ptb_occ as g
from ptb_read import (
    circular_openings, cylinder_of, edge_points, end_is_open, holes_from_faces, picked_faces, plane_of,
)
from shape_util import _wrap_topods


def _layer_height(f, ctx, label):
    h = float(ctx.val(f.get("layerHeight", 0.2)))
    if not 0.01 <= h <= 5.0:
        raise ValueError(f"{label}: the layer height must be between 0.01 and 5 mm (got {h:g})")
    return h


def _layer_count(f, ctx, label, default, most):
    raw = float(ctx.val(f.get("layers", default)))
    n = int(round(raw))
    if abs(raw - n) > 1e-9 or not 1 <= n <= most:
        raise ValueError(f"{label}: the number of layers must be a whole number from 1 to {most} (got {raw:g})")
    return n


def bridge_openings(center, x, y, r, reach, count):
    """The open region of each bridging layer, nearest the floor first.

    The first leaves a slot as wide as the bore running wall to wall, the second crosses it and
    leaves a square, the third trims the square's corners to an octagon.
    """
    shapes = [
        [g.lin(center, (sx * reach, x), (sy * r, y)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))],
        [g.lin(center, (sx * r, x), (sy * r, y)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))],
    ]
    rr = r / math.cos(math.pi / 8)
    shapes.append([
        g.lin(center, (rr * math.cos(a), x), (rr * math.sin(a), y))
        for a in (math.pi / 8 + k * math.pi / 4 for k in range(8))
    ])
    return shapes[:count]


def _walled(shape, center, n, outer_pts, probe):
    hits = 0
    for p in outer_pts:
        radial = g.sub(p, center)
        radial = g.sub(radial, g.mul(n, g.dot(radial, n)))
        if g.norm(radial) < 1e-9:
            continue
        if g.inside(shape, g.lin(p, (probe, g.unit(radial)), (probe, n))):
            hits += 1
    return hits * 2 >= max(1, len(outer_pts))


def handle_counterbore_bridge(f, ctx):
    label = "Counterbore bridge"
    lh = _layer_height(f, ctx, label)
    count = _layer_count(f, ctx, label, 2, 3)
    turn = math.radians(float(ctx.val(f.get("angle", 0))))
    staged = []
    for body, faces in picked_faces(f, ctx, label):
        shape = body["shape"]
        tools = []
        for fc in faces:
            pl = plane_of(fc)
            if pl is None:
                raise ValueError(f"{label}: pick the flat floor of a counterbore, this face is curved")
            n, _ = pl
            openings = circular_openings(fc)
            if len(openings) != 1:
                raise ValueError(f"{label}: the picked floor needs exactly one round bore through it (found {len(openings)})")
            center, r = openings[0]
            outer_pts = edge_points(fc.outer_wire().wrapped)
            probe = max(0.01, 0.1 * lh)
            if not _walled(shape, center, n, outer_pts, probe):
                raise ValueError(f"{label}: the picked face is not a counterbore floor, nothing walls it in")
            total = count * lh
            for k in range(count):
                if g.inside(shape, g.lin(center, (-(k + 0.5) * lh, n))):
                    raise ValueError(f"{label}: the bore below this floor is shorter than {count} layers of {lh:g} mm")
            reach = max(g.norm(g.sub(p, center)) for p in outer_pts) + 1.0
            hx, hy = perp_frame_rotated(n, turn)
            footprint = BRepBuilderAPI_MakeFace(fc.outer_wire().wrapped, True).Face()
            slab = g.face_prism(footprint, g.mul(n, -total))
            for k, pts in enumerate(bridge_openings(center, hx, hy, r, reach, count)):
                pts = [g.lin(p, (-k * lh, n)) for p in pts]
                tool = g.common(slab, g.prism(pts, g.mul(n, -lh)))
                if tool is None:
                    raise ValueError(f"{label}: could not shape layer {k + 1}")
                tools.append(tool)
        staged.append((body, g.cut(shape.wrapped, tools, label)))
    for body, out in staged:
        body["shape"] = _wrap_topods(out)


def perp_frame_rotated(n, turn):
    x, y = g.perp_frame(n)
    c, s = math.cos(turn), math.sin(turn)
    return g.add(g.mul(x, c), g.mul(y, s)), g.add(g.mul(y, c), g.mul(x, -s))


def _openings_for(shape, fc, bdir, side, probe, label):
    """[(point on the opening plane, inward unit vector, radius, depth available)] for one picked face."""
    cyl = cylinder_of(fc)
    if cyl is not None:
        out = []
        for hole in holes_from_faces(shape, [fc], label):
            a, length = hole["axis"], hole["t1"] - hole["t0"]
            ends = []
            if end_is_open(shape, hole, True, probe):
                ends.append((g.lin(hole["origin"], (hole["t0"], a)), a))
            if end_is_open(shape, hole, False, probe):
                ends.append((g.lin(hole["origin"], (hole["t1"], a)), g.mul(a, -1.0)))
            if not ends:
                raise ValueError(f"{label}: this hole does not open onto any face")
            pick = min if side == "bottom" else max
            p, inward = pick(ends, key=lambda e: round(g.dot(e[0], bdir), 9))
            out.append((p, inward, hole["radius"], length))
        return out
    pl = plane_of(fc)
    if pl is None:
        raise ValueError(f"{label}: pick the inside face of a round hole, or the flat face it opens onto")
    n, _ = pl
    out = []
    for center, r in circular_openings(fc):
        if not g.inside(shape, g.lin(center, (-probe, n))):
            out.append((center, g.mul(n, -1.0), r, None))
    if not out:
        raise ValueError(f"{label}: no round hole opens onto the picked face")
    return out


def handle_sacrificial_layer(f, ctx):
    label = "Sacrificial layer"
    lh = _layer_height(f, ctx, label)
    count = _layer_count(f, ctx, label, 1, 5)
    depth = float(ctx.val(f.get("depth", 0)))
    if depth < 0:
        raise ValueError(f"{label}: the depth cannot be negative")
    side = f.get("side") or "bottom"
    if side not in ("bottom", "top"):
        raise ValueError(f"{label}: unknown side {side!r}")
    bdir = g.build_dir(f, label)
    thick = count * lh
    staged = []
    for body, faces in picked_faces(f, ctx, label):
        shape = body["shape"]
        membranes = []
        for fc in faces:
            probe = max(0.01, 0.1 * lh)
            for p, inward, r, available in _openings_for(shape, fc, bdir, side, probe, label):
                if available is not None and depth + thick > available + 1e-9:
                    raise ValueError(
                        f"{label}: {depth:g} mm deep plus {thick:g} mm of layers runs past the end of the "
                        f"{available:g} mm hole"
                    )
                start = g.lin(p, (depth, inward))
                if g.inside(shape, g.lin(start, (thick / 2, inward))):
                    raise ValueError(f"{label}: at {depth:g} mm deep the hole is already closed")
                grip = min(0.05, 0.1 * r)
                membranes.append(g.disc(start, inward, r + grip, thick))
        staged.append((body, g.simplify(g.fuse(shape.wrapped, membranes, label))))
    for body, out in staged:
        body["shape"] = _wrap_topods(out)
