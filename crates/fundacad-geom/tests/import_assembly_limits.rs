//! The XCAF product walk places every instance of a shared product, so its work grows with the
//! instance count, not the file size. It stops with an error past a budget of instances or nesting.

use std::path::PathBuf;

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
