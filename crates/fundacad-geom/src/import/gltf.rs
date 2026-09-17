//! Binary glTF triangles, world placed, in Z up millimetres: what
//! `mesh_import._read_glb` gets from `RWGltf_CafReader`, which the static
//! kernel is built without (it needs RapidJSON).

use serde_json::Value;

type Mat4 = [f64; 16];

const IDENTITY: Mat4 = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

/// Column major, as glTF stores it.
fn mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for c in 0..4 {
        for r in 0..4 {
            out[c * 4 + r] = (0..4).map(|k| a[k * 4 + r] * b[c * 4 + k]).sum();
        }
    }
    out
}

fn floats(v: Option<&Value>) -> Option<Vec<f64>> {
    v?.as_array()?.iter().map(Value::as_f64).collect()
}

fn local_matrix(node: &Value) -> Mat4 {
    if let Some(m) = floats(node.get("matrix")).filter(|m| m.len() == 16) {
        let mut out = [0.0; 16];
        out.copy_from_slice(&m);
        return out;
    }
    let t = floats(node.get("translation")).filter(|t| t.len() == 3).unwrap_or_else(|| vec![0.0; 3]);
    let q = floats(node.get("rotation")).filter(|q| q.len() == 4).unwrap_or_else(|| vec![0.0, 0.0, 0.0, 1.0]);
    let s = floats(node.get("scale")).filter(|s| s.len() == 3).unwrap_or_else(|| vec![1.0; 3]);
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let r = [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + z * w),
        2.0 * (x * z - y * w),
        2.0 * (x * y - z * w),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + x * w),
        2.0 * (x * z + y * w),
        2.0 * (y * z - x * w),
        1.0 - 2.0 * (x * x + y * y),
    ];
    [
        r[0] * s[0], r[1] * s[0], r[2] * s[0], 0.0,
        r[3] * s[1], r[4] * s[1], r[5] * s[1], 0.0,
        r[6] * s[2], r[7] * s[2], r[8] * s[2], 0.0,
        t[0], t[1], t[2], 1.0,
    ]
}

struct Doc<'a> {
    json: Value,
    bin: &'a [u8],
}

impl Doc<'_> {
    fn arr(&self, key: &str) -> &[Value] {
        self.json.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }

    /// An accessor's elements as f64 rows of `width`.
    fn accessor(&self, index: usize, width: usize) -> Result<Vec<f64>, String> {
        let bad = || "couldn't read this glTF file, it may be corrupt or not a .glb".to_string();
        let acc = self.arr("accessors").get(index).ok_or_else(bad)?;
        let count = acc.get("count").and_then(Value::as_u64).ok_or_else(bad)? as usize;
        let kind = acc.get("componentType").and_then(Value::as_u64).ok_or_else(bad)?;
        let Some(view_index) = acc.get("bufferView").and_then(Value::as_u64) else {
            return Ok(vec![0.0; count * width]);
        };
        let view = self.arr("bufferViews").get(view_index as usize).ok_or_else(bad)?;
        if view.get("buffer").and_then(Value::as_u64).unwrap_or(0) != 0 {
            return Err("this glTF keeps its geometry in an external buffer, only a self-contained .glb imports".into());
        }
        let size = match kind {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            5125 | 5126 => 4,
            _ => return Err(bad()),
        };
        let stride = view.get("byteStride").and_then(Value::as_u64).map_or(size * width, |s| s as usize);
        let start = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize
            + acc.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let mut out = Vec::with_capacity(count * width);
        for i in 0..count {
            for c in 0..width {
                let at = start + i * stride + c * size;
                let b = self.bin.get(at..at + size).ok_or_else(bad)?;
                out.push(match kind {
                    5126 => f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                    5125 => f64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                    5123 => f64::from(u16::from_le_bytes([b[0], b[1]])),
                    5122 => f64::from(i16::from_le_bytes([b[0], b[1]])),
                    5121 => f64::from(b[0]),
                    _ => f64::from(b[0] as i8),
                });
            }
        }
        Ok(out)
    }
}

