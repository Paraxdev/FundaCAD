"""The `generateShape` op: a solid a plugin makes from parameters, outside any document.

Two outputs. "mesh" is for a preview the window draws itself. "store" writes the
solid into the blob store and answers with the fields of an `import` feature, so
what the window then adds to the document is imported geometry in every respect:
it rebuilds from the blob, travels inside the saved container, and never needs
the plugin that generated it again.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
import plugin_geometry
from shape_util import _shape_to_blob, _wrap_topods

MAX_PREVIEW_TRIANGLES = 400_000


def _as_shape(made):
    if made is None:
        raise ValueError("the generator made nothing")
    if not hasattr(made, "wrapped"):
        made = _wrap_topods(made)
    if made is None or made.wrapped is None or made.wrapped.IsNull():
        raise ValueError("the generator made an empty shape")
    return made


def _vec(v, what):
    try:
        x, y, z = (float(c) for c in v)
    except (TypeError, ValueError):
        raise ValueError(f"placement {what} must be three numbers")
    if not all(math.isfinite(c) for c in (x, y, z)):
        raise ValueError(f"placement {what} must be finite")
    return x, y, z


def place(shape, placement):
    """Carry the shape's local origin to `origin` and its +Z to `zAxis`."""
    from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf

    from build123d import Location

    ox, oy, oz = _vec(placement.get("origin") or (0, 0, 0), "origin")
    zx, zy, zz = _vec(placement.get("zAxis") or (0, 0, 1), "zAxis")
    n = math.sqrt(zx * zx + zy * zy + zz * zz)
    if n < 1e-9:
        raise ValueError("placement zAxis must not be zero")
    trsf = gp_Trsf()
    trsf.SetTransformation(gp_Ax3(gp_Pnt(ox, oy, oz), gp_Dir(zx / n, zy / n, zz / n)), gp_Ax3())
    return shape.moved(Location(trsf))


def _measure(shape):
    from OCP.BRepCheck import BRepCheck_Analyzer

    bb = shape.bounding_box()
    solids = shape.solids()
    return {
        "solid": len(solids) > 0,
        "solids": len(solids),
        "valid": bool(BRepCheck_Analyzer(shape.wrapped).IsValid()),
        "faces": len(shape.faces()),
        "volume": float(sum(s.volume for s in solids)),
        "bbox": {"min": [bb.min.X, bb.min.Y, bb.min.Z], "max": [bb.max.X, bb.max.Y, bb.max.Z]},
    }


def _mesh(shape):
    from tessellate import tessellate

    bb = shape.bounding_box()
    size = max(bb.size.X, bb.size.Y, bb.size.Z, 1e-3)
    normals = []
    positions, indices, _faces = tessellate(
        shape, tolerance=max(0.002, size * 0.0015), angular_tolerance=0.3, normals_out=normals,
    )
    if len(indices) // 3 > MAX_PREVIEW_TRIANGLES:
        raise ValueError("this shape is too detailed to preview")
    flat = []
    for base, chunk in sorted(normals, key=lambda c: c[0]):
        if base * 3 != len(flat):
            flat = []
            break
        flat.extend(chunk)
    return {
        "positions": [round(v, 5) for v in positions],
        "indices": list(indices),
        "normals": [round(v, 4) for v in flat] if len(flat) == len(positions) else [],
    }


def generate_shape(name, params, output="mesh", placement=None):
    build = plugin_geometry.generator_for(name)
    if build is None:
        raise ValueError(f"no plugin that is running offers the shape {name!r}")
    if output not in ("mesh", "store"):
        raise ValueError(f"unknown output {output!r}, expected mesh or store")
    shape = _as_shape(build(params or {}))
    if placement:
        shape = place(shape, placement)
    out = _measure(shape)
    if not out["solid"]:
        raise ValueError("the generator made no solid")
    if output == "mesh":
        out["mesh"] = _mesh(shape)
    else:
        out["geom"] = _shape_to_blob(shape)
    return out
