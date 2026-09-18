//! STEP through an XCAF document, replaces `exporters.export` for STEP and
//! the Python engine's `export_tree.py` (`build_export_tree`).

use std::collections::HashMap;
use std::path::Path;

use opencascade::primitives::Shape;
use opencascade::xcaf::StepWriter;
use serde_json::Value;

use super::ExportBody;
use crate::kernel;

/// What a STEP file carries: a product per node, a leaf per body.
pub enum Tree<'a> {
    Leaf { shape: &'a Shape, label: String, color: Option<[u8; 3]> },
    Group { label: String, children: Vec<Tree<'a>>, compound: Shape },
}

impl<'a> Tree<'a> {
    fn shape(&self) -> &Shape {
        match self {
            Tree::Leaf { shape, .. } => shape,
            Tree::Group { compound, .. } => compound,
        }
    }

    /// One compound per group, made once, so the component added for a group
    /// is the very shape its parent's compound holds.
    fn group(label: &str, children: Vec<Tree<'a>>) -> Tree<'a> {
        let compound = kernel::compound(children.iter().map(Tree::shape));
        Tree::Group { label: label.into(), children, compound }
    }
}

fn hex_color(hex: Option<&str>) -> Option<[u8; 3]> {
    let h = hex?.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let b = |i: usize| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok());
    Some([b(0)?, b(2)?, b(4)?])
}

fn display_name(b: &ExportBody<'_>) -> String {
    if !b.name.is_empty() {
        b.name.to_string()
    } else if !b.id.is_empty() {
        b.id.to_string()
    } else {
        "Body".into()
    }
}

/// `build_export_tree`: the bodies named, and grouped under the products of
/// the import manifests their `node_ref`s point into.
pub fn build_export_tree<'a>(
    document: &Value,
    bodies: &[ExportBody<'a>],
    root_name: &str,
) -> Option<Tree<'a>> {
    if bodies.is_empty() {
        return None;
    }
    let mut trees: HashMap<&str, &Vec<Value>> = HashMap::new();
    for f in document.get("features").and_then(Value::as_array).into_iter().flatten() {
        if f.get("type").and_then(Value::as_str) == Some("import") {
            if let Some(nodes) = f.get("nodes").and_then(Value::as_array).filter(|n| !n.is_empty()) {
                trees.insert(f.get("id").and_then(Value::as_str).unwrap_or(""), nodes);
            }
        }
    }
    let leaf = |b: &ExportBody<'a>, color| Tree::Leaf { shape: b.shape, label: display_name(b), color };

    if trees.is_empty() || !bodies.iter().any(|b| b.node_ref.is_some_and(|r| !r.is_empty())) {
        if bodies.len() == 1 {
            return Some(leaf(&bodies[0], None));
        }
        return Some(Tree::group(root_name, bodies.iter().map(|b| leaf(b, None)).collect()));
    }

    type Key<'k> = (&'k str, usize);
    let mut spec_of: HashMap<Key<'_>, &Value> = HashMap::new();
    let mut kids_of: HashMap<Key<'_>, Vec<Key<'_>>> = HashMap::new();
    let mut leaves_of: HashMap<Key<'_>, Vec<Tree<'a>>> = HashMap::new();
    let mut roots: Vec<Key<'_>> = Vec::new();
    let mut loose = Vec::new();

    fn ensure<'k>(
        key: Key<'k>,
        nodes: &'k [Value],
        spec_of: &mut HashMap<Key<'k>, &'k Value>,
        kids_of: &mut HashMap<Key<'k>, Vec<Key<'k>>>,
        roots: &mut Vec<Key<'k>>,
    ) {
        if spec_of.contains_key(&key) {
            return;
        }
        spec_of.insert(key, &nodes[key.1]);
        kids_of.insert(key, Vec::new());
        let parent = nodes[key.1].get("parent").and_then(Value::as_i64);
        match parent.and_then(|p| usize::try_from(p).ok()) {
            Some(p) if p < nodes.len() && p != key.1 => {
                ensure((key.0, p), nodes, spec_of, kids_of, roots);
                if let Some(k) = kids_of.get_mut(&(key.0, p)) {
                    k.push(key);
                }
            }
            _ => roots.push(key),
        }
    }

    for b in bodies {
        let r = b.node_ref.unwrap_or("");
        let slash = r.rfind('/').filter(|&s| s > 0);
        let feature_id = slash.map_or("", |s| &r[..s]);
        let nodes = (!feature_id.is_empty()).then(|| trees.get(feature_id)).flatten();
        let index = slash.and_then(|s| r[s + 1..].trim().parse::<i64>().ok());
        let found = match (nodes, index) {
            (Some(nodes), Some(i)) if i >= 0 && (i as usize) < nodes.len() => Some((nodes, i as usize)),
            _ => None,
        };
        let Some((nodes, i)) = found else {
            loose.push(leaf(b, None));
            continue;
        };
        let color = hex_color(nodes[i].get("color").and_then(Value::as_str));
        let key = (feature_id, i);
        ensure(key, nodes, &mut spec_of, &mut kids_of, &mut roots);
        leaves_of.entry(key).or_default().push(leaf(b, color));
    }

    fn materialise<'a, 'k>(
        key: Key<'k>,
        spec_of: &HashMap<Key<'k>, &Value>,
        kids_of: &HashMap<Key<'k>, Vec<Key<'k>>>,
        leaves_of: &mut HashMap<Key<'k>, Vec<Tree<'a>>>,
    ) -> Option<Tree<'a>> {
        let kids = kids_of.get(&key).cloned().unwrap_or_default();
        let mut parts: Vec<Tree<'a>> = kids
            .iter()
            .filter_map(|k| materialise(*k, spec_of, kids_of, leaves_of))
            .collect();
        parts.extend(leaves_of.remove(&key).unwrap_or_default());
        if parts.is_empty() {
            return None;
        }
        if parts.len() == 1 && kids.is_empty() {
            return parts.pop();
        }
        let label = spec_of
            .get(&key)
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Part");
        Some(Tree::group(label, parts))
    }

    let mut top: Vec<Tree<'a>> = roots
        .iter()
        .filter_map(|k| materialise(*k, &spec_of, &kids_of, &mut leaves_of))
        .collect();
    top.extend(loose);
    match top.len() {
        0 => None,
        1 => top.pop(),
        _ => Some(Tree::group(root_name, top)),
    }
}

