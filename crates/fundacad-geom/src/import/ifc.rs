//! IFC building models (IFC2X3, IFC4, IFC4X3): ifc-lite tessellates each product, openings cut, into one named,
//! coloured body. Openings, spaces, envelopes, virtual elements, annotations and grids are not material, left out.

use std::collections::{BTreeMap, HashMap, HashSet};

use ifc_lite_core::IfcType;
use ifc_lite_processing::{default_color_for_type, process_geometry, MeshData};
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use super::mesh::{dominant_color, object_shapes, unit_color, MeshObject, MAX_IMPORT_TRIANGLES};
use super::Imported;
use crate::kernel::{self, Kind};

/// Welding and on-edge distance for the T-junction split, in mm, and how
/// many single precision steps of the largest coordinate it grows to.
const T_JUNCTION_TOL: f64 = 1e-3;
const T_JUNCTION_ULPS: f64 = 4.0;

fn not_material(ifc_type: &str) -> bool {
    let t = IfcType::from_str(ifc_type);
    t.is_subtype_of(IfcType::IfcFeatureElementSubtraction)
        || (t.is_subtype_of(IfcType::IfcSpatialElement) && !t.is_subtype_of(IfcType::IfcSite))
        || t.is_subtype_of(IfcType::IfcVirtualElement)
        || t.is_subtype_of(IfcType::IfcAnnotation)
        || t.is_subtype_of(IfcType::IfcPositioningElement)
        || t == IfcType::IfcGrid
}

/// One building element, its pieces in the order ifc-lite gave them.
pub struct IfcElement {
    pub name: String,
    pub color: Option<[u8; 3]>,
    pub pieces: Vec<MeshObject>,
}

/// The file's elements as one body each, with what the reader has to say.
pub fn import_ifc(data: &[u8]) -> Result<Imported, String> {
    let (elems, mut notes) = read_ifc(data)?;
    let counts: Vec<usize> = elems.iter().map(|e| e.pieces.len()).collect();
    let mut meta = Vec::with_capacity(elems.len());
    let mut flat = Vec::new();
    for e in elems {
        meta.push((e.name, e.color));
        flat.extend(e.pieces);
    }
    let mut shapes = object_shapes(&flat)?.into_iter();
    let mut bodies = Vec::with_capacity(counts.len());
    for (&n, (name, _)) in counts.iter().zip(&meta) {
        let pieces: Vec<Shape> = shapes.by_ref().take(n).collect();
        if pieces.iter().any(|s| kernel::count(s, Kind::Solid) == 0) {
            notes.push(format!("{name}: its faces do not close into a solid, it came in as an open shell"));
        }
        bodies.push(if pieces.len() == 1 {
            pieces.into_iter().next().unwrap_or_else(Shape::empty)
        } else {
            kernel::compound(pieces.iter())
        });
    }
    let mut fields = Map::new();
    let shape = if bodies.len() == 1 {
        fields.insert("name".into(), json!(meta[0].0));
        if let Some(c) = meta[0].1 {
            fields.insert("color".into(), json!(super::hex(c)));
        }
        bodies.pop().unwrap_or_else(Shape::empty)
    } else {
        let nodes: Vec<Value> = meta.iter().map(|(name, _)| json!({"name": name, "parent": null})).collect();
        let parts: Vec<Value> = meta
            .iter()
            .zip(&bodies)
            .enumerate()
            .map(|(i, ((_, color), s))| {
                let mut part = json!({"node": i, "faces": kernel::count(s, Kind::Face)});
                if let Some(c) = color {
                    part["color"] = json!(super::hex(*c));
                }
                part
            })
            .collect();
        fields.insert("nodes".into(), Value::Array(nodes));
        fields.insert("parts".into(), Value::Array(parts));
        kernel::compound(bodies.iter())
    };
    if !notes.is_empty() {
        fields.insert("notes".into(), Value::Array(notes.into_iter().map(Value::String).collect()));
    }
    Ok(Imported { shape, fields })
}

