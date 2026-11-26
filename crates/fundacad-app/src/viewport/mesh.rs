use super::scene::Body;

/// Reads a binary STL as one body with a face per triangle.
pub fn load_stl(bytes: &[u8]) -> Result<Body, String> {
    if bytes.len() < 84 {
        return Err("too short for a binary STL".into());
    }
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    if bytes.len() < 84 + count * 50 {
        return Err(format!("{count} triangles announced, the file is shorter"));
    }
    let mut positions = Vec::with_capacity(count * 9);
    for t in 0..count {
        let base = 84 + t * 50 + 12;
        for k in 0..9 {
            let o = base + k * 4;
            positions.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
        }
    }
    Ok(Body {
        id: "stl".into(),
        positions,
        indices: (0..count as u32 * 3).collect(),
        face_ids: (0..count as u32).collect(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use glam::Vec3;

    use super::*;
    use crate::viewport::scene::SceneBody;

    #[test]
    fn reads_one_triangle() {
        let mut bytes = vec![0u8; 84 + 50];
        bytes[80..84].copy_from_slice(&1u32.to_le_bytes());
        let corners = [[0.0f32, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]];
        for (k, c) in corners.iter().enumerate() {
            for (i, v) in c.iter().enumerate() {
                let o = 84 + 12 + k * 12 + i * 4;
                bytes[o..o + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        let body = SceneBody::new(Arc::new(load_stl(&bytes).unwrap()));
        assert_eq!(body.indices.len(), 3);
        assert_eq!(body.vertices[0].normal(), Vec3::Z);
        assert_eq!(body.vertices[1].position(), Vec3::new(2.0, 0.0, 0.0));
    }

    #[test]
    fn rejects_a_truncated_file() {
        let mut bytes = vec![0u8; 84];
        bytes[80..84].copy_from_slice(&5u32.to_le_bytes());
        assert!(load_stl(&bytes).is_err());
    }
}
