//! The trace pass's one bind group layout, as a table: a new buffer gets its
//! slot, its owner and its path here, and the storage floor test counts it.

use super::{Path, Tracer};

/// `Tracer::new` refuses adapters with fewer storage buffers per shader stage.
pub(super) const STORAGE_FLOOR: u32 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Uniform,
    Storage { write: bool },
    Accel,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Binding {
    pub slot: u32,
    /// The variable in the WGSL.
    pub name: &'static str,
    /// The `Tracer` field that holds the resource.
    pub owner: &'static str,
    pub kind: Kind,
    /// None when both paths bind it.
    pub path: Option<Path>,
}

const fn b(slot: u32, name: &'static str, owner: &'static str, kind: Kind, path: Option<Path>) -> Binding {
    Binding { slot, name, owner, kind, path }
}

const RO: Kind = Kind::Storage { write: false };
const RW: Kind = Kind::Storage { write: true };

pub(super) const TRACE: [Binding; 13] = [
    b(0, "u", "uniform", Kind::Uniform, None),
    b(1, "accum", "accum", RW, None),
    b(2, "aov", "aov", RW, None),
    b(3, "pos", "shading.pos", RO, None),
    b(4, "nrm", "shading.nrm", RO, None),
    b(5, "idx", "shading.idx", RO, None),
    b(6, "slots", "shading.slots", RO, None),
    b(7, "cols", "shading.cols", RO, None),
    b(8, "insts", "insts", RO, None),
    b(9, "mats", "mats", RO, None),
    b(10, "acc", "scene.accel.tlas", Kind::Accel, Some(Path::RayQuery)),
    b(10, "nodes", "shading.nodes", RO, Some(Path::Software)),
    b(11, "order", "shading.order", RO, Some(Path::Software)),
];

pub(super) fn bound(path: Path) -> impl Iterator<Item = &'static Binding> {
    TRACE.iter().filter(move |b| b.path.is_none_or(|p| p == path))
}

#[cfg(test)]
pub(super) fn storage_count(path: Path) -> u32 {
    bound(path).filter(|b| matches!(b.kind, Kind::Storage { .. })).count() as u32
}

pub(super) fn entry(slot: u32, kind: Kind) -> wgpu::BindGroupLayoutEntry {
    let buf = |ty| wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None };
    wgpu::BindGroupLayoutEntry {
        binding: slot,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: match kind {
            Kind::Uniform => buf(wgpu::BufferBindingType::Uniform),
            Kind::Storage { write } => buf(wgpu::BufferBindingType::Storage { read_only: !write }),
            Kind::Accel => wgpu::BindingType::AccelerationStructure { vertex_return: false },
        },
        count: None,
    }
}

pub(super) fn trace_layout(device: &wgpu::Device, path: Path) -> wgpu::BindGroupLayout {
    let entries: Vec<_> = bound(path).map(|b| entry(b.slot, b.kind)).collect();
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &entries })
}

impl Tracer {
    pub(super) fn bind_group(&mut self) -> wgpu::BindGroup {
        if let Some(b) = &self.bind {
            return b.clone();
        }
        let s = &self.shading;
        let e: Vec<_> = bound(self.path)
            .map(|b| wgpu::BindGroupEntry {
                binding: b.slot,
                resource: match b.owner {
                    "uniform" => self.uniform.as_entire_binding(),
                    "accum" => self.accum.as_entire_binding(),
                    "aov" => self.aov.as_entire_binding(),
                    "shading.pos" => s.pos.as_entire_binding(),
                    "shading.nrm" => s.nrm.as_entire_binding(),
                    "shading.idx" => s.idx.as_entire_binding(),
                    "shading.slots" => s.slots.as_entire_binding(),
                    "shading.cols" => s.cols.as_entire_binding(),
                    "insts" => self.insts.as_entire_binding(),
                    "mats" => self.mats.as_entire_binding(),
                    "scene.accel.tlas" => self.scene.accel.tlas.as_ref().expect("Tracer::new builds a tlas for ray queries").as_binding(),
                    "shading.nodes" => s.nodes.as_entire_binding(),
                    "shading.order" => s.order.as_entire_binding(),
                    o => unreachable!("{} has no owner {o}", b.name),
                },
            })
            .collect();
        let b = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.pipes.trace_bgl, entries: &e });
        self.bind = Some(b.clone());
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gpu::pipelines::trace_source;

    /// What the assembled kernel declares: slot, name and kind per global.
    fn declared(path: Path) -> Vec<(u32, String, Kind)> {
        let m = naga::front::wgsl::parse_str(&trace_source(path)).expect("the trace kernel parses");
        let mut v: Vec<_> = m
            .global_variables
            .iter()
            .filter_map(|(_, g)| {
                let slot = g.binding.as_ref()?.binding;
                let kind = match g.space {
                    naga::AddressSpace::Uniform => Kind::Uniform,
                    naga::AddressSpace::Storage { access } => Kind::Storage { write: access.contains(naga::StorageAccess::STORE) },
                    _ => Kind::Accel,
                };
                Some((slot, g.name.clone().unwrap_or_default(), kind))
            })
            .collect();
        v.sort_by_key(|d| d.0);
        v
    }

    #[test]
    fn the_binding_table_is_what_each_kernel_declares() {
        for path in [Path::Software, Path::RayQuery] {
            let table: Vec<_> = bound(path).map(|b| (b.slot, b.name.to_string(), b.kind)).collect();
            assert_eq!(table, declared(path), "{path:?}");
        }
    }

    #[test]
    fn each_path_binds_no_more_storage_buffers_than_the_floor() {
        assert_eq!(storage_count(Path::Software), 11);
        assert_eq!(storage_count(Path::RayQuery), 9);
        for path in [Path::Software, Path::RayQuery] {
            let n = declared(path).iter().filter(|d| matches!(d.2, Kind::Storage { .. })).count() as u32;
            assert_eq!(n, storage_count(path), "{path:?}");
            assert!(n <= STORAGE_FLOOR, "{path:?} binds {n} storage buffers over the floor of {STORAGE_FLOOR}");
        }
    }

    fn span(path: Path, name: &str) -> u32 {
        let m = naga::front::wgsl::parse_str(&trace_source(path)).unwrap();
        let mut l = naga::proc::Layouter::default();
        l.update(m.to_ctx()).unwrap();
        let (h, _) = m.types.iter().find(|(_, t)| t.name.as_deref() == Some(name)).expect(name);
        l[h].size
    }

    #[test]
    fn the_kernel_reads_the_packed_strides() {
        for path in [Path::Software, Path::RayQuery] {
            assert_eq!(span(path, "Mat"), 144, "{path:?}");
            assert_eq!(span(path, "Inst"), 160, "{path:?}");
            assert_eq!(span(path, "Mat") as usize, std::mem::size_of::<crate::material::GpuMaterial>());
            assert_eq!(span(path, "Inst") as usize, std::mem::size_of::<crate::scene::GpuInst>());
        }
    }
}
