//! Additive Manufacturing File (AMF), plain XML or zip compressed, each
//! `<object>` one body with its name and colour.

use std::collections::HashMap;
use std::io::Read;

use quick_xml::events::Event;

use super::mesh::{dominant_color, unit_color, MeshObject};

fn bad(why: impl std::fmt::Display) -> String {
    format!("couldn't read this AMF file, {why}")
}

#[derive(Default)]
struct Volume {
    material: Option<String>,
    color: Option<[u8; 3]>,
    triangles: usize,
}

#[derive(Default)]
struct Object {
    name: Option<String>,
    color: Option<[u8; 3]>,
    pos: Vec<f64>,
    idx: Vec<u32>,
    volumes: Vec<Volume>,
}

/// The XML of a plain or zipped AMF, the zip's one `.amf` entry capped at
/// `cap` bytes unpacked.
fn xml_of(data: Vec<u8>, cap: u64) -> Result<String, String> {
    if !data.starts_with(b"PK") {
        return String::from_utf8(data).map_err(|_| bad("it is neither XML nor a zip"));
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(bad)?;
    let name = z
        .file_names()
        .find(|n| n.to_lowercase().ends_with(".amf"))
        .or_else(|| z.file_names().find(|n| !n.ends_with('/')))
        .map(String::from)
        .ok_or_else(|| bad("the zip holds no .amf entry"))?;
    let mut xml = String::new();
    z.by_name(&name).map_err(bad)?.take(cap + 1).read_to_string(&mut xml).map_err(bad)?;
    if xml.len() as u64 > cap {
        return Err(bad(format!("it unpacks past {} MiB", cap / (1024 * 1024))));
    }
    Ok(xml)
}

fn mm_per(unit: &str) -> Result<f64, String> {
    Ok(match unit.trim().to_lowercase().as_str() {
        "" | "millimeter" | "millimetre" | "mm" => 1.0,
        "inch" | "in" => 25.4,
        "feet" | "foot" | "ft" => 304.8,
        "meter" | "metre" | "m" => 1000.0,
        "micron" | "micrometer" | "micrometre" => 0.001,
        other => return Err(bad(format!("the unit '{other}' is not known"))),
    })
}

pub fn read_amf(data: Vec<u8>) -> Result<(Vec<MeshObject>, Vec<String>), String> {
    let xml = xml_of(data, super::MAX_IMPORT_FILE_BYTES)?;
    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut scale = 1.0;
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut objects: Vec<Object> = Vec::new();
    let mut materials: HashMap<String, [u8; 3]> = HashMap::new();
    let mut material: Option<String> = None;
    let mut rgb = [0.0f64; 3];
    let mut xyz = [0.0f64; 3];
    let mut tri = [0u32; 3];
    let mut meta: Option<String> = None;
    let mut constellations = 0;
    loop {
        match reader.read_event().map_err(bad)? {
            Event::Start(e) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                let attr = |key: &[u8]| {
                    e.attributes()
                        .flatten()
                        .find(|a| a.key.local_name().as_ref() == key)
                        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
                };
                match local.as_str() {
                    "amf" => scale = mm_per(&attr(b"unit").unwrap_or_default())?,
                    "object" => objects.push(Object::default()),
                    "volume" => {
                        if let Some(o) = objects.last_mut() {
                            o.volumes.push(Volume { material: attr(b"materialid"), ..Volume::default() });
                        }
                    }
                    "material" => material = attr(b"id"),
                    "metadata" => meta = attr(b"type"),
                    "constellation" => constellations += 1,
                    "color" => rgb = [0.0; 3],
                    _ => {}
                }
                path.push(local);
                text.clear();
            }
            Event::Text(t) => text.push_str(&t.unescape().map_err(bad)?),
            Event::CData(t) => text.push_str(&String::from_utf8_lossy(&t)),
            Event::End(_) => {
                let Some(local) = path.pop() else { continue };
                let parent = path.last().map_or("", String::as_str);
                let num = || {
                    text.trim()
                        .parse::<f64>()
                        .map_err(|_| bad(format!("<{local}> holds '{}', not a number", text.trim())))
                };
                match (parent, local.as_str()) {
                    ("coordinates", "x") => xyz[0] = num()?,
                    ("coordinates", "y") => xyz[1] = num()?,
                    ("coordinates", "z") => xyz[2] = num()?,
                    (_, "coordinates") => {
                        if let Some(o) = objects.last_mut() {
                            o.pos.extend(xyz.map(|v| v * scale));
                        }
                    }
                    ("triangle", "v1") => tri[0] = num()? as u32,
                    ("triangle", "v2") => tri[1] = num()? as u32,
                    ("triangle", "v3") => tri[2] = num()? as u32,
                    ("volume", "triangle") => {
                        if let Some(o) = objects.last_mut() {
                            o.idx.extend(tri);
                            if let Some(v) = o.volumes.last_mut() {
                                v.triangles += 1;
                            }
                        }
                    }
                    ("color", "r") => rgb[0] = num()?,
                    ("color", "g") => rgb[1] = num()?,
                    ("color", "b") => rgb[2] = num()?,
                    (owner, "color") => {
                        let c = Some(unit_color(rgb));
                        match owner {
                            "object" => {
                                if let Some(o) = objects.last_mut() {
                                    o.color = c;
                                }
                            }
                            "volume" => {
                                if let Some(v) = objects.last_mut().and_then(|o| o.volumes.last_mut()) {
                                    v.color = c;
                                }
                            }
                            "material" => {
                                if let (Some(id), Some(c)) = (material.clone(), c) {
                                    materials.insert(id, c);
                                }
                            }
                            _ => {}
                        }
                    }
                    ("object", "metadata") if meta.as_deref() == Some("name") => {
                        if let Some(o) = objects.last_mut() {
                            o.name = Some(text.trim().to_string());
                        }
                    }
                    (_, "material") => material = None,
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut notes = Vec::new();
    if constellations > 0 {
        notes.push(format!(
            "{constellations} constellation{} not placed, each object came in once where the file draws it",
            if constellations == 1 { " was" } else { "s were" }
        ));
    }
    let out = objects
        .into_iter()
        .map(|o| {
            let color = o.color.or_else(|| {
                dominant_color(o.volumes.iter().flat_map(|v| {
                    let c = v.color.or_else(|| v.material.as_ref().and_then(|m| materials.get(m).copied()));
                    std::iter::repeat_n(c, v.triangles)
                }))
            });
            MeshObject { name: o.name, color, pos: o.pos, idx: o.idx }
        })
        .collect();
    Ok((out, notes))
}
