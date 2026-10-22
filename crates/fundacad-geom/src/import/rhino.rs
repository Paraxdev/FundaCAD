//! Rhino .3dm: Breps, extrusions and NURBS surfaces become OCCT faces with
//! their trims, meshes go through the mesh path, layers become the tree.
//!
//! The decoder hands an IR of NURBS surfaces, 3D edge curves and 2D trims.
//! There is no binding to build a B-spline surface or a pcurve, so each body
//! is written as OCCT BRep text and read back, then healed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

use cadmpeg_codec_rhino::RhinoCodec;
use cadmpeg_ir::report::Severity;
use cadmpeg_ir::{Codec, DecodeOptions};
use opencascade::heal::FixOptions;
use opencascade::primitives::{Shape, ShapeType};
use opencascade::progress::ProgressRange;
use opencascade::sewing::{Sewing, SewingOptions};
use serde_json::{json, Map, Value};

use super::mesh::{self, MeshObject};
use super::{clean, hex, Imported};
use crate::kernel::{self, Kind};

const MAX_TOL: f64 = 0.1;

pub fn read_3dm(path: &Path) -> Result<Imported, String> {
    let (ir, losses) = decode(path)?;
    let model = Model::index(&ir);
    let linear = ir.pointer("/tolerances/linear").and_then(Value::as_f64).unwrap_or(0.0);
    let tol = linear.clamp(1e-3, MAX_TOL);

    let mut notes: Vec<String> = Vec::new();
    let (objects, faceless) = model.objects();
    let mut shapes: Vec<Option<Shape>> = Vec::with_capacity(objects.len());
    let mut meshes: Vec<(usize, MeshObject)> = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        let label = o.label(i);
        let shape = match o.kind {
            ObjKind::Brep => model.brep(o, tol),
            ObjKind::Surface => model.free_surface(&o.uuid),
            ObjKind::Mesh => match model.mesh(o) {
                Ok(m) => {
                    meshes.push((i, m));
                    shapes.push(None);
                    continue;
                }
                Err(e) => Err(e),
            },
        };
        match shape {
            Ok(s) if kernel::count(&s, Kind::Face) > 0 => shapes.push(Some(s)),
            Ok(_) => {
                notes.push(format!("{label}: no faces came out of it, it was skipped"));
                shapes.push(None);
            }
            Err(e) => {
                notes.push(format!("{label}: {e}, it was skipped"));
                shapes.push(None);
            }
        }
    }
    if !meshes.is_empty() {
        let (slots, objs): (Vec<usize>, Vec<MeshObject>) = meshes.into_iter().unzip();
        for (slot, shape) in slots.into_iter().zip(mesh::object_shapes(&objs)?) {
            shapes[slot] = Some(shape);
        }
    }
    notes.extend(model.skipped_note(faceless));
    notes.extend(losses);

    let kept: Vec<(&Obj, usize, Shape)> =
        objects.iter().zip(shapes).enumerate().filter_map(|(i, (o, s))| s.map(|s| (o, i, s))).collect();
    if kept.is_empty() {
        let why = notes.first().map(|n| format!(" ({n})")).unwrap_or_default();
        return Err(format!("the Rhino file has no solid, surface or mesh that could be imported{why}"));
    }
    let mut fields = Map::new();
    if !notes.is_empty() {
        fields.insert("notes".into(), json!(notes));
    }
    if kept.len() == 1 {
        let (o, i, shape) = kept.into_iter().next().unwrap_or_else(|| unreachable!());
        fields.insert("name".into(), json!(o.label(i)));
        if let Some(c) = o.color {
            fields.insert("color".into(), json!(hex(c)));
        }
        return Ok(Imported { shape, fields });
    }

    let (mut nodes, layer_node) = model.layer_nodes(kept.iter().filter_map(|(o, _, _)| o.layer.as_deref()));
    let mut parts = Vec::with_capacity(kept.len());
    for (o, i, shape) in &kept {
        let parent = o.layer.as_deref().and_then(|l| layer_node.get(l)).map_or(Value::Null, |&n| json!(n));
        nodes.push(json!({"name": o.label(*i), "parent": parent}));
        let mut part = json!({"node": nodes.len() - 1, "faces": kernel::count(shape, Kind::Face)});
        if let Some(c) = o.color {
            part["color"] = json!(hex(c));
        }
        parts.push(part);
    }
    fields.insert("nodes".into(), Value::Array(nodes));
    fields.insert("parts".into(), Value::Array(parts));
    Ok(Imported { shape: kernel::compound(kept.iter().map(|(_, _, s)| s)), fields })
}

/// The IR as JSON and the decoder's warnings worded as notes.
fn decode(path: &Path) -> Result<(Value, Vec<String>), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        RhinoCodec.decode(&mut file, &DecodeOptions::default()).map(|r| {
            let losses: Vec<String> = r
                .report()
                .losses
                .iter()
                .filter(|l| matches!(l.severity, Severity::Error | Severity::Blocking))
                .map(|l| format!("Rhino reader: {}", l.message))
                .collect();
            (serde_json::to_value(r.ir()), losses)
        })
    }))
    .map_err(|_| "the Rhino file could not be read, the reader stopped on it".to_string())?
    .map_err(|e| format!("the Rhino file could not be read ({e})"))?;
    let (ir, mut losses) = result;
    let ir = ir.map_err(|e| format!("the Rhino file could not be read ({e})"))?;
    let mut seen = HashSet::new();
    losses.retain(|l| seen.insert(l.clone()));
    losses.truncate(5);
    Ok((ir, losses))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ObjKind {
    Brep,
    Surface,
    Mesh,
}

