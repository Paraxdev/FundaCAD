//! FreeCAD documents (.FCStd): a zip of `Document.xml` and one OCCT BREP per object. Only the XML and the BREPs
//! are read, never anything a document could run.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use opencascade::primitives::Shape;
use opencascade::progress::ProgressRange;
use quick_xml::events::{BytesStart, Event};
use serde_json::{json, Map, Value};

use super::Imported;
use crate::kernel::{self, Kind};

#[derive(Default)]
struct Object {
    kind: String,
    label: Option<String>,
    shape_file: Option<String>,
    visible: Option<bool>,
    /// FreeCAD's quaternion (x, y, z, w) and position.
    placement: Option<([f64; 4], [f64; 3])>,
    group: Vec<String>,
}

fn not_freecad(e: &dyn std::fmt::Display) -> String {
    format!("could not read the FreeCAD file (it may be truncated or not a FreeCAD document): {e}")
}

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == key)
        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
}

fn member(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    z.by_name(name).ok()?.read_to_end(&mut out).ok()?;
    Some(out)
}

/// The objects of `Document.xml` by name, in document order.
fn objects(xml: &str) -> Result<Vec<(String, Object)>, String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    let mut by_name: HashMap<String, Object> = HashMap::new();
    let mut current: Option<String> = None;
    let mut property: Option<String> = None;
    loop {
        let event = reader.read_event().map_err(|e| not_freecad(&e))?;
        let (e, empty) = match &event {
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(_) => {
                if let Some(closed) = stack.pop() {
                    match closed.as_slice() {
                        b"Property" => property = None,
                        b"Object" if stack.last().map(Vec::as_slice) == Some(b"ObjectData") => current = None,
                        _ => {}
                    }
                }
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        let local = e.local_name().as_ref().to_vec();
        let parent = stack.last().map(Vec::as_slice);
        let grand = stack.len().checked_sub(2).map(|i| stack[i].as_slice());
        match (local.as_slice(), parent) {
            (b"Object", Some(b"Objects")) => {
                if let (Some(name), Some(kind)) = (attr(e, b"name"), attr(e, b"type")) {
                    if !by_name.contains_key(&name) {
                        order.push(name.clone());
                    }
                    by_name.entry(name).or_default().kind = kind;
                }
            }
            (b"Object", Some(b"ObjectData")) => {
                current = attr(e, b"name");
                if let Some(name) = &current {
                    if !by_name.contains_key(name) {
                        order.push(name.clone());
                    }
                    by_name.entry(name.clone()).or_default();
                }
            }
            (b"Property", Some(b"Properties")) if current.is_some() && grand == Some(b"Object") => {
                property = attr(e, b"name");
            }
            _ => {}
        }
        if let (Some(name), Some(prop)) = (&current, &property) {
            let o = by_name.entry(name.clone()).or_default();
            match (prop.as_str(), local.as_slice()) {
                ("Label", b"String") => o.label = attr(e, b"value"),
                ("Shape", b"Part") => o.shape_file = attr(e, b"file").filter(|f| !f.is_empty()),
                ("Visibility", b"Bool") => o.visible = attr(e, b"value").map(|v| v == "true"),
                ("Placement", b"PropertyPlacement") => {
                    let f = |k: &[u8]| attr(e, k).and_then(|v| v.trim().parse::<f64>().ok());
                    if let (Some(px), Some(py), Some(pz), Some(x), Some(y), Some(z), Some(w)) =
                        (f(b"Px"), f(b"Py"), f(b"Pz"), f(b"Q0"), f(b"Q1"), f(b"Q2"), f(b"Q3"))
                    {
                        o.placement = Some(([x, y, z, w], [px, py, pz]));
                    }
                }
                ("Group", b"Link") => {
                    if let Some(v) = attr(e, b"value").filter(|v| !v.is_empty()) {
                        o.group.push(v);
                    }
                }
                _ => {}
            }
        }
        if !empty {
            stack.push(local);
        }
    }
    Ok(order.into_iter().filter_map(|n| by_name.remove(&n).map(|o| (n, o))).collect())
}

/// `Visibility` of each view provider, where documents before FreeCAD 0.19 kept it.
fn gui_visibility(xml: &str) -> HashMap<String, bool> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut out = HashMap::new();
    let mut provider: Option<String> = None;
    let mut in_visibility = false;
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                b"ViewProvider" => provider = attr(&e, b"name"),
                b"Property" => in_visibility = attr(&e, b"name").as_deref() == Some("Visibility"),
                b"Bool" if in_visibility => {
                    if let (Some(p), Some(v)) = (&provider, attr(&e, b"value")) {
                        out.entry(p.clone()).or_insert(v == "true");
                    }
                }
                _ => {}
            },
            Event::End(e) if e.local_name().as_ref() == b"Property" => in_visibility = false,
            Event::Eof => break,
            _ => {}
        }
    }
    out
}

type Rigid = ([[f64; 3]; 3], [f64; 3]);

fn rigid((q, p): ([f64; 4], [f64; 3])) -> Rigid {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    let [x, y, z, w] = if n > 0.0 { q.map(|c| c / n) } else { [0.0, 0.0, 0.0, 1.0] };
    let r = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ];
    (r, p)
}

/// `outer` after `inner`.
fn then(outer: &Rigid, inner: &Rigid) -> Rigid {
    let (a, t) = outer;
    let (b, u) = inner;
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    let shift = std::array::from_fn(|i| t[i] + (0..3).map(|k| a[i][k] * u[k]).sum::<f64>());
    (r, shift)
}

