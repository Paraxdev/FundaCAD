//! print_project3mf.py: the Orca project 3MF, one object per body, a per
//! object extruder (the palette slot) and the palette's colours as filament
//! slots.
//!
//! Indexing, which is easy to get wrong: palette slots and the
//! project_settings filament_colour array are 0-based, the model_settings
//! "extruder" metadata is 1-based. A body with no palette slot prints on
//! extruder 1.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::py::{self, quoteattr};
use crate::zipw::ZipOut;
use crate::ExportBody;

const MAX_SLOTS: usize = 8;
const MAX_NAME: usize = 100;
const BBS_NS: &str = "http://schemas.bambulab.com/package/2021";
const XML_CHUNK_VERTS: usize = 4096;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"#;

const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;

pub struct Slot {
    pub name: String,
    pub color: String,
    pub material: Option<String>,
}

fn cap(s: &str) -> String {
    s.chars().take(MAX_NAME).collect()
}

/// mesh_writers.py `norm_color`: '#RRGGBB' or 'RRGGBB', any case, an 8 digit
/// RRGGBBAA tolerated, to '#RRGGBB' upper; anything else the grey fallback.
pub fn norm_color(c: Option<&Value>) -> String {
    let raw = if py::truthy(c) { c.map(py::str_of).unwrap_or_default() } else { String::new() };
    let mut s: String = raw.trim().trim_start_matches('#').to_string();
    if s.chars().count() == 8 {
        s = s.chars().take(6).collect();
    }
    if s.chars().count() != 6 || !s.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return "#808080".into();
    }
    format!("#{}", s.to_uppercase())
}

/// `list(x or [])` of a JSON value.
fn as_list(v: Option<&Value>) -> Vec<Value> {
    if !py::truthy(v) {
        return Vec::new();
    }
    match v {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        Some(Value::Object(o)) => o.keys().map(|k| Value::String(k.clone())).collect(),
        _ => Vec::new(),
    }
}

fn as_map(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(o)) if py::truthy(v) => o.clone(),
        _ => Map::new(),
    }
}

/// `sanitize_inputs`: untrusted request fields clamped to what the writer
/// expects, colours normalised, names capped and slot indices kept to the
/// palette (an index out of range is unassigned).
pub fn sanitize_inputs(
    palette: Option<&Value>,
    body_colors: Option<&Value>,
    body_names: Option<&Value>,
) -> (Vec<Slot>, HashMap<String, usize>, HashMap<String, String>) {
    let mut pal: Vec<Slot> = Vec::new();
    for slot in as_list(palette).into_iter().take(MAX_SLOTS) {
        let empty = Map::new();
        let obj = slot.as_object().unwrap_or(&empty);
        let name = if py::truthy(obj.get("name")) {
            cap(&py::str_of(&obj["name"]))
        } else {
            cap(&format!("Filament {}", pal.len() + 1))
        };
        let material = if py::truthy(obj.get("material")) {
            cap(py::str_of(&obj["material"]).trim())
        } else {
            String::new()
        };
        pal.push(Slot {
            name,
            color: norm_color(obj.get("color")),
            material: (!material.is_empty()).then_some(material),
        });
    }
    let mut colors = HashMap::new();
    for (bid, idx) in as_map(body_colors) {
        let Some(i) = py::int_of(&idx) else {
            continue;
        };
        if i >= 0 && (i as usize) < pal.len() {
            colors.insert(bid, i as usize);
        }
    }
    let names = as_map(body_names)
        .into_iter()
        .map(|(k, v)| (k, cap(&py::str_of(&v))))
        .collect();
    (pal, colors, names)
}

fn bbox(bodies: &[ExportBody]) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for b in bodies {
        for p in b.positions.chunks_exact(3) {
            for a in 0..3 {
                if p[a] < lo[a] {
                    lo[a] = p[a];
                }
                if p[a] > hi[a] {
                    hi[a] = p[a];
                }
            }
        }
    }
    (lo, hi)
}

/// mesh_writers.py `mesh_chunks`, written to `out` in bounded pieces.
fn mesh_xml(positions: &[f64], indices: &[u32], out: &mut ZipOut) -> Result<(), String> {
    out.write(b"<mesh><vertices>")?;
    let mut buf = String::new();
    let mut n = 0;
    for p in positions.chunks_exact(3) {
        buf.push_str(&format!(
            "<vertex x=\"{}\" y=\"{}\" z=\"{}\"/>",
            py::g(p[0], 6),
            py::g(p[1], 6),
            py::g(p[2], 6)
        ));
        n += 1;
        if n >= XML_CHUNK_VERTS {
            out.write(buf.as_bytes())?;
            buf.clear();
            n = 0;
        }
    }
    out.write(buf.as_bytes())?;
    buf.clear();
    out.write(b"</vertices><triangles>")?;
    n = 0;
    for t in indices.chunks_exact(3) {
        buf.push_str(&format!("<triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>", t[0], t[1], t[2]));
        n += 1;
        if n >= XML_CHUNK_VERTS {
            out.write(buf.as_bytes())?;
            buf.clear();
            n = 0;
        }
    }
    out.write(buf.as_bytes())?;
    out.write(b"</triangles></mesh>")
}

