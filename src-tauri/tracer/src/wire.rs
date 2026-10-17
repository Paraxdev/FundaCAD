//! The raw invoke bodies the page sends a mesh or its colours in:
//! [u32 header length][JSON header][zero pad to 4][buffers], little endian,
//! the framing src/geometry/client.ts reads engine meshes with.

use serde::Deserialize;

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

fn split(bytes: &[u8]) -> Result<(Header, &[u8]), String> {
    let len = bytes.get(..4).ok_or("the body is shorter than its header length")?;
    let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
    let json = bytes.get(4..4 + len).ok_or("the header runs past the body")?;
    let head: Header = serde_json::from_slice(json).map_err(|e| format!("bad header: {e}"))?;
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
    let (h, body) = split(bytes)?;
    let mut r = Reader(body);
    let positions = r.vec3(h.vertices, "positions")?;
    let normals = if h.normals { r.vec3(h.vertices, "normals")? } else { Vec::new() };
    let indices =
        if h.indices > 0 { r.u32s(h.indices, "indices")? } else { (0..h.vertices as u32).collect() };
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
    let (h, body) = split(bytes)?;
    let colors = if h.colors { Some(Reader(body).vec3(h.vertices, "colors")?) } else { None };
    Ok((h.key, colors))
}

#[cfg(test)]
pub(crate) fn encode(header: &str, floats: &[f32], ints: &[u32], tail: &[f32]) -> Vec<u8> {
    let mut b = (header.len() as u32).to_le_bytes().to_vec();
    b.extend_from_slice(header.as_bytes());
    b.resize(b.len().next_multiple_of(4), 0);
    floats.iter().for_each(|f| b.extend_from_slice(&f.to_le_bytes()));
    ints.iter().for_each(|i| b.extend_from_slice(&i.to_le_bytes()));
    tail.iter().for_each(|f| b.extend_from_slice(&f.to_le_bytes()));
    b
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn colours_set_or_clear() {
        let (k, c) = decode_colors(&encode(r#"{"key":"k","vertices":1,"colors":true}"#, &[0.5, 0.25, 1.], &[], &[]))
            .unwrap();
        assert_eq!((k.as_str(), c), ("k", Some(vec![[0.5, 0.25, 1.]])));
        assert_eq!(decode_colors(&encode(r#"{"key":"k","vertices":1}"#, &[], &[], &[])).unwrap().1, None);
    }
}
