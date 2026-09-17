"""Small exact-geometry helpers shared by every tool in this plugin.

Plain tuples for vectors, OCP for anything that touches the kernel.
"""

import math

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_IN, TopAbs_ON, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_ListOfShape
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec

BUILD_DIRS = {
    "+X": (1.0, 0.0, 0.0), "-X": (-1.0, 0.0, 0.0),
    "+Y": (0.0, 1.0, 0.0), "-Y": (0.0, -1.0, 0.0),
    "+Z": (0.0, 0.0, 1.0), "-Z": (0.0, 0.0, -1.0),
}


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a)
    return (a[0] / n, a[1] / n, a[2] / n)


def lin(origin, *terms):
    """origin + sum(scale * vector) for (scale, vector) pairs."""
    out = origin
    for s, v in terms:
        out = add(out, mul(v, s))
    return out


def build_dir(f, label):
    key = f.get("buildDir") or "+Z"
    d = BUILD_DIRS.get(key)
    if d is None:
        raise ValueError(f"{label}: unknown build direction {key!r}")
    return d


def perp_frame(n, hint=(1.0, 0.0, 0.0)):
    """Two unit vectors spanning the plane normal to `n`, the first as close to `hint` as it can be."""
    x = sub(hint, mul(n, dot(hint, n)))
    if norm(x) < 1e-6:
        x = sub((0.0, 1.0, 0.0), mul(n, n[1]))
    x = unit(x)
    return x, cross(n, x)


def gp(p):
    return gp_Pnt(p[0], p[1], p[2])


def prism(points, vec):
    """A closed planar polygon swept along `vec`, as a TopoDS solid."""
    poly = BRepBuilderAPI_MakePolygon()
    for p in points:
        poly.Add(gp(p))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
    mk = BRepPrimAPI_MakePrism(face, gp_Vec(*vec))
    mk.Build()
    return mk.Shape()


def face_prism(face_topods, vec):
    mk = BRepPrimAPI_MakePrism(face_topods, gp_Vec(*vec))
    mk.Build()
    return mk.Shape()


def disc(center, axis, radius, height):
    """A cylinder whose bottom disc is centred on `center`, rising `height` along `axis`."""
    ax = gp_Ax2(gp(center), gp_Dir(*axis))
    return BRepPrimAPI_MakeCylinder(ax, radius, height).Shape()


def solids(topods):
    topods = getattr(topods, "wrapped", topods)
    out = []
    ex = TopExp_Explorer(topods, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


def inside(topods, p, tol=1e-6):
    """True when `p` is in the material of any solid of the shape, ON counts as not inside."""
    for s in solids(topods):
        c = BRepClass3d_SolidClassifier(s, gp(p), tol)
        st = c.State()
        if st == TopAbs_IN:
            return True
        if st == TopAbs_ON:
            return False
    return False


def volume(topods):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(topods, props)
    return props.Mass()


def _run_bool(op, base, tools, label, verb):
    args = TopTools_ListOfShape()
    args.Append(base)
    tl = TopTools_ListOfShape()
    for t in tools:
        tl.Append(t)
    op.SetArguments(args)
    op.SetTools(tl)
    op.SetRunParallel(True)
    op.Build()
    if not op.IsDone():
        raise ValueError(f"{label}: the geometry engine could not {verb} this body")
    out = op.Shape()
    if out is None or out.IsNull() or not BRepCheck_Analyzer(out).IsValid():
        raise ValueError(f"{label}: {verb} produced an invalid solid")
    return out


def cut(base, tools, label):
    return _run_bool(BRepAlgoAPI_Cut(), base, tools, label, "cut")


def fuse(base, tools, label):
    return _run_bool(BRepAlgoAPI_Fuse(), base, tools, label, "join")


def common(a, b):
    op = BRepAlgoAPI_Common(a, b)
    op.Build()
    return op.Shape() if op.IsDone() else None


def simplify(topods):
    """Merge the faces a boolean split along a shared surface, best effort."""
    try:
        from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

        up = ShapeUpgrade_UnifySameDomain(topods, True, True, True)
        up.Build()
        out = up.Shape()
        if out is not None and not out.IsNull() and BRepCheck_Analyzer(out).IsValid():
            return out
    except Exception:
        pass
    return topods
