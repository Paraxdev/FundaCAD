"""Modelled helical threads, cut with the engine's own climbing revolve (sidecar/revolve_feature.py).

The groove is the 60 degree triangle src/features/threadMath.ts draws: ISO 68-1's basic depth of
0.6134 P, pushed past the cylinder it cuts so the boolean is never tangent.

The groove is cut into a plain cylinder one turn per tool, all tools in one boolean. A long
helical tool running nearly parallel to the cylinder it meets defeats the kernel outright, the cut
reports success and removes nothing (sidecar/booleans.py `_retried_in_slices` has the measurements),
and so does the same groove cut into a revolved shank with a chamfered tip. So a screw's thread is
cut into its own cylinder, which is then fused to the head on a flat face and given its point.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see sidecar/font_guard.py
from build123d import Axis, Face, Vector, Wire

from scr_shapes import one

DEPTH = 0.6134
HALF_WIDTH = DEPTH * math.tan(math.pi / 6)
BREAKOUT_RATIO = 0.15
BREAKOUT_FLOOR = 0.02
MINOR_OFFSET = 0.54127


def _groove(radius, pitch, external, z0):
    depth = pitch * DEPTH
    half = pitch * HALF_WIDTH
    breakout = max(BREAKOUT_FLOOR, depth * BREAKOUT_RATIO)
    apex = radius - depth if external else radius + depth
    base = radius + breakout if external else radius - breakout
    pts = [Vector(base, 0, z0 - half), Vector(base, 0, z0 + half), Vector(apex, 0, z0)]
    return Face(Wire.make_polygon(pts, close=True))


def _tools(radius, pitch, bottom, top, external, left, per_tool):
    from revolve_feature import _screw_revolve

    total = (top - bottom) / pitch
    tools = []
    done = 0.0
    while done < total - 1e-9:
        turns = min(per_tool, total - done)
        if left:
            face = _groove(radius, pitch, external, top - done * pitch)
            tools.append(one(_screw_revolve(face, Axis.Z, 360.0 * turns, -pitch)))
        else:
            face = _groove(radius, pitch, external, bottom + done * pitch)
            tools.append(one(_screw_revolve(face, Axis.Z, 360.0 * turns, pitch)))
        done += turns
    return tools


def groove_volume(radius, pitch, external, span):
    """What the groove should take out of `span` mm of cylinder: the part of the triangle inside the
    material, swept round its centroid."""
    depth = pitch * DEPTH
    breakout = max(BREAKOUT_FLOOR, depth * BREAKOUT_RATIO)
    half_at_surface = pitch * HALF_WIDTH * depth / (depth + breakout)
    centroid = radius - depth / 3 if external else radius + depth / 3
    return depth * half_at_surface * 2 * math.pi * centroid * span / pitch


# (turns per tool, phase in pitches). Measured on M1.6 to M24: one turn per tool cut every case
# cleanly; the others rescue the rare case it does not.
STRATEGIES = ((1, 0.0), (2, 0.0), (2, 0.37))


def cut_groove(body, radius, pitch, z_from, z_to, external, left, span):
    """Cut the groove from a pitch below z_from to z_to, all tools in one boolean, and check the
    result against the volume the groove should remove from `span` mm of material."""
    from OCP.BRepCheck import BRepCheck_Analyzer

    from booleans import _serial_bool

    want = groove_volume(radius, pitch, external, span)
    before = body.volume
    for per_tool, phase in STRATEGIES:
        bottom = z_from - pitch * (1 + phase)
        top = z_to + pitch * phase
        try:
            out = one(_serial_bool(body, _tools(radius, pitch, bottom, top, external, left, per_tool), "cut"))
        except Exception:
            continue
        if len(out.solids()) != 1 or not BRepCheck_Analyzer(out.wrapped).IsValid():
            continue
        if abs((before - out.volume) - want) <= 0.1 * want:
            return out.solids()[0]
    raise ValueError("Fastener: the kernel could not cut this modelled thread, use a simplified thread")


def cut_external(body, d, pitch, z_from, z_to, left=False):
    return cut_groove(body, d / 2, pitch, z_from, z_to, True, left, z_to - z_from)


def minor_radius(d, pitch):
    return d / 2 - MINOR_OFFSET * pitch


def cut_internal(body, d, pitch, z_from, z_to, left=False):
    return cut_groove(body, minor_radius(d, pitch), pitch, z_from, z_to + pitch, False, left, z_to - z_from)
