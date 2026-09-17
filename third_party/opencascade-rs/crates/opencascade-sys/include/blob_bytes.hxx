#pragma once
// Binary BREP in memory, pinned to BinTools format V3 with triangles, as
// sidecar/geomstore.py `serialize_shape` writes the blob store's bytes.

#include "rust/cxx.h"
#include <BinTools.hxx>
#include <BinTools_FormatVersion.hxx>
#include <TopoDS_Shape.hxx>
#include <bindings_common.hxx>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

inline rust::Vec<uint8_t> blob_bytes_write_v3(const TopoDS_Shape &shape) {
  std::ostringstream out(std::ios::out | std::ios::binary);
  BinTools::Write(shape, out, true, false, BinTools_FormatVersion_VERSION_3);
  std::string data = out.str();
  rust::Vec<uint8_t> bytes;
  bytes.reserve(data.size());
  for (char c : data) {
    bytes.push_back(static_cast<uint8_t>(c));
  }
  return bytes;
}

inline std::unique_ptr<TopoDS_Shape> blob_bytes_read(rust::Slice<const uint8_t> data) {
  std::istringstream in(std::string(reinterpret_cast<const char *>(data.data()), data.size()),
                        std::ios::in | std::ios::binary);
  std::unique_ptr<TopoDS_Shape> shape(new TopoDS_Shape());
  BinTools::Read(*shape, in);
  if (shape->IsNull()) {
    throw std::runtime_error("binary BREP decoded to a null shape");
  }
  return shape;
}
