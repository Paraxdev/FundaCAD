#pragma once
// The rebuild cache's restore check, sidecar/rebuild_cache.py `_body_fingerprint`.
// The box must not use triangulation: a body is meshed when its checkpoint is
// written and never when it is restored, which moves such a box by up to 0.5 mm.

#include "rust/cxx.h"
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <Standard_Failure.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Shape.hxx>

inline bool geom_cache_fingerprint(const TopoDS_Shape &shape, rust::Slice<double> out) {
  if (shape.IsNull() || out.size() < 9) return false;
  try {
    const TopAbs_ShapeEnum kinds[3] = {TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX};
    for (int k = 0; k < 3; ++k) {
      TopTools_IndexedMapOfShape map;
      TopExp::MapShapes(shape, kinds[k], map);
      out[k] = map.Extent();
    }
    Bnd_Box box;
    BRepBndLib::Add(shape, box, false);
    if (box.IsVoid()) {
      for (int k = 3; k < 9; ++k) out[k] = 0.0;
      return true;
    }
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    out[3] = x0; out[4] = y0; out[5] = z0;
    out[6] = x1; out[7] = y1; out[8] = z1;
    return true;
  } catch (const Standard_Failure &) {
    return false;
  }
}
