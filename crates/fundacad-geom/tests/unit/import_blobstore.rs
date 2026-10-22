use base64::Engine as _;
use fundacad_geom::import::blobstore::*;
use serde_json::{json, Map, Value};

fn req(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn scratch(tag: &str) -> BlobStore {
    let dir = std::env::temp_dir().join(format!("fundacad-blobop-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    BlobStore::open(dir).unwrap()
}

#[test]
fn a_blob_written_in_ranges_reads_back_whole() {
    let from = scratch("from");
    let to = scratch("to");
    let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let h = from.put_bytes(&data).unwrap();
    let has = blob_op("blobHas", &req(json!({"hashes": [h, "0".repeat(32)]})), &to).unwrap();
    assert_eq!(has["missing"].as_array().unwrap().len(), 2);

    let b64 = base64::engine::general_purpose::STANDARD;
    for (i, piece) in data.chunks(30_000).enumerate() {
        let r = blob_op(
            "blobWrite",
            &req(json!({"hash": h, "offset": i * 30_000, "total": data.len(),
                        "data": b64.encode(piece)})),
            &to,
        )
        .unwrap();
        assert_eq!(r["stored"], json!(i == 3));
    }
    assert_eq!(to.get_bytes(&h).unwrap(), data);

    let r = blob_op("blobRead", &req(json!({"hash": h})), &to).unwrap();
    assert_eq!(r["size"], json!(data.len()));
    assert_eq!(b64.decode(r["data"].as_str().unwrap()).unwrap(), data);
}

#[test]
fn bytes_that_do_not_match_their_hash_are_never_published() {
    let to = scratch("bad");
    let h = hash_bytes(b"the real bytes");
    let b64 = base64::engine::general_purpose::STANDARD;
    let r = blob_op("blobWrite", &req(json!({"hash": h, "offset": 0, "total": 5, "data": b64.encode(b"forge")})), &to);
    assert!(r.is_err());
    assert!(to.get_bytes(&h).is_none());
    let r = blob_op("blobRead", &req(json!({"hash": h})), &to).unwrap();
    assert_eq!(r["missing"], json!(true));
    assert!(blob_op("blobRead", &req(json!({"hash": "../../etc"})), &to).is_err());
}

#[test]
fn blobs_stored_at_the_same_moment_each_read_back() {
    let store = std::sync::Arc::new(scratch("together"));
    for round in 0..50u32 {
        let put: Vec<_> = (0..8u32)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let data: Vec<u8> = format!("blob {round} {i}").repeat(64).into_bytes();
                    (store.put_bytes(&data).unwrap(), data)
                })
            })
            .collect();
        for t in put {
            let (h, data) = t.join().unwrap();
            assert_eq!(store.get_bytes(&h).as_deref(), Some(&data[..]), "round {round}");
        }
    }
}
