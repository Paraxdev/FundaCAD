#include <Message_ProgressRange.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeFix_Wire.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Wire.hxx>
#include <bindings_common.hxx>
#include <stdexcept>

// ShapeFix tools are Standard_Transient, so each is held by a handle for the
// one call rather than owned by a unique_ptr.

inline std::unique_ptr<TopoDS_Shape> ShapeFix_Shape_perform(const TopoDS_Shape &shape, double precision,
                                                            double min_tolerance, double max_tolerance,
                                                            const Message_ProgressRange &progress, bool &modified) {
  Handle(ShapeFix_Shape) fix = new ShapeFix_Shape(shape);
  if (precision > 0.0) {
    fix->SetPrecision(precision);
  }
  if (min_tolerance > 0.0) {
    fix->SetMinTolerance(min_tolerance);
  }
  if (max_tolerance > 0.0) {
    fix->SetMaxTolerance(max_tolerance);
  }
  modified = fix->Perform(progress);
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(fix->Shape()));
}

inline std::unique_ptr<TopoDS_Shape> ShapeFix_Solid_perform(const TopoDS_Shape &shape, double precision,
                                                            double max_tolerance) {
  Handle(ShapeFix_Solid) fix = new ShapeFix_Solid();
  if (precision > 0.0) {
    fix->SetPrecision(precision);
  }
  if (max_tolerance > 0.0) {
    fix->SetMaxTolerance(max_tolerance);
  }
  switch (shape.ShapeType()) {
  case TopAbs_SHELL:
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(fix->SolidFromShell(TopoDS::Shell(shape))));
  case TopAbs_SOLID:
    fix->Init(TopoDS::Solid(shape));
    fix->Perform();
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(fix->Solid()));
  default:
    throw std::invalid_argument("ShapeFix_Solid takes a solid or a shell");
  }
}

inline std::unique_ptr<TopoDS_Wire> ShapeFix_Wire_perform(const TopoDS_Wire &wire, const TopoDS_Face &face,
                                                          double precision, bool &modified) {
  Handle(ShapeFix_Wire) fix = new ShapeFix_Wire(wire, face, precision);
  modified = fix->Perform();
  return std::unique_ptr<TopoDS_Wire>(new TopoDS_Wire(fix->WireAPIMake()));
}

// Result, not Face: a missing seam fix can split the face into a compound.
inline std::unique_ptr<TopoDS_Shape> ShapeFix_Face_perform(const TopoDS_Face &face, double precision,
                                                           bool &modified) {
  Handle(ShapeFix_Face) fix = new ShapeFix_Face(face);
  if (precision > 0.0) {
    fix->SetPrecision(precision);
  }
  modified = fix->Perform();
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(fix->Result()));
}
