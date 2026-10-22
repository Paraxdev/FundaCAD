//! The FundaCAD document files, shared by the app, the engine and the CLI; docs/FUNDA-FORMAT.md is the specification.
//! `fnda` is the binary `.fundab`, `container` the ZIP container it replaced plus the reader dispatch, `json_doc` the
//! readable `.funda`. Nothing here knows about Tauri or geometry.

pub mod container;
pub mod fnda;
pub mod json_doc;
mod par;
mod pread;
mod segments;
pub mod summary;

use std::path::Path;

/// Open any document and return its JSON, publishing embedded geometry into
/// `blob_dir` on the way, the same path the app's open takes.
pub fn read_document(path: &Path, blob_dir: &Path) -> Result<String, String> {
    container::open_document_checked(path, blob_dir, None).map(|(doc, _)| doc)
}
