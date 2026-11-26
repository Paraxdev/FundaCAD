// Added by FundaCAD: Windows windows draw through gpui_wgpu (Vulkan, GL fallback) like Linux, instead of
// DirectX 11. FUNDA_GPUI_RENDERER=dx keeps the stock DirectX renderer.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use anyhow::Result;
use gpui::{DevicePixels, GpuSpecs, PlatformAtlas, Scene, Size, WindowBackgroundAppearance};
use gpui_wgpu::{GpuContext, WgpuRenderer, WgpuSurfaceConfig};
use raw_window_handle as rwh;
use windows::Win32::Foundation::HWND;

use crate::{DirectXDevices, DirectXRenderer};

thread_local! {
    static GPU_CONTEXT: GpuContext = Rc::new(RefCell::new(None));
}

pub fn wgpu_selected() -> bool {
    !matches!(std::env::var("FUNDA_GPUI_RENDERER").as_deref(), Ok("dx"))
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct HwndHandle {
    hwnd: isize,
    hinstance: isize,
}

unsafe impl Send for HwndHandle {}
unsafe impl Sync for HwndHandle {}

impl rwh::HasWindowHandle for HwndHandle {
    fn window_handle(&self) -> Result<rwh::WindowHandle<'_>, rwh::HandleError> {
        let mut raw = rwh::Win32WindowHandle::new(std::num::NonZeroIsize::new(self.hwnd).unwrap());
        raw.hinstance = std::num::NonZeroIsize::new(self.hinstance);
        Ok(unsafe { rwh::WindowHandle::borrow_raw(raw.into()) })
    }
}

impl rwh::HasDisplayHandle for HwndHandle {
    fn display_handle(&self) -> Result<rwh::DisplayHandle<'_>, rwh::HandleError> {
        Ok(rwh::DisplayHandle::windows())
    }
}

pub(crate) enum WinRenderer {
    Dx(DirectXRenderer),
    Wgpu {
        renderer: WgpuRenderer,
        handle: HwndHandle,
    },
}

impl WinRenderer {
    pub(crate) fn new(
        hwnd: HWND,
        size: Size<DevicePixels>,
        directx_devices: &DirectXDevices,
        disable_direct_composition: bool,
    ) -> Result<Self> {
        if !wgpu_selected() {
            return Ok(Self::Dx(DirectXRenderer::new(
                hwnd,
                directx_devices,
                disable_direct_composition,
            )?));
        }
        let handle = HwndHandle {
            hwnd: hwnd.0 as isize,
            hinstance: crate::get_module_handle().0 as isize,
        };
        // The window is still CW_USEDEFAULT sized here, the first resize sets the real size.
        let size = Size {
            width: DevicePixels(size.width.0.clamp(1, 4096)),
            height: DevicePixels(size.height.0.clamp(1, 4096)),
        };
        let context = GPU_CONTEXT.with(Rc::clone);
        let renderer = WgpuRenderer::new(
            context,
            &handle,
            WgpuSurfaceConfig {
                size,
                transparent: false,
                preferred_present_mode: None,
            },
            None,
        )?;
        GPU_CONTEXT.with(|ctx| {
            if let Some(ctx) = ctx.borrow().as_ref() {
                log::info!("gpui wgpu renderer on {:?}: {:?}", ctx.backend(), ctx.adapter.get_info());
            }
        });
        Ok(Self::Wgpu { renderer, handle })
    }

    pub(crate) fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
        match self {
            Self::Dx(r) => r.sprite_atlas(),
            Self::Wgpu { renderer, .. } => renderer.sprite_atlas().clone(),
        }
    }

    pub(crate) fn handle_device_lost(&mut self, devices: &DirectXDevices) -> Result<()> {
        match self {
            Self::Dx(r) => r.handle_device_lost(devices),
            Self::Wgpu { renderer, handle } => renderer.recover(&*handle),
        }
    }

    pub(crate) fn draw(
        &mut self,
        scene: &Scene,
        background_appearance: WindowBackgroundAppearance,
    ) -> Result<()> {
        match self {
            Self::Dx(r) => r.draw(scene, background_appearance),
            Self::Wgpu { renderer, handle } => {
                if renderer.device_lost() {
                    renderer.recover(&*handle)?;
                }
                renderer.draw(scene);
                Ok(())
            }
        }
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn render_to_image(
        &mut self,
        scene: &Scene,
        background_appearance: WindowBackgroundAppearance,
    ) -> Result<image::RgbaImage> {
        match self {
            Self::Dx(r) => r.render_to_image(scene, background_appearance),
            Self::Wgpu { renderer, .. } => renderer.render_to_image(scene),
        }
    }

    pub(crate) fn resize(&mut self, new_size: Size<DevicePixels>) -> Result<()> {
        match self {
            Self::Dx(r) => r.resize(new_size),
            Self::Wgpu { renderer, .. } => {
                renderer.update_drawable_size(new_size);
                Ok(())
            }
        }
    }

    pub(crate) fn gpu_specs(&self) -> Result<GpuSpecs> {
        match self {
            Self::Dx(r) => r.gpu_specs(),
            Self::Wgpu { renderer, .. } => renderer
                .gpu_specs()
                .ok_or_else(|| anyhow::anyhow!("no gpu specs")),
        }
    }

    pub(crate) fn mark_drawable(&mut self) {
        if let Self::Dx(r) = self {
            r.mark_drawable();
        }
    }
}