#[derive(Debug)]
struct Obj {
    uuid: String,
    kind: ObjKind,
    name: Option<String>,
    color: Option<[u8; 3]>,
    layer: Option<String>,
}

impl Obj {
    fn label(&self, i: usize) -> String {
        self.name.as_deref().map(clean).filter(|n| !n.is_empty()).unwrap_or_else(|| {
            let kind = match self.kind {
                ObjKind::Brep => "Brep",
                ObjKind::Surface => "Surface",
                ObjKind::Mesh => "Mesh",
            };
            format!("{kind} {}", i + 1)
        })
    }
}

/// `rhino:object:surface#<uuid>.lateral-0` splits into the record kind,
/// the object uuid and the suffix.
fn split_id(id: &str) -> Option<(&str, &str, Option<&str>)> {
    let (head, rest) = id.split_once('#')?;
    let kind = head.rsplit(':').next()?;
    Some(match rest.split_once('.') {
        Some((uuid, suffix)) => (kind, uuid, Some(suffix)),
        None => (kind, rest, None),
    })
}

/// A Brep's render meshes come as `tessellation#<uuid>.render-N`, only a mesh
/// object has no suffix.
fn is_mesh_object(id: &str) -> bool {
    matches!(split_id(id), Some(("tessellation", _, None)))
}

fn rgb(c: &Value) -> Option<[u8; 3]> {
    let ch = |k: &str| c.get(k).and_then(Value::as_f64).map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8);
    Some([ch("r")?, ch("g")?, ch("b")?])
}

/// A layer colour is written `rrggbbaa`.
fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let b = |i: usize| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok());
    Some([b(0)?, b(2)?, b(4)?])
}

struct Model<'a> {
    ir: &'a Value,
    ix: HashMap<&'static str, HashMap<&'a str, &'a Value>>,
}

const TABLES: [&str; 11] =
    ["regions", "shells", "faces", "loops", "coedges", "edges", "vertices", "points", "surfaces", "curves", "pcurves"];

