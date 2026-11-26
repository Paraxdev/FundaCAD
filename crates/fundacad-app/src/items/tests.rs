use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::*;

fn doc(v: Value) -> Map<String, Value> {
    v.as_object().expect("an object").clone()
}

fn node(name: &str, parent: Option<usize>) -> AsmNode {
    AsmNode { name: name.into(), parent }
}

/// A root with a subassembly instanced twice, each holding two products, as the engine emits asm_nested.step.
fn nested() -> Trees {
    let nodes = vec![
        node("Robot", None),
        node("Electronics", Some(0)),
        node("Board", Some(1)),
        node("MCU", Some(2)),
        node("Header (x2)", Some(2)),
        node("Board", Some(1)),
        node("MCU", Some(5)),
        node("Header (x2)", Some(5)),
        node("Chassis", Some(0)),
    ];
    HashMap::from([("f1".to_string(), nodes)])
}

fn body(id: &str, name: &str, node_ref: Option<&str>) -> BodyRef {
    BodyRef { id: id.into(), name: name.into(), node_ref: node_ref.map(str::to_string) }
}

#[test]
fn no_assembly_when_no_body_belongs_to_one() {
    assert!(assembly_groups(&[body("body1", "Body1", None)], &nested()).is_none());
}

#[test]
fn a_body_nests_under_its_products_whole_ancestor_chain() {
    let out = assembly_groups(&[body("body1", "MCU", Some("f1/3"))], &nested()).unwrap();
    assert_eq!(out.roots.len(), 1);
    assert_eq!(out.roots[0].label, "Robot");
    assert_eq!(out.roots[0].children[0].label, "Electronics");
    assert_eq!(out.roots[0].children[0].children[0].label, "Board");
    assert_eq!(out.ancestors["body1"], ["n:f1/0", "n:f1/1", "n:f1/2", "n:f1/3"]);
}

#[test]
fn two_occurrences_of_one_subassembly_stay_apart() {
    let out = assembly_groups(&[body("body1", "MCU", Some("f1/3")), body("body2", "MCU", Some("f1/6"))], &nested())
        .unwrap();
    let electronics = &out.roots[0].children[0];
    let labels: Vec<_> = electronics.children.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Board", "Board"]);
    assert_ne!(electronics.children[0].key, electronics.children[1].key);
}

#[test]
fn every_solid_of_a_product_sits_under_one_node_and_counts_go_deep() {
    let bodies = [
        body("body1", "MCU", Some("f1/3")),
        body("body2", "Header (x2) 1", Some("f1/4")),
        body("body3", "Header (x2) 2", Some("f1/4")),
        body("body4", "MCU", Some("f1/6")),
        body("body5", "Chassis", Some("f1/8")),
    ];
    let out = assembly_groups(&bodies, &nested()).unwrap();
    let board = &out.roots[0].children[0].children[0];
    assert_eq!(board.children[1].bodies.len(), 2);
    assert_eq!(out.roots[0].total, 5);
    assert_eq!(out.roots[0].children[0].total, 4);
}

#[test]
fn an_unresolved_node_ref_keeps_its_body_loose() {
    let bodies = [
        body("body1", "MCU", Some("f1/3")),
        body("body2", "Orphan", Some("f1/999")),
        body("body3", "Wrong feature", Some("f9/0")),
        body("body4", "Malformed", Some("nonsense")),
    ];
    let out = assembly_groups(&bodies, &nested()).unwrap();
    let loose: Vec<_> = out.loose.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(loose, ["Orphan", "Wrong feature", "Malformed"]);
}

#[test]
fn a_cyclic_parent_chain_ends_and_files_the_body() {
    let trees = HashMap::from([("f1".to_string(), vec![node("A", Some(1)), node("B", Some(0))])]);
    let out = assembly_groups(&[body("body1", "x", Some("f1/0"))], &trees).unwrap();
    assert!(out.loose.is_empty());
    assert_eq!(out.roots.len(), 1);
}