pub fn read_fcstd(path: &Path) -> Result<Imported, String> {
    let file = std::fs::File::open(path).map_err(|e| not_freecad(&e))?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| not_freecad(&e))?;
    let xml = member(&mut z, "Document.xml").ok_or_else(|| not_freecad(&"it holds no Document.xml"))?;
    let xml = String::from_utf8_lossy(&xml).into_owned();
    let mut objects = objects(&xml)?;
    if objects.iter().any(|(_, o)| o.visible.is_none()) {
        if let Some(gui) = member(&mut z, "GuiDocument.xml") {
            let gui = gui_visibility(&String::from_utf8_lossy(&gui));
            for (name, o) in &mut objects {
                if o.visible.is_none() {
                    o.visible = gui.get(name).copied();
                }
            }
        }
    }
    let index: HashMap<&str, usize> = objects.iter().enumerate().map(|(i, (n, _))| (n.as_str(), i)).collect();
    let mut parent: Vec<Option<usize>> = vec![None; objects.len()];
    for (i, (_, o)) in objects.iter().enumerate() {
        for child in &o.group {
            if let Some(&c) = index.get(child.as_str()) {
                if c != i && parent[c].is_none() {
                    parent[c] = Some(i);
                }
            }
        }
    }
    let ancestors = |mut i: usize| {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        while let Some(p) = parent[i] {
            if !seen.insert(p) {
                break;
            }
            out.push(p);
            i = p;
        }
        out
    };

    let mut notes: Vec<String> = Vec::new();
    let mut links = 0usize;
    let mut picked: Vec<(String, Shape)> = Vec::new();
    for (i, (name, o)) in objects.iter().enumerate() {
        let up = ancestors(i);
        let containers: Vec<&Object> = up.iter().map(|&a| &objects[a].1).collect();
        if containers.iter().any(|c| c.kind == "PartDesign::Body") {
            continue;
        }
        let shown = o.visible.unwrap_or(true)
            && containers.iter().filter(|c| c.kind == "App::Part").all(|c| c.visible.unwrap_or(true));
        if !shown {
            continue;
        }
        if o.kind.starts_with("App::Link") {
            links += 1;
            continue;
        }
        let Some(file) = &o.shape_file else { continue };
        let label = o.label.clone().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| name.clone());
        let Some(bytes) = member(&mut z, file) else {
            notes.push(format!("{label}: its shape is missing from the file"));
            continue;
        };
        let read = if file.to_lowercase().ends_with(".bin") {
            Shape::from_brep_bytes(&bytes, &ProgressRange::detached())
        } else {
            Shape::from_brep_text(&String::from_utf8_lossy(&bytes), &ProgressRange::detached())
        };
        let shape = match read {
            Ok(s) => s,
            Err(e) => {
                notes.push(format!("{label}: its shape could not be read ({e})"));
                continue;
            }
        };
        if kernel::count(&shape, Kind::Face) == 0 {
            continue;
        }
        let mut place: Option<Rigid> = None;
        for c in containers.iter().filter(|c| c.kind == "App::Part") {
            if let Some(p) = c.placement {
                let r = rigid(p);
                place = Some(match &place {
                    Some(inner) => then(&r, inner),
                    None => r,
                });
            }
        }
        let shape = match place {
            Some((r, shift)) => {
                kernel::rigid_moved(&shape, [r[0][0], r[1][0], r[2][0]], [r[0][2], r[1][2], r[2][2]], shift)
                    .map_err(|e| format!("{label}: {e}"))?
            }
            None => shape,
        };
        picked.push((label, shape));
    }
    if links > 0 {
        notes.push(format!(
            "{links} linked object{} skipped, FreeCAD links are not read",
            if links == 1 { " was" } else { "s were" }
        ));
    }
    if picked.is_empty() {
        return Err("the FreeCAD document has no visible solid or surface to import".into());
    }

    let mut fields = Map::new();
    if !notes.is_empty() {
        fields.insert("notes".into(), json!(notes));
    }
    if picked.len() == 1 {
        let (label, shape) = picked.pop().unwrap_or_else(|| unreachable!());
        fields.insert("name".into(), json!(label));
        return Ok(Imported { shape, fields });
    }
    let nodes: Vec<Value> = picked.iter().map(|(label, _)| json!({"name": label, "parent": Value::Null})).collect();
    let parts: Vec<Value> = picked
        .iter()
        .enumerate()
        .map(|(i, (_, s))| json!({"node": i, "faces": kernel::count(s, Kind::Face)}))
        .collect();
    fields.insert("nodes".into(), Value::Array(nodes));
    fields.insert("parts".into(), Value::Array(parts));
    let shape = kernel::compound(picked.iter().map(|(_, s)| s));
    Ok(Imported { shape, fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarter_turn_then_a_shift() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let turn = rigid(([0.0, 0.0, s, s], [0.0, 0.0, 0.0]));
        let shift = rigid(([0.0, 0.0, 0.0, 1.0], [100.0, 0.0, 0.0]));
        let (r, t) = then(&shift, &turn);
        assert!((r[1][0] - 1.0).abs() < 1e-12 && r[0][0].abs() < 1e-12, "{r:?}");
        assert_eq!(t, [100.0, 0.0, 0.0]);
        let (_, t) = then(&turn, &shift);
        assert!(t[0].abs() < 1e-9 && (t[1] - 100.0).abs() < 1e-9, "{t:?}");
    }
}