fn add(w: &mut StepWriter, tree: &Tree<'_>, parent: Option<usize>) -> Result<(), String> {
    let (label, color) = match tree {
        Tree::Leaf { label, color, .. } => (label.as_str(), *color),
        Tree::Group { label, .. } => (label.as_str(), None),
    };
    let rgb = color.map(|c| c.map(|v| f64::from(v) / 255.0));
    let name = (!label.is_empty()).then_some(label);
    let Ok(index) = w.add(tree.shape(), parent, name, rgb) else {
        return Ok(());
    };
    if let Tree::Group { children, .. } = tree {
        for c in children {
            add(w, c, Some(index))?;
        }
    }
    Ok(())
}

/// Writes `tree` with names and colours, its root's label in the header.
pub fn write_tree(tree: &Tree<'_>, path: &Path) -> Result<(), String> {
    let mut w = StepWriter::new().map_err(|e| e.to_string())?;
    add(&mut w, tree, None)?;
    let header = match tree {
        Tree::Leaf { label, .. } | Tree::Group { label, .. } => label.as_str(),
    };
    w.write((!header.is_empty()).then_some(header), path).map_err(|e| e.to_string())
}

/// An unnamed shape, `exporters.export(shape, "step", path)`.
pub fn write_shape(shape: &Shape, path: &Path) -> Result<(), String> {
    let mut w = StepWriter::new().map_err(|e| e.to_string())?;
    w.add(shape, None, None, None).map_err(|e| e.to_string())?;
    w.write(None, path).map_err(|e| e.to_string())
}