impl<'a> Model<'a> {
    fn index(ir: &'a Value) -> Self {
        let mut ix = HashMap::new();
        for t in TABLES {
            let table: HashMap<&str, &Value> = ir["model"][t]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| Some((r.get("id")?.as_str()?, r)))
                .collect();
            ix.insert(t, table);
        }
        Model { ir, ix }
    }

    fn list(&self, table: &str) -> impl Iterator<Item = &'a Value> {
        self.ir["model"][table].as_array().into_iter().flatten()
    }

    fn rec(&self, table: &'static str, id: &str) -> Result<&'a Value, String> {
        self.ix.get(table).and_then(|t| t.get(id).copied()).ok_or_else(|| format!("the file names a missing {id}"))
    }

    /// Every importable object once, in the order of the file's records, and
    /// how many bodies hold no face, a curve or a point cloud.
    fn objects(&self) -> (Vec<Obj>, usize) {
        let mut rank: HashMap<&str, usize> = HashMap::new();
        let mut by_layer: HashSet<&str> = HashSet::new();
        for p in self.ir.pointer("/native/rhino/object_presentation").and_then(Value::as_array).into_iter().flatten() {
            let uuid = p["id"].as_str().and_then(split_id).map(|(_, u, _)| u);
            let record = p["links"][0].as_str().and_then(|l| l.rsplit('#').next()).and_then(|n| n.parse().ok());
            if let (Some(u), Some(r)) = (uuid, record) {
                rank.insert(u, r);
            }
            if let Some(u) = uuid.filter(|_| p["color_source"].as_i64() != Some(1)) {
                by_layer.insert(u);
            }
        }
        let mut info: HashMap<&str, (Option<String>, Option<[u8; 3]>, Option<String>)> = HashMap::new();
        for t in ["surfaces", "points", "curves", "tessellations"] {
            for r in self.list(t) {
                let Some(so) = r.get("source_object") else { continue };
                let Some(uuid) = so["object_id"].as_str() else { continue };
                info.entry(uuid).or_insert_with(|| {
                    (
                        so["name"].as_str().map(str::to_string),
                        rgb(&so["color"]),
                        so["layer"].as_str().map(str::to_string),
                    )
                });
            }
        }
        let mut out: Vec<Obj> = Vec::new();
        let mut seen = HashSet::new();
        let mut push = |uuid: &str, kind: ObjKind, name: Option<String>, color: Option<[u8; 3]>| {
            if !seen.insert(uuid.to_string()) {
                return;
            }
            let (n, c, layer) = info.get(uuid).cloned().unwrap_or_default();
            // black is the colour of every new Rhino layer, not a choice
            let color = color.or(c).filter(|&c| c != [0, 0, 0] || !by_layer.contains(uuid));
            out.push(Obj { uuid: uuid.to_string(), kind, name: name.or(n), color, layer });
        };
        let lateral: HashSet<&str> = self
            .list("surfaces")
            .filter_map(|s| match s["id"].as_str().and_then(split_id) {
                Some((_, u, Some(x))) if x.starts_with("lateral") => Some(u),
                _ => None,
            })
            .collect();
        let mut faceless = 0;
        for b in self.list("bodies") {
            let Some((_, uuid, _)) = b["id"].as_str().and_then(split_id) else { continue };
            if !lateral.contains(uuid) && !self.has_faces(b) {
                faceless += 1;
                continue;
            }
            push(uuid, ObjKind::Brep, b["name"].as_str().map(str::to_string), rgb(&b["color"]));
        }
        for s in self.list("surfaces") {
            if let Some(("surface", uuid, None)) = s["id"].as_str().and_then(split_id) {
                push(uuid, ObjKind::Surface, None, None);
            }
        }
        for t in self.list("tessellations") {
            if let Some(id) = t["id"].as_str().filter(|id| is_mesh_object(id)) {
                if let Some((_, uuid, _)) = split_id(id) {
                    push(uuid, ObjKind::Mesh, None, None);
                }
            }
        }
        out.sort_by_key(|o| rank.get(o.uuid.as_str()).copied().unwrap_or(usize::MAX));
        (out, faceless)
    }

    fn has_faces(&self, body: &Value) -> bool {
        body["regions"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|r| {
            self.ix["regions"].get(r).is_some_and(|reg| {
                reg["shells"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|s| {
                    self.ix["shells"]
                        .get(s)
                        .is_some_and(|sh| sh["members"].as_array().into_iter().flatten().any(|m| m["kind"] == "face"))
                })
            })
        })
    }

    /// One note for what the file holds that does not import.
    fn skipped_note(&self, faceless: usize) -> Vec<String> {
        let mut out = Vec::new();
        let subds = self.list("subds").count();
        if subds > 0 {
            out.push(format!(
                "{subds} SubD object{} skipped, convert {} to NURBS in Rhino (ToNURBS) to import {}",
                if subds == 1 { " was" } else { "s were" },
                if subds == 1 { "it" } else { "them" },
                if subds == 1 { "it" } else { "them" },
            ));
        }
        let loose = |t: &str, kind: &str| {
            self.list(t)
                .filter(|r| matches!(r["id"].as_str().and_then(split_id), Some((k, _, None)) if k == kind))
                .count()
        };
        let native =
            |t: &str| self.ir.pointer(&format!("/native/rhino/{t}")).and_then(Value::as_array).map_or(0, Vec::len);
        let other = faceless
            + loose("curves", "curve")
            + loose("points", "point")
            + native("text_dots")
            + native("annotations");
        if other > 0 {
            out.push(format!(
                "{other} curve, point or annotation object{} skipped, only solids, surfaces and meshes import",
                if other == 1 { " was" } else { "s were" }
            ));
        }
        out
    }

    /// A Brep, or an extrusion's caps sewn to its lateral surfaces.
    fn brep(&self, o: &Obj, tol: f64) -> Result<Shape, String> {
        let bodies: Vec<&Value> = self
            .list("bodies")
            .filter(|b| matches!(b["id"].as_str().and_then(split_id), Some((_, u, _)) if u == o.uuid))
            .collect();
        let mut text = BrepText::new(tol);
        let mut roots = Vec::new();
        let mut solid = false;
        for body in &bodies {
            solid |= body["kind"] == "solid";
            let mut shells = Vec::new();
            for region in body["regions"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                for shell in
                    self.rec("regions", region)?["shells"].as_array().into_iter().flatten().filter_map(Value::as_str)
                {
                    let faces: Vec<&str> = self.rec("shells", shell)?["members"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|m| m["kind"] == "face")
                        .filter_map(|m| m["id"].as_str())
                        .collect();
                    let mut members = Vec::new();
                    for f in faces {
                        members.push(self.face(&mut text, f)?);
                    }
                    if !members.is_empty() {
                        shells.push(text.push(
                            "Sh",
                            String::new(),
                            if body["kind"] == "solid" { "0101100" } else { "0101000" },
                            members,
                        ));
                    }
                }
            }
            if body["kind"] == "solid" && !shells.is_empty() {
                let subs = shells.into_iter().map(|s| (false, s)).collect();
                roots.push((false, text.push("So", String::new(), "0101000", subs)));
            } else {
                roots.extend(shells.into_iter().map(|s| (false, s)));
            }
        }
        let laterals: Vec<&Value> = self
            .list("surfaces")
            .filter(|s| matches!(s["id"].as_str().and_then(split_id), Some((_, u, Some(x))) if u == o.uuid && x.starts_with("lateral")))
            .collect();
        let mut shape = if roots.is_empty() {
            None
        } else {
            let root = if roots.len() == 1 { roots[0].1 } else { text.push("Co", String::new(), "1100000", roots) };
            Some(read_brep(&text.finish(root))?)
        };
        if !laterals.is_empty() {
            let mut faces: Vec<Shape> = shape.iter().flat_map(|s| s.subshapes(ShapeType::Face)).collect();
            for s in laterals {
                faces.push(untrimmed(&s["geometry"])?);
            }
            let sewn = Sewing::run(
                faces.iter(),
                SewingOptions { tolerance: tol, cutting: true, non_manifold: false },
                &ProgressRange::detached(),
            )
            .map_err(|e| format!("its extrusion faces could not be sewn ({e})"))?
            .shape();
            let shells = sewn.subshapes(ShapeType::Shell);
            shape = Some(match shells.as_slice() {
                [one] => one.fix_solid(tol, MAX_TOL).unwrap_or_else(|_| sewn.clone()),
                _ => sewn,
            });
            solid = false;
        }
        let shape = shape.ok_or("it has no faces")?;
        let fixed = shape.fix(FixOptions::default()).map(|f| f.shape).unwrap_or(shape);
        Ok(if solid && fixed.shape_type() == ShapeType::Solid {
            fixed.fix_solid(tol, MAX_TOL).unwrap_or(fixed)
        } else {
            fixed
        })
    }

    fn free_surface(&self, uuid: &str) -> Result<Shape, String> {
        let s = self
            .list("surfaces")
            .find(|s| matches!(s["id"].as_str().and_then(split_id), Some(("surface", u, None)) if u == uuid))
            .ok_or("its surface is missing")?;
        untrimmed(&s["geometry"])
    }

    fn mesh(&self, o: &Obj) -> Result<MeshObject, String> {
        let t = self
            .list("tessellations")
            .find(|t| {
                t["id"].as_str().filter(|id| is_mesh_object(id)).and_then(split_id).is_some_and(|(_, u, _)| u == o.uuid)
            })
            .ok_or("its mesh is missing")?;
        let m = &t["mesh"];
        let mut pos = Vec::new();
        for v in m["vertices"].as_array().ok_or("its mesh has no vertex list")? {
            let p = v.get("position").unwrap_or(v);
            pos.extend(xyz(p)?);
        }
        let mut idx = Vec::new();
        for tri in m["triangles"].as_array().ok_or("its mesh has no triangle list")? {
            let corners = tri.get("corners").unwrap_or(tri);
            for c in corners.as_array().into_iter().flatten() {
                idx.push(c.as_u64().and_then(|i| u32::try_from(i).ok()).ok_or("its mesh has a bad triangle")?);
            }
        }
        Ok(MeshObject { name: o.name.clone(), color: o.color, pos, idx })
    }

    /// The layers holding `used` and their parents, as tree nodes in the
    /// file's layer order, and each layer's node by uuid.
    fn layer_nodes<'b>(&self, used: impl Iterator<Item = &'b str>) -> (Vec<Value>, HashMap<String, usize>) {
        let mut layers: Vec<&Value> =
            self.ir.pointer("/native/rhino/layers").and_then(Value::as_array).into_iter().flatten().collect();
        layers.sort_by_key(|l| l["archive_index"].as_i64().unwrap_or(i64::MAX));
        let by_uuid: HashMap<&str, &Value> =
            layers.iter().filter_map(|l| Some((l["source_uuid"].as_str()?, *l))).collect();
        let mut wanted: HashSet<&str> = HashSet::new();
        for mut u in used {
            while let Some(l) = by_uuid.get(u) {
                if !wanted.insert(u) {
                    break;
                }
                match l["parent_uuid"].as_str() {
                    Some(p) => u = p,
                    None => break,
                }
            }
        }
        let mut nodes = Vec::new();
        let mut node_of: HashMap<String, usize> = HashMap::new();
        // a parent can follow its child in the table, so place parents first
        let mut pending: Vec<&Value> =
            layers.into_iter().filter(|l| l["source_uuid"].as_str().is_some_and(|u| wanted.contains(u))).collect();
        while !pending.is_empty() {
            let before = pending.len();
            pending.retain(|l| {
                let parent = l["parent_uuid"].as_str().filter(|p| wanted.contains(p));
                let parent_node = match parent {
                    Some(p) => match node_of.get(p) {
                        Some(&n) => json!(n),
                        None => return true,
                    },
                    None => Value::Null,
                };
                let name = l["name"].as_str().map(clean).filter(|n| !n.is_empty()).unwrap_or_else(|| "Layer".into());
                let mut node = json!({"name": name, "parent": parent_node});
                if let Some(c) = l["color"].as_str().and_then(hex_rgb).filter(|&c| c != [0, 0, 0]) {
                    node["color"] = json!(hex(c));
                }
                node_of.insert(l["source_uuid"].as_str().unwrap_or_default().to_string(), nodes.len());
                nodes.push(node);
                false
            });
            if pending.len() == before {
                break;
            }
        }
        (nodes, node_of)
    }

    /// A face's wires into `text`, its edges and vertices on first use.
    fn face(&self, text: &mut BrepText, face_id: &str) -> Result<(bool, usize), String> {
        let f = self.rec("faces", face_id)?;
        let surf = f["surface"].as_str().ok_or("a face has no surface")?;
        let s = text.surface(surf, &self.rec("surfaces", surf)?["geometry"])?;
        let mut wires = Vec::new();
        let mut uses: BTreeMap<String, Vec<(bool, usize)>> = BTreeMap::new();
        for lid in f["loops"]["loops"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let mut members = Vec::new();
            for cid in self.rec("loops", lid)?["boundary"]["coedges"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let c = self.rec("coedges", cid)?;
                let eid = c["edge"].as_str().ok_or("a trim has no edge")?;
                let e = self.edge(text, eid)?;
                let rev = c["sense"] == "reversed";
                let pid = c["pcurves"][0]["pcurve"].as_str().ok_or("a trim has no 2D curve")?;
                let pc = Nurbs::read(&self.rec("pcurves", pid)?["geometry"], 2)?;
                let range = match text.edges[e].range {
                    Some(r) => r,
                    None => {
                        let r = pc.domain();
                        text.edges[e].range = Some(r);
                        r
                    }
                };
                let pc = pc.reversed_if(rev).remapped(range);
                uses.entry(eid.to_string()).or_default().push((rev, text.curve2d(&pc)));
                members.push((rev, e));
            }
            if !members.is_empty() {
                wires.push((false, text.push("Wi", String::new(), "0101100", members)));
            }
        }
        if wires.is_empty() {
            return Err("a Brep face has no trims".into());
        }
        for (eid, pcs) in uses {
            let e = text.edge_of[&eid];
            let rep = match pcs.as_slice() {
                [(_, pc)] => format!("2 {pc} {s} 0"),
                [(false, a), (true, b)] | [(true, b), (false, a)] => format!("3 {a} {b} C0 {s} 0"),
                _ => return Err("an edge bounds one face more than twice".into()),
            };
            text.edges[e].reps.push(rep);
        }
        let reversed = f["sense"] == "reversed";
        Ok((reversed, text.push_face(s, wires)))
    }

    fn edge(&self, text: &mut BrepText, eid: &str) -> Result<usize, String> {
        if let Some(&e) = text.edge_of.get(eid) {
            return Ok(e);
        }
        let e = self.rec("edges", eid)?;
        let mut vertex = |key: &str| -> Result<usize, String> {
            let vid = e[key].as_str().ok_or("an edge has no vertex")?;
            if let Some(&v) = text.vertex_of.get(vid) {
                return Ok(v);
            }
            let pid = self.rec("vertices", vid)?["point"].as_str().ok_or("a vertex has no point")?;
            let p = xyz(&self.rec("points", pid)?["position"])?;
            let v = text.push("Ve", format!("{}\n{} {} {}\n0 0\n", text.tol, p[0], p[1], p[2]), "0101101", Vec::new());
            text.vertex_of.insert(vid.to_string(), v);
            Ok(v)
        };
        let start = vertex("start")?;
        let end = vertex("end")?;
        // a singular trim, the pole of a sphere, has an empty carrier
        let (curve, range) = match e["carrier"]["curve"].as_str() {
            Some(cid) => {
                let g = Nurbs::read(&self.rec("curves", cid)?["geometry"], 3)?;
                let r =
                    e["carrier"]["param_range"].as_array().filter(|r| r.len() == 2).ok_or("an edge has no range")?;
                let range = (r[0].as_f64().unwrap_or(0.0), r[1].as_f64().unwrap_or(0.0));
                (Some(text.curve3d(&g)), Some(range))
            }
            None => (None, None),
        };
        text.edges.push(EdgeRec { start, end, curve, range, reps: Vec::new() });
        let e = text.edges.len() - 1;
        text.edge_of.insert(eid.to_string(), e);
        Ok(e)
    }
}

