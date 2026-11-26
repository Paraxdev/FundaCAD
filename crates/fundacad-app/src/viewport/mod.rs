mod camera;
mod demo;
mod drag;
pub mod mesh;
mod pick;
mod renderer;
pub mod scene;

use std::path::Path;
use std::sync::Arc;

use fundacad_client::{Doc, Event, Mesh as EngineMesh};
use glam::{Vec2, Vec3};
use gpui::*;

pub use camera::Camera;
use pick::Hit;
use renderer::{Overlay, Renderer};
use scene::Scene;

use crate::engine::{self, Opened, Session};
use crate::plastic::{self, Grip};

/// Index GPUI samples the main 3D view from.
const MAIN_TEXTURE: u32 = gpui_wgpu::EXTERNAL_TEXTURE_BASE;

#[derive(Clone, Copy, PartialEq)]
enum Nav {
    Orbit,
    Pan,
}

/// A face being pushed: its feature's value follows the cursor, the cap is stretched on the GPU between engine meshes.
struct Push {
    grip: Grip,
    body: String,
    axis: Vec3,
    anchor: Vec3,
    grabbed: f32,
    value: f64,
    /// Where the cap sits in the mesh on screen, as an offset along `axis`.
    mesh_plane: f32,
    mask: Vec<f32>,
    mask_body: usize,
    /// The mesh on screen does not show the cap where its value puts it, so nothing is stretched.
    lost: bool,
    /// Each value sent, with the document revision it made.
    sent: Vec<(u64, f64)>,
    /// The revision of the mesh on screen.
    shown: u64,
    released: bool,
}

impl Push {
    fn target_plane(&self) -> f32 {
        self.plane_at(self.value)
    }

    fn plane_at(&self, value: f64) -> f32 {
        self.anchor.dot(self.axis) + self.grip.travel(value)
    }

    /// Released, and the mesh of the last value sent is on screen.
    fn settled(&self) -> bool {
        self.released && self.sent.last().is_none_or(|(r, _)| self.shown >= *r)
    }

    /// The value the mesh of `revision` was built with.
    fn value_at(&self, revision: u64) -> f64 {
        self.sent.iter().rev().find(|(r, _)| *r <= revision).map_or(self.grip.start, |(_, v)| *v)
    }
}

pub struct Viewport {
    camera: Camera,
    scene: Scene,
    radius: f32,
    fitted: bool,
    renderer: Option<Renderer>,
    nav: Option<(Nav, Point<Pixels>)>,
    bounds: Bounds<Pixels>,
    backend: Option<String>,
    session: Option<Session>,
    hover: Option<(Hit, Result<Grip, String>)>,
    push: Option<Push>,
    mask_revision: u64,
    background: [u8; 3],
    message: Option<String>,
    rebuild_ms: Option<f64>,
    _wake: Option<Task<()>>,
    _demo: Option<Task<()>>,
}

impl Viewport {
    /// The colour behind the model, as sRGB bytes, usually the theme's viewport background.
    #[allow(dead_code, reason = "fc2/shell calls it from the theme")]
    pub fn set_background(&mut self, rgb: [u8; 3], cx: &mut Context<Self>) {
        if self.background != rgb {
            self.background = rgb;
            cx.notify();
        }
    }

    pub fn new() -> Self {
        Self {
            camera: Camera::default(),
            scene: Scene::default(),
            radius: 1.0,
            fitted: false,
            renderer: None,
            nav: None,
            bounds: Bounds::default(),
            backend: None,
            session: None,
            hover: None,
            push: None,
            mask_revision: 0,
            background: [23, 26, 31],
            message: None,
            rebuild_ms: None,
            _wake: None,
            _demo: None,
        }
    }

    pub fn open(&mut self, path: &Path, cx: &mut Context<Self>) {
        let (tx, rx) = async_channel::bounded::<()>(1);
        match engine::open(path, move || {
            let _ = tx.try_send(());
        }) {
            Ok(Opened::Stl(body)) => self.show(&[Arc::new(body)]),
            Ok(Opened::Doc(session)) => {
                self.session = Some(session);
                self.message = Some("building".into());
                self._wake = Some(cx.spawn(async move |this, cx| {
                    while rx.recv().await.is_ok() {
                        if this.update(cx, |v, cx| v.drain(cx)).is_err() {
                            break;
                        }
                    }
                }));
                if let Some(travel) = demo::travel() {
                    self._demo = Some(cx.spawn(async move |this, cx| demo::run(this, cx, travel).await));
                }
            }
            Err(e) => {
                log::error!("{e}");
                self.message = Some(e);
            }
        }
        cx.notify();
    }

    /// The open document as the app sees it, edits included before the engine has built them.
    #[allow(dead_code, reason = "fc2/shell reads it for History")]
    pub fn doc(&self) -> Option<&Doc> {
        self.session.as_ref().map(|s| &s.doc)
    }

