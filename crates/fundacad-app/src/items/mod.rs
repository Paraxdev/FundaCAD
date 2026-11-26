//! The Items browser as data: the flat list of folders and rows BrowserPane drew, from the document and the built
//! bodies. Nothing here draws, so the shell's card only walks the list.

mod edit;
pub mod geometry;

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

pub use edit::*;

/// A built body as the browser lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct BodyRef {
    pub id: String,
    pub name: String,
    /// `<import feature id>/<node index>` when the body came out of an imported assembly.
    pub node_ref: Option<String>,
}

impl BodyRef {
    pub fn new(id: &str, name: &str) -> Self {
        Self { id: id.into(), name: name.into(), node_ref: None }
    }

    pub fn of(body: &fundacad_client::Body) -> Self {
        let node_ref = body.fields.get("nodeRef").and_then(Value::as_str).map(str::to_string);
        Self { id: body.id.clone(), name: body.name.clone(), node_ref }
    }
}

/// The lists whose eyes go together: a solo on a sketch hides sketches and nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    Bodies,
    Sketches,
    Planes,
    Datums,
}

impl Category {
    pub fn show_all_label(self) -> &'static str {
        match self {
            Category::Bodies => "Show all bodies",
            Category::Sketches => "Show all sketches",
            Category::Planes => "Show all planes",
            Category::Datums => "Show all datums",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Filter {
    #[default]
    All,
    Bodies,
    Planes,
    Sketches,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Origin,
    Planes,
    Bodies,
    Sketches,
}

pub const FILTERS: [Filter; 4] = [Filter::All, Filter::Bodies, Filter::Planes, Filter::Sketches];

impl Filter {
    pub fn label(self) -> &'static str {
        match self {
            Filter::All => "All items",
            Filter::Bodies => "Bodies",
            Filter::Planes => "Planes and axes",
            Filter::Sketches => "Sketches",
        }
    }

    /// Origin and the construction planes are separate sections one filter shows together.
    pub fn shows(self, section: Section) -> bool {
        match self {
            Filter::All => true,
            Filter::Bodies => section == Section::Bodies,
            Filter::Planes => matches!(section, Section::Origin | Section::Planes),
            Filter::Sketches => section == Section::Sketches,
        }
    }
}

/// What a row's eye stands for. `key` is a body or feature id, or `g:<collapse key>` for a folder head standing for
/// every body in `ids`.
#[derive(Clone, Debug, PartialEq)]
pub struct Eye {
    pub category: Category,
    pub key: String,
    pub ids: Vec<String>,
    pub visible: bool,
}

/// Where a rename writes.
#[derive(Clone, Debug, PartialEq)]
pub enum Rename {
    Body(String),
    Feature(String),
    Element(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// `members` are the body ids at or below an element or assembly head, which a click on it selects.
    Folder { count: usize, collapsed: bool, members: Vec<String> },
    Row,
    Empty,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    /// The row's key, also its collapse key on a folder: `f:Bodies`, `e:<element>`, `n:<feature>/<node>`, `b:<body>`,
    /// `o:XY`, `p:`, `d:`, `j:`, `m:` or `s:<feature>`.
    pub k: String,
    pub kind: Kind,
    pub depth: usize,
    pub label: String,
    pub icon: &'static str,
    pub eye: Option<Eye>,
    pub rename: Option<Rename>,
    pub dim: bool,
    pub suppressed: bool,
    pub error: bool,
}

impl Node {
    fn row(k: String, depth: usize, label: String, icon: &'static str) -> Self {
        Self {
            k,
            kind: Kind::Row,
            depth,
            label,
            icon,
            eye: None,
            rename: None,
            dim: false,
            suppressed: false,
            error: false,
        }
    }

    pub fn is_folder(&self) -> bool {
        matches!(self.kind, Kind::Folder { .. })
    }

    /// The body or feature id behind a row key.
    pub fn id(&self) -> &str {
        self.k.split_once(':').map_or("", |(_, id)| id)
    }
}

/// Which folders the user folded. Assembly nodes start folded so a big import does not paint every part on arrival.
#[derive(Clone, Debug, Default)]
pub struct Collapse(HashMap<String, bool>);

impl Collapse {
    pub fn is_collapsed(&self, key: &str) -> bool {
        self.0.get(key).copied().unwrap_or_else(|| key.starts_with("n:"))
    }

