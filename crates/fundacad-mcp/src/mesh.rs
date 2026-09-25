//! A built body's triangles as flat arrays. A 666 part assembly is millions
//! of coordinates, and as one JSON number each the reply of one `build` took
//! most of 17 GB.

use fundacad_protocol::frame::Buf;
use serde_json::{Map, Value};

const ARRAYS: [&str; 4] = ["positions", "normals", "indices", "faceIds"];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MeshBody {
    /// Every key of the body but its arrays: id, name, bbox, faceCount...
    pub info: Map<String, Value>,
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub face_ids: Vec<u32>,
    /// Each edge's polyline, xyz triples.
    pub edges: Vec<Vec<f32>>,
}

fn numbers<T>(v: Option<&Value>, cast: impl Fn(f64) -> T) -> Vec<T> {
    let mut out = Vec::new();
    fn walk<T>(v: &Value, cast: &impl Fn(f64) -> T, out: &mut Vec<T>) {
        match v {
            Value::Array(items) => items.iter().for_each(|i| walk(i, cast, out)),
            other => {
                if let Some(x) = other.as_f64() {
                    out.push(cast(x));
                }
            }
        }
    }
    if let Some(v) = v {
        walk(v, &cast, &mut out);
    }
    out
}

impl MeshBody {
    /// A body of a JSON reply, the arrays inline.
    pub fn from_value(v: &Value) -> MeshBody {
        let mut info = v.as_object().cloned().unwrap_or_default();
        let positions = numbers(info.get("positions"), |x| x as f32);
        let indices = numbers(info.get("indices"), |x| x as u32);
        let face_ids = numbers(info.get("faceIds"), |x| x as u32);
        let edges = match info.get("edges") {
            Some(Value::Array(list)) => list
                .iter()
                .map(|e| numbers(e.get("points").or(Some(e)), |x| x as f32))
                .collect(),
            _ => Vec::new(),
        };
        for k in ARRAYS.iter().chain(&["edges"]) {
            info.shift_remove(*k);
        }
        MeshBody { info, positions, indices, face_ids, edges }
    }

    /// A body of a binary frame, its arrays still `$buf` references into `bufs`.
    pub fn from_frame(v: Value, bufs: &mut [Buf]) -> MeshBody {
        let mut info = match v {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        let mut take = |v: Option<Value>| -> Option<Buf> {
            let k = v?.get("$buf")?.as_u64()? as usize;
            bufs.get_mut(k).map(|b| std::mem::replace(b, Buf::U32(Vec::new())))
        };
        let floats = |b: Option<Buf>| match b {
            Some(Buf::F32(v)) => v,
            Some(Buf::U32(v)) => v.into_iter().map(|x| x as f32).collect(),
            None => Vec::new(),
        };
        let ints = |b: Option<Buf>| match b {
            Some(Buf::U32(v)) => v,
            Some(Buf::F32(v)) => v.into_iter().map(|x| x as u32).collect(),
            None => Vec::new(),
        };
        let positions = floats(take(info.shift_remove("positions")));
        let indices = ints(take(info.shift_remove("indices")));
        let face_ids = ints(take(info.shift_remove("faceIds")));
        take(info.shift_remove("normals"));
        let mut edges = Vec::new();
        if let Some(packed) = info.shift_remove("edges") {
            if packed.get("$pts").is_some() {
                let pts = floats(take(packed.get("$pts").cloned()));
                let counts = ints(take(packed.get("$counts").cloned()));
                let mut at = 0;
                for n in counts {
                    let end = (at + n as usize * 3).min(pts.len());
                    edges.push(pts[at..end].to_vec());
                    at = end;
                }
            } else if let Value::Array(list) = &packed {
                edges = list
                    .iter()
                    .map(|e| numbers(e.get("points").or(Some(e)), |x| x as f32))
                    .collect();
            }
        }
        MeshBody { info, positions, indices, face_ids, edges }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.info.get(key)
    }

    pub fn id(&self) -> &str {
        self.info.get("id").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn triangles(&self) -> usize {
        self.indices.len() / 3
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
