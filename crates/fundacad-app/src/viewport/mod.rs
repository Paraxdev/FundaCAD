mod blur;
mod camera;
mod datums;
mod demo;
mod drag;
mod edges;
mod gizmo;
pub mod inspecting;
mod issues;
pub mod mesh;
mod pick;
mod profiles;
mod renderer;
mod resolve;
pub mod scene;
mod sketching;
mod select;
mod session;
mod undo;
mod visible;
mod views;

pub use sketching::install as install_sketch;
pub use views::View;

use std::path::Path;
use std::sync::Arc;

use fundacad_client::{Doc, Event, Mesh as EngineMesh};
use glam::{Vec2, Vec3};
use gpui::prelude::FluentBuilder as _;
use gpui::*;

pub use blur::Frost;
pub use camera::Camera;
#[allow(unused_imports, reason = "fc2/shell reads it for History")]
pub use issues::FeatureIssue;
use pick::Hit;
use renderer::{Overlay, Renderer};
use scene::Scene;
use undo::UndoStack;
#[allow(unused_imports, reason = "the shell and the tools read it")]
pub use session::ToolRun;

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
    /// The document before the drag, the undo step it makes.
    before: Doc,
    /// Drags of the same face under the same driver merge into one undo step.
    key: String,
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
    /// Counts every change to the open document, and `opened` every document opened, so watchers skip a redraw.
    changes: u64,
    opened: u64,
    background: [u8; 3],
    frosted: Vec<Frost>,
    issues: Vec<FeatureIssue>,
    undo: UndoStack,
    message: Option<String>,
    /// What the last undo, redo or panel edit said, kept past the rebuild it starts.
    said: Option<String>,
    rebuild_ms: Option<f64>,
    /// The latest mesh's bodies, hidden ones included.
    built: Vec<Arc<scene::Body>>,
    highlight: Option<(String, u32)>,
    sketch: Option<crate::sketch::Editor>,
    sketch_ui: sketching::Ui,
    profiles: profiles::Profiles,
    datums: datums::Datums,
    picking: select::Picking,
    tool: Option<ToolRun>,
    gizmo: gizmo::Gizmo,
    inspect: inspecting::Inspecting,
    _wake: Option<Task<()>>,
    _demo: Option<Task<()>>,
}

impl Viewport {
    /// The colour behind the model, as sRGB bytes, usually the theme's viewport background.
    pub fn set_background(&mut self, rgb: [u8; 3], cx: &mut Context<Self>) {
        if self.background != rgb {
            self.background = rgb;
            cx.notify();
        }
    }

    /// The panels floating over the view, in window space, to blur what is behind them.
    pub fn set_frosted(&mut self, frosted: Vec<Frost>, cx: &mut Context<Self>) {
        if self.frosted != frosted {
            self.frosted = frosted;
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
            changes: 0,
            opened: 0,
            background: [23, 26, 31],
            frosted: Vec::new(),
            issues: Vec::new(),
            undo: UndoStack::default(),
            message: None,
            said: None,
            rebuild_ms: None,
            built: Vec::new(),
            highlight: None,
            sketch: None,
            sketch_ui: Default::default(),
            profiles: Default::default(),
            datums: Default::default(),
            picking: Default::default(),
            tool: None,
            gizmo: Default::default(),
            inspect: Default::default(),
            _wake: None,
            _demo: None,
        }
    }

    /// Shows the file at `path`, or says why it cannot and keeps what was shown.
    pub fn open(&mut self, path: &Path, cx: &mut Context<Self>) -> Result<(), String> {
        self.load(|wake| engine::open(path, wake), cx)
    }

    /// Shows a document that is in no file, such as a new one.
    pub fn open_doc(&mut self, doc: Doc, cx: &mut Context<Self>) -> Result<(), String> {
        self.load(|wake| engine::start(doc, wake).map(Opened::Doc), cx)
    }

