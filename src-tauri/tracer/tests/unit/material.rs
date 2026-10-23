use fundacad_tracer::material::{FLAG_NO_LIGHT, FLAG_SOLID};
use fundacad_tracer::{pack_material, tri_slots, GpuMaterial, Group};

fn parse(j: &str) -> GpuMaterial {
    pack_material(&serde_json::from_str(j).unwrap())
}

#[test]
fn the_pack_is_nine_vec4_with_film_and_finish_zero() {
    assert_eq!(std::mem::size_of::<GpuMaterial>(), 144);
    let m = parse(r#"{"color":[0.2,0.3,0.4],"transmission":1,"sheen":0.5}"#);
    assert_eq!(m.film, [0.0; 4]);
    assert_eq!(m.finish, [0.0; 4]);
    assert_eq!(m.flags() & FLAG_NO_LIGHT, 0);
}

#[test]
fn defaults_follow_trace_material_from() {
    let m = parse("{}");
    assert_eq!(m.base, [1.0, 1.0, 1.0, 1.0]);
    assert_eq!(m.pbr, [0.0, 0.5, 0.0, 1.5]);
    assert_eq!(m.attenuation[3], f32::INFINITY);
    assert_eq!(m.coat, [0.0, 0.0, 0.0, 1.0]);
    assert_eq!(m.flags(), 0);
    assert!(!m.emits());
}

#[test]
fn transmission_makes_a_solid_and_zero_distance_does_not_absorb() {
    let m = parse(r#"{"transmission":1,"ior":1.45,"attenuationDistance":0,"attenuationColor":[0.2,0.5,0.9]}"#);
    assert_eq!(m.flags() & FLAG_SOLID, FLAG_SOLID);
    assert_eq!(m.attenuation, [0.2, 0.5, 0.9, f32::INFINITY]);
    assert_eq!(m.pbr[3], 1.45);
    assert_eq!(parse(r#"{"attenuationDistance":12}"#).attenuation[3], 12.0);
    assert_eq!(parse(r#"{"transmission":0}"#).flags() & FLAG_SOLID, 0);
}

#[test]
fn emission_is_colour_times_intensity_and_black_does_not_emit() {
    let m = parse(r#"{"emissive":[1,0.5,0],"emissiveIntensity":3}"#);
    assert_eq!(&m.emission[..3], &[3.0, 1.5, 0.0]);
    assert!(m.emits());
    assert!(!parse(r#"{"emissive":[0,0,0],"emissiveIntensity":5}"#).emits());
}

#[test]
fn no_light_keeps_the_glow_out_of_the_light_table() {
    let m = parse(r#"{"emissive":[1,1,1],"emissiveIntensity":2,"noLight":true}"#);
    assert_eq!(m.flags() & FLAG_NO_LIGHT, FLAG_NO_LIGHT);
    assert!(m.emits());
    assert_eq!(m.light_power(), 0.0);
    assert!((parse(r#"{"emissive":[1,1,1],"emissiveIntensity":2}"#).light_power() - 2.0).abs() < 1e-5);
}

#[test]
fn finish_table() {
    // (finish, json, metalness, roughness, transmission, clearcoat, clearcoat roughness, dispersion)
    let rows = [
        ("matte", r#"{"color":[0.8,0.8,0.8],"roughness":0.9}"#, 0.0, 0.9, 0.0, 0.0, 0.0, 0.0),
        ("metal", r#"{"metalness":1,"roughness":0.2}"#, 1.0, 0.2, 0.0, 0.0, 0.0, 0.0),
        ("glass", r#"{"transmission":1,"roughness":0,"ior":1.5,"dispersion":0.3}"#, 0.0, 0.0, 1.0, 0.0, 0.0, 0.3),
        (
            "car paint",
            r#"{"metalness":0.6,"roughness":0.4,"clearcoat":1,"clearcoatRoughness":0.05}"#,
            0.6,
            0.4,
            0.0,
            1.0,
            0.05,
            0.0,
        ),
    ];
    for (name, j, me, ro, tr, cc, ccr, di) in rows {
        let m = parse(j);
        assert_eq!([m.pbr[0], m.pbr[1], m.pbr[2]], [me, ro, tr], "{name}");
        assert_eq!([m.coat[0], m.coat[1], m.coat[2]], [cc, ccr, di], "{name}");
    }
}

#[test]
fn face_groups_give_per_triangle_slots() {
    let g = [Group { start: 0, count: 6, slot: 0 }, Group { start: 6, count: 3, slot: 2 }];
    assert_eq!(tri_slots(&g, 3), vec![0, 0, 2]);
    assert_eq!(tri_slots(&[], 2), vec![0, 0]);
}

#[test]
fn a_baked_slot_takes_the_vertex_colour_not_the_base_colour() {
    // The mirror whitens a baked slot's material (mirror.ts refreshMirrorMaterials).
    let baked = parse(r#"{"color":[1,1,1],"vertexColors":true}"#);
    assert_eq!(baked.albedo(Some([0.3, 0.6, 0.1])), [0.3, 0.6, 0.1]);
    let plain = parse(r#"{"color":[0.5,0.5,0.5]}"#);
    assert_eq!(plain.albedo(Some([0.3, 0.6, 0.1])), [0.5, 0.5, 0.5]);
}
