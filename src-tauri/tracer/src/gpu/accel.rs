use crate::bvh::{self, Bvh};
use crate::scene::{Accel, Instance, Mesh};

use super::{buffer, bytes};

pub enum GpuBlas {
    Hw(wgpu::Blas),
    Sw(Bvh),
}

pub struct GpuAccel {
    pub(super) device: wgpu::Device,
    pub(super) queue: wgpu::Queue,
    pub(super) hw: bool,
    pub(super) tlas: Option<wgpu::Tlas>,
}

impl Accel for GpuAccel {
    type Blas = GpuBlas;

    fn build_blas(&mut self, mesh: &Mesh) -> GpuBlas {
        if !self.hw {
            return GpuBlas::Sw(bvh::build(&mesh.positions, &mesh.indices));
        }
        let verts: Vec<f32> = mesh.positions.iter().flat_map(|p| [p[0], p[1], p[2], 0.0]).collect();
        let usage = wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST;
        let vb = buffer(&self.device, &self.queue, bytes(&verts), usage);
        let ib = buffer(&self.device, &self.queue, bytes(&mesh.indices), usage);
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: mesh.positions.len() as u32,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(mesh.indices.len() as u32),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("tracer-blas"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![size.clone()] },
        );
        let entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &size,
                vertex_buffer: &vb,
                first_vertex: 0,
                vertex_stride: 16,
                index_buffer: Some(&ib),
                first_index: Some(0),
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        };
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.build_acceleration_structures(std::iter::once(&entry), std::iter::empty());
        self.queue.submit([enc.finish()]);
        GpuBlas::Hw(blas)
    }

    fn build_tlas(&mut self, instances: &[Instance<'_, GpuBlas>]) {
        if self.hw {
            self.tlas = Some(make_tlas(&self.device, &self.queue, instances));
        }
    }
}

pub(super) fn make_tlas(device: &wgpu::Device, queue: &wgpu::Queue, instances: &[Instance<'_, GpuBlas>]) -> wgpu::Tlas {
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("tracer-tlas"),
        max_instances: instances.len().max(1) as u32,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (i, inst) in instances.iter().enumerate() {
        if let GpuBlas::Hw(b) = inst.blas {
            tlas[i] = Some(wgpu::TlasInstance::new(b, inst.xf, i as u32, 0xff));
        }
    }
    let mut enc = device.create_command_encoder(&Default::default());
    enc.build_acceleration_structures(std::iter::empty(), std::iter::once(&tlas));
    queue.submit([enc.finish()]);
    tlas
}
