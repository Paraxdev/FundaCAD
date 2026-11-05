#!/usr/bin/env python3
# Writes tests/vectors/blend_sections.json from the formulas of secblend::section in blend_section.hxx, profile 0.
# Run it from the repo root after changing those formulas; the Rust and TypeScript replays then say what moved.
import json, math, re

G2_SETBACK = 1.55
G2_TENSION = 0.5
G3_SETBACK = G2_SETBACK * 3.0 / 8.0 * 128.0 / 51.0
SETBACK = {"G1": 1.0, "G2": G2_SETBACK, "G3": G3_SETBACK}
BEND = 1.0 / 40.0

def bezier(poles, s):
    pts = [list(p) for p in poles]
    for r in range(1, len(pts)):
        for i in range(len(pts) - r):
            pts[i] = [pts[i][0] * (1 - s) + pts[i + 1][0] * s, pts[i][1] * (1 - s) + pts[i + 1][1] * s]
    return pts[0]

def height(c, side, bend):
    """How far c sits off a face through the origin, toward side, the face curling toward side by bend."""
    if bend == 0:
        return c[0] * side[0] + c[1] * side[1]
    o = (side[0] / bend, side[1] / bend)
    d = math.hypot(c[0] - o[0], c[1] - o[1])
    return 1 / bend - d if bend > 0 else d + 1 / bend

def foot(c, side, bend, r):
    if bend == 0:
        return (c[0] - side[0] * r, c[1] - side[1] * r)
    o = (side[0] / bend, side[1] / bend)
    d = math.hypot(c[0] - o[0], c[1] - o[1])
    return (o[0] + (c[0] - o[0]) / d / abs(bend), o[1] + (c[1] - o[1]) / d / abs(bend))

def ball(t, r, bend1, bend2):
    """The ball's centre by Newton from where flat faces put it, and its two feet."""
    side1, side2 = (0.0, 1.0), (math.sin(t), -math.cos(t))
    c = [r / math.tan(t / 2), r]
    for _ in range(60):
        g = (height(c, side1, bend1) - r, height(c, side2, bend2) - r)
        h = 1e-6
        a = (height((c[0] + h, c[1]), side1, bend1) - r - g[0]) / h
        b = (height((c[0], c[1] + h), side1, bend1) - r - g[0]) / h
        e = (height((c[0] + h, c[1]), side2, bend2) - r - g[1]) / h
        f = (height((c[0], c[1] + h), side2, bend2) - r - g[1]) / h
        det = a * f - b * e
        c = [c[0] - (f * g[0] - b * g[1]) / det, c[1] - (a * g[1] - e * g[0]) / det]
    return c, foot(c, side1, bend1, r), foot(c, side2, bend2, r)

def section(angle, radius, cont, bend1=0.0, bend2=0.0, n=8):
    t = math.radians(angle)
    r = radius * SETBACK[cont]
    c, qa, qb = ball(t, r, bend1, bend2)
    if cont == "G1":
        a0 = math.atan2(qa[1] - c[1], qa[0] - c[0])
        a1 = math.atan2(qb[1] - c[1], qb[0] - c[0])
        sweep = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        return [[c[0] + r * math.cos(a0 + sweep * k / n), c[1] + r * math.sin(a0 + sweep * k / n)] for k in range(n + 1)]
    if cont == "G2":
        h = 1 - G2_TENSION
        poles = [qa, (qa[0] * (1 - h), qa[1] * (1 - h)), (0.0, 0.0), (qb[0] * (1 - h), qb[1] * (1 - h)), qb]
    else:
        poles = [None] * 8
        for i in range(4):
            f = i / 4.0
            poles[i] = (qa[0] * (1 - f), qa[1] * (1 - f))
            poles[7 - i] = (qb[0] * (1 - f), qb[1] * (1 - f))
    return [bezier(poles, k / n) for k in range(n + 1)]

def entry(corner, angle, radius, cont, bend1=0.0, bend2=0.0):
    pts = [[round(v, 9) + 0.0 for v in p] for p in section(angle, radius, cont, bend1, bend2)]
    e = {"corner": corner, "angle": angle, "radius": radius, "continuity": cont}
    if bend1 or bend2:
        e.update(bend1=bend1, bend2=bend2)
    e["points"] = pts
    return e

out = {
    "about": "Fillet cross sections the engine builds (blend_section.hxx, profile 0), written by scripts/make-blend-vectors.py. Replayed by crates/fundacad-geom/tests/blend_section_vectors.rs and tests/features/blendSectionVectors.test.ts.",
    "frame": "The edge is the origin. Face 1 leaves along +x, face 2 along (cos a, sin a) for the wedge angle a in degrees. The material fills the wedge on a convex corner and its outside on a concave one. bend1 and bend2 curl a face toward the wedge's inside, per mm, absent when flat; G2 and G3 only build on flat faces. Points run from face 1's contact to face 2's at s = k/8: even angles for the G1 arc, the Bezier parameter for G2 and G3.",
    "sections": [],
}
for corner in ("convex", "concave"):
    for angle in (60, 90, 120):
        for radius in (3, 8):
            for cont in ("G1", "G2", "G3"):
                out["sections"].append(entry(corner, angle, radius, cont))
    for bend1, bend2 in ((0, BEND), (0, -BEND), (BEND, 0), (-BEND, 0), (BEND, BEND), (-BEND, -BEND)):
        out["sections"].append(entry(corner, 90, 3, "G1", bend1, bend2))

with open("tests/vectors/blend_sections.json", "w", newline="\n") as f:
    text = json.dumps(out, indent=1)
    text = re.sub(r"\[\s+(-?[0-9.e-]+),\s+(-?[0-9.e-]+)\s+\]", r"[\1, \2]", text)
    f.write(text + "\n")
