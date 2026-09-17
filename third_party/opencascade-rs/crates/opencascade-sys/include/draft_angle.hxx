#pragma once
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <bindings_common.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <stdexcept>

inline std::unique_ptr<TopoDS_Shape> BRepOffsetAPI_DraftAngle_run(const TopoDS_Shape &shape,
                                                                  const TopTools_ListOfShape &faces,
                                                                  rust::Slice<const double> direction, double angle,
                                                                  rust::Slice<const double> plane_origin,
                                                                  rust::Slice<const double> plane_normal,
                                                                  int &refused) {
  if (direction.size() < 3 || plane_origin.size() < 3 || plane_normal.size() < 3) {
    throw std::invalid_argument("direction, origin and normal take 3 values");
  }
  gp_Dir pull(direction[0], direction[1], direction[2]);
  gp_Pln neutral(gp_Pnt(plane_origin[0], plane_origin[1], plane_origin[2]),
                 gp_Dir(plane_normal[0], plane_normal[1], plane_normal[2]));
  BRepOffsetAPI_DraftAngle drafter(shape);
  refused = 0;
  int index = 0;
  for (TopTools_ListOfShape::Iterator it(faces); it.More(); it.Next()) {
    ++index;
    drafter.Add(TopoDS::Face(it.Value()), pull, angle, neutral);
    // After a refused Add the drafter takes no more faces.
    if (!drafter.AddDone()) {
      refused = index;
      return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
    }
  }
  drafter.Build();
  if (!drafter.IsDone()) {
    throw std::runtime_error("the draft did not build");
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(drafter.Shape()));
}