pub fn read_ifc(data: &[u8]) -> Result<(Vec<IfcElement>, Vec<String>), String> {
    if data.starts_with(b"PK") {
        return Err("this is a zipped IFC (IFCZIP). Unzip it and import the .ifc file inside.".into());
    }
    let head = String::from_utf8_lossy(&data[..data.len().min(64)]);
    if !head.trim_start_matches('\u{feff}').trim_start().starts_with("ISO-10303-21") {
        return Err("this is not an IFC file, it does not start with the ISO-10303-21 header".into());
    }
    let mut notes = Vec::new();
    let tail = String::from_utf8_lossy(&data[data.len().saturating_sub(256)..]);
    if !tail.trim_end().ends_with("END-ISO-10303-21;") {
        notes.push("the file stops before its END-ISO-10303-21 line, it looks cut off, so only the elements before the cut came in".to_string());
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_geometry(data)))
        .map_err(|_| "couldn't read this IFC file, its geometry could not be tessellated".to_string())?;

    let mut products: BTreeMap<u32, Vec<&MeshData>> = BTreeMap::new();
    for m in &result.meshes {
        if not_material(&m.ifc_type) || m.indices.len() < 3 {
            continue;
        }
        products.entry(m.express_id).or_default().push(m);
    }
    if products.is_empty() {
        return Err("no building elements with geometry found in this IFC file".into());
    }
    let ntri: usize = products.values().flatten().map(|m| m.indices.len() / 3).sum();
    if ntri as u64 > MAX_IMPORT_TRIANGLES {
        return Err(format!(
            "This building has {ntri} triangles, too many to import as editable bodies (limit {MAX_IMPORT_TRIANGLES}). \
             Export a storey or a selection from the BIM tool and import that."
        ));
    }

    let mut objs: Vec<IfcElement> = Vec::with_capacity(products.len());
    for (i, pieces) in products.values().enumerate() {
        let first = pieces[0];
        let name = first.name.as_deref().map(super::clean).filter(|n| !n.is_empty()).unwrap_or_else(|| {
            if first.ifc_type.is_empty() {
                format!("Object {}", i + 1)
            } else {
                first.ifc_type.clone()
            }
        });
        // A piece that closes on its own is sewn alone, so two items of one
        // element that touch stay two solids instead of one with a face inside.
        let mut closed = Vec::new();
        let mut open = Vec::new();
        for m in pieces {
            let o = soup(&[m]);
            if o.idx.len() < 3 {
                continue;
            }
            if open_edges(&o.idx) == 0 {
                closed.push(o);
            } else {
                open.push(*m);
            }
        }
        if !open.is_empty() {
            closed.push(soup(&open));
        }
        if closed.is_empty() {
            continue;
        }
        let rgb = |c: [f32; 4]| unit_color([f64::from(c[0]), f64::from(c[1]), f64::from(c[2])]);
        // ifc-lite paints an unstyled product with a stock colour of its type,
        // which is not the author's, so that colour is dropped.
        let stock = rgb(default_color_for_type(IfcType::from_str(&first.ifc_type)).0);
        let color =
            dominant_color(pieces.iter().flat_map(|m| std::iter::repeat_n(Some(rgb(m.color)), m.indices.len() / 3)))
                .filter(|&c| c != stock);
        objs.push(IfcElement { name, color, pieces: closed });
    }
    if objs.is_empty() {
        return Err("no building elements with geometry found in this IFC file".into());
    }
    Ok((objs, notes))
}

/// The pieces as one soup in mm, T-junctions split.
fn soup(pieces: &[&MeshData]) -> MeshObject {
    let mut o = MeshObject::default();
    let mut idx = Vec::new();
    let mut reach = 0f32;
    for m in pieces {
        reach = m.positions.iter().fold(reach, |r, v| r.max(v.abs()));
        let base = (o.pos.len() / 3) as u32;
        o.pos.extend(
            m.positions.chunks_exact(3).flat_map(|p| [0, 1, 2].map(|k| (m.origin[k] + f64::from(p[k])) * 1000.0)),
        );
        idx.extend(m.indices[..m.indices.len() / 3 * 3].iter().map(|&i| base + i));
    }
    // ifc-lite's metres are f32, so a T vertex sits up to a step of the
    // largest coordinate off its edge, 0.008 mm a hundred metres out.
    let tol = T_JUNCTION_TOL.max(T_JUNCTION_ULPS * f64::from(f32::EPSILON) * f64::from(reach) * 1000.0);
    o.idx = split_t_junctions(&o.pos, &idx, tol);
    o
}

