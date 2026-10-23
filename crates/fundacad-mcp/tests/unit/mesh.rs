use fundacad_mcp::mesh::*;
use fundacad_protocol::frame::Buf;
use serde_json::json;

#[test]
fn a_json_body_and_a_framed_one_read_the_same() {
    let v = json!({"id": "b1", "name": "Body1", "faceCount": 1,
        "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2], "faceIds": [0],
        "normals": [0, 0, 1, 0, 0, 1, 0, 0, 1],
        "edges": [{"points": [[0, 0, 0], [1, 0, 0]], "body": "b1"}]});
    let a = MeshBody::from_value(&v);
    let mut bufs = vec![
        Buf::F32(vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
        Buf::U32(vec![0, 1, 2]),
        Buf::U32(vec![0]),
        Buf::F32(vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
        Buf::U32(vec![2]),
    ];
    let framed = json!({"id": "b1", "name": "Body1", "faceCount": 1,
        "positions": {"$buf": 0}, "indices": {"$buf": 1}, "faceIds": {"$buf": 2},
        "edges": {"$pts": {"$buf": 3}, "$counts": {"$buf": 4}, "body": "b1"}});
    let b = MeshBody::from_frame(framed, &mut bufs);
    assert_eq!(a, b);
    assert_eq!(a.triangles(), 1);
    assert_eq!(a.id(), "b1");
    assert_eq!(a.edges, vec![vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0]]);
    assert!(a.get("positions").is_none());
}