    pub fn toggle(&mut self, key: &str) {
        let next = !self.is_collapsed(key);
        self.0.insert(key.to_string(), next);
    }
}

/// A caret plus the head gap, so a child caret sits under its parent icon; a leaf takes one more step. Capped, the
/// card has no horizontal scroll.
pub fn folder_indent(depth: usize) -> f32 {
    4. + depth.min(6) as f32 * 20.
}

pub fn row_indent(depth: usize) -> f32 {
    folder_indent(depth) + 20.
}

pub(crate) fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(crate) fn features(doc: &Map<String, Value>) -> impl Iterator<Item = &Value> {
    doc.get("features").and_then(Value::as_array).into_iter().flatten()
}

fn features_of<'a>(doc: &'a Map<String, Value>, types: &'a [&str]) -> Vec<&'a Value> {
    features(doc).filter(|f| str_of(f, "type").is_some_and(|t| types.contains(&t))).collect()
}

fn own_name(f: &Value) -> Option<&str> {
    str_of(f, "name").filter(|n| !n.trim().is_empty())
}

pub fn datum_plane_name(f: &Value, place: usize) -> String {
    own_name(f).map_or_else(|| format!("Plane{}", place + 1), str::to_string)
}

pub(crate) fn flag(doc: &Map<String, Value>, side: &str, id: &str, default: bool) -> bool {
    doc.get(side).and_then(|m| m.get(id)).and_then(Value::as_bool).unwrap_or(default)
}

pub fn suppressed(doc: &Map<String, Value>, id: &str) -> bool {
    doc.get("suppressed").and_then(Value::as_array).is_some_and(|s| s.iter().any(|v| v.as_str() == Some(id)))
}

pub fn body_visible(doc: &Map<String, Value>, id: &str) -> bool {
    flag(doc, "bodyVisibility", id, true)
}

pub fn sketch_visible(doc: &Map<String, Value>, id: &str) -> bool {
    flag(doc, "sketchVisibility", id, false)
}

/// The Origin planes start hidden, datums shown.
pub fn plane_visible(doc: &Map<String, Value>, id: &str) -> bool {
    flag(doc, "planeVisibility", id, !matches!(id, "XY" | "XZ" | "YZ"))
}

/// The rebuild's bodies, or before any build the document's own body ids, so the list is not empty while it builds.
pub fn body_list(doc: &Map<String, Value>, built: &[BodyRef]) -> Vec<BodyRef> {
    if !built.is_empty() {
        return built.to_vec();
    }
    let mut out: Vec<BodyRef> = Vec::new();
    for id in doc.get("bodyIds").and_then(Value::as_object).into_iter().flat_map(|m| m.values().filter_map(Value::as_str))
    {
        if !out.iter().any(|b| b.id == id) {
            let mut name = id.to_string();
            if let Some(c) = name.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            out.push(BodyRef::new(id, &name));
        }
    }
    out
}

/// Each body's label: the user's name for it, else the engine's, else its id, with " 2", " 3" on repeats in the
/// order given. A name the user typed is labelled first, so an engine "Box" takes the number, not the user's.
pub fn body_labels(bodies: &[BodyRef], user: impl Fn(&str) -> Option<String>) -> HashMap<String, String> {
    let user: Vec<String> = bodies.iter().map(|b| user(&b.id).unwrap_or_default()).collect();
    let base: Vec<String> = bodies
        .iter()
        .zip(&user)
        .map(|(b, u)| {
            if !u.is_empty() {
                u.clone()
            } else if !b.name.is_empty() {
                b.name.clone()
            } else {
                b.id.clone()
            }
        })
        .collect();
    let mut taken: HashSet<String> = base.iter().cloned().collect();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut order: Vec<usize> = (0..bodies.len()).collect();
    order.sort_by_key(|&i| user[i].is_empty());
    let mut out = HashMap::new();
    for i in order {
        let name = &base[i];
        let mut n = seen.get(name).copied().unwrap_or(0) + 1;
        let mut label = name.clone();
        if n > 1 {
            while taken.contains(&format!("{name} {n}")) {
                n += 1;
            }
            label = format!("{name} {n}");
            taken.insert(label.clone());
        }
        seen.insert(name.clone(), n);
        out.insert(bodies[i].id.clone(), label);
    }
    out
}

pub fn user_body_name(doc: &Map<String, Value>, id: &str) -> Option<String> {
    doc.get("bodyNames").and_then(|m| m.get(id)).and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ElementDef {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
}

pub fn elements_of(doc: &Map<String, Value>) -> Vec<ElementDef> {
    let list = doc.get("elements").and_then(Value::as_array).into_iter().flatten();
    list.filter_map(|e| {
        Some(ElementDef {
            id: str_of(e, "id")?.to_string(),
            name: str_of(e, "name").unwrap_or("").to_string(),
            parent: str_of(e, "parent").map(str::to_string),
        })
    })
    .collect()
}

/// An element whose parent is missing or caught in a cycle counts as a root: a folder not drawn hides its contents.
pub fn children_by_parent(elements: &[ElementDef]) -> HashMap<String, Vec<ElementDef>> {
    let by_id: HashMap<&str, &ElementDef> = elements.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut cyclic: HashSet<&str> = HashSet::new();
    let mut settled: HashSet<&str> = HashSet::new();
    for e in elements {
        if settled.contains(e.id.as_str()) {
            continue;
        }
        let mut path: Vec<&str> = Vec::new();
        let mut on_path: HashSet<&str> = HashSet::new();
        let mut cur = Some(e.id.as_str());
        while let Some(c) = cur.filter(|c| by_id.contains_key(c) && !settled.contains(c) && !on_path.contains(c)) {
            on_path.insert(c);
            path.push(c);
            cur = by_id[c].parent.as_deref();
        }
        let from = cur.filter(|c| on_path.contains(c)).and_then(|c| path.iter().position(|p| *p == c));
        let from = from.unwrap_or(path.len());
        for (i, p) in path.iter().enumerate() {
            settled.insert(p);
            if i >= from {
                cyclic.insert(p);
            }
        }
    }
    let mut out: HashMap<String, Vec<ElementDef>> = HashMap::new();
    for e in elements {
        let parent = e
            .parent
            .as_deref()
            .filter(|p| by_id.contains_key(p) && !cyclic.contains(e.id.as_str()))
            .unwrap_or("")
            .to_string();
        out.entry(parent).or_default().push(e.clone());
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GroupKind {
    Element,
    Assembly,
}

/// An element or an imported assembly node.
#[derive(Clone, Debug, PartialEq)]
pub struct TreeGroup {
    pub kind: GroupKind,
    /// `e:<element id>` or `n:<feature id>/<node index>`.
    pub key: String,
    pub label: String,
    pub children: Vec<TreeGroup>,
    pub bodies: Vec<BodyRef>,
    /// Bodies at or below here, what the count badge shows.
    pub total: usize,
}

impl TreeGroup {
    pub fn body_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect(&self, out: &mut Vec<String>) {
        out.extend(self.bodies.iter().map(|b| b.id.clone()));
        for c in &self.children {
            c.collect(out);
        }
    }

    pub fn element_id(&self) -> Option<&str> {
        (self.kind == GroupKind::Element).then(|| self.key.trim_start_matches("e:"))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AsmNode {
    pub name: String,
    pub parent: Option<usize>,
}

pub type Trees = HashMap<String, Vec<AsmNode>>;

/// feature id to the assembly manifest an import feature carries.
pub fn import_trees(doc: &Map<String, Value>) -> Trees {
    let mut out = Trees::new();
    for f in features_of(doc, &["import"]) {
        let (Some(id), Some(nodes)) = (str_of(f, "id"), f.get("nodes").and_then(Value::as_array)) else { continue };
        let nodes = nodes
            .iter()
            .map(|n| AsmNode {
                name: str_of(n, "name").unwrap_or("").to_string(),
                parent: n.get("parent").and_then(Value::as_u64).map(|p| p as usize),
            })
            .collect();
        out.insert(id.to_string(), nodes);
    }
    out
}

pub struct AsmGroups {
    pub roots: Vec<TreeGroup>,
    pub loose: Vec<BodyRef>,
    pub ancestors: HashMap<String, Vec<String>>,
}

/// None when no body belongs to an assembly. A body whose `node_ref` does not resolve goes to `loose`, a dropped
/// body would be invisible and unselectable.
pub fn assembly_groups(bodies: &[BodyRef], trees: &Trees) -> Option<AsmGroups> {
    if !bodies.iter().any(|b| b.node_ref.is_some()) {
        return None;
    }
    let mut roots: Vec<TreeGroup> = Vec::new();
    let mut loose = Vec::new();
    let mut ancestors = HashMap::new();
    for b in bodies {
        let plain = BodyRef { node_ref: None, ..b.clone() };
        let split = b.node_ref.as_deref().and_then(|r| r.rsplit_once('/')).filter(|(f, _)| !f.is_empty());
        let resolved = split.and_then(|(feature, leaf)| {
            let nodes = trees.get(feature)?;
            let leaf: usize = leaf.parse().ok().filter(|&i| i < nodes.len())?;
            Some((feature, nodes, leaf))
        });
        let Some((feature, nodes, leaf)) = resolved else {
            loose.push(plain);
            continue;
        };
        // Walked leaf to root, a cyclic `parent` in a hand-edited file stops at the first repeat.
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut at = Some(leaf);
        while let Some(i) = at.filter(|&i| i < nodes.len() && seen.insert(i)) {
            chain.insert(0, i);
            at = nodes[i].parent;
        }
        let keys: Vec<String> = chain.iter().map(|i| format!("n:{feature}/{i}")).collect();
        let mut siblings = &mut roots;
        for (index, key) in chain.iter().zip(&keys) {
            let at = match siblings.iter().position(|g| &g.key == key) {
                Some(at) => at,
                None => {
                    let name = &nodes[*index].name;
                    siblings.push(TreeGroup {
                        kind: GroupKind::Assembly,
                        key: key.clone(),
                        label: if name.is_empty() { "Part".into() } else { name.clone() },
                        children: Vec::new(),
                        bodies: Vec::new(),
                        total: 0,
                    });
                    siblings.len() - 1
                }
            };
            if key == keys.last().expect("the chain holds the leaf") {
                siblings[at].bodies.push(plain.clone());
                break;
            }
            siblings = &mut siblings[at].children;
        }
        ancestors.insert(b.id.clone(), keys);
    }
    fn total(g: &mut TreeGroup) -> usize {
        g.total = g.bodies.len() + g.children.iter_mut().map(total).sum::<usize>();
        g.total
    }
    roots.iter_mut().for_each(|r| {
        total(r);
    });
    Some(AsmGroups { roots, loose, ancestors })
}

pub struct BodyTree {
    pub groups: Vec<TreeGroup>,
    pub loose: Vec<BodyRef>,
    /// The folder keys above each body, for opening the way to a body picked in the view once that link exists.
    #[cfg_attr(not(test), allow(dead_code))]
    pub ancestors: HashMap<String, Vec<String>>,
}

/// Elements first, then the imported assembly structure, then the rest. A body the user filed shows only in its
/// element, whatever its file said. Empty elements are kept so they can be filled later.
pub fn body_tree(
    bodies: &[BodyRef],
    trees: &Trees,
    elements: &[ElementDef],
    body_element: &HashMap<String, String>,
) -> BodyTree {
    let known: HashSet<&str> = elements.iter().map(|e| e.id.as_str()).collect();
    let mut held: HashMap<String, Vec<BodyRef>> = HashMap::new();
    let mut rest = Vec::new();
    for b in bodies {
        match body_element.get(&b.id).filter(|e| known.contains(e.as_str())) {
            Some(e) => held.entry(e.clone()).or_default().push(BodyRef { node_ref: None, ..b.clone() }),
            None => rest.push(b.clone()),
        }
    }
    let mut ancestors = HashMap::new();
    let kids = children_by_parent(elements);
    fn walk(
        e: &ElementDef,
        chain: &[String],
        kids: &HashMap<String, Vec<ElementDef>>,
        held: &HashMap<String, Vec<BodyRef>>,
        ancestors: &mut HashMap<String, Vec<String>>,
    ) -> TreeGroup {
        let key = format!("e:{}", e.id);
        let mut here = chain.to_vec();
        here.push(key.clone());
        let children: Vec<TreeGroup> =
            kids.get(&e.id).into_iter().flatten().map(|c| walk(c, &here, kids, held, ancestors)).collect();
        let bodies = held.get(&e.id).cloned().unwrap_or_default();
        for b in &bodies {
            ancestors.insert(b.id.clone(), here.clone());
        }
        let total = bodies.len() + children.iter().map(|c| c.total).sum::<usize>();
        TreeGroup { kind: GroupKind::Element, key, label: e.name.clone(), children, bodies, total }
    }
    let mut groups: Vec<TreeGroup> =
        kids.get("").into_iter().flatten().map(|e| walk(e, &[], &kids, &held, &mut ancestors)).collect();
    let loose = match assembly_groups(&rest, trees) {
        Some(asm) => {
            ancestors.extend(asm.ancestors);
            groups.extend(asm.roots);
            asm.loose
        }
        None => rest.into_iter().map(|b| BodyRef { node_ref: None, ..b }).collect(),
    };
    BodyTree { groups, loose, ancestors }
}

pub fn body_elements(doc: &Map<String, Value>) -> HashMap<String, String> {
    let map = doc.get("bodyElement").and_then(Value::as_object).into_iter().flatten();
    map.filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()
}

/// What the list is built from.
pub struct Inputs<'a> {
    pub doc: &'a Map<String, Value>,
    pub bodies: &'a [BodyRef],
    pub collapse: &'a Collapse,
    pub filter: Filter,
    /// Features the latest rebuild could not build.
    pub errors: &'a HashSet<String>,
}

/// The tree's rows in drawn order.
pub fn nodes(i: &Inputs) -> Vec<Node> {
    let doc = i.doc;
    let show = |s| i.filter.shows(s);
    let mut out: Vec<Node> = Vec::new();
    let feature_row = |prefix: &str, f: &Value, label: String, icon: &'static str| {
        let id = str_of(f, "id").unwrap_or("").to_string();
        let mut row = Node::row(format!("{prefix}:{id}"), 1, label, icon);
        row.error = i.errors.contains(&id);
        row.suppressed = suppressed(doc, &id);
        row.rename = Some(Rename::Feature(id));
        row
    };
    let folder = |out: &mut Vec<Node>, id: &str, label: &str, icon: &'static str, rows: Vec<Node>, empty: &str| {
        let key = format!("f:{id}");
        let collapsed = i.collapse.is_collapsed(&key);
        let kind = Kind::Folder { count: rows.len(), collapsed, members: Vec::new() };
        out.push(Node { kind, ..Node::row(key.clone(), 0, label.into(), icon) });
        if collapsed {
            return;
        }
        if rows.is_empty() && !empty.is_empty() {
            out.push(Node { kind: Kind::Empty, ..Node::row(format!("{key}:empty"), 1, empty.into(), "") });
        }
        out.extend(rows);
    };

    if show(Section::Origin) {
        let rows = ["XY", "XZ", "YZ"]
            .into_iter()
            .map(|p| {
                let on = plane_visible(doc, p);
                let mut row = Node { dim: !on, ..Node::row(format!("o:{p}"), 1, format!("{p} plane"), "plane") };
                row.eye = Some(eye(Category::Planes, p, on));
                row
            })
            .collect();
        folder(&mut out, "Origin", "Origin", "origin", rows, "");
    }

    let datums = features_of(doc, &["datumPlane"]);
    if !datums.is_empty() && show(Section::Planes) {
        let rows = datums
            .iter()
            .enumerate()
            .map(|(n, f)| {
                let mut row = feature_row("p", f, datum_plane_name(f, n), "plane");
                row.eye = Some(eye(Category::Planes, row.id(), plane_visible(doc, row.id())));
                row
            })
            .collect();
        folder(&mut out, "Planes", "Planes", "plane", rows, "");
    }

    let refs = features_of(doc, &["datumPoint", "datumAxis"]);
    if !refs.is_empty() && show(Section::Planes) {
        let rows = refs
            .iter()
            .enumerate()
            .map(|(n, f)| {
                let axis = str_of(f, "type") == Some("datumAxis");
                let label = own_name(f).map_or_else(
                    || if axis { format!("Axis{}", n + 1) } else { format!("Point{}", n + 1) },
                    str::to_string,
                );
                let mut row = feature_row("d", f, label, if axis { "datumAxis" } else { "datumPoint" });
                row.eye = Some(eye(Category::Datums, row.id(), plane_visible(doc, row.id())));
                row
            })
            .collect();
        folder(&mut out, "Datums", "Datums", "datumPoint", rows, "");
    }

    let bodies = body_list(doc, i.bodies);
    let labels = body_labels(&bodies, |id| user_body_name(doc, id));
    if show(Section::Bodies) {
        let body_row = |b: &BodyRef, depth: usize| {
            let label = labels.get(&b.id).cloned().unwrap_or_else(|| b.name.clone());
            let mut row = Node::row(format!("b:{}", b.id), depth, label, "body");
            row.eye = Some(eye(Category::Bodies, &b.id, body_visible(doc, &b.id)));
            row.rename = Some(Rename::Body(b.id.clone()));
            row
        };
        let tree = body_tree(&bodies, &import_trees(doc), &elements_of(doc), &body_elements(doc));
        let collapsed = i.collapse.is_collapsed("f:Bodies");
        let kind = Kind::Folder { count: bodies.len(), collapsed, members: Vec::new() };
        out.push(Node { kind, ..Node::row("f:Bodies".into(), 0, "Bodies".into(), "body") });
        if !collapsed {
            if tree.groups.is_empty() && tree.loose.is_empty() {
                out.push(Node { kind: Kind::Empty, ..Node::row("f:Bodies:empty".into(), 1, "No bodies yet".into(), "") });
            }
            fn group_node(
                g: &TreeGroup,
                depth: usize,
                out: &mut Vec<Node>,
                i: &Inputs,
                body_row: &dyn Fn(&BodyRef, usize) -> Node,
            ) {
                // A one-body leaf of an import reads as that body, an element stays a folder the user made on purpose.
                if g.kind == GroupKind::Assembly && g.children.is_empty() && g.bodies.len() == 1 {
                    out.push(body_row(&g.bodies[0], depth));
                    return;
                }
                let ids = g.body_ids();
                let any = ids.iter().any(|id| body_visible(i.doc, id));
                let collapsed = i.collapse.is_collapsed(&g.key);
                let element = g.element_id().map(|e| Rename::Element(e.to_string()));
                let icon = if element.is_some() { "element" } else { "assembly" };
                out.push(Node {
                    kind: Kind::Folder { count: g.total, collapsed, members: ids.clone() },
                    eye: Some(Eye { category: Category::Bodies, key: format!("g:{}", g.key), ids, visible: any }),
                    rename: element,
                    ..Node::row(g.key.clone(), depth, g.label.clone(), icon)
                });
                if collapsed {
                    return;
                }
                for c in &g.children {
                    group_node(c, depth + 1, out, i, body_row);
                }
                for b in &g.bodies {
                    out.push(body_row(b, depth + 1));
                }
            }
            for g in &tree.groups {
                group_node(g, 1, &mut out, i, &body_row);
            }
            for b in &tree.loose {
                out.push(body_row(b, 1));
            }
        }
    }

    let name_of = |id: Option<&str>| {
        let id = id.unwrap_or("?");
        labels.get(id).cloned().unwrap_or_else(|| id.to_string())
    };
    let joints = features_of(doc, &["joint"]);
    if !joints.is_empty() && show(Section::Bodies) {
        let rows = joints
            .iter()
            .map(|f| {
                let to = f.get("to").and_then(|t| str_of(t, "body"));
                let label = own_name(f)
                    .map_or_else(|| format!("{} → {}", name_of(str_of(f, "moving")), name_of(to)), str::to_string);
                feature_row("j", f, label, "assembly")
            })
            .collect();
        folder(&mut out, "Joints", "Joints", "assembly", rows, "");
    }
    let mechanisms = features_of(doc, &["mechanism"]);
    if !mechanisms.is_empty() && show(Section::Bodies) {
        let rows = mechanisms
            .iter()
            .enumerate()
            .map(|(n, f)| {
                let label = own_name(f).map_or_else(|| format!("Mechanism {}", n + 1), str::to_string);
                feature_row("m", f, label, "mechanism")
            })
            .collect();
        folder(&mut out, "Mechanisms", "Mechanisms", "mechanism", rows, "");
    }

    if show(Section::Sketches) {
        let rows = features_of(doc, &["sketch"])
            .iter()
            .enumerate()
            .map(|(n, f)| {
                let label = own_name(f).map_or_else(|| format!("Sketch{}", n + 1), str::to_string);
                let mut row = feature_row("s", f, label, "sketch");
                row.eye = Some(eye(Category::Sketches, row.id(), sketch_visible(doc, row.id())));
                row
            })
            .collect();
        folder(&mut out, "Sketches", "Sketches", "sketch", rows, "No sketches yet");
    }
    out
}

fn eye(category: Category, key: &str, visible: bool) -> Eye {
    Eye { category, key: key.to_string(), ids: Vec::new(), visible }
}

/// Every glyph the list can draw.
#[cfg(test)]
pub const GLYPHS: [&str; 9] =
    ["origin", "plane", "datumPoint", "datumAxis", "body", "element", "assembly", "mechanism", "sketch"];

#[cfg(test)]
mod tests;
