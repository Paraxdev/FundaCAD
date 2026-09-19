//! STEP through XCAF documents: a writer carrying product names and colours,
//! a reader returning the product tree with world placed leaves, and binary
//! BREP bytes for the blob store.

use crate::primitives::Shape;
use crate::Error;
use cxx::UniquePtr;
use crate::progress::ProgressRange;
use crate::shape_io::BrepWriteOptions;
use opencascade_sys::xcaf as ffi;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

// The XCAF application, the STEP controllers and Interface_Static are process
// globals, and two writers at once raise from inside the transfer.
static STEP_LOCK: Mutex<()> = Mutex::new(());

fn step_lock() -> MutexGuard<'static, ()> {
    STEP_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn path_str(path: &Path) -> Result<&str, Error> {
    path.to_str().ok_or(Error::InvalidInput("the path is not valid UTF-8"))
}

pub struct StepWriter {
    inner: UniquePtr<ffi::XcafStepWriter>,
    _lock: MutexGuard<'static, ()>,
}

impl StepWriter {
    pub fn new() -> Result<Self, Error> {
        let lock = step_lock();
        Ok(Self { inner: ffi::xcaf_step_writer_new()?, _lock: lock })
    }

    /// Adds a root, or a component under the node `parent` returned earlier.
    /// `color` is sRGB in 0..=1.
    pub fn add(
        &mut self,
        shape: &Shape,
        parent: Option<usize>,
        name: Option<&str>,
        color: Option<[f64; 3]>,
    ) -> Result<usize, Error> {
        let [r, g, b] = color.unwrap_or_default();
        let parent = parent.map_or(-1, |p| i32::try_from(p).unwrap_or(i32::MAX));
        let index = ffi::xcaf_step_writer_add(
            self.inner.pin_mut(),
            &shape.inner,
            parent,
            name.unwrap_or(""),
            color.is_some(),
            r,
            g,
            b,
        )?;
        usize::try_from(index).map_err(|_| Error::OperationFailed("adding a shape to the XCAF document"))
    }

    pub fn write(&mut self, header_name: Option<&str>, path: &Path) -> Result<(), Error> {
        ffi::xcaf_step_writer_write(self.inner.pin_mut(), header_name.unwrap_or(""), path_str(path)?)?;
        Ok(())
    }
}

fn rgb(packed: i32) -> Option<[u8; 3]> {
    (packed >= 0).then(|| [(packed >> 16) as u8, (packed >> 8) as u8, packed as u8])
}

pub struct StepNode {
    /// The name on the product label.
    pub name: String,
    /// The name on the instance label, the fallback for an unnamed product.
    pub instance_name: String,
    pub parent: Option<usize>,
    /// This label's own colour, the instance's before the product's.
    pub color: Option<[u8; 3]>,
}

pub struct StepLeaf {
    pub node: usize,
    pub shape: Shape,
    /// One entry per face, present when any face is coloured.
    pub face_colors: Option<Vec<Option<[u8; 3]>>>,
    pub solid_color: Option<[u8; 3]>,
    /// The product solid this leaf places, keyed per product and solid, in
    /// the product's own frame. None for a leaf that is no solid.
    pub product: Option<(String, Shape)>,
}

pub struct StepAssembly {
    pub nodes: Vec<StepNode>,
    pub leaves: Vec<StepLeaf>,
    pub roots: Vec<Shape>,
    pub is_assembly: bool,
    raw: UniquePtr<ffi::StepAssembly>,
}

impl StepAssembly {
    /// `shape` moved by leaf `leaf`'s placement.
    pub fn place(&self, leaf: usize, shape: &Shape) -> Result<Shape, Error> {
        let a = self.raw.as_ref().ok_or(Error::StepReadFailed)?;
        Ok(Shape { inner: ffi::step_assembly_leaf_place(a, leaf as i32, &shape.inner)? })
    }
}

pub fn read_step_assembly(path: &Path) -> Result<StepAssembly, Error> {
    read_step_assembly_with(path, &ProgressRange::detached())
}

/// [`read_step_assembly`] reporting its transfer into `progress`, which OCCT
/// polls between entities and faces, so a cancel stops it there.
pub fn read_step_assembly_with(path: &Path, progress: &ProgressRange) -> Result<StepAssembly, Error> {
    let lock = step_lock();
    let a = ffi::step_assembly_read(path_str(path)?, progress.raw())?;
    drop(lock);
    let raw = a;
    let a = raw.as_ref().ok_or(Error::StepReadFailed)?;
    let mut nodes = Vec::new();
    for i in 0..ffi::step_assembly_node_count(a) {
        let raw = ffi::step_assembly_node_names(a, i)?;
        let mut parts = raw.split(|&b| b == 0);
        let name = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
        let instance_name = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
        nodes.push(StepNode {
            name,
            instance_name,
            parent: usize::try_from(ffi::step_assembly_node_parent(a, i)?).ok(),
            color: rgb(ffi::step_assembly_node_color(a, i)?),
        });
    }
    let mut leaves = Vec::new();
    for i in 0..ffi::step_assembly_leaf_count(a) {
        let colors = ffi::step_assembly_leaf_face_colors(a, i)?;
        leaves.push(StepLeaf {
            node: usize::try_from(ffi::step_assembly_leaf_node(a, i)?).unwrap_or(0),
            shape: Shape { inner: ffi::step_assembly_leaf_shape(a, i)? },
            face_colors: (!colors.is_empty()).then(|| colors.iter().map(|&c| rgb(c)).collect()),
            solid_color: rgb(ffi::step_assembly_leaf_solid_color(a, i)?),
            product: {
                let key = ffi::step_assembly_leaf_product(a, i)?.to_string();
                if key.is_empty() {
                    None
                } else {
                    Some((key, Shape { inner: ffi::step_assembly_leaf_local(a, i)? }))
                }
            },
        });
    }
    let mut roots = Vec::new();
    for i in 0..ffi::step_assembly_root_count(a) {
        roots.push(Shape { inner: ffi::step_assembly_root_shape(a, i)? });
    }
    let is_assembly = ffi::step_assembly_is_assembly(a);
    Ok(StepAssembly { nodes, leaves, roots, is_assembly, raw })
}

/// Binary BREP, BinTools format V3 with triangles.
pub fn to_bin_v3(shape: &Shape) -> Result<Vec<u8>, Error> {
    shape.to_brep_bytes(
        BrepWriteOptions { with_triangles: true, with_normals: false, version: 3 },
        &ProgressRange::detached(),
    )
}

pub fn from_bin(data: &[u8]) -> Result<Shape, Error> {
    Shape::from_brep_bytes(data, &ProgressRange::detached())
}
