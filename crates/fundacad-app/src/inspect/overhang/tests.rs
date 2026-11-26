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

#[test]
fn areas_split_an_off_origin_block_into_floor_walls_and_top() {
    use crate::viewport::scene::{tests::block, SceneBody};
    let b = SceneBody::new(std::sync::Arc::new(block(Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0), "ex1")));
    assert_eq!(areas([], Vec3::Z, 45.0), [0.0, 0.0, 0.0]);
    assert_eq!(areas([&b], Vec3::Z, 45.0), [28.0, 44.0, 28.0]);
    assert_eq!(areas([&b, &b], Vec3::Z, 45.0), [56.0, 88.0, 56.0]);
    assert_eq!(areas([&b], Vec3::NEG_X, 45.0), [14.0, 72.0, 14.0]);
    assert_eq!(areas([&b], Vec3::Z, 0.0), [0.0, 72.0, 28.0]);
    assert_eq!(
        rows([28.0, 44.5, 0.0]),
        [("Needs support".to_string(), "28 mm²".to_string()), ("Prints as is".into(), "44.5 mm²".into()), ("Faces up".into(), "0 mm²".into())]
    );
}
