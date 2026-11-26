mod camera;
pub mod mesh;
mod renderer;

use gpui::*;

pub use camera::Camera;
use mesh::Mesh;
use renderer::Renderer;

/// Index GPUI samples the main 3D view from.
const MAIN_TEXTURE: u32 = gpui_wgpu::EXTERNAL_TEXTURE_BASE;

#[derive(Clone, Copy, PartialEq)]
enum Drag {
    Orbit,
    Pan,
}

pub struct Viewport {
    camera: Camera,
    mesh: Mesh,
    renderer: Option<Renderer>,
    drag: Option<(Drag, Point<Pixels>)>,
    bounds: Bounds<Pixels>,
    backend: Option<String>,
}

impl Viewport {
    pub fn new(mesh: Mesh) -> Self {
        let mut camera = Camera::default();
        if let Some((centre, radius)) = mesh.bounds() {
            camera.fit(centre.into(), radius);
        }
        Self { camera, mesh, renderer: None, drag: None, bounds: Bounds::default(), backend: None }
    }

    /// The GPU the viewport draws on, once the first frame ran.
    pub fn backend(&self) -> Option<&str> {
        self.backend.as_deref()
    }

    pub fn triangles(&self) -> usize {
        self.mesh.triangles()
    }

    /// Makes or remakes the renderer whenever GPUI has a new device.
    fn renderer(&mut self) -> Option<&mut Renderer> {
        let generation = gpui_wgpu::shared_context_generation();
        if self.renderer.as_ref().is_none_or(|r| r.context_generation() != generation) {
            let context = gpui_wgpu::shared_context()?;
            let info = context.adapter.get_info();
            let backend = format!("{:?} on {}", info.backend, info.name);
            log::info!("viewport on {backend}");
            self.backend = Some(backend);
            let mut renderer = Renderer::new(&context, generation, MAIN_TEXTURE);
            renderer.set_mesh(&self.mesh);
            self.renderer = Some(renderer);
        }
        self.renderer.as_mut()
    }

    /// Returns true when a new renderer was made, so views showing the backend can update.
    fn paint(&mut self, bounds: Bounds<Pixels>, window: &mut Window) -> bool {
        self.bounds = bounds;
        let had_backend = self.backend.clone();
        let scale = window.scale_factor();
        let size = size(
            DevicePixels((bounds.size.width.as_f32() * scale).round() as i32),
            DevicePixels((bounds.size.height.as_f32() * scale).round() as i32),
        );
        let camera = self.camera.clone();
        let Some(renderer) = self.renderer() else { return false };
        let index = renderer.render(&camera, size);
        window.paint_external_texture(bounds, Corners::all(px(10.)), index, size);
        had_backend != self.backend
    }

    fn begin_drag(&mut self, kind: Drag, at: Point<Pixels>) {
        self.drag = Some((kind, at));
    }

    fn drag_to(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some((kind, last)) = self.drag else { return };
        let held = match kind {
            Drag::Orbit => event.pressed_button == Some(MouseButton::Right),
            Drag::Pan => matches!(event.pressed_button, Some(MouseButton::Right | MouseButton::Middle)),
        };
        if !held {
            self.drag = None;
            return;
        }
        let delta = event.position - last;
        let delta = glam::Vec2::new(delta.x.as_f32(), delta.y.as_f32());
        self.drag = Some((kind, event.position));
        match kind {
            Drag::Orbit if !event.modifiers.shift => self.camera.orbit(delta),
            _ => self.camera.pan(delta, self.bounds.size.height.as_f32()),
        }
        cx.notify();
    }

    fn zoom(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let steps = event.delta.pixel_delta(px(20.)).y.as_f32() / 20.0;
        let b = self.bounds;
        let (w, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let local = event.position - b.origin;
        let ndc = glam::Vec2::new(local.x.as_f32() / w * 2.0 - 1.0, 1.0 - local.y.as_f32() / h * 2.0);
        self.camera.zoom_at(steps, ndc, w / h);
        cx.notify();
    }
}

impl Render for Viewport {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        div()
            .id("viewport")
            .size_full()
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, e: &MouseDownEvent, _, _| {
                    let kind = if e.modifiers.shift { Drag::Pan } else { Drag::Orbit };
                    this.begin_drag(kind, e.position);
                }),
            )
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|this, e: &MouseDownEvent, _, _| this.begin_drag(Drag::Pan, e.position)),
            )
            .on_mouse_up(MouseButton::Right, cx.listener(|this, _: &MouseUpEvent, _, _| this.drag = None))
            .on_mouse_up(MouseButton::Middle, cx.listener(|this, _: &MouseUpEvent, _, _| this.drag = None))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| this.drag_to(e, cx)))
            .on_scroll(cx.listener(|this, e: &ScrollEvent, _, cx| this.zoom(e, cx)))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, cx| {
                        entity.update(cx, |this, cx| {
                            if this.paint(bounds, window) {
                                cx.notify();
                            }
                        });
                    },
                )
                .size_full(),
            )
    }
}
