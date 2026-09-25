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

// Resource_FormatType values.
const CODEPAGE_SJIS: i32 = 0;
const CODEPAGE_UTF8: i32 = 4;
const CODEPAGE_GBK: i32 = 25;

/// Double byte text: every high byte either a `single` or a `lead` followed by
/// a `trail`. None when the bytes are not that, else how many pairs there are
/// and how many of them are `common`.
fn double_byte_fit(
    bytes: &[u8],
    lead: impl Fn(u8) -> bool,
    trail: impl Fn(u8) -> bool,
    single: impl Fn(u8) -> bool,
    common: impl Fn(u8, u8) -> bool,
) -> Option<(usize, usize)> {
    let (mut pairs, mut hits, mut i) = (0, 0, 0);
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 || single(b) {
            i += 1;
            continue;
        }
        let t = *bytes.get(i + 1)?;
        if !lead(b) || !trail(t) {
            return None;
        }
        pairs += 1;
        hits += usize::from(common(b, t));
        i += 2;
    }
    Some((pairs, hits))
}

/// The code page a STEP file's unescaped text is in, as a Resource_FormatType.
/// The standard wants anything beyond ASCII escaped, but CAD exports from
/// Chinese and Japanese systems write names in the local code page, which a
/// UTF-8 reading turns into Latin-1 mojibake.
pub fn step_codepage(bytes: &[u8]) -> i32 {
    if bytes.is_ascii() || std::str::from_utf8(bytes).is_ok() {
        return CODEPAGE_UTF8;
    }
    let gbk = double_byte_fit(
        bytes,
        |b| (0x81..=0xFE).contains(&b),
        |t| (0x40..=0x7E).contains(&t) || (0x80..=0xFE).contains(&t),
        |_| false,
        // GB2312, which nearly all Chinese text stays inside.
        |b, t| (0xA1..=0xF7).contains(&b) && t >= 0xA1,
    );
    if let Some((pairs, hits)) = gbk {
        if pairs > 0 && hits * 10 >= pairs * 9 {
            return CODEPAGE_GBK;
        }
    }
    let sjis = double_byte_fit(
        bytes,
        |b| (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b),
        |t| (0x40..=0x7E).contains(&t) || (0x80..=0xFC).contains(&t),
        |b| (0xA1..=0xDF).contains(&b),
        // Kana and the first level kanji.
        |b, _| (0x81..=0x9F).contains(&b),
    );
    if let Some((pairs, hits)) = sjis {
        if pairs > 0 && hits * 2 >= pairs {
            return CODEPAGE_SJIS;
        }
    }
    // OCCT reads each string that is valid UTF-8 as such and any other one as
    // Latin-1, which is right for a Western file and for one that mixes both.
    CODEPAGE_UTF8
}

pub fn read_step_assembly(path: &Path) -> Result<StepAssembly, Error> {
    read_step_assembly_with(path, &ProgressRange::detached())
}

/// [`read_step_assembly`] reporting its transfer into `progress`, which OCCT
/// polls between entities and faces, so a cancel stops it there.
pub fn read_step_assembly_with(path: &Path, progress: &ProgressRange) -> Result<StepAssembly, Error> {
    let codepage = std::fs::read(path).map_or(CODEPAGE_UTF8, |b| step_codepage(&b));
    let lock = step_lock();
    let a = ffi::step_assembly_read(path_str(path)?, codepage, progress.raw())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_pages_of_unescaped_names() {
        assert_eq!(step_codepage(b"#1 = PRODUCT ( 'plain', 'plain', '', ( #2 ) ) ;"), CODEPAGE_UTF8);
        assert_eq!(step_codepage("'M3\u{d7}18 \u{87ba}\u{4e1d}'".as_bytes()), CODEPAGE_UTF8);
        // The Ender-3 export's "4040 profile, 4 countersunk holes", in GBK.
        assert_eq!(step_codepage(b"'4040 profile\xa3\xac4\xb8\xf6\xb3\xc1\xcd\xb7\xbf\xd7'"), CODEPAGE_GBK);
        // "screw M3" in Shift_JIS.
        assert_eq!(step_codepage(b"'\x82\xcb\x82\xb6 M3'"), CODEPAGE_SJIS);
        // Latin-1: a high byte before ASCII is no double byte text.
        assert_eq!(step_codepage(b"'Gr\xf6\xdfe \xd820'"), CODEPAGE_UTF8);
    }
}
