//! BREP to and from memory, binary (`BinTools`) and ASCII (`BRepTools`), and
//! deep copies (`BRepBuilderAPI_Copy`).

use crate::{primitives::Shape, progress::ProgressRange, Error};
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrepWriteOptions {
    pub with_triangles: bool,
    pub with_normals: bool,
    /// 0 for the kernel's current format version.
    pub version: i32,
}

impl Default for BrepWriteOptions {
    fn default() -> Self {
        Self { with_triangles: false, with_normals: false, version: 0 }
    }
}

impl Shape {
    pub fn to_brep_bytes(&self, options: BrepWriteOptions, progress: &ProgressRange) -> Result<Vec<u8>, Error> {
        Ok(ffi::shape_io::BinTools_write_bytes(
            &self.inner,
            options.with_triangles,
            options.with_normals,
            options.version,
            &progress.inner,
        )?)
    }

    pub fn from_brep_bytes(bytes: &[u8], progress: &ProgressRange) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::shape_io::BinTools_read_bytes(bytes, &progress.inner)? })
    }

    pub fn to_brep_text(&self, options: BrepWriteOptions, progress: &ProgressRange) -> Result<String, Error> {
        Ok(ffi::shape_io::BRepTools_write_string(
            &self.inner,
            options.with_triangles,
            options.with_normals,
            options.version,
            &progress.inner,
        )?)
    }

    pub fn from_brep_text(text: &str, progress: &ProgressRange) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::shape_io::BRepTools_read_string(text, &progress.inner)? })
    }

    /// Topology and, with `copy_geometry`, geometry no longer shared with `self`.
    pub fn deep_copy(&self, copy_geometry: bool, copy_mesh: bool) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::shape_io::BRepBuilderAPI_Copy_shape(&self.inner, copy_geometry, copy_mesh)? })
    }
}
