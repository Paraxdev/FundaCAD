use std::collections::HashMap;

use crate::material::{pack_material, tri_slots, GpuMaterial};
use crate::scene::{pack_inst, GpuInst};

use super::accel::GpuBlas;
use super::{buffer, bytes, Tracer};

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
        let mut rows: Vec<GpuInst> = vec![];
        let mut mats: Vec<GpuMaterial> = vec![];
        let insts = self.scene.instances();
        for inst in &insts {
            let off = self.shading.offsets.get(&inst.body.key).copied().unwrap_or_default();
            let base = mats.len() as u32;
            let mut body: Vec<GpuMaterial> = inst.body.materials.iter().map(pack_material).collect();
            if body.is_empty() {
                body.push(pack_material(&Default::default()));
            }
            rows.push(pack_inst(&inst.xf, off, base, body.len() as u32));
            mats.extend(body);
        }
        self.n_inst = insts.len() as u32;
        // A runtime array binding needs room for one element even when the
        // loop traces before the first mesh lands; n_inst keeps it unread.
        if rows.is_empty() {
            rows.push(pack_inst(&[0.0; 12], [0; 4], 0, 0));
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