    fn load(
        &mut self,
        open: impl FnOnce(Box<dyn Fn() + Send + Sync>) -> Result<Opened, String>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let (tx, rx) = async_channel::bounded::<()>(1);
        let opened = open(Box::new(move || {
            let _ = tx.try_send(());
        }));
        let opened = match opened {
            Ok(opened) => opened,
            Err(e) => {
                log::error!("{e}");
                self.message = Some(e.clone());
                cx.notify();
                return Err(e);
            }
        };
        self.changes += 1;
        self.opened += 1;
        self.issues.clear();
        self.undo = UndoStack::default();
        self.push = None;
        self.hover = None;
        self.tool = None;
        self.picking = Default::default();
        self.message = None;
        self.rebuild_ms = None;
        self.fitted = false;
        self._wake = None;
        self._demo = None;
        self.inspect = inspecting::Inspecting::opened(match &opened {
            Opened::Doc(session) => Some(&session.doc),
            Opened::Stl(_) => None,
        });
        self.show(&[]);
        match opened {
            Opened::Stl(body) => {
                self.session = None;
                self.show(&[Arc::new(body)]);
            }
            Opened::Doc(session) => {
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
        }
        cx.notify();
        Ok(())
    }

    /// The folder the open document's imported geometry is published to, which a save embeds from.
    pub fn blob_dir(&self) -> Option<&Path> {
        self.session.as_ref().map(|s| s.blob_dir.as_path())
    }

    pub fn changes(&self) -> u64 {
        self.changes
    }

    pub fn opened(&self) -> u64 {
        self.opened
    }

    /// The open document as the app sees it, edits included before the engine has built them.
    pub fn doc(&self) -> Option<&Doc> {
        self.session.as_ref().map(|s| &s.doc)
    }

    /// The engine link of the open document, with `path` its file, for requests that run beside the view.
    pub fn session_link(&self, path: Option<&std::path::Path>) -> Option<engine::Link> {
        self.session.as_ref().map(|s| s.link(path))
    }

    /// What the latest rebuild said of each feature it could not build whole, empty when all built.
    #[allow(dead_code, reason = "fc2/shell reads it for History")]
    pub fn feature_issues(&self) -> &[FeatureIssue] {
        &self.issues
    }

    /// Edits the open document, for panels beside the view. The revision it made, None when nothing changed.
    pub fn edit(
        &mut self,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<Option<u64>, String> {
        self.edit_step(None, None, f, cx)
    }

    /// `edit` as an undo step that folds into the last one of the same `key`, worded `label` when a diff would not.
    pub fn edit_step(
        &mut self,
        key: Option<String>,
        label: Option<String>,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<Option<u64>, String> {
        self.said = None;
        if self.push.as_ref().is_some_and(|p| !p.released) {
            return Err("a face is being pushed".into());
        }
        let session = self.session.as_mut().ok_or("no document is open")?;
        let before = session.doc.clone();
        let edited = session.edit(f)?;
        if edited.is_some() {
            self.changes += 1;
            // A running tool's edits are one step, recorded when it finishes.
            if self.tool.is_none() {
                self.undo.record(before, key, label);
            }
            self.settle_tool(cx);
        }
        self.hover = None;
        self.show_built();
        cx.notify();
        Ok(edited)
    }

    /// Puts a line in the status until the next change, for what a panel refused or warned of.
    pub fn say(&mut self, line: String, cx: &mut Context<Self>) {
        self.said = Some(line);
        cx.notify();
    }

    #[allow(dead_code, reason = "fc2/shell greys its undo button with it")]
    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    #[allow(dead_code, reason = "fc2/shell greys its redo button with it")]
    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    /// "Undo Fillet 2" for the undo or redo button's tooltip.
    #[allow(dead_code, reason = "fc2/shell titles its undo and redo buttons with it")]
    pub fn step_text(&self, undo: bool) -> String {
        let label = self.session.as_ref().and_then(|s| self.undo.label(undo, &s.doc));
        crate::timeline::labels::menu_text(undo, label.as_deref())
    }

    /// Steps the document back one change, a run of drags of one face counting as one.
    pub fn undo(&mut self, cx: &mut Context<Self>) {
        self.step(true, cx);
    }

    pub fn redo(&mut self, cx: &mut Context<Self>) {
        self.step(false, cx);
    }

    fn step(&mut self, undo: bool, cx: &mut Context<Self>) {
        if self.push.as_ref().is_some_and(|p| !p.released) {
            return;
        }
        // Undo during a tool cancels it, redo has nothing to bring back yet.
        if self.tool.is_some() {
            if undo {
                self.finish(false, cx);
            }
            return;
        }
        let Some(session) = self.session.as_mut() else { return };
        let label = self.undo.label(undo, &session.doc);
        let taken = if undo { self.undo.undo(session.doc.clone()) } else { self.undo.redo(session.doc.clone()) };
        let Some(doc) = taken else { return };
        self.said = label.map(|l| crate::timeline::labels::stepped(undo, &l));
        if let Err(e) = session.edit(move |d| {
            d.clone_from(&doc);
            Ok(())
        }) {
            self.message = Some(e);
        }
        self.changes += 1;
        self.push = None;
        self.hover = None;
        self.show_built();
        cx.notify();
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
            (None, Some((_, Ok(g)))) if g.adds() && self.tool.is_none() => parts.push("drag to press pull this face".into()),
            (None, Some((_, Ok(g)))) => parts.push(format!("drag to push {} ({} mm)", g.label(), g.start)),
            (None, Some((_, Err(why)))) => parts.push(why.clone()),
            (None, None) => {}
        }
        parts.extend(self.sketch_status());
        if let Some(m) = &self.message {
            parts.push(m.clone());
        }
        if let Some(s) = &self.said {
            parts.push(s.clone());
        }
        if let Some(s) = self.picking.selection.describe().filter(|_| self.tool.is_none()) {
            parts.push(format!("{s} selected"));
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
        self.picking.rescan(&self.scene);
    }

    fn drain(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else { return };
        let events: Vec<Event> = session.events.try_iter().collect();
        let mut latest: Option<Arc<EngineMesh>> = None;
        for event in events {
            match event {
                Event::Mesh(mesh) => {
                    self.issues = issues::of_result(&mesh.result);
                    latest = Some(mesh);
                }
                Event::Failed { message, feature_id, .. } => {
                    log::warn!("{message}");
                    if let Some(id) = &feature_id {
                        issues::failed(&mut self.issues, id, &message);
                    }
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
            for i in &self.issues {
                log::warn!("{}: {}", i.feature_id, i.message);
            }
            self.rebuild_ms = Some(mesh.timing.total.as_secs_f64() * 1000.0);
            self.message = None;
            self.hover = None;
            self.built = mesh.bodies.clone();
            self.datums.mesh = Some(mesh.clone());
            self.inspect.rebuilt();
            self.show_built();
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
        let unbuilt = p.grip.adds() && p.value_at(revision) == 0.0;
        let found = self.scene.body_index(&p.body).and_then(|bi| {
            let body = &self.scene.bodies[bi];
            if unbuilt {
                // The press-pull is not in this mesh, so the face is found again under the point it was picked at.
                let hit = pick::pick(&self.scene, p.anchor + p.axis * tol * 10.0, -p.axis)
                    .filter(|h| h.body == bi && drag::flat(body, h.face, p.axis))?;
                let plane = drag::face_plane(body, hit.face, p.axis)?;
                return Some((bi, plane, drag::face_mask(body, hit.face, p.axis, plane, tol * 0.1)));
            }
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
            (None, None) => self.highlighted(),
        };
        let stretch =
            self.push.as_ref().filter(|p| !p.lost).map(|p| (p.mask_body, p.axis * (p.target_plane() - p.mesh_plane)));
        Overlay {
            hover,
            stretch,
            mask_revision: self.mask_revision,
            selection_revision: self.picking.revision,
            clip: self.clip_plane(),
            shade: self.shade_uniform(),
        }
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
        let tint = self.tint();
        let renderer = self.renderer.as_mut().expect("made above");
        renderer.set_background(self.background);
        let panels = self.frosted.iter().map(|f| blur::Panel::new(f, bounds.origin, scale)).collect();
        renderer.set_frost(panels, scale);
        let index = renderer.render(&self.scene, &self.camera, &overlay, mask, &tint, size);
        window.paint_external_texture(bounds, Corners::all(px(10.)), index, size);
        self.paint_datums(window);
        self.paint_profiles(window);
        self.paint_sketch(window);
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
        let hit = self.pick_ray(origin, dir);
        let same = match (&self.hover, &hit) {
            (Some((a, _)), Some(b)) => a.body == b.body && a.face == b.face,
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.hover = hit.map(|hit| (hit, self.grip_at(&hit)));
        cx.notify();
    }

    fn grip_at(&self, hit: &Hit) -> Result<Grip, String> {
        let Some(s) = &self.session else { return Err("open a FundaCAD document to push faces".into()) };
        let body = &self.scene.bodies[hit.body];
        let flat = drag::flat(body, hit.face, hit.normal);
        plastic::pick(&s.doc, body.owner(hit.face), &body.source.id, hit.normal, hit.point, flat)
    }

    fn press(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        // A running tool's edits are one step, a push would make another the tool's Cancel cannot take back.
        if self.tool.is_some() {
            return;
        }
        // A released drag is still waiting for its mesh, a grip read off the old mesh would push a stale face.
        if self.push.is_some() {
            return;
        }
        self.hover = None;
        self.hover_at(position, cx);
        let Some((hit, Ok(grip))) = self.hover.clone() else {
            self.undo.close();
            return;
        };
        let (origin, dir) = self.ray_at(position);
        let grabbed = drag::axis_travel(hit.point, hit.normal, origin, dir).unwrap_or(0.0);
        self.begin(hit, grip, grabbed);
        cx.notify();
    }

    fn begin(&mut self, hit: Hit, grip: Grip, grabbed: f32) -> bool {
        let body = &self.scene.bodies[hit.body];
        let axis = hit.normal;
        let tol = self.radius * 1e-4;
        let found = match grip.adds() {
            true => drag::face_plane(body, hit.face, axis)
                .map(|plane| (plane, drag::face_mask(body, hit.face, axis, plane, tol * 0.1))),
            false => drag::cap(body, &grip.feature, axis, hit.point.dot(axis), grip.mirror, tol),
        };
        let Some((plane, mask)) = found else { return false };
        let Some(before) = self.session.as_ref().map(|s| s.doc.clone()) else { return false };
        // Adding 0.0 turns -0.0 into 0.0, so a face hit from the other side keys the same.
        let r = |v: f32| (v * 100.0).round() / 100.0 + 0.0;
        let key = format!("{} {} {} {}", grip.label(), r(axis.x), r(axis.y), r(axis.z));
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
            before,
            key,
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
                Ok(Some(revision)) => {
                    p.sent.push((revision, value));
                    self.changes += 1;
                }
                Ok(None) => {}
                Err(e) => self.message = Some(e),
            }
        }
        cx.notify();
    }

    fn release(&mut self, cx: &mut Context<Self>) {
        if let Some((at, mods)) = self.picking.pressed.take() {
            self.click(at, mods, cx);
        }
        if let Some(p) = self.push.as_mut().filter(|p| !p.released) {
            p.released = true;
            if self.session.as_ref().is_some_and(|s| s.doc != p.before) {
                self.undo.record(p.before.clone(), Some(p.key.clone()), None);
            }
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
        } else if let Some((at, _)) = self.picking.pressed.filter(|_| event.pressed_button == Some(MouseButton::Left)) {
            if Self::dragged(at, event.position) {
                self.picking.pressed = None;
                self.press(at, cx);
                self.push_to(event.position, cx);
            }
        } else if self.push.as_ref().is_some_and(|p| !p.released) {
            if event.pressed_button == Some(MouseButton::Left) {
                self.push_to(event.position, cx);
            } else {
                self.release(cx);
            }
        } else if event.pressed_button.is_none() {
            self.picking.pressed = None;
            self.hover_at(event.position, cx);
            self.hover_edge_at(event.position, cx);
            self.hover_area_at(event.position, cx);
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
        let focus = self.sketch_focus(cx);
        let layer = self.sketch_layer(cx);
        div()
            .id("viewport")
            .size_full()
            .track_focus(&focus)
            .when(self.sketch_typing(), |d| d.key_context("Input"))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| this.sketch_key(e, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, w, cx| {
                    if !this.sketch_press(e.position, w, cx) && !this.gizmo_press(e.position, cx) {
                        this.picking.pressed = Some((e.position, select::mods(&e.modifiers)));
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    this.sketch_release(cx);
                    this.gizmo_release(cx);
                    this.release(cx)
                }),
            )
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
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                if this.nav.is_some() || !(this.sketch_move(e, cx) || this.gizmo_move(e, cx)) {
                    this.mouse_move(e, cx)
                }
            }))
            .on_scroll(cx.listener(|this, e: &ScrollEvent, _, cx| this.zoom(e, cx)))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, cx| {
                        let t = crate::theme::ActiveTheme::theme(cx);
                        let (picked, hover) = (Hsla::from(t.accent), Hsla::from(t.accent_hot));
                        let axes = [t.axis_x, t.axis_y, t.axis_z].map(Hsla::from);
                        entity.update(cx, |this, cx| {
                            if this.paint(bounds, window) {
                                cx.notify();
                            }
                            this.paint_edges(bounds, picked, hover, window);
                            this.paint_gizmo(axes, hover, window);
                            this.paint_inspect(bounds, hover, window);
                        });
                    },
                )
                .size_full(),
            )
            .children(layer)
    }
}
