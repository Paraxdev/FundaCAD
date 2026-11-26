use super::files::*;

#[test]
fn drops_route_by_extension_alone() {
    assert_eq!(route_dropped_name("C:\\parts\\Bracket.FUNDA"), DropAction::Open);
    assert_eq!(route_dropped_name("/a.b/old.neocad"), DropAction::Open);
    assert_eq!(route_dropped_name("scan.PLY"), DropAction::Import);
    assert_eq!(route_dropped_name("studio.exr"), DropAction::Environment);
    assert_eq!(route_dropped_name("notes.txt"), DropAction::Reject);
    assert_eq!(route_dropped_name("dir.step/README"), DropAction::Reject);
    assert_eq!(route_dropped_name("trailing."), DropAction::Reject);
}

#[test]
fn a_drop_opens_the_first_document_and_keeps_order() {
    let names = ["a.stl", "one.funda", "sky.hdr", "two.fundab", "b.step", "x.doc"];
    let plan = plan_drop(names, |n| n);
    assert_eq!(plan.open, Some("one.funda"));
    assert_eq!(plan.imports, ["a.stl", "b.step"]);
    assert_eq!(plan.environments, ["sky.hdr"]);
    assert_eq!(plan.skipped, ["two.fundab"]);
    assert_eq!(plan.rejected, ["x.doc"]);
}

#[test]
fn import_formats_follow_fundacad_1() {
    assert_eq!(import_format("a/part.STP"), "step");
    assert_eq!(import_format("part.step.gz"), "step");
    assert_eq!(import_format("mesh.wrz"), "vrml");
    assert_eq!(import_format("scene.x3dz"), "x3d");
    assert_eq!(import_format("p.igs"), "iges");
    assert_eq!(import_format("weird.txt"), "step");
}
