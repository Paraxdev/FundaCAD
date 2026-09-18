// Joint placement: the rigid move that mates one connector frame onto another,
// composed the way the Python engine's `joints.py` composes build123d Locations.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>
#include <gp_EulerSequence.hxx>
#include <gp_Pnt.hxx>
#include <gp_Quaternion.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <cmath>
#include <memory>
#include <stdexcept>

// build123d `Plane(origin, x_dir, z_dir).location`; `frame` is origin, z, x
// and an x of zero length means no x was given.
inline gp_Trsf jt_frame_location(rust::Slice<const double> frame) {
  if (frame.size() < 9) throw std::invalid_argument("a frame takes 9 values");
  gp_Pnt o(frame[0], frame[1], frame[2]);
  gp_Dir z(frame[3], frame[4], frame[5]);
  double xl = std::sqrt(frame[6] * frame[6] + frame[7] * frame[7] + frame[8] * frame[8]);
  gp_Ax3 ax = xl > 0 ? gp_Ax3(o, z, gp_Dir(frame[6], frame[7], frame[8])) : gp_Ax3(o, z);
  gp_Ax3 cs(o, z, ax.XDirection());
  gp_Trsf t;
  t.SetTransformation(cs);
  t.Invert();
  return t;
}

// build123d `Location((0, 0, dz), (rx, 0, rz))`.
inline gp_Trsf jt_location(double dz, double rx, double rz) {
  gp_Quaternion q;
  q.SetEulerAngles(gp_Intrinsic_XYZ, rx * M_PI / 180.0, 0.0, rz * M_PI / 180.0);
  gp_Trsf t;
  t.SetRotation(q);
  t.SetTranslationPart(gp_Vec(0, 0, dz));
  return t;
}

inline std::unique_ptr<TopoDS_Shape> jt_mated(const TopoDS_Shape &shape,
                                              rust::Slice<const double> fixed,
                                              rust::Slice<const double> moving, double offset,
                                              double angle, bool flush) {
  gp_Trsf fix = jt_frame_location(fixed);
  gp_Trsf mov = jt_frame_location(moving);
  gp_Trsf adj = jt_location(offset, 0, angle);
  if (!flush) adj.Multiply(jt_location(0, 180, 0));
  gp_Trsf place = fix;
  place.Multiply(adj);
  place.Multiply(mov.Inverted());
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(shape.Moved(TopLoc_Location(place))));
}