/// Every triangle primitive of the default scene, node transforms applied,
/// then metres scaled by `mm_per_unit` and Y up turned Z up.
pub fn read_glb(data: &[u8], mm_per_unit: f64) -> Result<(Vec<f64>, Vec<u32>), String> {
    let bad = || "couldn't read this glTF file, it may be corrupt or not a .glb".to_string();
    if data.len() < 20 || data[0..4] != *b"glTF" {
        return Err(bad());
    }
    let jlen = u32::from_le_bytes(data[12..16].try_into().map_err(|_| bad())?) as usize;
    let json: Value = serde_json::from_slice(data.get(20..20 + jlen).ok_or_else(bad)?).map_err(|_| bad())?;
    let mut at = 20 + jlen;
    let mut bin: &[u8] = &[];
    while at + 8 <= data.len() {
        let len = u32::from_le_bytes(data[at..at + 4].try_into().map_err(|_| bad())?) as usize;
        let kind = &data[at + 4..at + 8];
        let body = data.get(at + 8..at + 8 + len).ok_or_else(bad)?;
        if kind == b"BIN\0" {
            bin = body;
            break;
        }
        at += 8 + len;
    }
    let doc = Doc { json, bin };

    let nodes = doc.arr("nodes");
    let roots: Vec<usize> = match doc.arr("scenes").get(doc.json.get("scene").and_then(Value::as_u64).unwrap_or(0) as usize) {
        Some(scene) => scene.get("nodes").and_then(Value::as_array).into_iter().flatten().filter_map(|n| n.as_u64()).map(|n| n as usize).collect(),
        None => {
            let children: std::collections::HashSet<u64> = nodes
                .iter()
                .flat_map(|n| n.get("children").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64))
                .collect();
            (0..nodes.len()).filter(|i| !children.contains(&(*i as u64))).collect()
        }
    };

    let mut pos = Vec::new();
    let mut idx = Vec::new();
    let mut stack: Vec<(usize, Mat4, usize)> = roots.into_iter().rev().map(|r| (r, IDENTITY, 0)).collect();
    while let Some((n, parent, depth)) = stack.pop() {
        if depth > 64 {
            return Err(bad());
        }
        let node = nodes.get(n).ok_or_else(bad)?;
        let world = mul(&parent, &local_matrix(node));
        if let Some(mesh) = node.get("mesh").and_then(Value::as_u64).and_then(|m| doc.arr("meshes").get(m as usize)) {
            for prim in mesh.get("primitives").and_then(Value::as_array).into_iter().flatten() {
                if prim.get("mode").and_then(Value::as_u64).unwrap_or(4) != 4 {
                    continue;
                }
                let Some(p) = prim.get("attributes").and_then(|a| a.get("POSITION")).and_then(Value::as_u64) else {
                    continue;
                };
                let points = doc.accessor(p as usize, 3)?;
                let nvert = points.len() / 3;
                let base = (pos.len() / 3) as u32;
                for v in points.chunks_exact(3) {
                    let x = world[0] * v[0] + world[4] * v[1] + world[8] * v[2] + world[12];
                    let y = world[1] * v[0] + world[5] * v[1] + world[9] * v[2] + world[13];
                    let z = world[2] * v[0] + world[6] * v[1] + world[10] * v[2] + world[14];
                    pos.extend([x * mm_per_unit, -z * mm_per_unit, y * mm_per_unit]);
                }
                let tris: Vec<u32> = match prim.get("indices").and_then(Value::as_u64) {
                    Some(i) => doc.accessor(i as usize, 1)?.into_iter().map(|v| v as u32).collect(),
                    None => (0..nvert as u32).collect(),
                };
                if tris.iter().any(|&t| t as usize >= nvert) {
                    return Err(bad());
                }
                idx.extend(tris[..tris.len() / 3 * 3].iter().map(|t| t + base));
            }
        }
        for c in node.get("children").and_then(Value::as_array).into_iter().flatten().rev() {
            if let Some(c) = c.as_u64() {
                stack.push((c as usize, world, depth + 1));
            }
        }
    }
    if idx.is_empty() {
        return Err("no geometry found in the glTF file".into());
    }
    Ok((pos, idx))
}

/// The largest side of the points' bounding box.
pub fn max_extent(pos: &[f64]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in pos.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max)
}