fn open_edges(idx: &[u32]) -> usize {
    let edges: HashSet<(u32, u32)> =
        idx.chunks_exact(3).flat_map(|t| (0..3).map(move |k| (t[k], t[(k + 1) % 3]))).collect();
    edges.iter().filter(|&&(a, b)| !edges.contains(&(b, a))).count()
}

/// The triangles with every edge split at any open edge vertex lying inside it. ifc-lite's opening cuts leave
/// such T-junctions, and sewing cannot close a shell across one.
pub fn split_t_junctions(pos: &[f64], idx: &[u32], tol: f64) -> Vec<u32> {
    let at = |i: u32| {
        let i = i as usize * 3;
        [pos[i], pos[i + 1], pos[i + 2]]
    };
    let mut welded: HashMap<[i64; 3], u32> = HashMap::new();
    let canon: Vec<u32> = (0..(pos.len() / 3) as u32)
        .map(|i| *welded.entry(at(i).map(|v| (v / tol).round() as i64)).or_insert(i))
        .collect();
    let mut tris: Vec<[u32; 3]> = idx
        .chunks_exact(3)
        .map(|t| [canon[t[0] as usize], canon[t[1] as usize], canon[t[2] as usize]])
        .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
        .collect();
    for _ in 0..8 {
        let edges: HashSet<(u32, u32)> =
            tris.iter().flat_map(|t| (0..3).map(move |k| (t[k], t[(k + 1) % 3]))).collect();
        let open: Vec<(usize, usize)> = tris
            .iter()
            .enumerate()
            .flat_map(|(ti, t)| (0..3).map(move |k| (ti, k, t[k], t[(k + 1) % 3])))
            .filter(|&(_, _, a, b)| !edges.contains(&(b, a)))
            .map(|(ti, k, _, _)| (ti, k))
            .collect();
        let mut ends: Vec<u32> = open.iter().flat_map(|&(ti, k)| [tris[ti][k], tris[ti][(k + 1) % 3]]).collect();
        ends.sort_unstable();
        ends.dedup();
        if open.is_empty() || open.len().saturating_mul(ends.len()) > 20_000_000 {
            break;
        }
        let mut splits: HashMap<usize, (usize, Vec<u32>)> = HashMap::new();
        for &(ti, k) in &open {
            if splits.contains_key(&ti) {
                continue;
            }
            let (a, b) = (tris[ti][k], tris[ti][(k + 1) % 3]);
            let (pa, pb) = (at(a), at(b));
            let d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
            let len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            if len2 <= tol * tol {
                continue;
            }
            let mut on: Vec<(f64, u32)> = ends
                .iter()
                .filter(|&&v| v != a && v != b)
                .filter_map(|&v| {
                    let p = at(v);
                    let w = [p[0] - pa[0], p[1] - pa[1], p[2] - pa[2]];
                    let t = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / len2;
                    let off = [w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]];
                    let inside =
                        t > 0.0 && t < 1.0 && t * t * len2 > tol * tol && (1.0 - t) * (1.0 - t) * len2 > tol * tol;
                    (inside && off[0] * off[0] + off[1] * off[1] + off[2] * off[2] <= tol * tol).then_some((t, v))
                })
                .collect();
            if !on.is_empty() {
                on.sort_by(|x, y| x.0.total_cmp(&y.0));
                splits.insert(ti, (k, on.into_iter().map(|(_, v)| v).collect()));
            }
        }
        if splits.is_empty() {
            break;
        }
        let mut next = Vec::with_capacity(tris.len() + splits.len() * 2);
        for (ti, t) in tris.iter().enumerate() {
            let Some((k, mid)) = splits.get(&ti) else {
                next.push(*t);
                continue;
            };
            let (a, b, c) = (t[*k], t[(k + 1) % 3], t[(k + 2) % 3]);
            let chain: Vec<u32> = std::iter::once(a).chain(mid.iter().copied()).chain(std::iter::once(b)).collect();
            next.extend(chain.windows(2).map(|w| [w[0], w[1], c]));
        }
        tris = next;
    }
    tris.into_iter().flatten().collect()
}
