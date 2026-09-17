"""Zip-tie channel: a U-shaped tunnel cut under a flat face so a tie can loop
through the part, two vertical slots down to an inset depth joined by a
horizontal tunnel between them.

The tunnel spans exactly between the two slots (no overlap to subtract), which
is what keeps the removed volume a plain product: width * height *
(2 * inset + span - height).
"""

import math

import ptb_occ as g
from ptb_layers import perp_frame_rotated
from ptb_read import picked_faces, plane_of
from shape_util import _wrap_topods


def handle_zip_tie_channel(f, ctx):
    label = "Zip-tie channel"
    width = float(ctx.val(f.get("channelWidth", 4)))
    if width <= 0:
        raise ValueError(f"{label}: the channel width must be greater than 0 (got {width:g})")
    height = float(ctx.val(f.get("channelHeight", 2)))
    if height <= 0:
        raise ValueError(f"{label}: the channel height must be greater than 0 (got {height:g})")
    inset = float(ctx.val(f.get("insetDepth", 2)))
    if inset <= 0:
        raise ValueError(f"{label}: the inset depth must be greater than 0 (got {inset:g})")
    span = float(ctx.val(f.get("span", 10)))
    if span <= height:
        raise ValueError(f"{label}: the span must be greater than the channel height (got span {span:g}, height {height:g})")
    angle = math.radians(float(ctx.val(f.get("angle", 0))))
    allow_breakthrough = bool(f.get("allowBreakthrough", False))

    staged = []
    for body, faces in picked_faces(f, ctx, label):
        shape = body["shape"]
        tools = []
        for fc in faces:
            pl = plane_of(fc)
            if pl is None:
                raise ValueError(f"{label}: pick a flat face for the zip-tie channel")
            n, _ = pl
            center = fc.center().to_tuple()
            inward = g.mul(n, -1.0)
            along, across = perp_frame_rotated(n, angle)

            half_h = height / 2.0
            for sgn in (-1.0, 1.0):
                c = g.lin(center, (sgn * span / 2.0, along))
                pts = [
                    g.lin(c, (-half_h, along), (-width / 2.0, across)),
                    g.lin(c, (half_h, along), (-width / 2.0, across)),
                    g.lin(c, (half_h, along), (width / 2.0, across)),
                    g.lin(c, (-half_h, along), (width / 2.0, across)),
                ]
                tools.append(g.prism(pts, g.mul(inward, inset)))

            tl = (span - height) / 2.0
            base_pts = [
                g.lin(center, (-tl, along), (-width / 2.0, across)),
                g.lin(center, (tl, along), (-width / 2.0, across)),
                g.lin(center, (tl, along), (width / 2.0, across)),
                g.lin(center, (-tl, along), (width / 2.0, across)),
            ]
            deep_pts = [g.lin(p, (inset - height, inward)) for p in base_pts]
            tools.append(g.prism(deep_pts, g.mul(inward, height)))

            if not allow_breakthrough:
                probe = max(0.01, 0.05 * width)
                for along_off in (0.0, -span / 2.0, span / 2.0):
                    p = g.lin(center, (along_off, along), (inset + probe, inward))
                    if not g.inside(shape.wrapped, p):
                        raise ValueError(
                            f"{label}: the channel would break through the part's far side; "
                            "reduce the inset depth or allow breakthrough"
                        )
        staged.append((body, g.cut(shape.wrapped, tools, label)))
    for body, out in staged:
        body["shape"] = _wrap_topods(out)
