#pragma once
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <GProp_PrincipalProps.hxx>
#include <bindings_common.hxx>
#include <gp_Mat.hxx>
#include <stdexcept>

inline void BRepGProp_properties(const TopoDS_Shape &shape, int kind, bool skip_shared, rust::Slice<double> out) {
  if (out.size() < 16) {
    throw std::invalid_argument("properties need 16 slots");
  }
  GProp_GProps props;
  switch (kind) {
  case 1:
    BRepGProp::LinearProperties(shape, props, skip_shared);
    break;
  case 2:
    BRepGProp::SurfaceProperties(shape, props, skip_shared);
    break;
  case 3:
    BRepGProp::VolumeProperties(shape, props, Standard_False, skip_shared);
    break;
  default:
    throw std::invalid_argument("property kind is 1 linear, 2 surface or 3 volume");
  }
  out[0] = props.Mass();
  gp_Pnt centre = props.CentreOfMass();
  out[1] = centre.X();
  out[2] = centre.Y();
  out[3] = centre.Z();
  gp_Mat inertia = props.MatrixOfInertia();
  for (int row = 1; row <= 3; ++row) {
    for (int col = 1; col <= 3; ++col) {
      out[3 + (row - 1) * 3 + col] = inertia.Value(row, col);
    }
  }
  Standard_Real ixx = 0.0, iyy = 0.0, izz = 0.0;
  props.PrincipalProperties().Moments(ixx, iyy, izz);
  out[13] = ixx;
  out[14] = iyy;
  out[15] = izz;
}
