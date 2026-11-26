//! File kinds by extension, and what a drop of several files does.

pub const DOC_EXT: &str = "funda";
pub const BINARY_DOC_EXT: &str = "fundab";
/// Read forever, newest first.
pub const LEGACY_DOC_EXTS: [&str; 2] = ["neocad", "sindri"];
/// `json` too: a pre-v5 document is plain JSON and some are still called that.
pub const DOC_EXTS: [&str; 5] = [DOC_EXT, BINARY_DOC_EXT, "neocad", "sindri", "json"];

pub const IMPORT_EXTS: [&str; 27] = [
    "stl", "3mf", "step", "stp", "stpz", "gz", "xbf", "iges", "igs", "brep", "fcstd", "3dm", "ifc", "dxf", "obj",
    "ply", "off", "amf", "glb", "gltf", "wrl", "wrz", "x3d", "x3dz", "fbx", "3ds", "svg",
];

pub fn is_document_ext(ext: &str) -> bool {
    DOC_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

pub fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The engine's import format for a path. Total like FundaCAD 1's: anything unknown reads as STEP, so a caller
/// routes by [`route_dropped_name`] first.
pub fn import_format(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    let mut parts: Vec<&str> = lower.split('.').collect();
    if parts.len() > 2 && parts.last() == Some(&"gz") {
        parts.pop();
    }
    match parts.pop().unwrap_or("") {
        "stl" => "stl",
        "3mf" => "3mf",
        "obj" => "obj",
        "brep" => "brep",
        "xbf" => "xbf",
        "glb" => "glb",
        "iges" | "igs" => "iges",
        "fcstd" => "fcstd",
        "3dm" => "3dm",
        "ifc" => "ifc",
        "dxf" => "dxf",
        "svg" => "svg",
        "gltf" => "gltf",
        "ply" => "ply",
        "off" => "off",
        "amf" => "amf",
        "wrl" | "wrz" => "vrml",
        "x3d" | "x3dz" => "x3d",
        "fbx" => "fbx",
        "3ds" => "3ds",
        _ => "step",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropAction {
    Open,
    Import,
    Environment,
    Reject,
}

pub fn route_dropped_name(name: &str) -> DropAction {
    let base = base_name(name);
    let Some(dot) = base.rfind('.') else { return DropAction::Reject };
    let ext = base[dot + 1..].to_ascii_lowercase();
    if ext.is_empty() {
        DropAction::Reject
    } else if is_document_ext(&ext) {
        DropAction::Open
    } else if IMPORT_EXTS.contains(&ext.as_str()) {
        DropAction::Import
    } else if ext == "hdr" || ext == "exr" {
        DropAction::Environment
    } else {
        DropAction::Reject
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropPlan<T> {
    /// The first document dropped, opened before the imports.
    pub open: Option<T>,
    /// In drop order.
    pub imports: Vec<T>,
    /// The last one lights the viewport.
    pub environments: Vec<T>,
    /// Further documents, only one can be open at a time.
    pub skipped: Vec<T>,
    pub rejected: Vec<T>,
}

pub fn plan_drop<T>(items: impl IntoIterator<Item = T>, name_of: impl Fn(&T) -> &str) -> DropPlan<T> {
    let mut plan = DropPlan { open: None, imports: vec![], environments: vec![], skipped: vec![], rejected: vec![] };
    for item in items {
        match route_dropped_name(name_of(&item)) {
            DropAction::Import => plan.imports.push(item),
            DropAction::Environment => plan.environments.push(item),
            DropAction::Reject => plan.rejected.push(item),
            DropAction::Open if plan.open.is_none() => plan.open = Some(item),
            DropAction::Open => plan.skipped.push(item),
        }
    }
    plan
}
