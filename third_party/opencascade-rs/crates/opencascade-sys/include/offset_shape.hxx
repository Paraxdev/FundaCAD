#pragma once
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <Message_ProgressRange.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <bindings_common.hxx>
#include <stdexcept>

inline BRepOffset_Mode fc_offset_mode(int mode) {
  switch (mode) {
  case 0:
    return BRepOffset_Skin;
  case 1:
    return BRepOffset_Pipe;
  case 2:
    return BRepOffset_RectoVerso;
  default:
    throw std::invalid_argument("offset mode is 0 skin, 1 pipe or 2 recto verso");
  }
}

inline GeomAbs_JoinType fc_offset_join(int join) {
  switch (join) {
  case 0:
    return GeomAbs_Arc;
  case 1:
    return GeomAbs_Tangent;
  case 2:
    return GeomAbs_Intersection;
  default:
    throw std::invalid_argument("join is 0 arc, 1 tangent or 2 intersection");
  }
}

inline std::unique_ptr<TopoDS_Shape>
BRepOffset_MakeOffset_run(const TopoDS_Shape &shape, double offset, double tolerance, int mode, bool intersection,
                          bool self_intersection, int join, bool thickening, bool remove_internal_edges,
                          const TopTools_ListOfShape &faces, rust::Slice<const double> face_offsets,
                          const TopTools_ListOfShape &closing_faces, bool thick_solid,
                          const Message_ProgressRange &progress, int &error) {
  if (static_cast<size_t>(faces.Extent()) != face_offsets.size()) {
    throw std::invalid_argument("one offset per face");
  }
  BRepOffset_MakeOffset maker;
  maker.Initialize(shape, offset, tolerance, fc_offset_mode(mode), intersection, self_intersection,
                   fc_offset_join(join), thickening, remove_internal_edges);
  size_t i = 0;
  for (TopTools_ListOfShape::Iterator it(faces); it.More(); it.Next(), ++i) {
    maker.SetOffsetOnFace(TopoDS::Face(it.Value()), face_offsets[i]);
  }
  for (TopTools_ListOfShape::Iterator it(closing_faces); it.More(); it.Next()) {
    maker.AddFace(TopoDS::Face(it.Value()));
  }
  if (thick_solid) {
    maker.MakeThickSolid(progress);
  } else {
    maker.MakeOffsetShape(progress);
  }
  error = static_cast<int>(maker.Error());
  if (!maker.IsDone()) {
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(maker.Shape()));
}

inline std::unique_ptr<TopoDS_Shape>
BRepOffsetAPI_MakeThickSolid_join(const TopoDS_Shape &shape, const TopTools_ListOfShape &closing_faces, double offset,
                                  double tolerance, bool intersection, bool self_intersection, int join,
                                  bool remove_internal_edges, const Message_ProgressRange &progress) {
  BRepOffsetAPI_MakeThickSolid maker;
  maker.MakeThickSolidByJoin(shape, closing_faces, offset, tolerance, BRepOffset_Skin, intersection,
                             self_intersection, fc_offset_join(join), remove_internal_edges, progress);
  if (!maker.IsDone()) {
    throw std::runtime_error("MakeThickSolidByJoin did not finish");
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(maker.Shape()));
}

inline std::unique_ptr<TopoDS_Shape> BRepOffsetAPI_MakeThickSolid_simple(const TopoDS_Shape &shape, double offset) {
  BRepOffsetAPI_MakeThickSolid maker;
  maker.MakeThickSolidBySimple(shape, offset);
  if (!maker.IsDone()) {
    throw std::runtime_error("MakeThickSolidBySimple did not finish");
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(maker.Shape()));
}
