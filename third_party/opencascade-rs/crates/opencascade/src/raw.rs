//! The raw OpenCASCADE handle under a [`Shape`], for crates that bind their own
//! operations in `opencascade-sys` and still hand shapes to this crate.

use crate::primitives::Shape;
use cxx::UniquePtr;
use opencascade_sys::topo_ds::TopoDS_Shape;

impl Shape {
    pub fn from_raw(inner: UniquePtr<TopoDS_Shape>) -> Self {
        Self { inner }
    }

    /// A shape sharing `shape`'s topology (a handle copy, not a deep copy).
    pub fn from_raw_ref(shape: &TopoDS_Shape) -> Self {
        Self::from_shape(shape)
    }

    pub fn raw(&self) -> &TopoDS_Shape {
        &self.inner
    }

    pub fn raw_pin(&mut self) -> std::pin::Pin<&mut TopoDS_Shape> {
        self.inner.pin_mut()
    }
}

impl Clone for Shape {
    fn clone(&self) -> Self {
        Self::from_shape(&self.inner)
    }
}
