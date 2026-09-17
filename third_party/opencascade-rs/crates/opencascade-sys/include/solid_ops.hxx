#pragma once
#include <BRepBuilderAPI_MakeFace.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <bindings_common.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pln.hxx>
#include <stdexcept>

inline std::unique_ptr<TopoDS_Shape> solid_ops_plane_face(rust::Slice<const double> origin,
                                                          rust::Slice<const double> normal,
                                                          rust::Slice<const double> xdir) {
  if (origin.size() < 3 || normal.size() < 3 || xdir.size() < 3) {
    throw std::invalid_argument("origin, normal and xdir take 3 values");
  }
  gp_Ax3 frame(gp_Pnt(origin[0], origin[1], origin[2]), gp_Dir(normal[0], normal[1], normal[2]),
               gp_Dir(xdir[0], xdir[1], xdir[2]));
  gp_Pln plane(frame);
  BRepBuilderAPI_MakeFace maker(plane);
  if (!maker.IsDone()) {
    throw std::runtime_error("the plane face did not build");
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(maker.Face()));
}