/// `write_project_3mf`, the assembly centred on a 270 mm bed with its lowest
/// point dropped to z = 0, one shared translation for every build item.
pub fn write_project_3mf(
    bodies: &[ExportBody],
    palette: &[Slot],
    body_colors: &HashMap<String, usize>,
    body_names: &HashMap<String, String>,
    settings: &Map<String, Value>,
) -> Result<(), String> {
    if bodies.is_empty() {
        return Err("nothing to export, no bodies".into());
    }
    let bed = (270.0, 270.0);
    let (lo, hi) = bbox(bodies);
    let tx = bed.0 / 2.0 - (lo[0] + hi[0]) / 2.0;
    let ty = bed.1 / 2.0 - (lo[1] + hi[1]) / 2.0;
    let tz = -lo[2];
    let transform = format!("1 0 0 0 1 0 0 0 1 {} {} {}", py::g(tx, 6), py::g(ty, 6), py::g(tz, 6));

    let mats: String = palette
        .iter()
        .map(|s| format!("<m:base name={} displaycolor=\"{}FF\"/>", quoteattr(&s.name), s.color))
        .collect();
    let basematerials = if palette.is_empty() {
        String::new()
    } else {
        format!("<m:basematerials id=\"1\">{mats}</m:basematerials>")
    };

    let mut headers = Vec::new();
    let mut items = String::new();
    let mut cfg_objects = Vec::new();
    for (n, b) in bodies.iter().enumerate() {
        let oid = n + 2;
        let slot = if palette.is_empty() { 0 } else { body_colors.get(&b.id).copied().unwrap_or(0) };
        let name = body_names
            .get(&b.id)
            .filter(|s| !s.is_empty())
            .cloned()
            .or_else(|| (!b.name.is_empty()).then(|| b.name.clone()))
            .unwrap_or_else(|| format!("Body{}", n + 1));
        let name = cap(&name);
        let pid = if palette.is_empty() {
            String::new()
        } else {
            format!(" pid=\"1\" pindex=\"{slot}\"")
        };
        headers.push(format!("<object id=\"{oid}\" type=\"model\" name={}{pid}>", quoteattr(&name)));
        items.push_str(&format!("<item objectid=\"{oid}\" transform=\"{transform}\" printable=\"1\"/>"));
        cfg_objects.push(format!(
            "  <object id=\"{oid}\">\n    <metadata key=\"name\" value={q}/>\n    <metadata key=\"extruder\" value=\"{e}\"/>\n    <part id=\"1\" subtype=\"normal_part\">\n      <metadata key=\"name\" value={q}/>\n    </part>\n  </object>",
            q = quoteattr(&name),
            e = slot + 1
        ));
    }
    let model_settings = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n{}\n</config>",
        cfg_objects.join("\n")
    );

    let mut proj = Map::new();
    if !palette.is_empty() {
        proj.insert(
            "filament_colour".into(),
            Value::Array(palette.iter().map(|s| Value::String(s.color.clone())).collect()),
        );
        if palette.iter().any(|s| s.material.is_some()) {
            proj.insert(
                "filament_type".into(),
                Value::Array(
                    palette
                        .iter()
                        .map(|s| Value::String(s.material.clone().unwrap_or_else(|| "PLA".into())))
                        .collect(),
                ),
            );
        }
    }
    for (k, v) in settings {
        proj.insert(k.clone(), v.clone());
    }

    let mut z = ZipOut::new();
    z.entry("[Content_Types].xml", CONTENT_TYPES.as_bytes())?;
    z.entry("_rels/.rels", RELS.as_bytes())?;
    z.begin("3D/3dmodel.model")?;
    z.write(
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" xmlns:m=\"http://schemas.microsoft.com/3dmanufacturing/material/2015/02\" xmlns:BambuStudio=\"{BBS_NS}\">\n <metadata name=\"Application\">FundaCAD</metadata>\n <metadata name=\"BambuStudio:3mfVersion\">1</metadata>\n <resources>{basematerials}"
        )
        .as_bytes(),
    )?;
    for (b, header) in bodies.iter().zip(&headers) {
        z.write(header.as_bytes())?;
        mesh_xml(&b.positions, &b.indices, &mut z)?;
        z.write(b"</object>")?;
    }
    z.write(format!("</resources>\n <build>{items}</build>\n</model>").as_bytes())?;
    z.end()?;
    z.entry("Metadata/model_settings.config", model_settings.as_bytes())?;
    z.entry(
        "Metadata/project_settings.config",
        py::dumps_indent1(&Value::Object(proj)).as_bytes(),
    )?;
    z.finish()
}
