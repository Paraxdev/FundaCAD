use std::collections::HashMap;

use crate::material::{pack_material, tri_slots, GpuMaterial};
use crate::scene::{pack_inst, GpuInst, Mesh, INST_EMITTERS};

use super::accel::GpuBlas;
use super::{buffer, bytes, storage, Tracer};

/// Every triangle that lights the scene, in world space, as the alias table
/// the shader picks one by power (area times luminance) with.
#[derive(Default)]
pub(super) struct Emitters {
    /// chance, alias, instance and triangle as bits per entry
    pub(super) table: Vec<[f32; 4]>,
    pub(super) count: u32,
    pub(super) total: f32,
}

/// The power of each triangle of `mesh` placed by `xf`, zero for the ones
/// whose slot does not light.
fn tri_powers(mesh: &Mesh, xf: &[f32; 12], mats: &[GpuMaterial]) -> Vec<f32> {
    let slots = tri_slots(&mesh.groups, mesh.tri_count());
    let world = |i: u32| {
        let p = mesh.positions.get(i as usize).copied().unwrap_or_default();
        [0, 1, 2].map(|r| xf[r * 4] * p[0] + xf[r * 4 + 1] * p[1] + xf[r * 4 + 2] * p[2] + xf[r * 4 + 3])
    };
    mesh.indices
        .chunks_exact(3)
        .zip(slots)
        .map(|(t, slot)| {
            let m = mats.get(slot as usize).unwrap_or(&mats[0]);
            let lum = m.light_power();
            if lum <= 0.0 {
                return 0.0;
            }
            let (a, b, c) = (world(t[0]), world(t[1]), world(t[2]));
            let e1 = [0, 1, 2].map(|k| (b[k] - a[k]) as f64);
            let e2 = [0, 1, 2].map(|k| (c[k] - a[k]) as f64);
            let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            let area = 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            (area * lum as f64) as f32
        })
        .collect()
}

/// Vose's alias table over `entries` of (instance, triangle, power).
fn alias_table(entries: &[(u32, u32, f32)]) -> Emitters {
    let n = entries.len();
    let total: f64 = entries.iter().map(|e| e.2 as f64).sum();
    if n == 0 || total <= 0.0 {
        return Emitters::default();
    }
    let mut prob: Vec<f64> = entries.iter().map(|e| e.2 as f64 * n as f64 / total).collect();
    let mut alias: Vec<u32> = (0..n as u32).collect();
    let (mut small, mut large): (Vec<usize>, Vec<usize>) = (0..n).partition(|&i| prob[i] < 1.0);
    while !small.is_empty() && !large.is_empty() {
        let (s, l) = (small.pop().unwrap(), *large.last().unwrap());
        alias[s] = l as u32;
        prob[l] -= 1.0 - prob[s];
        if prob[l] < 1.0 {
            large.pop();
            small.push(l);
        }
    }
    for i in small.into_iter().chain(large) {
        prob[i] = 1.0;
    }
    let table = entries
        .iter()
        .enumerate()
        .map(|(i, e)| [prob[i] as f32, f32::from_bits(alias[i]), f32::from_bits(e.0), f32::from_bits(e.1)])
        .collect();
    Emitters { table, count: n as u32, total: total as f32 }
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
        let mut rows: Vec<GpuInst> = vec![];
        let mut mats: Vec<GpuMaterial> = vec![];
        let mut emitting: Vec<(u32, u32, f32)> = vec![];
        let insts = self.scene.instances();
        for inst in &insts {
            let off = self.shading.offsets.get(&inst.body.key).copied().unwrap_or_default();
            let base = mats.len() as u32;
            let mut body: Vec<GpuMaterial> = inst.body.materials.iter().map(pack_material).collect();
            if body.is_empty() {
                body.push(pack_material(&Default::default()));
            }
            let mut row = pack_inst(&inst.xf, off, base, body.len() as u32);
            if body.iter().any(|m| m.light_power() > 0.0) {
                if let Some(mesh) = self.scene.mesh(&inst.body.key) {
                    let first = emitting.len() as u32;
                    let i = rows.len() as u32;
                    emitting.extend(tri_powers(mesh, &inst.xf, &body).into_iter().enumerate().filter(|e| e.1 > 0.0).map(|(t, p)| (i, t as u32, p)));
                    if emitting.len() as u32 > first {
                        row.extra[2] |= INST_EMITTERS;
                        row.extra[3] = first;
                    }
                }
            }
            rows.push(row);
            mats.extend(body);
        }
        self.emitters = alias_table(&emitting);
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
        self.write_emitters();
        self.instance_uploads += 1;
    }

    /// The emitter table into the lights buffer after the environment's
    /// tables, a bigger buffer with both when it no longer fits.
    pub(super) fn write_emitters(&mut self) {
        let base = self.env.tables.len() * 16;
        let need = (base + self.emitters.table.len() * 16) as u64;
        if self.env.lights.size() < need {
            self.env.lights = storage(&self.device, need.next_power_of_two(), wgpu::BufferUsages::empty());
            self.queue.write_buffer(&self.env.lights, 0, bytes(&self.env.tables));
            self.bind = None;
        }
        if !self.emitters.table.is_empty() {
            self.queue.write_buffer(&self.env.lights, base as u64, bytes(&self.emitters.table));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alias_table_picks_each_triangle_by_its_power() {
        let powers = [1.0, 3.0, 0.5, 2.5, 3.0];
        let e = alias_table(&powers.iter().enumerate().map(|(i, p)| (7, i as u32, *p)).collect::<Vec<_>>());
        assert_eq!((e.count, e.total), (5, 10.0));
        let mut got = [0.0f64; 5];
        for (i, row) in e.table.iter().enumerate() {
            got[i] += row[0] as f64 / 5.0;
            got[row[1].to_bits() as usize] += (1.0 - row[0] as f64) / 5.0;
            assert_eq!((row[2].to_bits(), row[3].to_bits()), (7, i as u32));
        }
        for (g, p) in got.iter().zip(powers) {
            assert!((g - p as f64 / 10.0).abs() < 1e-6, "{got:?}");
        }
    }

    #[test]
    fn a_triangle_lights_by_its_world_area() {
        let mesh = Mesh { positions: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], indices: vec![0, 1, 2], ..Default::default() };
        let glow = pack_material(&crate::material::PageMaterial { emissive: Some([1.0; 3]), emissive_intensity: Some(4.0), ..Default::default() });
        let xf = [2.0, 0.0, 0.0, 5.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        assert!((tri_powers(&mesh, &xf, &[glow])[0] - 0.5 * 6.0 * 4.0).abs() < 1e-4);
        let none = pack_material(&crate::material::PageMaterial { no_light: true, ..Default::default() });
        assert_eq!(tri_powers(&mesh, &xf, &[none]), vec![0.0]);
    }
}
