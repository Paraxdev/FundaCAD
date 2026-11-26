use super::*;

#[test]
fn up_down_and_walls() {
    assert_eq!(classify(Vec3::new(0.0, 0.0, 3.0), Vec3::Z, 45.0), Tint::Top);
    assert_eq!(classify(Vec3::NEG_Z, Vec3::Z, 45.0), Tint::Overhang);
    assert_eq!(classify(Vec3::X, Vec3::Z, 45.0), Tint::Wall);
    assert_eq!(classify(Vec3::ZERO, Vec3::Z, 45.0), Tint::Wall);
}

#[test]
fn both_sides_of_the_threshold() {
    let at = |deg: f32| {
        let r = deg.to_radians();
        Vec3::new(r.sin(), 0.0, -r.cos())
    };
    assert_eq!(classify(at(44.0), Vec3::Z, 45.0), Tint::Overhang);
    assert_eq!(classify(at(46.0), Vec3::Z, 45.0), Tint::Wall);
    assert_eq!(classify(at(46.0), Vec3::Z, 60.0), Tint::Overhang);
}

#[test]
fn the_build_direction_turns_it() {
    assert_eq!(classify(Vec3::NEG_Z, direction("-Z"), 45.0), Tint::Top);
    assert_eq!(classify(Vec3::NEG_X, direction("+X"), 45.0), Tint::Overhang);
    assert_eq!(classify(Vec3::Y, direction("-Y"), 45.0), Tint::Overhang);
    assert_eq!(direction("nonsense"), Vec3::Z);
    assert_eq!(Tint::Overhang.rgb(), 0xe24a3b);
}
