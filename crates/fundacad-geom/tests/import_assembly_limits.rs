//! The XCAF product walk places every instance of a shared product, so its work grows with the
//! instance count, not the file size. It stops with an error past a budget of instances or nesting.

use std::path::PathBuf;

use fundacad_geom::import::{self, blobstore::BlobStore};
use opencascade::xcaf;

/// inside_out_cube.step (product definition #5, representation #10) under `levels` assembly levels,
/// each holding `per_level` instances of the level below it. `back` adds an instance of the
/// second level inside the first, so the two hold each other.
fn assembly(name: &str, levels: usize, per_level: usize, back: bool) -> PathBuf {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
    let text = std::fs::read_to_string(fixtures.join("inside_out_cube.step")).unwrap();
    let end = text.rfind("ENDSEC;").unwrap();
    let mut extra = String::new();
    let mut id: u32 = 100_000;
    let mut next = || {
        id += 1;
        id
    };
    let (mut child_pd, mut child_rep): (u32, u32) = (5, 10);
    let link = |extra: &mut String, parent: (u32, u32), child: (u32, u32), n: u32, t: u32, r: u32, s: u32, d: u32| {
        extra.push_str(&format!(
            "#{n} = NEXT_ASSEMBLY_USAGE_OCCURRENCE('{n}','','',#{},#{},$);\n\
             #{s} = PRODUCT_DEFINITION_SHAPE('Placement','',#{n});\n\
             #{t} = ITEM_DEFINED_TRANSFORMATION('','',#11,#11);\n\
             #{r} = ( REPRESENTATION_RELATIONSHIP('','',#{},#{}) \
             REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#{t}) SHAPE_REPRESENTATION_RELATIONSHIP() );\n\
             #{d} = CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#{r},#{s});\n",
            parent.0, child.0, child.1, parent.1
        ));
    };
    let mut made: Vec<(u32, u32)> = Vec::new();
    for level in 1..=levels {
        let (sdr, pds, pd, pdf, product, rep) = (next(), next(), next(), next(), next(), next());
        extra.push_str(&format!(
            "#{sdr} = SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep});\n\
             #{pds} = PRODUCT_DEFINITION_SHAPE('','',#{pd});\n\
             #{pd} = PRODUCT_DEFINITION('design','',#{pdf},#9);\n\
             #{pdf} = PRODUCT_DEFINITION_FORMATION('','',#{product});\n\
             #{product} = PRODUCT('L{level}','L{level}','',(#8));\n\
             #{rep} = SHAPE_REPRESENTATION('',(#11),#345);\n"
        ));
        for _ in 0..per_level {
            let ids = (next(), next(), next(), next(), next());
            link(&mut extra, (pd, rep), (child_pd, child_rep), ids.0, ids.1, ids.2, ids.3, ids.4);
        }
        (child_pd, child_rep) = (pd, rep);
        made.push((pd, rep));
    }
    if back {
        let ids = (next(), next(), next(), next(), next());
        link(&mut extra, made[0], made[1], ids.0, ids.1, ids.2, ids.3, ids.4);
    }
    let dir = std::env::temp_dir().join(format!("fundacad-assembly-limits-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join(name);
    std::fs::write(&out, format!("{}{extra}{}", &text[..end], &text[end..])).unwrap();
    out
}

#[test]
fn a_small_shared_assembly_is_placed_in_full() {
    let asm = xcaf::read_step_assembly(&assembly("shared_small.step", 4, 2, false)).unwrap();
    assert_eq!(asm.leaves.len(), 16);
}

#[test]
fn an_assembly_with_too_many_instances_is_refused() {
    let err = xcaf::read_step_assembly(&assembly("shared_wide.step", 17, 2, false)).err().map(|e| e.to_string());
    let err = err.expect("an assembly of 2^17 instances is refused");
    assert!(err.contains("too many instances"), "{err}");
}

#[test]
fn an_assembly_nested_too_deep_is_refused() {
    let err = xcaf::read_step_assembly(&assembly("nested_deep.step", 300, 1, false)).err().map(|e| e.to_string());
    let err = err.expect("an assembly 300 levels deep is refused");
    assert!(err.contains("nested too deep"), "{err}");
}

#[test]
fn an_assembly_that_holds_itself_is_refused_before_it_is_read() {
    let path = assembly("holds_itself.step", 3, 1, true);
    let store = BlobStore::open(path.parent().unwrap()).unwrap();
    let err = import::import_geometry(path.to_str().unwrap(), "step", &store).err();
    let err = err.expect("an assembly whose parts hold it is refused");
    assert!(err.contains("holds itself"), "{err}");
}

#[test]
fn a_shared_assembly_without_a_loop_still_imports() {
    let path = assembly("shared_import.step", 3, 2, false);
    let store = BlobStore::open(path.parent().unwrap()).unwrap();
    import::import_geometry(path.to_str().unwrap(), "step", &store).unwrap();
}

fn import_step(path: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let store = BlobStore::open(path.parent().unwrap()).unwrap();
    import::import_geometry(path.to_str().unwrap(), "step", &store)
}

/// The same file with every instance written as the complex entity some exporters use for it.
fn with_complex_usages(path: PathBuf) -> PathBuf {
    let text = std::fs::read_to_string(&path).unwrap();
    let text: String = text
        .lines()
        .map(|line| match line.split_once(" = NEXT_ASSEMBLY_USAGE_OCCURRENCE(") {
            Some((id, rest)) => {
                let a: Vec<&str> = rest.trim_end_matches(");").split(',').collect();
                format!(
                    "{id} = ( ASSEMBLY_COMPONENT_USAGE($) NEXT_ASSEMBLY_USAGE_OCCURRENCE() \
                     PRODUCT_DEFINITION_RELATIONSHIP({},{},{},{},{}) PRODUCT_DEFINITION_USAGE() );\n",
                    a[0], a[1], a[2], a[3], a[4]
                )
            }
            None => format!("{line}\n"),
        })
        .collect();
    std::fs::write(&path, text).unwrap();
    path
}

const TOO_DEEP: &str = "this STEP assembly is nested more than 256 levels deep, which FundaCAD does not import";

#[test]
fn an_assembly_nested_one_level_past_the_cap_is_refused_before_it_is_read() {
    assert_eq!(import_step(&assembly("nested_257.step", 257, 1, false)).unwrap_err(), TOO_DEEP);
}

#[test]
fn an_assembly_nested_thousands_of_levels_deep_is_refused_before_it_is_read() {
    assert_eq!(import_step(&assembly("nested_5000.step", 5000, 1, false)).unwrap_err(), TOO_DEEP);
}

#[test]
fn an_assembly_nested_exactly_to_the_cap_still_imports() {
    let out = import_step(&assembly("nested_256.step", 256, 1, false)).unwrap();
    assert_eq!(out.get("faces"), Some(&serde_json::json!(6)), "{out:?}");
}

#[test]
fn a_complex_entity_instance_without_a_loop_still_imports() {
    let out = import_step(&with_complex_usages(assembly("complex_usage.step", 3, 2, false))).unwrap();
    // OCCT 7.8 places no part through a complex instance, so only the cube itself is read.
    assert_eq!(out.get("faces"), Some(&serde_json::json!(6)), "{out:?}");
}

#[test]
fn a_complex_entity_instance_without_its_parent_and_part_is_refused() {
    let path = assembly("complex_bare.step", 2, 1, false);
    let mut text = std::fs::read_to_string(&path).unwrap();
    let end = text.rfind("ENDSEC;").unwrap();
    text.insert_str(end, "#200001 = ( ASSEMBLY_COMPONENT_USAGE($) NEXT_ASSEMBLY_USAGE_OCCURRENCE() );\n");
    std::fs::write(&path, text).unwrap();
    assert_eq!(
        import_step(&path).unwrap_err(),
        "this STEP file places an assembly part through a complex entity whose parent and part FundaCAD cannot find"
    );
}

#[test]
fn a_complex_entity_instance_that_closes_a_loop_is_refused() {
    let err = import_step(&with_complex_usages(assembly("complex_loop.step", 3, 1, true))).unwrap_err();
    assert_eq!(err, "this STEP assembly holds itself through its own parts, so it has no end to place");
}

/// inside_out_cube.step with its shape placed through `levels` mapped items, each nesting the one
/// before it. `back` points the innermost map at the outermost shape instead of the cube.
fn mapped(name: &str, levels: u32, back: bool) -> PathBuf {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
    let text = std::fs::read_to_string(fixtures.join("inside_out_cube.step")).unwrap();
    let end = text.rfind("ENDSEC;").unwrap();
    let rep = |level: u32| 100_001 + 3 * level;
    let mut extra = String::new();
    for level in 0..levels {
        let (item, map) = (rep(level) + 1, rep(level) + 2);
        let inner = match level {
            0 if back => rep(levels - 1),
            0 => 10,
            _ => rep(level - 1),
        };
        extra.push_str(&format!(
            "#{} = SHAPE_REPRESENTATION('',(#11,#{item}),#345);\n#{item} = MAPPED_ITEM('',#{map},#11);\n\
             #{map} = REPRESENTATION_MAP(#11,#{inner});\n",
            rep(level)
        ));
    }
    let top = format!("#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#{});", rep(levels - 1));
    let text = format!("{}{extra}{}", &text[..end], &text[end..])
        .replace("#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#10);", &top);
    let dir = std::env::temp_dir().join(format!("fundacad-assembly-limits-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join(name);
    std::fs::write(&out, text).unwrap();
    out
}

const MAPPED_TOO_DEEP: &str =
    "this STEP file nests shapes more than 256 levels deep through mapped items, which FundaCAD does not import";

#[test]
fn a_shape_placed_through_a_few_mapped_items_still_imports() {
    let out = import_step(&mapped("mapped_3.step", 3, false)).unwrap();
    assert_eq!(out.get("faces"), Some(&serde_json::json!(6)), "{out:?}");
}

#[test]
fn a_shape_nested_through_mapped_items_exactly_to_the_cap_still_imports() {
    let out = import_step(&mapped("mapped_256.step", 256, false)).unwrap();
    assert_eq!(out.get("faces"), Some(&serde_json::json!(6)), "{out:?}");
}

#[test]
fn a_shape_nested_through_mapped_items_one_level_past_the_cap_is_refused() {
    assert_eq!(import_step(&mapped("mapped_257.step", 257, false)).unwrap_err(), MAPPED_TOO_DEEP);
}

#[test]
fn a_shape_nested_through_thousands_of_mapped_items_is_refused() {
    assert_eq!(import_step(&mapped("mapped_5000.step", 5000, false)).unwrap_err(), MAPPED_TOO_DEEP);
}

#[test]
fn a_shape_that_maps_itself_through_its_mapped_items_is_refused() {
    assert_eq!(
        import_step(&mapped("mapped_loop.step", 3, true)).unwrap_err(),
        "this STEP file places a shape inside itself through its mapped items, so it has no end to place"
    );
}
