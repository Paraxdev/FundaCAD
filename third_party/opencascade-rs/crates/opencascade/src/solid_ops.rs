//! Construction helpers for the solid operations.

use crate::{primitives::Shape, Error};
use glam::DVec3;
use opencascade_sys as ffi;

impl Shape {
    /// The unbounded face of the plane through `origin` with `normal`, its
    /// u axis along `xdir`, what build123d hands a splitter for a `Plane`.
    pub fn plane_face(origin: DVec3, normal: DVec3, xdir: DVec3) -> Result<Shape, Error> {
        Ok(Shape::from_raw(ffi::solid_ops::solid_ops_plane_face(
            &origin.to_array(),
            &normal.to_array(),
            &xdir.to_array(),
        )?))
    }
}