fn xyz(p: &Value) -> Result<[f64; 3], String> {
    let c = |k: &str| p.get(k).and_then(Value::as_f64).ok_or_else(|| "a point has no coordinates".to_string());
    Ok([c("x")?, c("y")?, c("z")?])
}

fn read_brep(text: &str) -> Result<Shape, String> {
    Shape::from_brep_text(text, &ProgressRange::detached())
        .map_err(|e| format!("its geometry could not be built ({e})"))
}

/// A surface over its whole range, for a free surface or an extrusion side.
fn untrimmed(geometry: &Value) -> Result<Shape, String> {
    if geometry["kind"] == "plane" {
        return Err("its plane has no bounds in the file as read".into());
    }
    let mut text = BrepText::new(1e-7);
    let s = text.surface("s", geometry)?;
    let root = text.push("Fa", format!("1 1e-07 {s} 0\n"), "1100000", Vec::new());
    let shape = read_brep(&text.finish(root))?;
    let face = shape.as_face().ok_or("its surface did not read back as a face")?;
    let face = face.untrimmed(1e-7).map_err(|e| format!("its surface could not be bounded ({e})"))?;
    Ok(Shape::from(face))
}

/// A NURBS curve or surface of the IR with its knots made unique.
#[derive(Clone, Debug, PartialEq)]
struct Nurbs {
    dim: usize,
    degree: usize,
    poles: Vec<f64>,
    weights: Vec<f64>,
    knots: Vec<f64>,
    mults: Vec<usize>,
}

