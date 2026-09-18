#pragma once
// Hidden line removal for sketch projection (fundacad-geom::projection), the
// sequence the Python engine's `projection.py` `_project_silhouette` runs.

#include "rust/cxx.h"
#include <BRepLib.hxx>
#include <BRep_Builder.hxx>
#include <HLRAlgo_Projector.hxx>
#include <HLRBRep_Algo.hxx>
#include <HLRBRep_HLRToShape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <memory>
#include <stdexcept>

// A compound of two compounds, the visible sharp edges (VCompound) then the
// visible outlines (OutLineVCompound), each edge given a 3D curve. The edges
// lie in the projector's own 2D frame, z = 0. frame is origin, normal, xdir.
inline std::unique_ptr<TopoDS_Shape> HLR_visible_outline(const TopoDS_Shape &shape, rust::Slice<const double> frame) {
  if (frame.size() < 9) throw std::invalid_argument("frame needs 9 values");
  if (shape.IsNull()) throw std::invalid_argument("null shape");
  gp_Ax2 ax2(gp_Pnt(frame[0], frame[1], frame[2]), gp_Dir(frame[3], frame[4], frame[5]),
             gp_Dir(frame[6], frame[7], frame[8]));
  Handle(HLRBRep_Algo) algo = new HLRBRep_Algo();
  algo->Add(shape);
  algo->Projector(HLRAlgo_Projector(ax2));
  algo->Update();
  algo->Hide();
  HLRBRep_HLRToShape hlr(algo);
  BRep_Builder bb;
  TopoDS_Compound out;
  bb.MakeCompound(out);
  TopoDS_Shape buckets[2] = {hlr.VCompound(), hlr.OutLineVCompound()};
  for (const TopoDS_Shape &bucket : buckets) {
    TopoDS_Compound part;
    bb.MakeCompound(part);
    if (!bucket.IsNull()) {
      for (TopExp_Explorer ex(bucket, TopAbs_EDGE); ex.More(); ex.Next()) {
        TopoDS_Edge e = TopoDS::Edge(ex.Current());
        BRepLib::BuildCurves3d(e);
        bb.Add(part, e);
      }
    }
    bb.Add(out, part);
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(out));
}
