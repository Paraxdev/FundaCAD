use fundacad_tracer::{choose, Candidate, Refusal};
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
