"""A fillet that builds surface on top of surface.

Run:  python test_blend_overlap.py

The report: a saved document whose model "flashes triangles and just isn't quite
right". Nothing was missing from it. The solid was closed, every edge had two
faces, every triangle had area, BRepCheck_Analyzer called it valid, and the
timeline showed no error. What it had instead was three faces from ONE fillet
lying on top of each other over about a square millimetre, which a depth buffer
cannot resolve, so the doubled patch flips between them as the view moves.

The shape that does it, once the face list is read: a rounded bore whose blend
runs out exactly where a step rises, so the corner between them has no flat
ground on the inside, and a second fillet put in that corner has nothing to roll
on. These tests build that from a box and two cylinders, and then move the step
back so the corner has ground either side, which is the case that must still be
allowed.

That second test is the one that matters most. A guard like this fails by
refusing real work, and it fails INVISIBLY: every refusal looks exactly like the
operation being hard, and the person on the other end just tries a smaller
radius forever. Hence a control at every level here, down to the plain box.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Solid

import blend_overlap
from blend_overlap import (
    COINCIDENT_MM, FOLD_AREA_MM2, MEASURE_DEFLECTION_MM, doubled_area,
    folds_over_itself, new_faces,
)
from conic_blend import conic_blend

BORE = 1.2862      # the bore's radius, from the reported document
BLEND = 0.357      # the round on its top rim, likewise
STEP = 0.3         # how far the ring beside it stands up
SECOND = 0.15      # the fillet in the corner they make
TOP = 4.0


def _ring_edge(shape, z, want_r=None):
    """The circular edge at height `z`, nearest `want_r` (or nearest the axis
    when no radius is asked for)."""
    best, bestd = None, 1e9
    for e in shape.edges():
        if abs(e.position_at(0).Z - z) > 1e-6 or abs(e.position_at(1).Z - z) > 1e-6:
            continue
        m = e.position_at(0.5)
        r = (m.X ** 2 + m.Y ** 2) ** 0.5
        d = abs(r - want_r) if want_r is not None else r
        if d < bestd:
            best, bestd = e, d
    return best


def _bored_and_blended():
    """A plate with a through bore whose top rim is rounded, so the blend ends
    tangent to the top face at BORE + BLEND."""
    plate = Solid.make_box(12, 12, TOP).translate((-6, -6, 0))
    holed = plate - Solid.make_cylinder(BORE, TOP + 2).translate((0, 0, -1))
    return holed.fillet(BLEND, [_ring_edge(holed, TOP)])


def _stepped(land):
    """Stand a ring on the top face, its inner wall `land` outside where the
    blend runs out, and return (before, after) for a fillet in the corner."""
    inner_r = BORE + BLEND + land
    ring = (Solid.make_cylinder(6.0, STEP).translate((0, 0, TOP))
            - Solid.make_cylinder(inner_r, STEP + 2).translate((0, 0, TOP - 1)))
    before = _bored_and_blended() + ring
    return before, before.fillet(SECOND, [_ring_edge(before, TOP, inner_r)])


def test_the_reported_shape_is_refused():
    before, after = _stepped(0.0)
    area = doubled_area(new_faces(before, after))
    assert area > FOLD_AREA_MM2, (
        f"the fold measured {area:.4f} mm2, under the {FOLD_AREA_MM2} mm2 it takes to report")
    assert folds_over_itself(before, after)
    print(f"fold caught OK: {area:.4f} mm2 of the blend lies on itself")


def test_the_same_fillet_with_ground_to_sit_on_is_allowed():
    """The control that has to fail if the guard is too eager. Same bore, same
    blend, same fillet, same radius: the ONLY difference is that the corner has
    flat ground on both sides of it."""
    before, after = _stepped(0.6)
    area = doubled_area(new_faces(before, after))
    assert area == 0.0, f"a sound fillet measured {area:.4f} mm2 of doubled surface"
    assert not folds_over_itself(before, after)
    print("sound fillet allowed OK: 0.0000 mm2")


def test_a_tangent_junction_is_not_a_fold():
    """Every fillet ends in one, so if a tangency read as doubled surface the
    guard would refuse every blend on every model. The two faces here really do
    lie in each other's planes along the join, which is why the measurement is
    to the triangle and not to its plane."""
    plate = Solid.make_box(12, 12, TOP).translate((-6, -6, 0))
    holed = plate - Solid.make_cylinder(BORE, TOP + 2).translate((0, 0, -1))
    after = holed.fillet(BLEND, [_ring_edge(holed, TOP)])
    area = doubled_area(new_faces(holed, after))
    assert area == 0.0, f"a plain rim round measured {area:.4f} mm2"
    print("tangent junction reads as 0.0000 mm2 OK")


def test_ordinary_blends_are_untouched():
    box = Solid.make_box(10, 10, 10)
    one = box.fillet(1.0, [max(box.edges(), key=lambda e: e.length)])
    assert not folds_over_itself(box, one)
    every = box.fillet(0.8, list(box.edges()))
    assert not folds_over_itself(box, every)
    big = Solid.make_box(200, 120, 60)
    long_edge = big.fillet(5.0, [max(big.edges(), key=lambda e: e.length)])
    assert not folds_over_itself(big, long_edge)
    print("plain box fillets, all twelve edges, and a 200mm part all allowed OK")


# A slot-shaped boss on a plate, and the round on the rim where it stands up.
# From the reported document, reduced to the two numbers that matter: the boss is
# narrower than the blend is wide, so the blend wraps its ends tightly and the
# mesher has a hard surface to chord.
BOSS_W = 1.3967
BOSS_H = 1.801
BOSS_HALF = 6.0
BOSS_R = 1.28


def _slot_boss():
    plate = Solid.make_box(40, 40, 10).translate((-20, -20, 0))
    boss = Solid.make_box(2 * BOSS_HALF, BOSS_W, BOSS_H).translate(
        (-BOSS_HALF, -BOSS_W / 2, 10))
    for x in (-BOSS_HALF, BOSS_HALF):
        boss = boss + Solid.make_cylinder(BOSS_W / 2, BOSS_H).translate((x, 0, 10))
    solid = plate + boss
    rim = [e for e in solid.edges()
           if abs(e.position_at(0.5).Z - 10) < 1e-9
           and abs(abs(e.position_at(0.5).Y) - BOSS_W / 2) < 1e-9
           and abs(e.position_at(0.5).X) < 1e-9]
    assert rim, "no rim edge on the slot boss"
    return solid.wrapped, rim[0].wrapped


def test_a_coarse_chord_is_not_evidence_about_the_surfaces():
    """A sound blend the triangles accuse and the faces acquit.

    The triangles are coarse on purpose, and a coarse triangle is a CHORD: it can
    sit a long way inside the surface it stands for, and two chords can cross
    while their surfaces stay far apart. On this blend at a positive profile —
    where the mesher has the hardest time, see PROFILE_LIMIT in conic_blend.py —
    four triangles pass within a micron of a face, and every one of those faces
    is a fifth of a millimetre away.

    A fifth of a millimetre is not a depth-buffer problem. It is 200 times the
    distance the guard tests for, and the blend under it is perfectly sound: the
    refusal cost a real fillet on a real document, which is how this was found.

    CONTROLS:
      * the mesh really does propose it. Neutralise the bound and the same shape
        measures more than it takes to convict, so this is the bound working and
        not the proposal having quietly gone away.
      * the accused faces are measured, not assumed apart: what makes the verdict
        wrong is a number, and the number is in the test.
    """
    solid, edge = _slot_boss()
    after = conic_blend(solid, [edge], BOSS_R, 0.7)
    fresh = new_faces(solid, after)

    unbounded = _measure_without_the_bound(fresh)
    assert unbounded > FOLD_AREA_MM2, (
        f"the mesh no longer proposes anything here ({unbounded:.4f} mm2), so this "
        "shape has stopped being the case it was written for")
    gaps = _accused_gaps(fresh)
    assert gaps, "the proposals vanished between the two passes"
    assert min(gaps) > MEASURE_DEFLECTION_MM, (
        f"the accused faces are {min(gaps):.4f}mm apart, inside the deflection the "
        "triangles promised — the mesh is entitled to that claim and this is no "
        "longer a false one")

    area = doubled_area(fresh)
    assert area == 0.0, f"a sound blend measured {area:.4f} mm2 of doubled surface"
    assert not folds_over_itself(solid, after)
    print(f"coarse chords acquitted OK: mesh said {unbounded:.4f} mm2 where the "
          f"faces are {min(gaps):.4f}mm apart")


def _measure_without_the_bound(fresh):
    """What the triangles alone say, which is what this guard used to go on."""
    real = blend_overlap._near_the_face
    blend_overlap._near_the_face = lambda *_a: True
    try:
        return doubled_area(fresh)
    finally:
        blend_overlap._near_the_face = real


def _accused_gaps(fresh):
    """How far each accused point really is from the face it is accused of."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt
    from blend_overlap import PARALLEL_DOT, _point_to_triangle, _triangles
    tris = _triangles(fresh)
    out = []
    for fi, ci, ni, _ai, _pts in tris:
        for fj, _cj, nj, _aj, ptsj in tris:
            if fj == fi or abs(sum(ni[k] * nj[k] for k in range(3))) < PARALLEL_DOT:
                continue
            if _point_to_triangle(ci, ptsj) > COINCIDENT_MM:
                continue
            out.append(BRepExtrema_DistShapeShape(
                BRepBuilderAPI_MakeVertex(gp_Pnt(*ci)).Vertex(), fresh[fj]).Value())
            break
    return out


def test_nothing_new_is_not_a_fold():
    """An operation that changed no faces cannot have folded any. Reached when a
    blend resolves to nothing to do, and it must be cheap and quiet."""
    box = Solid.make_box(10, 10, 10)
    assert not folds_over_itself(box, box)
    assert doubled_area([]) == 0.0
    print("a no-op blend reports nothing OK")


if __name__ == "__main__":
    try:
        test_the_reported_shape_is_refused()
        test_the_same_fillet_with_ground_to_sit_on_is_allowed()
        test_a_tangent_junction_is_not_a_fold()
        test_a_coarse_chord_is_not_evidence_about_the_surfaces()
        test_ordinary_blends_are_untouched()
        test_nothing_new_is_not_a_fold()
        print("\nall blend-overlap tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
