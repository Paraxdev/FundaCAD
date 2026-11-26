//! What the Export dialog asks for, its presets, the choices it remembers and the request it sends.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Stl,
    ThreeMf,
    Step,
    Glb,
    Dxf,
    Svg,
}

pub struct FormatInfo {
    pub format: ExportFormat,
    pub value: &'static str,
    pub label: &'static str,
    /// What the save dialog offers, the first is the default name's.
    pub exts: &'static [&'static str],
}

pub const FORMATS: [FormatInfo; 6] = [
    FormatInfo { format: ExportFormat::Stl, value: "stl", label: "STL (*.stl)", exts: &["stl"] },
    FormatInfo { format: ExportFormat::ThreeMf, value: "3mf", label: "3MF (*.3mf)", exts: &["3mf"] },
    FormatInfo { format: ExportFormat::Step, value: "step", label: "STEP (*.step, *.stp)", exts: &["step", "stp"] },
    FormatInfo { format: ExportFormat::Glb, value: "glb", label: "GLB glTF (*.glb)", exts: &["glb"] },
    FormatInfo { format: ExportFormat::Dxf, value: "dxf", label: "DXF R12 (*.dxf)", exts: &["dxf"] },
    FormatInfo { format: ExportFormat::Svg, value: "svg", label: "SVG (*.svg)", exts: &["svg"] },
];

impl ExportFormat {
    pub fn info(self) -> &'static FormatInfo {
        FORMATS.iter().find(|f| f.format == self).expect("every format is listed")
    }

    pub fn value(self) -> &'static str {
        self.info().value
    }

    pub fn ext(self) -> &'static str {
        self.info().exts[0]
    }

    pub fn parse(s: &str) -> Option<ExportFormat> {
        FORMATS.iter().find(|f| f.value == s).map(|f| f.format)
    }

    /// Faceting means something only to a format written as triangles.
    pub fn is_mesh(self) -> bool {
        matches!(self, ExportFormat::Stl | ExportFormat::ThreeMf | ExportFormat::Glb)
    }

    /// A drawing of one sketch or flat face rather than of bodies.
    pub fn is_flat(self) -> bool {
        matches!(self, ExportFormat::Dxf | ExportFormat::Svg)
    }

    /// GLB is metres by convention and viewers expect it, so it takes no unit.
    pub fn takes_unit(self) -> bool {
        matches!(self, ExportFormat::Stl | ExportFormat::ThreeMf)
    }
}

/// The format a saved path names. Total: an unknown extension writes STEP.
pub fn format_of_path(path: &str) -> ExportFormat {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "stl" => ExportFormat::Stl,
        "3mf" => ExportFormat::ThreeMf,
        "glb" => ExportFormat::Glb,
        "dxf" => ExportFormat::Dxf,
        "svg" => ExportFormat::Svg,
        _ => ExportFormat::Step,
    }
}

