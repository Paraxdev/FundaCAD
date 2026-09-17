#pragma once
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BinTools.hxx>
#include <Message_ProgressRange.hxx>
#include <bindings_common.hxx>
#include <sstream>
#include <stdexcept>

inline rust::Vec<std::uint8_t> BinTools_write_bytes(const TopoDS_Shape &shape, bool with_triangles, bool with_normals,
                                                    int version, const Message_ProgressRange &progress) {
  if (version < 0 || version > BinTools_FormatVersion_UPPER) {
    throw std::invalid_argument("BinTools format version out of range");
  }
  BinTools_FormatVersion format =
      version == 0 ? BinTools_FormatVersion_CURRENT : static_cast<BinTools_FormatVersion>(version);
  std::ostringstream stream(std::ios::out | std::ios::binary);
  BinTools::Write(shape, stream, with_triangles, with_normals, format, progress);
  if (!stream) {
    throw std::runtime_error("BinTools::Write failed");
  }
  const std::string data = stream.str();
  rust::Vec<std::uint8_t> out;
  out.reserve(data.size());
  for (char c : data) {
    out.push_back(static_cast<std::uint8_t>(c));
  }
  return out;
}

inline std::unique_ptr<TopoDS_Shape> BinTools_read_bytes(rust::Slice<const std::uint8_t> bytes,
                                                         const Message_ProgressRange &progress) {
  std::istringstream stream(std::string(reinterpret_cast<const char *>(bytes.data()), bytes.size()),
                            std::ios::in | std::ios::binary);
  auto shape = std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
  BinTools::Read(*shape, stream, progress);
  if (shape->IsNull()) {
    throw std::runtime_error("BinTools::Read found no shape");
  }
  return shape;
}

inline rust::String BRepTools_write_string(const TopoDS_Shape &shape, bool with_triangles, bool with_normals,
                                           int version, const Message_ProgressRange &progress) {
  if (version < 0 || version > TopTools_FormatVersion_UPPER) {
    throw std::invalid_argument("BRep format version out of range");
  }
  TopTools_FormatVersion format =
      version == 0 ? TopTools_FormatVersion_CURRENT : static_cast<TopTools_FormatVersion>(version);
  std::ostringstream stream;
  BRepTools::Write(shape, stream, with_triangles, with_normals, format, progress);
  return rust::String(stream.str());
}

inline std::unique_ptr<TopoDS_Shape> BRepTools_read_string(rust::Str text, const Message_ProgressRange &progress) {
  std::istringstream stream(std::string(text.data(), text.size()));
  auto shape = std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
  BRep_Builder builder;
  BRepTools::Read(*shape, stream, builder, progress);
  if (shape->IsNull()) {
    throw std::runtime_error("BRepTools::Read found no shape");
  }
  return shape;
}

inline std::unique_ptr<TopoDS_Shape> BRepBuilderAPI_Copy_shape(const TopoDS_Shape &shape, bool copy_geometry,
                                                               bool copy_mesh) {
  BRepBuilderAPI_Copy copy(shape, copy_geometry, copy_mesh);
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(copy.Shape()));
}
