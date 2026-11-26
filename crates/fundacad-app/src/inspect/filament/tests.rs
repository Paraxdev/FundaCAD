use super::*;

#[test]
fn solid_at_full_infill() {
    assert_eq!(effective_volume(5000.0, 1800.0, 100.0, 0.8), 5000.0);
}

#[test]
fn shell_plus_infill_fraction() {
    // shell 1800 * 0.8 = 1440, interior 3560 at 20 %
    assert!((effective_volume(5000.0, 1800.0, 20.0, 0.8) - (1440.0 + 712.0)).abs() < 1e-9);
    assert!((effective_volume(5000.0, 1800.0, 0.0, 0.8) - 1440.0).abs() < 1e-9);
}

#[test]
fn a_thin_part_is_all_shell() {
    assert_eq!(effective_volume(100.0, 1000.0, 20.0, 0.8), 100.0);
    assert_eq!(effective_volume(-3.0, 10.0, 20.0, 0.8), 0.0);
}

#[test]
fn estimate_gives_mass_and_lengths() {
    let p = Prefs::default();
    let (mass, m) = estimate(5000.0, 1800.0, &p);
    assert!((mass - 2.152 * 1.24).abs() < 1e-9);
    assert!((m[0] - 2152.0 / (std::f64::consts::PI * 0.875 * 0.875) / 1000.0).abs() < 1e-9);
    assert!((m[1] - 2152.0 / (std::f64::consts::PI * 1.425 * 1.425) / 1000.0).abs() < 1e-9);
    assert_eq!(
        rows(5000.0, 1800.0, &p),
        vec![
            ("Mass, estimate".to_string(), "2.668 g".to_string()),
            ("Filament 1.75 mm".to_string(), "0.895 m".to_string()),
            ("Filament 2.85 mm".to_string(), "0.337 m".to_string()),
        ]
    );
}

#[test]
fn density_follows_material_and_custom() {
    let mut p = Prefs { material: "petg".into(), ..Prefs::default() };
    assert_eq!(density_for(&p), 1.27);
    p.material = CUSTOM.into();
    p.custom_density = 7.85;
    assert_eq!(density_for(&p), 7.85);
    p.material = "unknown".into();
    assert_eq!(density_for(&p), 1.24);
    assert_eq!(length_mm(10.0, 0.0), 0.0);
}