fn unique_knots(flat: &[f64]) -> (Vec<f64>, Vec<usize>) {
    let mut ks: Vec<f64> = Vec::new();
    let mut ms: Vec<usize> = Vec::new();
    for &k in flat {
        match ks.last() {
            Some(&last) if (k - last).abs() <= 1e-12 * last.abs().max(1.0) => {
                if let Some(m) = ms.last_mut() {
                    *m += 1;
                }
            }
            _ => {
                ks.push(k);
                ms.push(1);
            }
        }
    }
    (ks, ms)
}

fn pole(c: &Value, dim: usize) -> Result<([f64; 3], f64), String> {
    let p = c.get("point").unwrap_or(c);
    let w = c.get("weight").and_then(Value::as_f64).unwrap_or(1.0);
    let get =
        |k: &str| p.get(k).and_then(Value::as_f64).ok_or_else(|| "a control point has no coordinates".to_string());
    Ok(if dim == 2 { ([get("u")?, get("v")?, 0.0], w) } else { ([get("x")?, get("y")?, get("z")?], w) })
}

impl Nurbs {
    fn read(g: &Value, dim: usize) -> Result<Self, String> {
        if g["kind"] != "nurbs" {
            return Err(format!("a {} curve is not read", g["kind"].as_str().unwrap_or("unknown")));
        }
        let degree = g["degree"].as_u64().ok_or("a curve has no degree")? as usize;
        let mut poles = Vec::new();
        let mut weights = Vec::new();
        for c in g["poles"]["points"].as_array().ok_or("a curve has no control points")? {
            let (p, w) = pole(c, dim)?;
            poles.extend_from_slice(&p[..dim]);
            weights.push(w);
        }
        let flat: Vec<f64> = g["knots"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        if flat.len() != weights.len() + degree + 1 || weights.len() <= degree {
            return Err("a curve has knots that do not match its control points".into());
        }
        let (knots, mults) = unique_knots(&flat);
        Ok(Nurbs { dim, degree, poles, weights, knots, mults })
    }

    fn domain(&self) -> (f64, f64) {
        (self.knots[0], self.knots[self.knots.len() - 1])
    }

    fn reversed_if(mut self, rev: bool) -> Self {
        if !rev {
            return self;
        }
        let (t0, t1) = self.domain();
        let d = self.dim;
        let n = self.weights.len();
        let poles: Vec<f64> = (0..n).rev().flat_map(|i| self.poles[i * d..i * d + d].to_vec()).collect();
        self.poles = poles;
        self.weights.reverse();
        self.knots = self.knots.iter().rev().map(|k| t0 + t1 - k).collect();
        self.mults.reverse();
        self
    }

    /// The same curve over `[a, b]`. Rhino's trim domain is not its edge's.
    fn remapped(mut self, (a, b): (f64, f64)) -> Self {
        let (t0, t1) = self.domain();
        if (t1 - t0).abs() > 0.0 {
            self.knots = self.knots.iter().map(|k| a + (k - t0) * (b - a) / (t1 - t0)).collect();
        }
        self
    }

    fn rational(&self) -> bool {
        self.weights.iter().any(|&w| (w - 1.0).abs() > 1e-15)
    }

    fn write(&self, out: &mut String) {
        let rational = self.rational();
        let _ = write!(out, "7 {} 0 {} {} {} ", u8::from(rational), self.degree, self.weights.len(), self.knots.len());
        for (i, w) in self.weights.iter().enumerate() {
            for v in &self.poles[i * self.dim..i * self.dim + self.dim] {
                let _ = write!(out, "{v} ");
            }
            if rational {
                let _ = write!(out, "{w} ");
            }
        }
        for (k, m) in self.knots.iter().zip(&self.mults) {
            let _ = write!(out, "{k} {m} ");
        }
        out.push('\n');
    }
}

fn surface_text(g: &Value) -> Result<String, String> {
    let mut out = String::new();
    match g["kind"].as_str() {
        Some("plane") => {
            let o = xyz(&g["origin"])?;
            let n = unit(xyz(&g["normal"])?)?;
            let u = xyz(&g["u_axis"])?;
            let along = dot(u, n);
            let x = unit([u[0] - along * n[0], u[1] - along * n[1], u[2] - along * n[2]])?;
            let y = cross(n, x);
            let _ = writeln!(
                out,
                "1 {} {} {} {} {} {} {} {} {} {} {} {}",
                o[0], o[1], o[2], n[0], n[1], n[2], x[0], x[1], x[2], y[0], y[1], y[2]
            );
        }
        Some("nurbs") => {
            let rows = g["poles"]["rows"].as_array().ok_or("a surface has no control points")?;
            let nv = rows.first().and_then(Value::as_array).map_or(0, Vec::len);
            let mut pts = Vec::new();
            for r in rows {
                let r = r.as_array().filter(|r| r.len() == nv).ok_or("a surface has ragged control points")?;
                for c in r {
                    pts.push(pole(c, 3)?);
                }
            }
            let deg = |k: &str| g[k].as_u64().map(|d| d as usize).ok_or_else(|| "a surface has no degree".to_string());
            let (ud, vd) = (deg("u_degree")?, deg("v_degree")?);
            let knots = |k: &str, n: usize, d: usize| -> Result<(Vec<f64>, Vec<usize>), String> {
                let flat: Vec<f64> = g[k].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
                if flat.len() != n + d + 1 || n <= d {
                    return Err("a surface has knots that do not match its control points".into());
                }
                Ok(unique_knots(&flat))
            };
            let (uk, um) = knots("u_knots", rows.len(), ud)?;
            let (vk, vm) = knots("v_knots", nv, vd)?;
            let rational = pts.iter().any(|(_, w)| (w - 1.0).abs() > 1e-15);
            let r = u8::from(rational);
            let _ = write!(out, "9 {r} {r} 0 0 {ud} {vd} {} {nv} {} {} ", rows.len(), uk.len(), vk.len());
            for (p, w) in &pts {
                let _ = write!(out, "{} {} {} ", p[0], p[1], p[2]);
                if rational {
                    let _ = write!(out, "{w} ");
                }
            }
            for (k, m) in uk.iter().zip(&um).chain(vk.iter().zip(&vm)) {
                let _ = write!(out, "{k} {m} ");
            }
            out.push('\n');
        }
        other => return Err(format!("its {} surface is not read", other.unwrap_or("unknown"))),
    }
    Ok(out)
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(v: [f64; 3]) -> Result<[f64; 3], String> {
    let l = dot(v, v).sqrt();
    if l < 1e-12 {
        return Err("a plane has no direction".into());
    }
    Ok(v.map(|c| c / l))
}

struct EdgeRec {
    start: usize,
    end: usize,
    curve: Option<usize>,
    range: Option<(f64, f64)>,
    reps: Vec<String>,
}

struct TShape {
    kind: &'static str,
    geom: String,
    flags: &'static str,
    subs: Vec<(bool, usize)>,
}

/// OCCT's BRep text, version 3. A TShape names a sub-shape by its distance
/// from the end of the list, so the list is numbered only when written.
/// Edges are records until `finish`, each face adds its trims to them, and a
/// wire names its edges by record.
struct BrepText {
    tol: f64,
    curves2d: Vec<String>,
    curves: Vec<String>,
    surfaces: Vec<String>,
    surface_of: HashMap<String, usize>,
    shapes: Vec<TShape>,
    vertex_of: HashMap<String, usize>,
    edge_of: HashMap<String, usize>,
    edges: Vec<EdgeRec>,
}

impl BrepText {
    fn new(tol: f64) -> Self {
        BrepText {
            tol,
            curves2d: Vec::new(),
            curves: Vec::new(),
            surfaces: Vec::new(),
            surface_of: HashMap::new(),
            shapes: Vec::new(),
            vertex_of: HashMap::new(),
            edge_of: HashMap::new(),
            edges: Vec::new(),
        }
    }

    fn push(&mut self, kind: &'static str, geom: String, flags: &'static str, subs: Vec<(bool, usize)>) -> usize {
        self.shapes.push(TShape { kind, geom, flags, subs });
        self.shapes.len() - 1
    }

    fn surface(&mut self, id: &str, g: &Value) -> Result<usize, String> {
        if let Some(&s) = self.surface_of.get(id) {
            return Ok(s);
        }
        self.surfaces.push(surface_text(g)?);
        self.surface_of.insert(id.to_string(), self.surfaces.len());
        Ok(self.surfaces.len())
    }

    fn curve3d(&mut self, c: &Nurbs) -> usize {
        let mut s = String::new();
        c.write(&mut s);
        self.curves.push(s);
        self.curves.len()
    }

    fn curve2d(&mut self, c: &Nurbs) -> usize {
        let mut s = String::new();
        c.write(&mut s);
        self.curves2d.push(s);
        self.curves2d.len()
    }

    fn push_face(&mut self, surface: usize, wires: Vec<(bool, usize)>) -> usize {
        self.push("Fa", format!("0 {} {surface} 0\n", self.tol), "0101000", wires)
    }

    fn finish(mut self, root: usize) -> String {
        // Edge and vertex shapes go first: a TShape may only name shapes
        // written before it. Every pushed shape is renumbered after them.
        let mut order: Vec<TShape> = Vec::new();
        let mut vertex_new: HashMap<usize, usize> = HashMap::new();
        for (old, s) in self.shapes.iter_mut().enumerate() {
            if s.kind == "Ve" {
                vertex_new.insert(old, order.len());
                order.push(TShape { kind: "Ve", geom: std::mem::take(&mut s.geom), flags: s.flags, subs: Vec::new() });
            }
        }
        let mut edge_new = Vec::with_capacity(self.edges.len());
        for e in &self.edges {
            let mut geom = format!(" {} 0 0 {}\n", self.tol, u8::from(e.curve.is_none()));
            let (a, b) = e.range.unwrap_or((0.0, 1.0));
            if let Some(c) = e.curve {
                let _ = writeln!(geom, "1 {c} 0 {a} {b}");
            }
            for r in &e.reps {
                let _ = writeln!(geom, "{r} {a} {b}");
            }
            geom.push_str("0\n");
            edge_new.push(order.len());
            order.push(TShape {
                kind: "Ed",
                geom,
                flags: "0101000",
                subs: vec![(false, vertex_new[&e.start]), (true, vertex_new[&e.end])],
            });
        }
        let mut new_of: HashMap<usize, usize> = HashMap::new();
        for (old, s) in self.shapes.into_iter().enumerate() {
            if s.kind == "Ve" {
                continue;
            }
            let subs = s
                .subs
                .into_iter()
                .map(|(rev, i)| {
                    let n = if s.kind == "Wi" { edge_new[i] } else { new_of[&i] };
                    (rev, n)
                })
                .collect();
            new_of.insert(old, order.len());
            order.push(TShape { subs, ..s });
        }
        let n = order.len();
        let mut out = String::from("DBRep_DrawableShape\n\nCASCADE Topology V3, (c) Open Cascade\nLocations 0\n");
        let section = |out: &mut String, name: &str, items: &[String]| {
            let _ = writeln!(out, "{name} {}", items.len());
            for i in items {
                out.push_str(i);
            }
        };
        section(&mut out, "Curve2ds", &self.curves2d);
        section(&mut out, "Curves", &self.curves);
        out.push_str("Polygon3D 0\nPolygonOnTriangulations 0\n");
        section(&mut out, "Surfaces", &self.surfaces);
        let _ = write!(out, "Triangulations 0\n\nTShapes {n}\n");
        for s in &order {
            let _ = write!(out, "{}\n{}\n{}\n", s.kind, s.geom, s.flags);
            for (rev, i) in &s.subs {
                let _ = write!(out, "{}{} 0 ", if *rev { '-' } else { '+' }, n - i);
            }
            out.push_str("*\n");
        }
        let _ = write!(out, "\n+{} 0\n", n - new_of[&root]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_mesh_object_is_a_mesh() {
        assert!(is_mesh_object("rhino:object:tessellation#adea78eb-86a6-4731-a58a-9700f24d0611"));
        assert!(!is_mesh_object("rhino:object:tessellation#184a8d39-26de-4f03-a951-48d86c8d061f.render-0"));
        assert!(!is_mesh_object("rhino:object:surface#adea78eb-86a6-4731-a58a-9700f24d0611"));
    }

    #[test]
    fn a_reversed_trim_runs_the_other_way_over_its_edge_range() {
        let g = json!({"kind": "nurbs", "degree": 1, "knots": [0.0, 0.0, 2.0, 2.0],
            "poles": {"points": [{"u": 0.0, "v": 0.0}, {"u": 4.0, "v": 1.0}]}});
        let pc = Nurbs::read(&g, 2).unwrap().reversed_if(true).remapped((10.0, 20.0));
        assert_eq!(pc.poles, [4.0, 1.0, 0.0, 0.0]);
        assert_eq!(pc.knots, [10.0, 20.0]);
        assert_eq!(pc.mults, [2, 2]);
    }

    #[test]
    fn knots_that_do_not_fit_the_poles_are_refused() {
        let g = json!({"kind": "nurbs", "degree": 2, "knots": [0.0, 1.0],
            "poles": {"points": [{"u": 0.0, "v": 0.0}, {"u": 4.0, "v": 1.0}]}});
        assert!(Nurbs::read(&g, 2).is_err());
    }

    #[test]
    fn black_by_layer_is_no_colour_and_a_faceless_body_is_not_an_object() {
        let black = json!({"r": 0.0, "g": 0.0, "b": 0.0});
        let ir = json!({
            "model": {
                "bodies": [
                    {"id": "rhino:object:body#a", "kind": "solid", "regions": ["r"], "color": black},
                    {"id": "rhino:object:body#b", "kind": "solid", "regions": ["r"], "color": black},
                    {"id": "rhino:object:body#c", "kind": "general", "regions": [], "color": black}
                ],
                "regions": [{"id": "r", "shells": ["s"]}],
                "shells": [{"id": "s", "members": [{"kind": "face", "id": "f"}]}]
            },
            "native": {"rhino": {"object_presentation": [
                {"id": "rhino:presentation:object#a", "color_source": 0, "links": ["rhino:object:record#000001"]},
                {"id": "rhino:presentation:object#b", "color_source": 1, "links": ["rhino:object:record#000000"]}
            ]}}
        });
        let (objs, faceless) = Model::index(&ir).objects();
        assert_eq!(faceless, 1);
        let got: Vec<(&str, Option<[u8; 3]>)> = objs.iter().map(|o| (o.uuid.as_str(), o.color)).collect();
        assert_eq!(got, [("b", Some([0, 0, 0])), ("a", None)]);
    }

    #[test]
    fn a_subd_is_named_in_a_note() {
        let ir = json!({"model": {"subds": [{"id": "rhino:object:subd#a"}, {"id": "rhino:object:subd#b"}],
            "curves": [{"id": "rhino:object:curve#c"}, {"id": "rhino:object:curve#d.c3-0"}]}});
        let notes = Model::index(&ir).skipped_note(0);
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes[0].starts_with("2 SubD objects were skipped"), "{notes:?}");
        assert!(notes[1].starts_with("1 curve, point or annotation object was skipped"), "{notes:?}");
    }
}