    /// Edits the open document, for panels beside the view. The revision it made, None when nothing changed.
    #[allow(dead_code, reason = "fc2/shell edits through it")]
    pub fn edit(
        &mut self,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<Option<u64>, String> {
        if self.push.as_ref().is_some_and(|p| !p.released) {
            return Err("a face is being pushed".into());
        }
        let session = self.session.as_mut().ok_or("no document is open")?;
        let edited = session.edit(f)?;
        self.hover = None;
        cx.notify();
        Ok(edited)
    }

    /// One line for the status bar.
    pub fn status(&self) -> String {
        let mut parts = vec![format!("{} triangles", self.scene.triangles())];
        if let Some(b) = &self.backend {
            parts.push(b.clone());
        }
        if let Some(ms) = self.rebuild_ms {
            parts.push(format!("rebuild {ms:.0} ms"));
        }
        match (&self.push, &self.hover) {
            (Some(p), _) => parts.push(format!("{} {:.1} mm", p.grip.label(), p.value)),
            (None, Some((_, Ok(g)))) => parts.push(format!("drag to push {} ({} mm)", g.label(), g.start)),
            (None, Some((_, Err(why)))) => parts.push(why.clone()),
            (None, None) => {}
        }
        if let Some(m) = &self.message {
            parts.push(m.clone());
        }
        parts.join(", ")
    }

    fn show(&mut self, bodies: &[Arc<scene::Body>]) {
        self.scene.set(bodies);
        if let Some((centre, radius)) = self.scene.bounds() {
            self.radius = radius.max(1e-3);
            if !self.fitted {
                self.camera.fit(centre, radius);
                self.fitted = true;
            }
        }
    }

    fn drain(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else { return };
        let events: Vec<Event> = session.events.try_iter().collect();
        let mut latest: Option<Arc<EngineMesh>> = None;
        for event in events {
            match event {
                Event::Mesh(mesh) => latest = Some(mesh),
                Event::Failed { message, .. } => {
                    log::warn!("{message}");
                    self.message = Some(message);
                    if self.push.as_ref().is_some_and(|p| p.released) {
                        self.push = None;
                    }
                }
                Event::WorkerRestarted { cause, .. } => self.message = Some(format!("the engine restarted: {cause}")),
                Event::WorkerStartFailed(e) => self.message = Some(format!("the engine did not start: {e}")),
                Event::Progress { .. } => {}
            }
        }
        if let Some(mesh) = latest {
            log::info!("mesh {mesh}");
            if let Some(errors) =
                mesh.result.get("featureErrors").filter(|e| e.as_array().is_none_or(|a| !a.is_empty()) && !e.is_null())
            {
                log::warn!("feature errors {errors}");
            }
            self.rebuild_ms = Some(mesh.timing.total.as_secs_f64() * 1000.0);
            self.message = None;
            self.hover = None;
            self.show(&mesh.bodies);
            self.retarget(mesh.revision);
        }
        cx.notify();
    }

    /// Finds the pushed cap in the mesh of `revision` and remasks it.
    fn retarget(&mut self, revision: u64) {
        let Some(p) = &mut self.push else { return };
        p.shown = revision;
        if p.settled() {
            self.push = None;
            return;
        }
        let expected = p.plane_at(p.value_at(revision));
        let tol = self.radius * 1e-4;
        let found = self.scene.body_index(&p.body).and_then(|bi| {
            let body = &self.scene.bodies[bi];
            let (plane, mask) = drag::cap(body, &p.grip.feature, p.axis, expected, p.grip.mirror, tol)?;
            Some((bi, plane, mask))
        });
        p.lost = found.is_none();
        if let Some((bi, plane, mask)) = found {
            p.mask_body = bi;
            p.mesh_plane = plane;
            p.mask = mask;
        } else {
            log::info!("the cap of {} does not follow its value, the preview waits for the engine", p.grip.label());
        }
        self.mask_revision += 1;
    }

    fn overlay(&self) -> Overlay {
        let hover = match (&self.push, &self.hover) {
            (Some(_), _) => None,
            (None, Some((hit, grip))) => Some((hit.body, hit.face, grip.is_ok())),
            (None, None) => None,
        };
        let stretch =
            self.push.as_ref().filter(|p| !p.lost).map(|p| (p.mask_body, p.axis * (p.target_plane() - p.mesh_plane)));
        Overlay { hover, stretch, mask_revision: self.mask_revision }
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
            self.renderer = Some(Renderer::new(&context, generation, MAIN_TEXTURE));
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
        let overlay = self.overlay();
        if self.renderer().is_none() {
            return false;
        }
        let mask = self.push.as_ref().filter(|p| !p.lost).map(|p| p.mask.as_slice());
        let renderer = self.renderer.as_mut().expect("made above");
        renderer.set_background(self.background);
        let index = renderer.render(&self.scene, &self.camera, &overlay, mask, size);
        window.paint_external_texture(bounds, Corners::all(px(10.)), index, size);
        had_backend != self.backend
    }

    fn ray_at(&self, position: Point<Pixels>) -> (Vec3, Vec3) {
        let b = self.bounds;
        let (w, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let local = position - b.origin;
        let ndc = Vec2::new(local.x.as_f32() / w * 2.0 - 1.0, 1.0 - local.y.as_f32() / h * 2.0);
        self.camera.ray(ndc, w / h)
    }

    fn hover_at(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let (origin, dir) = self.ray_at(position);
        let hit = pick::pick(&self.scene, origin, dir);
        let same = match (&self.hover, &hit) {
            (Some((a, _)), Some(b)) => a.body == b.body && a.face == b.face,
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.hover = hit.map(|hit| {
            let body = &self.scene.bodies[hit.body];
            let grip = match (&self.session, body.owner(hit.face)) {
                (Some(s), Some(owner)) => plastic::grip(&s.doc, owner, &body.source.id, hit.normal, hit.point),
                (Some(_), None) => Err("this face has no feature behind it".into()),
                (None, _) => Err("open a FundaCAD document to push faces".into()),
            };
            (hit, grip)
        });
        cx.notify();
    }

    fn press(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        self.hover_at(position, cx);
        let Some((hit, Ok(grip))) = self.hover.clone() else { return };
        let (origin, dir) = self.ray_at(position);
        let grabbed = drag::axis_travel(hit.point, hit.normal, origin, dir).unwrap_or(0.0);
        self.begin(hit, grip, grabbed);
        cx.notify();
    }

    fn begin(&mut self, hit: Hit, grip: Grip, grabbed: f32) -> bool {
        let body = &self.scene.bodies[hit.body];
        let axis = hit.normal;
        let found = drag::cap(body, &grip.feature, axis, hit.point.dot(axis), grip.mirror, self.radius * 1e-4);
        let Some((plane, mask)) = found else { return false };
        self.push = Some(Push {
            value: grip.start,
            body: body.source.id.clone(),
            mask,
            mask_body: hit.body,
            mesh_plane: plane,
            lost: false,
            sent: Vec::new(),
            shown: 0,
            grip,
            axis,
            anchor: hit.point,
            grabbed,
            released: false,
        });
        self.mask_revision += 1;
        true
    }

    fn push_to(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let (origin, dir) = self.ray_at(position);
        let Some(p) = &self.push else { return };
        let Some(t) = drag::axis_travel(p.anchor, p.axis, origin, dir) else { return };
        let value = p.grip.value(t - p.grabbed);
        self.set_value(value, cx);
    }

    fn set_value(&mut self, value: f64, cx: &mut Context<Self>) {
        let Some(p) = &mut self.push else { return };
        if value == p.value {
            return;
        }
        p.value = value;
        let grip = p.grip.clone();
        if let Some(session) = &mut self.session {
            match session.edit(move |d| grip.apply(d, value)) {
                Ok(Some(revision)) => p.sent.push((revision, value)),
                Ok(None) => {}
                Err(e) => self.message = Some(e),
            }
        }
        cx.notify();
    }

    fn release(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.push {
            p.released = true;
            if p.settled() {
                self.push = None;
            }
        }
        cx.notify();
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some((kind, last)) = self.nav {
            let held = match kind {
                Nav::Orbit => event.pressed_button == Some(MouseButton::Right),
                Nav::Pan => matches!(event.pressed_button, Some(MouseButton::Right | MouseButton::Middle)),
            };
            if !held {
                self.nav = None;
                return;
            }
            let delta = event.position - last;
            let delta = Vec2::new(delta.x.as_f32(), delta.y.as_f32());
            self.nav = Some((kind, event.position));
            match kind {
                Nav::Orbit if !event.modifiers.shift => self.camera.orbit(delta),
                _ => self.camera.pan(delta, self.bounds.size.height.as_f32()),
            }
            cx.notify();
        } else if self.push.as_ref().is_some_and(|p| !p.released) {
            if event.pressed_button == Some(MouseButton::Left) {
                self.push_to(event.position, cx);
            } else {
                self.release(cx);
            }
        } else if event.pressed_button.is_none() {
            self.hover_at(event.position, cx);
        }
    }

    fn zoom(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let steps = event.delta.pixel_delta(px(20.)).y.as_f32() / 20.0;
        let b = self.bounds;
        let (w, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let local = event.position - b.origin;
        let ndc = Vec2::new(local.x.as_f32() / w * 2.0 - 1.0, 1.0 - local.y.as_f32() / h * 2.0);
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
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e: &MouseDownEvent, _, cx| this.press(e.position, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| this.release(cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, e: &MouseDownEvent, _, _| {
                    let kind = if e.modifiers.shift { Nav::Pan } else { Nav::Orbit };
                    this.nav = Some((kind, e.position));
                }),
            )
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|this, e: &MouseDownEvent, _, _| this.nav = Some((Nav::Pan, e.position))),
            )
            .on_mouse_up(MouseButton::Right, cx.listener(|this, _: &MouseUpEvent, _, _| this.nav = None))
            .on_mouse_up(MouseButton::Middle, cx.listener(|this, _: &MouseUpEvent, _, _| this.nav = None))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| this.mouse_move(e, cx)))
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
