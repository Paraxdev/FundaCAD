use std::collections::HashMap;

use crate::material::{pack_material, tri_slots, GpuMaterial, FLAG_VERTEX_COLORS};

use super::accel::GpuBlas;
use super::{buffer, bytes, Tracer};

/// Row major 3x4 affine inverse.
fn inverse(m: &[f32; 12]) -> [f32; 12] {
    let (a, b, c) = (m[0], m[1], m[2]);
    let (d, e, f) = (m[4], m[5], m[6]);
    let (g, h, i) = (m[8], m[9], m[10]);
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    let k = if det.abs() > 1e-30 { 1.0 / det } else { 0.0 };
    let r = [
        (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
        (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
        (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
    ];
    let t = [m[3], m[7], m[11]];
    let mut out = [0.0; 12];
    for row in 0..3 {
        out[row * 4] = r[row * 3];
        out[row * 4 + 1] = r[row * 3 + 1];
        out[row * 4 + 2] = r[row * 3 + 2];
        out[row * 4 + 3] = -(r[row * 3] * t[0] + r[row * 3 + 1] * t[1] + r[row * 3 + 2] * t[2]);
    }
    out
}

pub(super) struct Shading {
    pub(super) pos: wgpu::Buffer,
    pub(super) nrm: wgpu::Buffer,
    pub(super) idx: wgpu::Buffer,
    pub(super) slots: wgpu::Buffer,
    pub(super) cols: wgpu::Buffer,
    pub(super) nodes: wgpu::Buffer,
    pub(super) order: wgpu::Buffer,
    /// vertex base, index base, triangle base, node base per mesh key
    pub(super) offsets: HashMap<String, [u32; 4]>,
}

impl Tracer {
    pub(super) fn upload_geometry(&mut self) {
        let (mut pos, mut nrm, mut idx, mut slots, mut cols, mut nodes, mut order) =
            (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
        let mut offsets = HashMap::new();
        for (key, m, blas) in self.scene.meshes() {
            let vb = (pos.len() / 4) as u32;
            let ib = idx.len() as u32;
            let tb = slots.len() as u32;
            let nb = (nodes.len() / 2) as u32;
            offsets.insert(key.to_string(), [vb, ib, tb, nb]);
            pos.extend(m.positions.iter().flat_map(|p| [p[0], p[1], p[2], 0.0f32]));
            for i in 0..m.positions.len() {
                let n = m.normals.get(i).copied().unwrap_or([0.0; 3]);
                nrm.extend([n[0], n[1], n[2], 0.0f32]);
            }
            idx.extend_from_slice(&m.indices);
            slots.extend(tri_slots(&m.groups, m.tri_count()));
            match &m.colors {
                Some(c) if c.len() == m.positions.len() => cols.extend(c.iter().map(|c| {
                    let q = |x: f32| (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
                    q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (255 << 24)
                })),
                _ => cols.extend(std::iter::repeat_n(u32::MAX, m.positions.len())),
            }
            if let Some(GpuBlas::Sw(t)) = blas {
                for pair in t.nodes.chunks(2) {
                    let (mut a, b) = (pair[0], pair[1]);
                    let first = a[3].to_bits();
                    let leaf = b[3].to_bits() != 0;
                    a[3] = f32::from_bits(if leaf { first + order.len() as u32 } else { first + nb });
                    nodes.push(a);
                    nodes.push(b);
                }
                order.extend_from_slice(&t.order);
            }
        }
        let d = &self.device;
        let q = &self.queue;
        let u = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
        self.shading = Shading {
            pos: buffer(d, q, bytes(&pos), u),
            nrm: buffer(d, q, bytes(&nrm), u),
            idx: buffer(d, q, bytes(&idx), u),
            slots: buffer(d, q, bytes(&slots), u),
            cols: buffer(d, q, bytes(&cols), u),
            nodes: buffer(d, q, bytes(&nodes), u),
            order: buffer(d, q, bytes(&order), u),
            offsets,
        };
        self.bind = None;
    }

    pub(super) fn upload_instances(&mut self) {
        let mut rows: Vec<f32> = vec![];
        let mut mats: Vec<GpuMaterial> = vec![];
        let insts = self.scene.instances();
        for inst in &insts {
            let off = self.shading.offsets.get(&inst.body.key).copied().unwrap_or_default();
            rows.extend_from_slice(&inst.xf);
            rows.extend_from_slice(&inverse(&inst.xf));
            let base = mats.len() as u32;
            let mut body: Vec<GpuMaterial> = inst.body.materials.iter().map(pack_material).collect();
            if body.is_empty() {
                body.push(pack_material(&Default::default()));
            }
            let colors = body.iter().any(|m| m.flags() & FLAG_VERTEX_COLORS != 0) as u32;
            let n = body.len() as u32;
            mats.extend(body);
            rows.extend([off[0], off[1], base, off[2], off[3], n, colors, 0].map(f32::from_bits));
        }
        self.n_inst = insts.len() as u32;
        // A runtime array binding needs room for one element even when the
        // loop traces before the first mesh lands; n_inst keeps it unread.
        if rows.is_empty() {
            rows.resize(32, 0.0);
        }
        if mats.is_empty() {
            mats.push(pack_material(&Default::default()));
        }
        let u = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
        self.insts = buffer(&self.device, &self.queue, bytes(&rows), u);
        self.mats = buffer(&self.device, &self.queue, bytes(&mats), u);
        self.bind = None;
    }
}
