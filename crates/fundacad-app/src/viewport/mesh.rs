use glam::Vec3;

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
}

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangles(&self) -> usize {
        self.indices.len() / 3
    }

    /// Centre and radius of a sphere around every vertex.
    pub fn bounds(&self) -> Option<(Vec3, f32)> {
        let mut iter = self.vertices.iter().map(|v| Vec3::from(v.position));
        let first = iter.next()?;
        let (min, max) = iter.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p)));
        let centre = (min + max) * 0.5;
        Some((centre, (max - centre).length()))
    }
}

/// Reads a binary STL. Stands in until the engine link delivers meshes.
pub fn load_stl(bytes: &[u8]) -> Result<Mesh, String> {
    if bytes.len() < 84 {
        return Err("too short for a binary STL".into());
    }
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    if bytes.len() < 84 + count * 50 {
        return Err(format!("{count} triangles announced, the file is shorter"));
    }
    let mut vertices = Vec::with_capacity(count * 3);
    for t in 0..count {
        let base = 84 + t * 50;
        let f = |o: usize| f32::from_le_bytes(bytes[base + o..base + o + 4].try_into().unwrap());
        let corners = [0, 1, 2].map(|k| Vec3::new(f(12 + k * 12), f(16 + k * 12), f(20 + k * 12)));
        let normal = (corners[1] - corners[0]).cross(corners[2] - corners[0]).normalize_or_zero();
        for c in corners {
            vertices.push(Vertex { position: c.into(), normal: normal.into() });
        }
    }
    let indices = (0..vertices.len() as u32).collect();
    Ok(Mesh { vertices, indices })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mesh = load_stl(&bytes).unwrap();
        assert_eq!(mesh.triangles(), 1);
        assert_eq!(mesh.vertices[0].normal, [0.0, 0.0, 1.0]);
        let (centre, radius) = mesh.bounds().unwrap();
        assert_eq!(centre, Vec3::new(1.0, 1.0, 0.0));
        assert!((radius - 2f32.sqrt()).abs() < 1e-6);
    }

    #[test]
    fn rejects_a_truncated_file() {
        let mut bytes = vec![0u8; 84];
        bytes[80..84].copy_from_slice(&5u32.to_le_bytes());
        assert!(load_stl(&bytes).is_err());
    }
}
