use fundacad_geom::import::dxf::*;

fn dxf(insunits: i64, block: &str, entities: &str) -> Vec<u8> {
    let mut t = format!("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n{insunits}\n0\nENDSEC\n");
    t += &format!(
        "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nB\n70\n0\n10\n0\n20\n0\n30\n0\n{block}0\nENDBLK\n0\nENDSEC\n"
    );
    t += &format!("0\nSECTION\n2\nENTITIES\n{entities}0\nENDSEC\n0\nEOF\n");
    t.into_bytes()
}

const UNIT_LINE: &str = "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n";
const UNIT_FACE: &str =
    "0\n3DFACE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n12\n0\n22\n1\n32\n0\n13\n0\n23\n1\n33\n0\n";
const HUGE_ARRAY: &str = "0\nINSERT\n8\nL\n2\nB\n10\n0\n20\n0\n30\n0\n70\n30000\n71\n30000\n44\n2\n45\n2\n";

#[test]
fn a_huge_insert_array_stops_at_the_cap() {
    for block in [UNIT_LINE, UNIT_FACE] {
        let t = std::time::Instant::now();
        let err = read_dxf(&dxf(4, block, HUGE_ARRAY)).err().expect("a 30000 x 30000 array must be refused");
        assert!(err.contains("more than"), "{err}");
        assert!(t.elapsed().as_secs_f64() < 5.0, "took {:?}", t.elapsed());
    }
}

#[test]
fn layers_that_differ_only_in_case_are_one_sketch() {
    let walls = UNIT_LINE.replace("8\n0\n", "8\nWalls\n");
    let shouted = UNIT_LINE.replace("8\n0\n", "8\nWALLS\n").replace("21\n0", "21\n5");
    let ents = format!("{walls}{shouted}");
    let r = read_dxf(&dxf(4, "", &ents)).unwrap();
    let names: Vec<&str> = r.sketches.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["Walls"]);
    assert_eq!(r.sketches[0].1.len(), 2);
}
