//! Trace mode on the native side: the page's bodies, materials and camera in,
//! progressively accumulated frames out through fundacad-frames.

pub mod atrous;
pub mod bloom;
pub mod bvh;
pub mod denoise;
mod gpu;
pub mod material;
pub mod oidn;
pub mod scene;
pub mod selfcheck;
pub mod wire;

pub use bloom::Bloom;
pub use denoise::{Denoiser, Quality};
pub use gpu::{choose, encode_png, picture_refusal, Camera, Candidate, Look, Path, Picture, Refusal, Tracer, TracerOptions};
pub use material::{pack_material, tri_slots, GpuMaterial, Group, PageMaterial};
pub use selfcheck::{display16, Reference, SelfCheck};
pub use scene::{pack_inst, Accel, BodyDesc, Commit, GpuInst, Instance, Mesh, Scene};
pub use wire::{decode_colors, decode_mesh};
