//! The raw invoke bodies the page sends a mesh, its colours or an environment in:
//! [u32 header length][JSON header][zero pad to 4][buffers], little endian,
//! the framing src/geometry/client.ts reads engine meshes with.

use serde::Deserialize;

use crate::env::{Environment, Up};
use crate::material::Group;
use crate::scene::Mesh;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    key: String,
    vertices: usize,
    #[serde(default)]
    indices: usize,
    #[serde(default)]
    normals: bool,
    #[serde(default)]
    colors: bool,
    #[serde(default)]
    groups: Vec<Group>,
}

#[derive(Debug, Deserialize)]
struct EnvHeader {
    key: String,
    width: u32,
    height: u32,
    #[serde(default)]
    up: Up,
}

fn split<H: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<(H, &[u8]), String> {
    let len = bytes.get(..4).ok_or("the body is shorter than its header length")?;
    let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
    let json = bytes.get(4..4 + len).ok_or("the header runs past the body")?;
    let head: H = serde_json::from_slice(json).map_err(|e| format!("bad header: {e}"))?;
    let start = (4 + len).next_multiple_of(4);
    Ok((head, bytes.get(start..).unwrap_or(&[])))
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take(&mut self, n: usize, what: &str) -> Result<&[u8], String> {
        if self.0.len() < n * 4 {
            return Err(format!("{what}: {} bytes left, {} needed", self.0.len(), n * 4));
        }
        let (a, b) = self.0.split_at(n * 4);
        self.0 = b;
        Ok(a)
    }
    fn vec3(&mut self, n: usize, what: &str) -> Result<Vec<[f32; 3]>, String> {
        let raw = self.take(n * 3, what)?;
        let f = |i: usize| f32::from_le_bytes(raw[i * 4..i * 4 + 4].try_into().unwrap());
        Ok((0..n).map(|v| [f(v * 3), f(v * 3 + 1), f(v * 3 + 2)]).collect())
    }
    fn u32s(&mut self, n: usize, what: &str) -> Result<Vec<u32>, String> {
        let raw = self.take(n, what)?;
        Ok(raw.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
    }
}

/// Positions, then normals and indices when the header has them, then
/// colours. A mesh without indices is a triangle soup.
pub fn decode_mesh(bytes: &[u8]) -> Result<(String, Mesh), String> {
    let (h, body) = split::<Header>(bytes)?;
    let mut r = Reader(body);
    let positions = r.vec3(h.vertices, "positions")?;
    let normals = if h.normals { r.vec3(h.vertices, "normals")? } else { Vec::new() };
    let indices = if h.indices > 0 { r.u32s(h.indices, "indices")? } else { (0..h.vertices as u32).collect() };
    if indices.len() % 3 != 0 {
        return Err(format!("{} indices is not whole triangles", indices.len()));
    }
    if let Some(i) = indices.iter().find(|&&i| i as usize >= h.vertices) {
        return Err(format!("index {i} is past {} vertices", h.vertices));
    }
    let colors = if h.colors { Some(r.vec3(h.vertices, "colors")?) } else { None };
    Ok((h.key, Mesh { positions, normals, indices, groups: h.groups, colors }))
}

/// A body's vertex colours, or none to clear them.
pub fn decode_colors(bytes: &[u8]) -> Result<(String, Option<Vec<[f32; 3]>>), String> {
    let (h, body) = split::<Header>(bytes)?;
    let colors = if h.colors { Some(Reader(body).vec3(h.vertices, "colors")?) } else { None };
    Ok((h.key, colors))
}

/// An equirect, half float RGBA, row 0 first; 0 x 0 goes back to the sky.
pub fn decode_env(bytes: &[u8]) -> Result<Option<Environment>, String> {
    let (h, body) = split::<EnvHeader>(bytes)?;
    if h.width == 0 && h.height == 0 {
        return Ok(None);
    }
    if h.width == 0 || h.height == 0 || h.width > 8192 || h.height > 4096 {
        return Err(format!("an environment of {} x {} texels", h.width, h.height));
    }
    let n = h.width as usize * h.height as usize * 4;
    if body.len() < n * 2 {
        return Err(format!("environment: {} bytes left, {} needed", body.len(), n * 2));
    }
    let rgba = body[..n * 2].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Ok(Some(Environment { key: h.key, width: h.width, height: h.height, up: h.up, rgba }))
}
