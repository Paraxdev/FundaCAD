mod cosmic_text_system;
mod wgpu_atlas;
mod wgpu_context;
mod wgpu_renderer;

pub use cosmic_text_system::*;
pub use wgpu;
pub use wgpu_atlas::*;
pub use wgpu_context::*;
#[cfg(all(
    not(target_family = "wasm"),
    any(test, feature = "bench-support", feature = "test-support")
))]
pub use wgpu_renderer::WgpuHeadlessRenderer;
pub use wgpu_renderer::{GpuContext, WgpuRenderer, WgpuSurfaceConfig};

// FundaCAD: lets the app draw into textures on GPUI's own device and have GPUI composite them.
mod fundacad {
    use crate::{WgpuContext, WgpuTextureInfo};
    use gpui::{AtlasTextureId, AtlasTextureKind};
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Indices from here up name app rendered textures, never atlas textures.
    pub const EXTERNAL_TEXTURE_BASE: u32 = 0x4000_0000;

    static TEXTURES: Mutex<Option<HashMap<u32, WgpuTextureInfo>>> = Mutex::new(None);
    static SHARED: Mutex<Option<WgpuContext>> = Mutex::new(None);
    static SHARED_GENERATION: AtomicU64 = AtomicU64::new(0);

    /// Registers or replaces the texture GPUI samples for `index`. Bump `generation` whenever the
    /// view changes so cached bind groups are rebuilt.
    pub fn register_external_texture(index: u32, view: wgpu::TextureView, generation: u64) {
        TEXTURES
            .lock()
            .get_or_insert_with(HashMap::new)
            .insert(index, WgpuTextureInfo { view, generation });
    }

    pub(crate) fn external_texture(id: AtlasTextureId) -> Option<WgpuTextureInfo> {
        if id.kind != AtlasTextureKind::Polychrome || id.index < EXTERNAL_TEXTURE_BASE {
            return None;
        }
        TEXTURES.lock().as_ref()?.get(&id.index).cloned()
    }

    /// The context GPUI's windows draw with, once the first window exists.
    pub fn shared_context() -> Option<WgpuContext> {
        SHARED.lock().clone()
    }

    /// Changes whenever GPUI replaces its device, after a device loss for example. Resources made
    /// on an older device must be rebuilt.
    pub fn shared_context_generation() -> u64 {
        SHARED_GENERATION.load(Ordering::Acquire)
    }

    pub(crate) fn publish_context(context: &WgpuContext) {
        *SHARED.lock() = Some(context.clone());
        SHARED_GENERATION.fetch_add(1, Ordering::AcqRel);
        TEXTURES.lock().take();
    }
}
pub use fundacad::{
    register_external_texture, shared_context, shared_context_generation, EXTERNAL_TEXTURE_BASE,
};
pub(crate) use fundacad::{external_texture, publish_context};
