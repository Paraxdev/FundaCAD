"""Thread-forming ribs: thin axial ridges inside a plain round hole, so a
self-tapping screw cuts its own thread into the ribs instead of the whole wall.

Each rib is a straight rectangular prism from the core radius out to the hole
wall, evenly spaced around the axis. Its outer corners sit slightly beyond the
hole's circle (a straight edge across an arc always does), which a fuse with
the body silently absorbs since that sliver is already material; that is the
"small tolerance for the arc at the hole wall" the volume tests allow for.
"""

import math

import ptb_occ as g
from ptb_layers import perp_frame_rotated
from ptb_read import end_is_open, holes_from_faces, picked_faces
from shape_util import _wrap_topods


def handle_thread_ribs(f, ctx):
    label = "Thread-forming ribs"
    raw_count = float(ctx.val(f.get("ribCount", 3)))
    count = int(round(raw_count))
    if abs(raw_count - count) > 1e-9 or not 3 <= count <= 8:
        raise ValueError(f"{label}: the rib count must be a whole number from 3 to 8 (got {raw_count:g})")
    width = float(ctx.val(f.get("ribWidth", 0.6)))
    if width <= 0:
        raise ValueError(f"{label}: the rib width must be greater than 0 (got {width:g})")
    core_d = float(ctx.val(f.get("coreDiameter", 0)))
    if core_d < 0:
        raise ValueError(f"{label}: the core diameter cannot be negative")
    start_depth = float(ctx.val(f.get("startDepth", 0.5)))
    if start_depth < 0:
        raise ValueError(f"{label}: the start depth cannot be negative")

    staged = []
    for body, faces in picked_faces(f, ctx, label):
        shape = body["shape"]
        tools = []
        for hole in holes_from_faces(shape, faces, label):
            r = hole["radius"]
            core_r = (core_d / 2.0) if core_d > 0 else 0.8 * r
            if not 0 < core_r < r:
                raise ValueError(
                    f"{label}: the core diameter must be between 0 and the hole diameter of {2 * r:g} mm"
                )
            chord = 2.0 * r * math.sin(math.pi / count)
            if width >= chord:
                raise ValueError(
                    f"{label}: {count} ribs of {width:g} mm would overlap around a {2 * r:g} mm hole, "
                    "use fewer ribs or a narrower width"
                )
            probe = max(0.01, 0.05 * r)
            start = hole["t0"] + (start_depth if end_is_open(shape, hole, True, probe) else 0.0)
            end = hole["t1"] - (start_depth if end_is_open(shape, hole, False, probe) else 0.0)
            length = end - start
            if length <= 0:
                raise ValueError(
                    f"{label}: the start depth leaves nothing of the {hole['t1'] - hole['t0']:g} mm hole to rib"
                )
            base = g.lin(hole["origin"], (start, hole["axis"]))
            for k in range(count):
                up, side = perp_frame_rotated(hole["axis"], k * 2.0 * math.pi / count)
                pts = [
                    g.lin(base, (core_r, up), (-width / 2.0, side)),
                    g.lin(base, (r, up), (-width / 2.0, side)),
                    g.lin(base, (r, up), (width / 2.0, side)),
                    g.lin(base, (core_r, up), (width / 2.0, side)),
                ]
                tools.append(g.prism(pts, g.mul(hole["axis"], length)))
        staged.append((body, g.fuse(shape.wrapped, tools, label)))
    for body, out in staged:
        body["shape"] = _wrap_topods(out)
