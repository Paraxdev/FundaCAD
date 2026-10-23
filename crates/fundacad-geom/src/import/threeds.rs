//! 3D Studio .3ds: little endian chunks, a u16 id and a u32 length counting its 6 header bytes.
//! Each TRI_MESH is one object, coloured by its main material, mm times the master scale.

use std::collections::HashMap;

use super::mesh::{dominant_color, MeshObject};
use super::scan::{too_dense_for_a_scan, MAX_SCAN_TRIANGLES};

const MAIN: u16 = 0x4D4D;
const EDITOR: u16 = 0x3D3D;
const MASTER_SCALE: u16 = 0x0100;
const MATERIAL: u16 = 0xAFFF;
const MAT_NAME: u16 = 0xA000;
const MAT_DIFFUSE: u16 = 0xA020;
const COLOR_F: u16 = 0x0010;
const COLOR_24: u16 = 0x0011;
const OBJECT: u16 = 0x4000;
const TRI_MESH: u16 = 0x4100;
const POINTS: u16 = 0x4110;
const FACES: u16 = 0x4120;
const FACE_MATERIAL: u16 = 0x4130;

fn bad(why: &str) -> String {
    format!("couldn't read this 3DS file, {why}")
}

struct Chunk<'a> {
    id: u16,
    body: &'a [u8],
}

fn chunks(mut data: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    let mut out = Vec::new();
    while !data.is_empty() {
        if data.len() < 6 {
            return Err(bad("a chunk header is cut off"));
        }
        let id = u16::from_le_bytes([data[0], data[1]]);
        let len = u32::from_le_bytes([data[2], data[3], data[4], data[5]]) as usize;
        if len < 6 || len > data.len() {
            return Err(bad(&format!("chunk {id:#06x} claims {len} bytes but only {} are left", data.len())));
        }
        out.push(Chunk { id, body: &data[6..len] });
        data = &data[len..];
    }
    Ok(out)
}

/// The text up to its zero byte and what follows it.
fn cstr(data: &[u8]) -> Result<(String, &[u8]), String> {
    let end = data.iter().position(|&b| b == 0).ok_or_else(|| bad("a name has no end"))?;
    Ok((String::from_utf8_lossy(&data[..end]).into_owned(), &data[end + 1..]))
}

fn u16_at(d: &[u8], at: usize) -> Result<u16, String> {
    d.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or_else(|| bad("a chunk ends early"))
}

fn f32_at(d: &[u8], at: usize) -> Result<f32, String> {
    d.get(at..at + 4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or_else(|| bad("a chunk ends early"))
}

fn color(body: &[u8]) -> Result<Option<[u8; 3]>, String> {
    for c in chunks(body)? {
        match c.id {
            COLOR_24 => return Ok(c.body.get(..3).map(|b| [b[0], b[1], b[2]])),
            COLOR_F => {
                let rgb = [f32_at(c.body, 0)?, f32_at(c.body, 4)?, f32_at(c.body, 8)?];
                return Ok(Some(rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn material(body: &[u8]) -> Result<Option<(String, [u8; 3])>, String> {
    let (mut name, mut diffuse) = (None, None);
    for c in chunks(body)? {
        match c.id {
            MAT_NAME => name = Some(cstr(c.body)?.0),
            MAT_DIFFUSE => diffuse = color(c.body)?,
            _ => {}
        }
    }
    Ok(name.zip(diffuse))
}

fn read_mesh(
    name: &str,
    body: &[u8],
    scale: f64,
    colors: &HashMap<String, [u8; 3]>,
) -> Result<Option<MeshObject>, String> {
    let (mut pos, mut tris, mut groups) = (Vec::new(), Vec::new(), Vec::new());
    for c in chunks(body)? {
        match c.id {
            POINTS => {
                let n = u16_at(c.body, 0)? as usize;
                if c.body.len() < 2 + n * 12 {
                    return Err(bad(&format!("object '{name}' lists {n} points but the chunk is shorter")));
                }
                for i in 0..n * 3 {
                    pos.push(f64::from(f32_at(c.body, 2 + i * 4)?) * scale);
                }
            }
            FACES => {
                let n = u16_at(c.body, 0)? as usize;
                if n as u64 > MAX_SCAN_TRIANGLES {
                    return Err(too_dense_for_a_scan(n as u64));
                }
                if c.body.len() < 2 + n * 8 {
                    return Err(bad(&format!("object '{name}' lists {n} faces but the chunk is shorter")));
                }
                for f in 0..n {
                    for k in 0..3 {
                        tris.push(u32::from(u16_at(c.body, 2 + f * 8 + k * 2)?));
                    }
                }
                for sub in chunks(&c.body[2 + n * 8..])? {
                    if sub.id == FACE_MATERIAL {
                        let (mat, rest) = cstr(sub.body)?;
                        let count = u16_at(rest, 0)? as usize;
                        if rest.len() < 2 + count * 2 {
                            return Err(bad(&format!("a material group of '{name}' is cut off")));
                        }
                        let faces = (0..count).map(|i| u16_at(rest, 2 + i * 2)).collect::<Result<Vec<_>, _>>()?;
                        groups.push((mat, faces));
                    }
                }
            }
            _ => {}
        }
    }
    let count = pos.len() / 3;
    if tris.is_empty() {
        return Ok(None);
    }
    if tris.iter().any(|&i| i as usize >= count) {
        return Err(bad(&format!("a face of '{name}' uses a point that does not exist")));
    }
    let mut face_color = vec![None; tris.len() / 3];
    for (mat, faces) in &groups {
        let c = colors.get(mat).copied();
        for &f in faces {
            *face_color
                .get_mut(f as usize)
                .ok_or_else(|| bad(&format!("a material group of '{name}' names a face that does not exist")))? = c;
        }
    }
    Ok(Some(MeshObject {
        name: Some(name.to_string()).filter(|n| !n.is_empty()),
        color: dominant_color(face_color.into_iter()),
        pos,
        idx: tris,
    }))
}

/// Vertices are stored in world space, the local matrix chunk only says where
/// the object's own axes sit, so it is not applied.
pub fn read_3ds(data: &[u8]) -> Result<Vec<MeshObject>, String> {
    let top = chunks(data)?;
    let main = top.iter().find(|c| c.id == MAIN).ok_or_else(|| bad("it does not start with a main chunk"))?;
    let edit = chunks(main.body)?;
    let editor = edit.iter().find(|c| c.id == EDITOR).ok_or_else(|| bad("it has no editor chunk"))?;
    let items = chunks(editor.body)?;

    let mut scale = 1.0;
    let mut colors = HashMap::new();
    for c in &items {
        match c.id {
            MASTER_SCALE => {
                let s = f64::from(f32_at(c.body, 0)?);
                if s.is_finite() && s > 0.0 {
                    scale = s;
                }
            }
            MATERIAL => colors.extend(material(c.body)?),
            _ => {}
        }
    }
    let mut objs = Vec::new();
    for c in items.iter().filter(|c| c.id == OBJECT) {
        let (name, rest) = cstr(c.body)?;
        for sub in chunks(rest)?.iter().filter(|s| s.id == TRI_MESH) {
            objs.extend(read_mesh(&name, sub.body, scale, &colors)?);
        }
    }
    Ok(objs)
}
