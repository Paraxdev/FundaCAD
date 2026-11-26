use super::*;

#[test]
fn spells_numbers_short() {
    assert_eq!(spell(12.0), "12");
    assert_eq!(spell(3.14159), "3.142");
    assert_eq!(spell(-0.0001), "0");
    assert_eq!(spell(-2.5), "-2.5");
    assert_eq!(spell(f64::NAN), "?");
    assert_eq!(spell_xyz([3.0, -2.25, 0.1]), "3, -2.25, 0.1");
}

/// `block` with every face wound outward, so its signed volume is positive and its low faces face down.
pub fn solid(min: glam::Vec3, max: glam::Vec3) -> crate::viewport::scene::Body {
    let mut b = crate::viewport::scene::tests::block(min, max, "ex1");
    for (t, tri) in b.indices.chunks_exact_mut(3).enumerate() {
        if b.face_ids[t] % 2 == 0 {
            tri.swap(1, 2);
        }
    }
    b
}

#[test]
fn solid_faces_point_out() {
    let b = solid(glam::Vec3::ZERO, glam::Vec3::ONE);
    let at = |i: u32| glam::Vec3::from_slice(&b.positions[i as usize * 3..i as usize * 3 + 3]);
    for (t, tri) in b.indices.chunks_exact(3).enumerate() {
        let n = (at(tri[1]) - at(tri[0])).cross(at(tri[2]) - at(tri[0]));
        let out = if b.face_ids[t] % 2 == 0 { -1.0 } else { 1.0 };
        assert!(n.dot(glam::Vec3::AXES[b.face_ids[t] as usize / 2]) * out > 0.0);
    }
}