#[test]
fn an_unnamed_product_reads_part() {
    let trees = HashMap::from([("f1".to_string(), vec![node("", None)])]);
    let out = assembly_groups(&[body("body1", "x", Some("f1/0"))], &trees).unwrap();
    assert_eq!(out.roots[0].label, "Part");
}

fn el(id: &str, name: &str, parent: Option<&str>) -> ElementDef {
    ElementDef { id: id.into(), name: name.into(), parent: parent.map(str::to_string) }
}

fn assigned(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

#[test]
fn elements_nest_count_and_keep_empty_ones() {
    let bodies = [body("body1", "A", None), body("body2", "B", None), body("body3", "C", None)];
    let elements = [el("e1", "Rig", None), el("e2", "Motor", Some("e1")), el("e3", "Empty", None)];
    let out = body_tree(&bodies, &Trees::new(), &elements, &assigned(&[("body1", "e1"), ("body2", "e2")]));
    assert_eq!(out.groups.len(), 2);
    assert_eq!((out.groups[0].label.as_str(), out.groups[0].total), ("Rig", 2));
    assert_eq!(out.groups[0].children[0].bodies[0].id, "body2");
    assert_eq!(out.groups[1].total, 0);
    assert_eq!(out.loose.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["body3"]);
    assert_eq!(out.ancestors["body2"], ["e:e1", "e:e2"]);
}

#[test]
fn a_filed_body_leaves_its_imported_node_and_elements_come_first() {
    let bodies = [body("body0", "Loose", None), body("body1", "MCU", Some("f1/3")), body("body2", "MCU", Some("f1/6"))];
    let out = body_tree(&bodies, &nested(), &[el("e1", "Spares", None)], &assigned(&[("body1", "e1")]));
    let kinds: Vec<_> = out.groups.iter().map(|g| (g.kind, g.total)).collect();
    assert_eq!(kinds, [(GroupKind::Element, 1), (GroupKind::Assembly, 1)]);
    assert_eq!(out.ancestors["body1"], ["e:e1"]);
    assert_eq!(out.ancestors["body2"][0], "n:f1/0");
    assert_eq!(out.loose[0].id, "body0");
}

#[test]
fn an_assignment_to_a_missing_element_is_ignored() {
    let out = body_tree(&[body("body1", "A", None)], &Trees::new(), &[], &assigned(&[("body1", "gone")]));
    assert!(out.groups.is_empty());
    assert_eq!(out.loose[0].id, "body1");
}

#[test]
fn an_element_cycle_counts_as_roots() {
    let kids = children_by_parent(&[el("a", "A", Some("b")), el("b", "B", Some("a")), el("c", "C", Some("a"))]);
    let roots: Vec<_> = kids[""].iter().map(|e| e.id.as_str()).collect();
    assert_eq!(roots, ["a", "b"]);
    assert_eq!(kids["a"][0].id, "c");
}

fn labels(bodies: &[(&str, &str)], user: &[(&str, &str)]) -> Vec<(String, String)> {
    let bodies: Vec<BodyRef> = bodies.iter().map(|(id, n)| BodyRef::new(id, n)).collect();
    let user: HashMap<&str, &str> = user.iter().copied().collect();
    let out = body_labels(&bodies, |id| user.get(id).map(|s| s.to_string()));
    let mut out: Vec<_> = out.into_iter().collect();
    out.sort();
    out
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<_> = v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    v.sort();
    v
}

#[test]
fn body_labels_number_repeats_in_order() {
    let got = labels(
        &[("body3", "Box"), ("body1", "Cylinder"), ("body8", "Box"), ("body2", "Box"), ("body5", "Cylinder")],
        &[],
    );
    let want =
        pairs(&[("body3", "Box"), ("body1", "Cylinder"), ("body8", "Box 2"), ("body2", "Box 3"), ("body5", "Cylinder 2")]);
    assert_eq!(got, want);
}

#[test]
fn a_typed_name_wins_and_the_engines_twin_takes_the_number() {
    let got = labels(&[("body1", "Box"), ("body2", "Box"), ("body3", "Sphere")], &[("body2", "Lid"), ("body3", "Lid")]);
    assert_eq!(got, pairs(&[("body1", "Box"), ("body2", "Lid"), ("body3", "Lid 2")]));
    let got = labels(&[("body1", "Box"), ("body2", "Cylinder"), ("body3", "Box")], &[("body2", "Box")]);
    assert_eq!(got, pairs(&[("body1", "Box 2"), ("body2", "Box"), ("body3", "Box 3")]));
}

#[test]
fn body_labels_skip_a_taken_number_and_fall_back_to_the_id() {
    let got = labels(&[("body1", "Box"), ("body2", "Box"), ("body3", "Box")], &[("body3", "Box 2")]);
    assert_eq!(got, pairs(&[("body1", "Box"), ("body2", "Box 3"), ("body3", "Box 2")]));
    assert_eq!(labels(&[("body6", "")], &[]), pairs(&[("body6", "body6")]));
}

#[test]
fn filters_show_their_sections() {
    assert!(Filter::All.shows(Section::Sketches));
    assert!(Filter::Planes.shows(Section::Origin) && Filter::Planes.shows(Section::Planes));
    assert!(!Filter::Planes.shows(Section::Bodies));
    assert!(Filter::Bodies.shows(Section::Bodies) && !Filter::Bodies.shows(Section::Sketches));
    assert_eq!(FILTERS.map(Filter::label), ["All items", "Bodies", "Planes and axes", "Sketches"]);
}

#[test]
fn indents_step_by_twenty_and_cap() {
    assert_eq!(folder_indent(0), 4.);
    assert_eq!(row_indent(1), 44.);
    assert_eq!(folder_indent(9), folder_indent(6));
}

#[test]
fn a_body_two_features_build_is_listed_once_and_same_names_get_numbers() {
    let d = doc(json!({"bodyIds": {"box:0": "body1", "lid:0": "body2", "lip:0": "body2"}}));
    let inputs = |built: &[BodyRef]| {
        let rows = nodes(&Inputs {
            doc: &d,
            bodies: built,
            collapse: &Collapse::default(),
            filter: Filter::Bodies,
            errors: &HashSet::new(),
        });
        rows.iter().filter(|n| n.k.starts_with("b:")).map(|n| n.label.clone()).collect::<Vec<_>>()
    };
    assert_eq!(inputs(&[]), ["Body1", "Body2"]);
    assert_eq!(inputs(&[BodyRef::new("body1", "Box"), BodyRef::new("body2", "Box")]), ["Box", "Box 2"]);
}

fn sample() -> Map<String, Value> {
    doc(json!({
        "features": [
            {"id": "s1", "type": "sketch", "name": "Base"},
            {"id": "ex", "type": "extrude"},
            {"id": "s2", "type": "sketch"},
            {"id": "dp", "type": "datumPlane"},
            {"id": "ax", "type": "datumAxis"},
            {"id": "j1", "type": "joint", "moving": "body2", "to": {"body": "body1"}},
            {"id": "m1", "type": "mechanism"},
        ],
        "suppressed": ["s2"],
        "bodyIds": {"ex:0": "body1", "ex:1": "body2"},
        "bodyNames": {"body2": "Lid"},
        "bodyVisibility": {"body1": false},
        "sketchVisibility": {"s1": true},
        "elements": [{"id": "e1", "name": "Rig"}],
        "bodyElement": {"body2": "e1"},
    }))
}

fn keys(nodes: &[Node]) -> Vec<&str> {
    nodes.iter().map(|n| n.k.as_str()).collect()
}

#[test]
fn the_document_reads_as_folders_and_rows() {
    let d = sample();
    let built = [BodyRef::new("body1", "Box"), BodyRef::new("body2", "Box")];
    let errors = HashSet::from(["s1".to_string()]);
    let nodes = nodes(&Inputs { doc: &d, bodies: &built, collapse: &Collapse::default(), filter: Filter::All, errors: &errors });
    assert_eq!(
        keys(&nodes),
        [
            "f:Origin", "o:XY", "o:XZ", "o:YZ", "f:Planes", "p:dp", "f:Datums", "d:ax", "f:Bodies", "e:e1", "b:body2",
            "b:body1", "f:Joints", "j:j1", "f:Mechanisms", "m:m1", "f:Sketches", "s:s1", "s:s2",
        ]
    );
    let by = |k: &str| nodes.iter().find(|n| n.k == k).unwrap();
    assert_eq!(by("p:dp").label, "Plane1");
    assert_eq!(by("d:ax").label, "Axis1");
    assert_eq!(by("b:body2").label, "Lid");
    assert_eq!(by("b:body2").depth, 2);
    assert_eq!(by("b:body1").eye.as_ref().unwrap().visible, false);
    assert_eq!(by("j:j1").label, "Lid → Box");
    assert_eq!(by("m:m1").label, "Mechanism 1");
    assert_eq!(by("s:s2").label, "Sketch2");
    assert!(by("s:s1").error && by("s:s1").eye.as_ref().unwrap().visible);
    assert!(by("s:s2").suppressed && !by("s:s2").eye.as_ref().unwrap().visible);
    assert!(matches!(by("f:Bodies").kind, Kind::Folder { count: 2, .. }));
    let head = by("e:e1");
    assert_eq!(head.eye.as_ref().unwrap().key, "g:e:e1");
    assert_eq!(head.eye.as_ref().unwrap().ids, ["body2"]);
    assert_eq!(head.rename, Some(Rename::Element("e1".into())));
}

#[test]
fn a_folded_folder_and_a_filter_leave_rows_out() {
    let d = sample();
    let mut collapse = Collapse::default();
    collapse.toggle("f:Sketches");
    let errors = HashSet::new();
    let nodes = nodes(&Inputs { doc: &d, bodies: &[], collapse: &collapse, filter: Filter::Sketches, errors: &errors });
    assert_eq!(keys(&nodes), ["f:Sketches"]);
    assert!(matches!(nodes[0].kind, Kind::Folder { count: 2, collapsed: true, .. }));
}

#[test]
fn empty_folders_say_so_and_bodies_fall_back_to_the_documents_ids() {
    let empty = doc(json!({"features": []}));
    let errors = HashSet::new();
    let c = Collapse::default();
    let nodes = nodes(&Inputs { doc: &empty, bodies: &[], collapse: &c, filter: Filter::All, errors: &errors });
    let notes: Vec<_> = nodes.iter().filter(|n| n.kind == Kind::Empty).map(|n| n.label.as_str()).collect();
    assert_eq!(notes, ["No bodies yet", "No sketches yet"]);
    let d = sample();
    let list = body_list(&d, &[]);
    assert_eq!(list.iter().map(|b| (b.id.as_str(), b.name.as_str())).collect::<Vec<_>>(), [("body1", "Body1"), ("body2", "Body2")]);
}

#[test]
fn assembly_nodes_start_folded_and_a_lone_part_reads_as_its_body() {
    let d = doc(json!({"features": [{"id": "f1", "type": "import", "nodes": [
        {"name": "Robot", "parent": null}, {"name": "Arm", "parent": 0}, {"name": "Base", "parent": 0}]}]}));
    let built = [body("body1", "Arm", Some("f1/1")), body("body2", "Base", Some("f1/2"))];
    let errors = HashSet::new();
    let mut collapse = Collapse::default();
    let list = |c: &Collapse| nodes(&Inputs { doc: &d, bodies: &built, collapse: c, filter: Filter::Bodies, errors: &errors });
    assert_eq!(keys(&list(&collapse)), ["f:Bodies", "n:f1/0"]);
    collapse.toggle("n:f1/0");
    assert_eq!(keys(&list(&collapse)), ["f:Bodies", "n:f1/0", "b:body1", "b:body2"]);
}

#[test]
fn every_glyph_is_in_the_icon_pack() {
    use gpui::AssetSource as _;
    let missing: Vec<_> = GLYPHS
        .iter()
        .chain(&["caretDown", "caretRight", "visible", "hidden", "more", "check"])
        .filter(|g| crate::assets::Assets.load(&crate::ui::icon_path(g)).ok().flatten().is_none())
        .collect();
    assert!(missing.is_empty(), "missing icons: {missing:?}");
}
