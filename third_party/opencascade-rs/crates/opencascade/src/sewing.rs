//! `BRepBuilderAPI_Sewing` and `BRepTools_ReShape`.

use crate::{
    boolean_op::{shape_list, shapes_of},
    primitives::Shape,
    progress::ProgressRange,
    Error,
};
use cxx::UniquePtr;
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SewingOptions {
    pub tolerance: f64,
    pub cutting: bool,
    pub non_manifold: bool,
}

impl Default for SewingOptions {
    fn default() -> Self {
        Self { tolerance: 1e-6, cutting: true, non_manifold: false }
    }
}

pub struct Sewing {
    inner: UniquePtr<ffi::sewing::FcSewing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SewingCounts {
    pub free_edges: usize,
    pub multiple_edges: usize,
    pub degenerated_shapes: usize,
    pub deleted_faces: usize,
}

impl Sewing {
    pub fn run<'a>(
        shapes: impl IntoIterator<Item = &'a Shape>,
        options: SewingOptions,
        progress: &ProgressRange,
    ) -> Result<Self, Error> {
        let inner = ffi::sewing::BRepBuilderAPI_Sewing_run(
            &shape_list(shapes),
            options.tolerance,
            options.cutting,
            options.non_manifold,
            &progress.inner,
        )?;
        Ok(Self { inner })
    }

    pub fn shape(&self) -> Shape {
        Shape { inner: ffi::sewing::FcSewing_sewed_shape(&self.inner) }
    }

    pub fn counts(&self) -> SewingCounts {
        let mut out = [0; 4];
        ffi::sewing::FcSewing_counts(&self.inner, &mut out);
        SewingCounts {
            free_edges: out[0] as usize,
            multiple_edges: out[1] as usize,
            degenerated_shapes: out[2] as usize,
            deleted_faces: out[3] as usize,
        }
    }

    pub fn free_edges(&self) -> Vec<Shape> {
        shapes_of(ffi::sewing::FcSewing_free_edges(&self.inner))
    }

    /// Where an input face ended up in the sewn shape.
    pub fn modified(&self, input: &Shape) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::sewing::FcSewing_modified(&self.inner, &input.inner)? })
    }

    pub fn is_modified(&self, input: &Shape) -> bool {
        ffi::sewing::FcSewing_is_modified(&self.inner, &input.inner)
    }
}

/// Records sub-shape replacements and removals, then rebuilds a shape with them.
pub struct ReShape {
    inner: UniquePtr<ffi::sewing::FcReShape>,
}

impl Default for ReShape {
    fn default() -> Self {
        Self::new()
    }
}

impl ReShape {
    pub fn new() -> Self {
        Self { inner: ffi::sewing::BRepTools_ReShape_new() }
    }

    pub fn replace(&mut self, original: &Shape, replacement: &Shape) -> Result<(), Error> {
        Ok(ffi::sewing::FcReShape_replace(&self.inner, &original.inner, &replacement.inner)?)
    }

    pub fn remove(&mut self, shape: &Shape) -> Result<(), Error> {
        Ok(ffi::sewing::FcReShape_remove(&self.inner, &shape.inner)?)
    }

    pub fn is_recorded(&self, shape: &Shape) -> bool {
        ffi::sewing::FcReShape_is_recorded(&self.inner, &shape.inner)
    }

    /// The recorded replacement of `shape`, itself when none, null when removed.
    pub fn value(&self, shape: &Shape) -> Shape {
        Shape { inner: ffi::sewing::FcReShape_value(&self.inner, &shape.inner) }
    }

    pub fn apply(&self, shape: &Shape) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::sewing::FcReShape_apply(&self.inner, &shape.inner)? })
    }
}
