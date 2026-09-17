//! STEP through an XCAF document, replaces `exporters.export` for STEP and
//! `export_tree.build_export_tree` of the sidecar.

use std::path::Path;

use opencascade::primitives::Shape;

/// A shape, its product name and its sRGB colour.
pub type Leaf<'a> = (&'a Shape, Option<&'a str>, Option<[u8; 3]>);

pub fn write_flat(_leaves: &[Leaf<'_>], _root: Option<&str>, _path: &Path) -> Result<(), String> {
    Err("STEP export is not ported yet".into())
}
