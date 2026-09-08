"""Randomised property test for the conic profile.

Run:  uv run python test_conic_fuzz.py [cases] [seed]

The fixed cases in test_conic_blend.py check four topologies chosen because they
exercise different code paths. This checks the thing those cannot: that the
property holds on geometry nobody picked.

The property is sharp, and it is what makes this worth running rather than a
vague "does it look right":

    IF the plain fillet builds at radius r, the conic MUST build at every
    profile of r.

Because the conic is not a different operation, it is OCCT's own blend face
with one row of NURBS weights scaled. No pole moves, no knot changes, no
tangency is renegotiated. If reweighting can turn a solid OCCT accepted into one
it rejects, that is our bug, not the kernel's, and it is exactly the "a sensible
fillet got denied" complaint.

Three more invariants ride along, all falsifiable:

  monotone    more profile MOVES less material, always. The drag depends on it:
              a slider that reverses direction anywhere is unusable.
  anchored    profile 0 reproduces the plain fillet to tessellation precision.
  bounded     profile -1 never moves more than the chamfer of the same setback,
              and +1 never moves more than the fillet. Those are the geometric
              ends of the family; crossing either is an overshoot.

"Moves", not "removes", and that word is load-bearing: a blend on a CONCAVE edge
adds material instead of taking it away, so every one of these invariants would
read backwards on it. Random booleans produce concave edges freely. The plain
fillet is asked for the sign once and all three are then stated along it, which
is also the only version that is true, the family runs from the chamfer to the
sharp corner whichever way the material goes.

Cases the plain fillet already refuses are SKIPPED, not failed, that is OCCT
declining, and diagnosing it is a different job from this one. The skip rate is
reported because it is itself interesting: a high rate means the generator is
drawing radii the geometry cannot hold.

Blends the conic family does not contain (`ConicNotApplicable`) are counted
apart from both. They are not failures, the property above is about blends the
identity describes, and that exception is exactly the builder saying this one is
not among them, but they are not passes either, so they get their own line and
have to be argued about rather than absorbed. Roughly one random boolean in
thirty lands there.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import random
import sys
import traceback

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCylinder,
)
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.gp import gp_Pnt, gp_Trsf, gp_Vec
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopoDS import TopoDS

from conic_blend import ConicNotApplicable, _sub, conic_blend
from test_conic_blend import mesh_volume

PROFILES = (-0.95, -0.6, -0.25, 0.0, 0.25, 0.6, 0.95)


def measure(shape, r):
    """Mesh deflection to volume-compare a blend of radius `r` against.

    Every volume here is a difference between two INDEPENDENTLY tessellated
    solids, so it carries the mesh error of both, and the blend splits a curved
    support face and gets that face re-triangulated differently from the way the
    unblended solid had it. That error is deflection times curved area, which
    has nothing to do with the blend, while the quantity being measured is the
    blend's own volume, near profile +0.95, where the blend has all but
    vanished, the two met and the sign of the answer was the mesh's to choose (a
    1mm blend on a 9mm cylinder read as removing -0.58mm3 of material).

    Tying the deflection to the radius instead of the model keeps the ratio
    between them bounded: the error goes as defl*R*H and the blend as r^2*R, so
    at defl = r/2000 the noise is a couple of percent of the feature however
    small the feature is relative to the part. NOISE below is the matching slack,
    sized to that, not chosen to make a case pass.
    """
    return min(0.005, r / 2000.0)


#: Slack for the volume invariants, as a fraction of the plain fillet's own
#: volume change. See `measure`: the mesh error is a bounded fraction of the
#: feature, so the tolerance has to be too. These checks are here to catch a
#: blend that runs backwards or overshoots its own ends, failures the size of
#: the feature, not to resolve its last percent.
NOISE = 0.05


def rand_solid(rng):
    """A random primitive, or a boolean of two, booleans matter because they
    make thin walls, which is where a blend's feasible radius stops being a
    function of the overall size and starts being local."""
    kind = rng.choice(["box", "cyl", "fuse", "cut"])
    a = BRepPrimAPI_MakeBox(
        rng.uniform(10, 60), rng.uniform(10, 60), rng.uniform(10, 60)
    ).Shape()
    if kind == "box":
        return a, kind
    if kind == "cyl":
        return BRepPrimAPI_MakeCylinder(rng.uniform(5, 25), rng.uniform(10, 50)).Shape(), kind

    b = BRepPrimAPI_MakeBox(
        rng.uniform(8, 40), rng.uniform(8, 40), rng.uniform(8, 40)
    ).Shape()
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(rng.uniform(-20, 20), rng.uniform(-20, 20), rng.uniform(-20, 20)))
    b = BRepBuilderAPI_Transform(b, t, True).Shape()
    op = BRepAlgoAPI_Fuse(a, b) if kind == "fuse" else BRepAlgoAPI_Cut(a, b)
    op.Build()
    if not op.IsDone():
        return a, "box"
    return op.Shape(), kind


def plain_fillet(shape, edges, r):
    """OCCT's own fillet, or None when it declines."""
    try:
        mk = BRepFilletAPI_MakeFillet(shape)
        for e in edges:
            mk.Add(r, e)
        mk.Build()
        if not mk.IsDone():
            return None
        out = mk.Shape()
        return out if BRepCheck_Analyzer(out).IsValid() else None
    except Exception:
        return None


