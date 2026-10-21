//! Which adapter the tracer runs on, and why none when it refuses them all.

use super::bindings::STORAGE_FLOOR;

/// What the choice reads of an adapter, so it can be tested without one.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub name: String,
    pub backend: wgpu::Backend,
    pub device_type: wgpu::DeviceType,
    pub storage_buffers: u32,
}

impl Candidate {
    pub fn of(a: &wgpu::Adapter) -> Candidate {
        let i = a.get_info();
        Candidate { name: i.name, backend: i.backend, device_type: i.device_type, storage_buffers: a.limits().max_storage_buffers_per_shader_stage }
    }
    fn cpu(&self) -> bool {
        self.device_type == wgpu::DeviceType::Cpu
    }
    fn rank(&self) -> (bool, u8, bool) {
        let backend = match self.backend {
            wgpu::Backend::Vulkan => 0u8,
            wgpu::Backend::Dx12 => 1,
            wgpu::Backend::Metal => 2,
            _ => 3,
        };
        (self.cpu(), backend, self.device_type != wgpu::DeviceType::DiscreteGpu)
    }
}

/// Why this machine has no native tracer, as the page greys the mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NoAdapter,
    /// Only software rasterisers, refused unless FUNDACAD_TRACER_ALLOW_CPU=1.
    Cpu { name: String },
    Limits { name: String, storage: u32 },
    SelfCheck(String),
    /// The adapter passed but would not give a device.
    Device(String),
}

impl Refusal {
    pub fn class(&self) -> Option<&'static str> {
        match self {
            Refusal::NoAdapter => Some("noadapter"),
            Refusal::Cpu { .. } => Some("cpu"),
            Refusal::Limits { .. } => Some("limits"),
            Refusal::SelfCheck(_) => Some("selfcheck"),
            Refusal::Device(_) => None,
        }
    }
    pub fn storage_buffers(&self) -> Option<u32> {
        match self {
            Refusal::Limits { storage, .. } => Some(*storage),
            _ => None,
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::NoAdapter => write!(f, "no graphics adapter"),
            Refusal::Cpu { name } => write!(f, "{name} is a software renderer"),
            Refusal::Limits { name, storage } => write!(f, "{name} binds {storage} storage buffers, the tracer needs {STORAGE_FLOOR}"),
            Refusal::SelfCheck(why) | Refusal::Device(why) => f.write_str(why),
        }
    }
}

/// The adapter as a report names it. The kind matters: a virtual machine's
/// Metal device reads like a real GPU by its name alone.
pub fn adapter_label(name: &str, backend: wgpu::Backend, kind: wgpu::DeviceType) -> String {
    let kind = match kind {
        wgpu::DeviceType::DiscreteGpu => "discrete GPU",
        wgpu::DeviceType::IntegratedGpu => "integrated GPU",
        wgpu::DeviceType::VirtualGpu => "virtual GPU",
        wgpu::DeviceType::Cpu => "software",
        wgpu::DeviceType::Other => "unknown kind",
    };
    format!("{name} ({backend:?}, {kind})")
}

/// The best adapter by backend, then discrete over integrated, CPU adapters
/// last and only when allowed. A refusal names the best adapter refused, so
/// a real GPU short of storage buffers is reported over a CPU one.
pub fn choose(c: &[Candidate], allow_cpu: bool) -> Result<usize, Refusal> {
    let by_rank = |ok: &dyn Fn(&Candidate) -> bool| (0..c.len()).filter(|&i| ok(&c[i])).min_by_key(|&i| c[i].rank());
    let allowed = |a: &Candidate| allow_cpu || !a.cpu();
    if let Some(i) = by_rank(&|a| allowed(a) && a.storage_buffers >= STORAGE_FLOOR) {
        return Ok(i);
    }
    if let Some(i) = by_rank(&allowed) {
        return Err(Refusal::Limits { name: c[i].name.clone(), storage: c[i].storage_buffers });
    }
    match c.first() {
        Some(a) => Err(Refusal::Cpu { name: a.name.clone() }),
        None => Err(Refusal::NoAdapter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::{Backend, DeviceType};

    fn cand(name: &str, backend: Backend, device_type: DeviceType, storage: u32) -> Candidate {
        Candidate { name: name.into(), backend, device_type, storage_buffers: storage }
    }

    #[test]
    fn adapters_are_chosen_and_refused_by_kind_and_limits() {
        let warp = cand("Microsoft Basic Render Driver", Backend::Dx12, DeviceType::Cpu, 262_144);
        let igpu = cand("Intel UHD", Backend::Dx12, DeviceType::IntegratedGpu, 262_144);
        let gl = cand("ANGLE", Backend::Gl, DeviceType::Other, 8);
        let vk = cand("RTX", Backend::Vulkan, DeviceType::DiscreteGpu, 524_288);
        let dx = cand("RTX", Backend::Dx12, DeviceType::DiscreteGpu, 262_144);

        assert_eq!(choose(&[], false), Err(Refusal::NoAdapter));
        assert_eq!(choose(&[warp.clone()], false), Err(Refusal::Cpu { name: warp.name.clone() }));
        assert_eq!(choose(&[warp.clone()], true), Ok(0));
        assert_eq!(choose(&[igpu.clone(), warp.clone()], false), Ok(0));
        assert_eq!(choose(&[warp.clone(), igpu.clone()], false), Ok(1));
        assert_eq!(choose(&[warp.clone(), igpu.clone()], true), Ok(1));
        assert_eq!(choose(&[gl.clone()], false), Err(Refusal::Limits { name: gl.name.clone(), storage: 8 }));
        assert_eq!(choose(&[warp.clone(), gl.clone()], false), Err(Refusal::Limits { name: gl.name.clone(), storage: 8 }));
        assert_eq!(choose(&[dx.clone(), vk.clone()], false), Ok(1));
        assert_eq!(choose(&[vk, dx], false), Ok(0));
        assert_eq!(Refusal::Limits { name: "ANGLE".into(), storage: 8 }.class(), Some("limits"));
        assert_eq!(Refusal::Limits { name: "ANGLE".into(), storage: 8 }.storage_buffers(), Some(8));
        assert_eq!(Refusal::Cpu { name: warp.name }.class(), Some("cpu"));
        assert_eq!(Refusal::SelfCheck("drew wrong".into()).class(), Some("selfcheck"));
    }

    #[test]
    fn an_adapter_is_named_with_its_backend_and_kind() {
        assert_eq!(adapter_label("Apple Paravirtual device", Backend::Metal, DeviceType::IntegratedGpu), "Apple Paravirtual device (Metal, integrated GPU)");
        assert_eq!(adapter_label("llvmpipe", Backend::Vulkan, DeviceType::Cpu), "llvmpipe (Vulkan, software)");
    }
}
