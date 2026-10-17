//! Trace mode on the native side: the page's bodies, materials and camera in,
//! progressively accumulated frames out through fundacad-frames.

pub mod bvh;
pub mod denoise;
mod gpu;
pub mod material;
pub mod scene;
pub mod wire;

pub use denoise::Quality;
pub use gpu::{Camera, Look, Path, Tracer, TracerOptions};
pub use material::{pack_material, tri_slots, GpuMaterial, Group, PageMaterial};
pub use scene::{Accel, BodyDesc, Commit, Instance, Mesh, Scene};
pub use wire::{decode_colors, decode_mesh};