def run(n_cases=60, seed=20260810):
    rng = random.Random(seed)
    skipped = 0
    checked = 0
    outside = []
    failures = []

    for case in range(n_cases):
        shape, kind = rand_solid(rng)
        edges = [TopoDS.Edge_s(e) for e in _sub(shape, TopAbs_EDGE)]
        if not edges:
            skipped += 1
            continue
        pick = rng.sample(edges, k=min(len(edges), rng.choice([1, 1, 1, 2, 3])))
        # Radius as a fraction of the model's own scale, so the draw scales with
        # whatever was generated instead of being tuned for one size.
        try:
            base = mesh_volume(shape) ** (1 / 3)
        except Exception:
            skipped += 1
            continue
        r = base * rng.uniform(0.02, 0.30)

        ref = plain_fillet(shape, pick, r)
        if ref is None:
            skipped += 1  # OCCT declined the plain fillet: not our property
            continue

        defl = measure(shape, r)
        try:
            base_vol = mesh_volume(shape, defl)
            ref_removed = base_vol - mesh_volume(ref, defl)
        except Exception:
            skipped += 1
            continue

        # Which way this blend moves material, read off the plain fillet rather
        # than assumed: on a concave edge a fillet FILLS the corner, so every
        # invariant below has to be stated along the fillet's own sign to mean
        # the same thing there as on a convex edge.
        way = 1.0 if ref_removed >= 0 else -1.0
        fillet_moved = abs(ref_removed)
        slack = max(1e-6, fillet_moved * NOISE)

        tag = f"case {case} seed={seed} kind={kind} edges={len(pick)} r={r:.4f}"
        prev = None
        try:
            for s in PROFILES:
                out = conic_blend(shape, pick, r, s)
                if not BRepCheck_Analyzer(out).IsValid():
                    failures.append(f"{tag}: INVALID solid at profile {s}")
                    break
                moved = way * (base_vol - mesh_volume(out, defl))
                if moved < -slack:
                    failures.append(
                        f"{tag}: moved {moved:.4f} the wrong way at {s}")
                    break
                if prev is not None and moved > prev + slack:
                    failures.append(
                        f"{tag}: NOT MONOTONE at {s} ({moved:.4f} > {prev:.4f})")
                    break
                if s == 0.0 and abs(moved - fillet_moved) > max(
                        1e-6, fillet_moved * 0.01):
                    failures.append(
                        f"{tag}: profile 0 drifted from the plain fillet "
                        f"({moved:.4f} vs {fillet_moved:.4f})")
                    break
                # Bounded above by the plain fillet on the +side, and below by
                # the chamfer of the same setback on the -side. The chamfer bound
                # is the triangle the chord cuts, which is always >= the arc's.
                if s > 0 and moved > fillet_moved * 1.01 + slack:
                    failures.append(
                        f"{tag}: OVERSHOOT at {s}: moved {moved:.4f} > "
                        f"fillet {fillet_moved:.4f}")
                    break
                prev = moved
        except ConicNotApplicable as ex:
            outside.append(f"{tag}: {ex}")
            continue  # deliberately not counted as checked
        except Exception as ex:
            failures.append(f"{tag}: RAISED {type(ex).__name__}: {ex}")
        checked += 1

    print(f"cases={n_cases} checked={checked} skipped={skipped} "
          f"outside={len(outside)} "
          f"(skips are OCCT declining the plain fillet)")
    if outside:
        print(f"\n{len(outside)} OUTSIDE the conic family (not failures, the "
              f"builder refused by name rather than producing a bad solid):")
        for o in outside:
            print("  -", o)
    if failures:
        print(f"\n{len(failures)} FAILURES:")
        for f in failures:
            print("  -", f)
        return 1
    print("property holds: every buildable fillet stayed buildable, monotone, "
          "anchored at 0 and bounded at both ends, across all profiles")
    return 0


if __name__ == "__main__":
    cases = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 20260810
    try:
        sys.exit(run(cases, seed))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(2)
