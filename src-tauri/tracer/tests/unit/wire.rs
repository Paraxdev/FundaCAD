use fundacad_tracer::env::{f32_to_f16, Up};
use fundacad_tracer::{decode_colors, decode_env, decode_mesh, Group};

fn encode(header: &str, floats: &[f32], ints: &[u32], tail: &[f32]) -> Vec<u8> {
    let mut b = (header.len() as u32).to_le_bytes().to_vec();
    b.extend_from_slice(header.as_bytes());
    b.resize(b.len().next_multiple_of(4), 0);
    floats.iter().for_each(|f| b.extend_from_slice(&f.to_le_bytes()));
    ints.iter().for_each(|i| b.extend_from_slice(&i.to_le_bytes()));
    tail.iter().for_each(|f| b.extend_from_slice(&f.to_le_bytes()));
    b
}

const TRI: [f32; 18] = [0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 1., 0., 0., 1.];

#[test]
fn a_mesh_arrives_with_its_groups_and_colours() {
    let h = r#"{"key":"b|e1|g1|1|1","vertices":3,"indices":3,"normals":true,"colors":true,
                "groups":[{"start":0,"count":3,"slot":2}]}"#;
    let b = encode(h, &TRI, &[0, 1, 2], &[1., 0., 0., 0., 1., 0., 0., 0., 1.]);
    let (key, m) = decode_mesh(&b).unwrap();
    assert_eq!(key, "b|e1|g1|1|1");
    assert_eq!(m.positions, vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]);
    assert_eq!(m.normals, vec![[0., 0., 1.]; 3]);
    assert_eq!(m.indices, vec![0, 1, 2]);
    assert_eq!(m.groups, vec![Group { start: 0, count: 3, slot: 2 }]);
    assert_eq!(m.colors.unwrap()[1], [0., 1., 0.]);
}

#[test]
fn a_soup_gets_indices_and_a_short_or_wrong_body_is_refused() {
    let (_, m) = decode_mesh(&encode(r#"{"key":"k","vertices":3}"#, &TRI[..9], &[], &[])).unwrap();
    assert_eq!(m.indices, vec![0, 1, 2]);
    assert!(m.normals.is_empty() && m.colors.is_none());
    assert!(decode_mesh(&encode(r#"{"key":"k","vertices":3}"#, &TRI[..8], &[], &[])).is_err());
    let past = encode(r#"{"key":"k","vertices":3,"indices":3}"#, &TRI[..9], &[0, 1, 3], &[]);
    assert!(decode_mesh(&past).unwrap_err().contains("past"));
    assert!(decode_mesh(&[9, 0, 0, 0, b'{']).is_err());
}

#[test]
fn an_environment_arrives_with_its_layout_and_a_short_one_is_refused() {
    let half = |v: &[u16]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let mut b = encode(r#"{"key":"room|h","width":2,"height":1,"up":"z"}"#, &[], &[], &[]);
    let one = f32_to_f16(1.0);
    b.extend(half(&[one, 0, 0, one, 0, one, 0, one]));
    let e = decode_env(&b).unwrap().unwrap();
    assert_eq!((e.key.as_str(), e.width, e.height, e.up), ("room|h", 2, 1, Up::Z));
    assert_eq!(e.texel(1, 0), [0.0, 1.0, 0.0]);
    let mut y = encode(r#"{"key":"k","width":2,"height":1}"#, &[], &[], &[]);
    y.extend(half(&[0; 8]));
    assert_eq!(decode_env(&y).unwrap().unwrap().up, Up::Y);
    assert_eq!(decode_env(&encode(r#"{"key":"","width":0,"height":0}"#, &[], &[], &[])).unwrap(), None);
    b.truncate(b.len() - 2);
    assert!(decode_env(&b).unwrap_err().contains("needed"));
}

#[test]
fn an_environment_past_8192_wide_is_taken() {
    let (w, h) = (16384u32, 2u32);
    let mut b = encode(&format!(r#"{{"key":"wide","width":{w},"height":{h},"up":"z"}}"#), &[], &[], &[]);
    b.resize(b.len() + (w * h * 4 * 2) as usize, 0);
    let e = decode_env(&b).unwrap().unwrap();
    assert_eq!((e.width, e.height), (w, h));
    let small = e.fit(8192, u64::MAX);
    assert_eq!((small.width, small.height), (8192, 1));
}

#[test]
fn colours_set_or_clear() {
    let (k, c) =
        decode_colors(&encode(r#"{"key":"k","vertices":1,"colors":true}"#, &[0.5, 0.25, 1.], &[], &[])).unwrap();
    assert_eq!((k.as_str(), c), ("k", Some(vec![[0.5, 0.25, 1.]])));
    assert_eq!(decode_colors(&encode(r#"{"key":"k","vertices":1}"#, &[], &[], &[])).unwrap().1, None);
}

#[test]
fn a_look_takes_bounces_and_the_firefly_clamp_and_keeps_six_and_ten_without() {
    let bare: fundacad_tracer::Look = serde_json::from_str("{}").unwrap();
    assert_eq!((bare.bounces, bare.firefly), (6, 10.0));
    let raised: fundacad_tracer::Look = serde_json::from_str(r#"{"bounces":24,"firefly":0}"#).unwrap();
    assert_eq!((raised.bounces, raised.firefly), (24, 0.0));
}