pub const UNITS: [&str; 5] = ["mm", "cm", "m", "in", "ft"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refinement {
    Low,
    Medium,
    High,
    Custom,
}

const MEDIUM: Faceting = Faceting { surface_deviation: 0.02, normal_deviation: 15.0, max_edge_length: 0.0 };

impl Refinement {
    pub fn preset(self) -> Option<Faceting> {
        match self {
            Refinement::Low => Some(Faceting { surface_deviation: 0.1, normal_deviation: 30.0, max_edge_length: 0.0 }),
            Refinement::Medium => Some(MEDIUM),
            Refinement::High => {
                Some(Faceting { surface_deviation: 0.005, normal_deviation: 5.0, max_edge_length: 0.0 })
            }
            Refinement::Custom => None,
        }
    }

    /// The preset these values match, or custom.
    pub fn of(f: &Faceting) -> Refinement {
        [Refinement::Low, Refinement::Medium, Refinement::High]
            .into_iter()
            .find(|r| r.preset().as_ref() == Some(f))
            .unwrap_or(Refinement::Custom)
    }

    pub fn value(self) -> &'static str {
        match self {
            Refinement::Low => "low",
            Refinement::Medium => "medium",
            Refinement::High => "high",
            Refinement::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Faceting {
    /// Largest gap between the body and a facet, mm.
    pub surface_deviation: f64,
    /// Largest angle between the normals of two neighbouring facets, degrees.
    pub normal_deviation: f64,
    /// Longest facet edge, mm, 0 for no limit.
    pub max_edge_length: f64,
}

fn clamp_or(v: f64, lo: f64, hi: f64, d: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        d
    }
}

impl Faceting {
    /// Clamped to what the engine accepts, so the dialog never sends a value it would replace.
    pub fn clamped(self) -> Faceting {
        Faceting {
            surface_deviation: clamp_or(self.surface_deviation, 0.0001, 10.0, MEDIUM.surface_deviation),
            normal_deviation: clamp_or(self.normal_deviation, 0.5, 90.0, MEDIUM.normal_deviation),
            max_edge_length: clamp_or(self.max_edge_length, 0.0, 1e6, 0.0),
        }
    }
}

pub fn clamp_tolerance(t: f64) -> f64 {
    clamp_or(t, 0.0001, 1.0, 0.01)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExportSettings {
    pub format: ExportFormat,
    pub unit: &'static str,
    pub binary: bool,
    pub refinement: Refinement,
    pub faceting: Faceting,
    pub show_advanced: bool,
    /// How far a DXF or SVG polyline may stray from a curve that is not a line, arc or circle, mm.
    pub tolerance: f64,
}

impl Default for ExportSettings {
    fn default() -> ExportSettings {
        ExportSettings {
            format: ExportFormat::Stl,
            unit: "mm",
            binary: true,
            refinement: Refinement::Medium,
            faceting: MEDIUM,
            show_advanced: false,
            tolerance: 0.01,
        }
    }
}

impl ExportSettings {
    /// Saved settings read back, anything unreadable replaced by its default. The JSON is FundaCAD 1's.
    pub fn parse(raw: Option<&str>) -> ExportSettings {
        let d = ExportSettings::default();
        let Some(Ok(Value::Object(v))) = raw.map(serde_json::from_str::<Value>) else { return d };
        let f = v.get("faceting").filter(|f| f.is_object());
        let num = |k: &str, dflt: f64| f.and_then(|o| o.get(k)).and_then(Value::as_f64).unwrap_or(dflt);
        let faceting = Faceting {
            surface_deviation: num("surfaceDeviation", d.faceting.surface_deviation),
            normal_deviation: num("normalDeviation", d.faceting.normal_deviation),
            max_edge_length: num("maxEdgeLength", d.faceting.max_edge_length),
        }
        .clamped();
        let s = |k: &str| v.get(k).and_then(Value::as_str);
        ExportSettings {
            format: s("format").and_then(ExportFormat::parse).unwrap_or(d.format),
            unit: s("unit").and_then(|u| UNITS.iter().find(|x| **x == u).copied()).unwrap_or(d.unit),
            binary: v.get("binary") != Some(&Value::Bool(false)),
            refinement: Refinement::of(&faceting),
            faceting,
            show_advanced: v.get("showAdvanced") == Some(&Value::Bool(true)),
            tolerance: clamp_tolerance(v.get("tolerance").and_then(Value::as_f64).unwrap_or(d.tolerance)),
        }
    }

    pub fn to_json(&self) -> String {
        json!({
            "format": self.format.value(),
            "unit": self.unit,
            "binary": self.binary,
            "refinement": self.refinement.value(),
            "faceting": {
                "surfaceDeviation": self.faceting.surface_deviation,
                "normalDeviation": self.faceting.normal_deviation,
                "maxEdgeLength": self.faceting.max_edge_length,
            },
            "showAdvanced": self.show_advanced,
            "tolerance": self.tolerance,
        })
        .to_string()
    }

    /// What is remembered after an export. DXF and SVG are offered only with a 2D source, so a flat export keeps
    /// the last 3D format for the next plain one.
    pub fn remembered(&self, before: &ExportSettings) -> ExportSettings {
        let mut s = self.clone();
        if s.format.is_flat() {
            s.format = before.format;
        }
        s
    }

    pub fn pick_refinement(&mut self, r: Refinement) {
        self.refinement = r;
        match r.preset() {
            Some(p) => self.faceting = p,
            None => self.show_advanced = true,
        }
    }

    /// One faceting field typed in, a non-finite value ignored.
    pub fn set_faceting(&mut self, value: f64, field: impl FnOnce(&mut Faceting) -> &mut f64) {
        if value.is_finite() {
            *field(&mut self.faceting) = value;
            self.refinement = Refinement::of(&self.faceting);
        }
    }

    /// The engine's `mesh` options.
    pub fn mesh_wire(&self) -> Value {
        let f = self.faceting.clamped();
        json!({
            "unit": self.unit,
            "binary": self.binary,
            "surfaceDeviation": f.surface_deviation,
            "normalDeviation": f.normal_deviation,
            "maxEdgeLength": f.max_edge_length,
        })
    }
}

/// Which bodies a 3D export writes. A body id is always `bodyN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyScope {
    All,
    Separate,
    Selected,
    SelectedSeparate,
    Body(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportStart {
    pub scope: BodyScope,
    /// The selected bodies still built, in build order.
    pub selected: Vec<String>,
    /// What the default file name starts with: the body, the folder or the document.
    pub base: String,
}

pub struct NamedBody<'a> {
    pub id: &'a str,
    pub name: &'a str,
}

/// A folder of the items tree, as far as export needs it.
pub struct TreeGroup {
    pub label: String,
    pub bodies: Vec<String>,
    pub children: Vec<TreeGroup>,
}

/// Where Export starts from what is selected: nothing is the whole document, one body is that body, more are
/// "selected", named after the folder they make up when they are exactly one folder's bodies.
pub fn scope_from_selection(
    selected: &[String],
    bodies: &[NamedBody<'_>],
    groups: &[TreeGroup],
    doc_name: &str,
) -> ExportStart {
    let picked: Vec<&NamedBody<'_>> = bodies.iter().filter(|b| selected.iter().any(|s| s == b.id)).collect();
    match picked.as_slice() {
        [] => ExportStart { scope: BodyScope::All, selected: vec![], base: doc_name.into() },
        [one] => {
            ExportStart { scope: BodyScope::Body(one.id.into()), selected: vec![one.id.into()], base: one.name.into() }
        }
        many => {
            let ids: Vec<String> = many.iter().map(|b| b.id.to_owned()).collect();
            let base = folder_of(&ids, groups).unwrap_or_else(|| doc_name.into());
            ExportStart { scope: BodyScope::Selected, selected: ids, base }
        }
    }
}

fn folder_of(ids: &[String], groups: &[TreeGroup]) -> Option<String> {
    fn walk(g: &TreeGroup, ids: &[String], found: &mut Option<String>) -> Vec<String> {
        let mut under = g.bodies.clone();
        for c in &g.children {
            under.extend(walk(c, ids, found));
        }
        if found.is_none() && under.len() == ids.len() && ids.iter().all(|id| under.contains(id)) {
            *found = Some(g.label.clone());
        }
        under
    }
    let mut found = None;
    for g in groups {
        walk(g, ids, &mut found);
    }
    found
}

/// What a DXF or SVG export draws: one sketch, or one flat face in the plane a sketch on it would take.
#[derive(Debug, Clone, PartialEq)]
pub enum FlatSource {
    Sketch { sketch: String, label: String },
    Face { face: Value, plane: Value, label: String },
}

impl FlatSource {
    pub fn label(&self) -> &str {
        match self {
            FlatSource::Sketch { label, .. } | FlatSource::Face { label, .. } => label,
        }
    }
}

/// The document's colours, which GLB writes one material per body from.
pub struct Colors<'a> {
    pub palette: &'a Value,
    pub body_colors: &'a Value,
}

/// The fields of an `export` request for [`crate::Client::export`]. `flat` is used by DXF and SVG only.
pub fn export_fields(
    settings: &ExportSettings,
    scope: &BodyScope,
    start: &ExportStart,
    flat: Option<&FlatSource>,
    path: &str,
    colors: Option<Colors<'_>>,
) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("format".into(), json!(settings.format.value()));
    m.insert("path".into(), json!(path));
    if settings.format.is_flat() {
        match flat {
            Some(FlatSource::Sketch { sketch, .. }) => {
                m.insert("sketch".into(), json!(sketch));
            }
            Some(FlatSource::Face { face, plane, .. }) => {
                m.insert("face".into(), face.clone());
                m.insert("plane".into(), plane.clone());
            }
            None => {}
        }
        m.insert("tolerance".into(), json!(clamp_tolerance(settings.tolerance)));
    } else {
        if matches!(scope, BodyScope::Separate | BodyScope::SelectedSeparate) {
            m.insert("separate".into(), json!(true));
        }
        match scope {
            BodyScope::Selected | BodyScope::SelectedSeparate => {
                m.insert("bodies".into(), json!(start.selected));
            }
            BodyScope::Body(id) => {
                m.insert("body".into(), json!(id));
            }
            BodyScope::All | BodyScope::Separate => {}
        }
    }
    if let Some(c) = colors {
        m.insert("palette".into(), c.palette.clone());
        m.insert("bodyColors".into(), c.body_colors.clone());
    }
    if settings.format.is_mesh() {
        m.insert("mesh".into(), settings.mesh_wire());
    }
    m
}

/// Local time, which the app reads from the system.
#[derive(Debug, Clone, Copy)]
pub struct Stamp {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

fn refused_in_name(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
}

/// A default file name no earlier export took, `bracket_20261016114207.stl`.
pub fn export_file_name(base: &str, ext: &str, now: Stamp) -> String {
    // Windows refuses these in a file name, and a trailing dot or space.
    let cleaned: String = base.chars().map(|c| if refused_in_name(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim();
    let safe = if cleaned.is_empty() { "part" } else { cleaned };
    let Stamp { year, month, day, hour, minute, second } = now;
    format!("{safe}_{year}{month:02}{day:02}{hour:02}{minute:02}{second:02}.{ext}")
}

/// The folder a saved path is in, remembered so the next save dialog opens there.
pub fn export_dir_of(path: &str) -> Option<&str> {
    let cut = path.rfind(['/', '\\'])?;
    (cut > 0).then(|| &path[..cut])
}

/// The paths an export reply says it wrote, one per body for a separate export.
pub fn written_paths(result: &Map<String, Value>) -> Vec<String> {
    let s = |v: &Value| v.as_str().map(str::to_owned);
    match result.get("paths").and_then(Value::as_array).filter(|p| !p.is_empty()) {
        Some(p) => p.iter().filter_map(s).collect(),
        None => result.get("path").and_then(s).into_iter().collect(),
    }
}

/// The features that failed during the export rebuild, whose bodies are missing from the files.
pub fn export_warnings(result: &Map<String, Value>) -> Vec<(Option<String>, String)> {
    result
        .get("warnings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|w| {
            let s = |k: &str| w.get(k).and_then(Value::as_str).map(str::to_owned);
            (s("feature_id"), s("message").unwrap_or_default())
        })
        .collect()
}
