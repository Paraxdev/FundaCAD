//! The sketch editor in the view: picking a plane or a flat face, the camera turned to it, the cursor through the
//! tools, the shapes, dimensions and regions drawn over the model, and each finished shape one undo step.

use glam::{DVec2, Vec2, Vec3};
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use serde_json::{json, Value};

use super::{drag, pick, Viewport};
use crate::commands::{self, Group, Mode};
use crate::i18n::{self, tr, Label};
use crate::sketch::{self, Editor, Plane, Tool};

const FREE: u32 = 0x5b9bff;
const DEFINED: u32 = 0xffffff;
const CONFLICT: u32 = 0xff5c5c;
const CONSTRUCTION: u32 = 0xffa64d;
const SNAP: u32 = 0xffaa33;
const AID: u32 = 0x8fa4bd;
const FILL: u32 = 0x3a7bd5;
const PREVIEW: u32 = 0xffffff;
const ACCENT: u32 = 0x9a9ff0;
const OVER: u32 = 0xf5a524;

#[derive(Default)]
pub(super) struct Ui {
    /// Waiting for a click on a plane or a flat face to sketch on.
    picking: bool,
    plane_hover: Option<(Plane, Value)>,
    /// The dimension being typed, its key and the text so far.
    typing: Option<(String, String)>,
    focus: Option<FocusHandle>,
    left_down: bool,
}

fn rgb_a(hex: u32, a: f32) -> Hsla {
    let mut c: Hsla = rgb(hex).into();
    c.a = a;
    c
}

fn fmt(v: f64) -> String {
    let s = format!("{:.2}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl Viewport {
    /// S: the next click on an origin plane or a flat face starts a sketch there.
    pub fn begin_sketch(&mut self, cx: &mut Context<Self>) {
        if self.sketch.is_some() {
            return;
        }
        if self.session.is_none() {
            self.say(i18n::t("sketch.needDocument"), cx);
            return;
        }
        self.sketch_ui.picking = true;
        cx.notify();
    }

    /// Starts a new sketch on `plane`, a named plane or a plane def, and opens it.
    pub fn new_sketch(&mut self, plane: Value, cx: &mut Context<Self>) {
        let made = std::sync::Arc::new(std::sync::Mutex::new(None));
        let out = made.clone();
        let r = self.edit_step(
            None,
            Some(tr!("step.label.add", step = i18n::t("tool.sketch"))),
            move |d| {
                let id = sketch::add_sketch(d, plane.clone())?;
                *out.lock().expect("one writer") = Some(id);
                Ok(())
            },
            cx,
        );
        self.sketch_ui.picking = false;
        let id = made.lock().expect("one writer").clone();
        match (r, id) {
            (Ok(_), Some(id)) => self.edit_sketch(&id, cx),
            (Err(e), _) => self.say(e, cx),
            _ => {}
        }
    }

    /// Opens sketch `id` for editing, the camera square to its plane.
    pub fn edit_sketch(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(editor) = self.session.as_ref().and_then(|s| Editor::open(&s.doc, id)) else {
            self.say(format!("{id} is no sketch"), cx);
            return;
        };
        self.blend_before_step(cx);
        self.look_at_plane(&editor.plane, cx.reduce_motion());
        self.sketch = Some(editor);
        self.sketch_ui.picking = false;
        self.hover = None;
        commands::set_mode(cx, Mode::Sketch);
        cx.notify();
    }

    /// The last sketch in the document, for Edit Sketch until History opens one by double click.
    /// Opens History's double clicked step when it is a sketch, as FC1 did.
    pub fn open_sketch_step(&mut self, id: &str, cx: &mut Context<Self>) {
        let is_sketch = self.session.as_ref().and_then(|s| sketch::feature(&s.doc, id)).is_some_and(|f| f.get("type").and_then(Value::as_str) == Some("sketch"));
        if is_sketch && self.sketch.as_ref().is_none_or(|e| e.feature != id) {
            self.finish_sketch(cx);
            self.edit_sketch(id, cx);
        }
    }

    pub fn edit_last_sketch(&mut self, cx: &mut Context<Self>) {
        let id = self.session.as_ref().and_then(|s| {
            s.doc.get("features")?.as_array()?.iter().rev().find(|f| f["type"] == "sketch")?.get("id")?.as_str().map(String::from)
        });
        match id {
            Some(id) => self.edit_sketch(&id, cx),
            None => self.say("the document has no sketch".into(), cx),
        }
    }

    pub fn finish_sketch(&mut self, cx: &mut Context<Self>) {
        self.sketch = None;
        self.sketch_ui = Ui { focus: self.sketch_ui.focus.take(), ..Default::default() };
        commands::set_mode(cx, Mode::Model);
        cx.notify();
    }

    fn look_at_plane(&mut self, plane: &Plane, reduce: bool) {
        let n = plane.n.as_vec3();
        let mut to = self.camera.clone();
        to.pitch = n.z.asin().clamp(-1.55, 1.55);
        to.yaw = if n.z.abs() > 0.99 { -std::f32::consts::FRAC_PI_2 } else { n.y.atan2(n.x) };
        let centre = self.scene.bounds().map_or(Vec3::ZERO, |(c, _)| c);
        to.target = plane.to_3d(plane.to_2d(centre.as_dvec3())).as_vec3();
        if self.scene.bounds().is_none() {
            to.distance = 200.0;
        }
        self.motion.fly(&mut self.camera, to, reduce);
    }

    fn commit_sketch(&mut self, label: String, cx: &mut Context<Self>) {
        let Some(e) = &self.sketch else { return };
        let (id, es, cs) = (e.feature.clone(), e.entities.clone(), e.constraints.clone());
        let r = self.edit_step(
            None,
            Some(label),
            move |d| sketch::write(d, &id, &es, &cs),
            cx,
        );
        if let Err(e) = r {
            self.say(e, cx);
        }
    }

    pub(super) fn to_screen(&self, w: Vec3) -> Option<Point<Pixels>> {
        let b = self.bounds;
        let (wd, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let clip = self.camera.projection(wd / h) * self.camera.view() * w.extend(1.0);
        if clip.w <= 1e-6 {
            return None;
        }
        let ndc = Vec2::new(clip.x / clip.w, clip.y / clip.w);
        Some(point(b.origin.x + px((ndc.x + 1.0) * 0.5 * wd), b.origin.y + px((1.0 - ndc.y) * 0.5 * h)))
    }

    fn sketch_point(&self, position: Point<Pixels>) -> Option<DVec2> {
        let plane = self.sketch.as_ref()?.plane;
        let (o, d) = self.ray_at(position);
        plane.hit(o, d)
    }

    /// Screen pixels per sketch millimetre near the plane's centre of view.
    fn px_per_mm(&self) -> f64 {
        let Some(e) = &self.sketch else { return 1.0 };
        let c = e.plane.to_2d(self.camera.target.as_dvec3());
        let a = self.to_screen(e.plane.to_3d(c).as_vec3());
        let b = self.to_screen(e.plane.to_3d(c + DVec2::X).as_vec3());
        match (a, b) {
            (Some(a), Some(b)) => (((b.x - a.x).as_f32()).hypot((b.y - a.y).as_f32()) as f64).max(1e-6),
            _ => 1.0,
        }
    }

    fn origin_plane_at(&self, position: Point<Pixels>) -> Option<(Plane, Value)> {
        let (o, d) = self.ray_at(position);
        let size = self.plane_size();
        ["XY", "XZ", "YZ"]
            .into_iter()
            .filter_map(|n| {
                let p = Plane::named(n)?;
                let q = p.hit(o, d)?;
                let t = (p.to_3d(q).as_vec3() - o).length();
                (q.x.abs() <= size && q.y.abs() <= size).then_some((t, p, n))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, p, n)| (p, json!(n)))
    }

    fn plane_size(&self) -> f64 {
        self.scene.bounds().map_or(50.0, |(_, r)| (r as f64 * 0.6).max(10.0))
    }

    fn face_plane_at(&self, position: Point<Pixels>) -> Option<(Plane, Value)> {
        let (o, d) = self.ray_at(position);
        let hit = pick::pick(&self.scene, o, d)?;
        let body = &self.scene.bodies[hit.body];
        if !drag::flat(body, hit.face, hit.normal) {
            return None;
        }
        let plane = Plane::on_face(hit.point, hit.normal);
        let mut spec = plane.spec();
        spec["at"] = json!([hit.point.x, hit.point.y, hit.point.z]);
        // FC1 resolves the face nearest the clicked point, an area centroid can lie off a ring or L shaped face.
        spec["face"] = json!({"kind": "face", "by": "nearest", "point": [hit.point.x, hit.point.y, hit.point.z], "body": body.source.id});
        Some((plane, spec))
    }

    /// Handles a left press while sketching or picking a plane, true when it took it.
    pub(super) fn sketch_press(&mut self, position: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.sketch_ui.picking {
            if let Some((_, spec)) = self.face_plane_at(position).or_else(|| self.origin_plane_at(position)) {
                self.new_sketch(spec, cx);
            }
            return true;
        }
        if self.sketch.is_none() {
            return false;
        }
        self.sketch_ui.left_down = true;
        if let Some(f) = &self.sketch_ui.focus {
            window.focus(f, cx);
        }
        let Some(p) = self.sketch_point(position) else { return true };
        let ppm = self.px_per_mm();
        if let Some(key) = self.dim_at(position) {
            let value = self.sketch.as_ref().and_then(|e| e.dims(0.0).into_iter().find(|d| d.key == key)).map(|d| fmt(d.value));
            self.sketch_ui.typing = Some((key, value.unwrap_or_default()));
            cx.notify();
            return true;
        }
        self.sketch_ui.typing = None;
        let e = self.sketch.as_mut().expect("checked above");
        if e.tool == Tool::Select && e.drag_start(p, crate::sketch::snap::PIXEL_TOL / ppm) {
            cx.notify();
            return true;
        }
        if let Some(label) = e.click(p, ppm) {
            self.commit_sketch(label, cx);
        }
        cx.notify();
        true
    }

    pub(super) fn sketch_release(&mut self, cx: &mut Context<Self>) {
        self.sketch_ui.left_down = false;
        if let Some(label) = self.sketch.as_mut().and_then(Editor::drag_end) {
            self.commit_sketch(label, cx);
        }
        cx.notify();
    }

    /// The cursor while sketching or picking a plane, true when it took it.
    pub(super) fn sketch_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        if self.sketch_ui.picking {
            self.sketch_ui.plane_hover = self.face_plane_at(event.position).or_else(|| self.origin_plane_at(event.position));
            cx.notify();
            return true;
        }
        let Some(p) = self.sketch_point(event.position) else { return self.sketch.is_some() };
        let ppm = self.px_per_mm();
        let snap_grid = self.display.sketch.snap;
        let Some(e) = self.sketch.as_mut() else { return false };
        e.snap_grid = snap_grid;
        if e.drag.is_some() {
            if event.pressed_button == Some(MouseButton::Left) {
                e.drag_to(p);
            } else if let Some(label) = e.drag_end() {
                self.commit_sketch(label, cx);
            }
        } else {
            e.hover(p, ppm);
        }
        cx.notify();
        true
    }

    /// Keeps the editor in step with the document after an undo or a panel edit.
    pub(super) fn sketch_sync(&mut self, cx: &mut Context<Self>) {
        let Some(doc) = self.session.as_ref().map(|s| &s.doc) else { return };
        if self.sketch.as_mut().is_some_and(|e| !e.reload(doc)) {
            self.finish_sketch(cx);
        }
    }

    /// Typing a dimension, digits and Enter.
    pub(super) fn sketch_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let Some((key, text)) = &mut self.sketch_ui.typing else { return };
        match event.keystroke.key.as_str() {
            "enter" => {
                let (key, text) = (key.clone(), text.clone());
                self.sketch_ui.typing = None;
                let angle = key.contains("angle");
                let kind = if angle { crate::inspector::Kind::Angle } else { crate::inspector::Kind::Length };
                let r = crate::inspector::parse(kind, &text).and_then(|v| {
                    self.sketch.as_mut().ok_or_else(|| "no sketch".to_string())?.set_dim(&key, v)
                });
                match r {
                    Ok(label) => self.commit_sketch(label, cx),
                    Err(e) => self.say(e, cx),
                }
            }
            "escape" => self.sketch_ui.typing = None,
            "backspace" => drop(text.pop()),
            _ => {
                if let Some(ch) = event.keystroke.key_char.as_deref().filter(|c| c.chars().all(|c| !c.is_control())) {
                    text.push_str(ch);
                }
            }
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn dim_at(&self, position: Point<Pixels>) -> Option<String> {
        let e = self.sketch.as_ref()?;
        let gap = 14.0 / self.px_per_mm();
        e.dims(gap).into_iter().find_map(|d| {
            let s = self.to_screen(e.plane.to_3d(d.anchor).as_vec3())?;
            ((s.x - position.x).abs() < px(26.) && (s.y - position.y).abs() < px(10.)).then_some(d.key)
        })
    }

    /// The status line part, None while not sketching.
    pub(super) fn sketch_status(&self) -> Option<String> {
        if self.sketch_ui.picking {
            return Some(i18n::t("sketch.pickPlane"));
        }
        let e = self.sketch.as_ref()?;
        let state = if !e.solved.conflicts.is_empty() {
            i18n::t("sketch.relations.conflicting")
        } else if e.solved.dof == 0 {
            i18n::t("sketch.relations.fullyDefined")
        } else {
            tr!("sketch.status.dofLeft", n = e.solved.dof)
        };
        let construction =
            if e.construction { format!(", {}", i18n::t("sketch.name.construction")) } else { String::new() };
        Some(format!("{}: {}, {}{}", e.name, e.tool.label(), state, construction))
    }

    pub(super) fn sketch_escape(&mut self, cx: &mut Context<Self>) -> bool {
        if self.sketch_ui.picking {
            self.sketch_ui = Ui { focus: self.sketch_ui.focus.take(), ..Default::default() };
            cx.notify();
            return true;
        }
        let Some(e) = &mut self.sketch else { return false };
        if self.sketch_ui.typing.take().is_none() && !e.escape() {
            self.finish_sketch(cx);
        }
        cx.notify();
        true
    }

    fn sketch_do(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Editor) -> Option<String>) {
        let Some(e) = &mut self.sketch else { return };
        if let Some(label) = f(e) {
            self.commit_sketch(label, cx);
        }
        cx.notify();
    }

    /// Finishes the sketch and extrudes every closed area of it.
    pub fn sketch_extrude(&mut self, revolve: bool, cx: &mut Context<Self>) {
        let Some(e) = &self.sketch else { return };
        if e.regions().is_empty() {
            self.say(i18n::t("sketch.noArea"), cx);
            return;
        }
        let id = e.feature.clone();
        let fill = e.fill_points();
        let axis = revolve.then(|| {
            let line = e.solved.entities.iter().filter(|x| e.is_construction(x.id())).find_map(|x| x.as_line_seg());
            let (a, b) = line.map_or((DVec2::ZERO, DVec2::Y), |(a, b)| (DVec2::new(a.x, a.y), DVec2::new(b.x, b.y)));
            let (o, d) = (e.plane.to_3d(a), e.plane.to_3d(b) - e.plane.to_3d(a));
            json!({"origin": [o.x, o.y, o.z], "dir": [d.x, d.y, d.z]})
        });
        let label = tr!("step.label.add", step = i18n::t(if revolve { "tool.revolve" } else { "tool.extrude" }));
        self.finish_sketch(cx);
        let r = self.edit_step(
            None,
            Some(label),
            move |d| {
                match &axis {
                    Some(axis) => sketch::add_revolve(d, &id, axis.clone(), &fill),
                    None => sketch::add_extrude(d, &id, 10.0, &fill),
                }
                .map(drop)
            },
            cx,
        );
        if let Err(e) = r {
            self.say(e, cx);
        }
    }

    pub fn sketching(&self) -> bool {
        self.sketch.is_some()
    }

    pub(super) fn sketch_focus(&mut self, cx: &mut Context<Self>) -> FocusHandle {
        self.sketch_ui.focus.get_or_insert_with(|| cx.focus_handle()).clone()
    }

    pub(super) fn sketch_typing(&self) -> bool {
        self.sketch_ui.typing.is_some()
    }

    /// The labels and the toolbar over the view, positioned in the view's own coordinates.
    pub(super) fn sketch_layer(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.sketch_sync(cx);
        let e = self.sketch.as_ref()?;
        let origin = self.bounds.origin;
        let gap = 14.0 / self.px_per_mm();
        let mut layer = div().absolute().top_0().left_0().size_full();
        for d in e.dims(gap).into_iter().filter(|_| self.display.sketch.dimensions) {
            let Some(s) = self.to_screen(e.plane.to_3d(d.anchor).as_vec3()) else { continue };
            let typing = self.sketch_ui.typing.as_ref().filter(|(k, _)| *k == d.key).map(|(_, t)| format!("{t}|"));
            let conflict = d.constraint.is_some_and(|i| e.solved.conflicts.contains(&i));
            let text = typing.clone().unwrap_or_else(|| {
                let v = match () {
                    _ if d.angle => format!("{}°", fmt(d.value)),
                    _ if d.diameter => format!("⌀{}", fmt(d.value)),
                    _ => fmt(d.value),
                };
                match (&d.expr, d.driven) {
                    (Some(x), _) => format!("{x} = {v}"),
                    (None, true) => format!("({v})"),
                    _ => v,
                }
            });
            let over = d.constraint.is_some_and(|i| e.solved.over.contains(&i));
            let color = if conflict { CONFLICT } else if over { OVER } else if typing.is_some() { ACCENT } else { DEFINED };
            layer = layer.child(
                div()
                    .absolute()
                    .left(s.x - origin.x - px(26.))
                    .top(s.y - origin.y - px(9.))
                    .min_w(px(52.))
                    .flex()
                    .justify_center()
                    .px_1()
                    .rounded_sm()
                    .bg(rgb_a(0x15131c, 0.85))
                    .border_1()
                    .border_color(rgb_a(color, if typing.is_some() { 1.0 } else { 0.35 }))
                    .text_size(px(12.))
                    .text_color(rgb(color))
                    .child(text),
            );
        }
        let tools = [
            ("viewControls.select", Tool::Select),
            ("tool.line", Tool::Line),
            ("tool.rectangle", Tool::Rectangle),
            ("tool.circle", Tool::Circle),
            ("tool.arc", Tool::Arc),
            ("tool.polygon", Tool::Polygon),
            ("tool.dimension", Tool::Dimension),
        ];
        let button = |label: &'static str, on: bool| {
            div()
                .id(label)
                .px_2()
                .py_1()
                .rounded_sm()
                .text_size(px(12.))
                .cursor_pointer()
                .text_color(rgb(if on { 0x15131c } else { 0xe8e6f0 }))
                .when(on, |d| d.bg(rgb(ACCENT)))
                .hover(|d| d.bg(rgb_a(ACCENT, 0.35)))
                .child(i18n::t(label))
        };
        let mut bar = div().flex().flex_wrap().justify_center().max_w(px(560.)).gap_1().p_1().rounded_md().bg(rgb_a(0x15131c, 0.9));
        for (label, tool) in tools {
            bar = bar.child(button(label, e.tool == tool).on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.sketch_do(cx, |e| {
                        e.set_tool(tool);
                        None
                    });
                }),
            ));
        }
        let selected = e.selected.as_ref().is_some_and(|s| e.is_construction(s.split('~').next().unwrap_or(s)));
        let actions: [(&'static str, bool, fn(&mut Viewport, &mut Context<Viewport>)); 4] = [
            ("sketchPalette.toggle.construction", e.construction || selected, |v, cx| {
                v.sketch_do(cx, Editor::toggle_construction)
            }),
            ("tool.extrude", false, |v, cx| v.sketch_extrude(false, cx)),
            ("tool.revolve", false, |v, cx| v.sketch_extrude(true, cx)),
            ("sketch.finish", false, |v, cx| v.finish_sketch(cx)),
        ];
        for (label, on, run) in actions {
            bar = bar.child(button(label, on).on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    run(this, cx);
                }),
            ));
        }
        layer = layer.child(div().absolute().top(px(76.)).left_0().right_0().flex().justify_center().child(bar));
        Some(layer.into_any_element())
    }

    /// Draws the sketch, the shape being drawn, the snap and the plane being picked, after the model.
    pub(super) fn paint_sketch(&self, window: &mut Window) {
        let line = |pts: &[DVec2], plane: &Plane, w: f32, color: Hsla, dash: bool, window: &mut Window| {
            let mut b = PathBuilder::stroke(px(w));
            if dash {
                b = b.dash_array(&[px(5.), px(4.)]);
            }
            let mut first = true;
            for q in pts {
                let Some(s) = self.to_screen(plane.to_3d(*q).as_vec3()) else { return };
                if first {
                    b.move_to(s);
                    first = false;
                } else {
                    b.line_to(s);
                }
            }
            if let Ok(p) = b.build() {
                window.paint_path(p, color);
            }
        };
        let fill = |pts: &[DVec2], plane: &Plane, color: Hsla, window: &mut Window| {
            let mut b = PathBuilder::fill();
            for (i, q) in pts.iter().enumerate() {
                let Some(s) = self.to_screen(plane.to_3d(*q).as_vec3()) else { return };
                if i == 0 {
                    b.move_to(s);
                } else {
                    b.line_to(s);
                }
            }
            b.close();
            if let Ok(p) = b.build() {
                window.paint_path(p, color);
            }
        };
        if self.sketch_ui.picking {
            let size = self.plane_size();
            let sq = [DVec2::new(-size, -size), DVec2::new(size, -size), DVec2::new(size, size), DVec2::new(-size, size)];
            for n in ["XY", "XZ", "YZ"] {
                let p = Plane::named(n).expect("a named plane");
                let hot = self.sketch_ui.plane_hover.as_ref().is_some_and(|(h, _)| *h == p);
                fill(&sq, &p, rgb_a(FILL, if hot { 0.35 } else { 0.12 }), window);
                let mut ring = sq.to_vec();
                ring.push(sq[0]);
                line(&ring, &p, 1.0, rgb_a(AID, 0.8), false, window);
            }
            if let Some((p, _)) = self.sketch_ui.plane_hover.as_ref().filter(|(p, _)| p.origin != glam::DVec3::ZERO || Plane::named("XY") != Some(*p)) {
                let s = size * 0.3;
                fill(&[DVec2::new(-s, -s), DVec2::new(s, -s), DVec2::new(s, s), DVec2::new(-s, s)], p, rgb_a(FILL, 0.4), window);
            }
            return;
        }
        let Some(e) = &self.sketch else { return };
        let plane = e.plane;
        for r in e.regions() {
            fill(&r, &plane, rgb_a(FILL, 0.18), window);
        }
        let axis = self.plane_size() * 0.5;
        line(&[DVec2::new(-axis, 0.0), DVec2::new(axis, 0.0)], &plane, 1.0, rgb_a(0xe5484d, 0.5), true, window);
        line(&[DVec2::new(0.0, -axis), DVec2::new(0.0, axis)], &plane, 1.0, rgb_a(0x46a758, 0.5), true, window);
        let conflicted: Vec<String> = e
            .solved
            .conflicts
            .iter()
            .filter_map(|i| e.constraints.get(*i))
            .flat_map(|c| ["line", "circle", "e", "e1", "e2", "l1", "l2"].map(|k| c.get(k).and_then(Value::as_str).map(|s| s.split('~').next().unwrap_or(s).to_string())))
            .flatten()
            .collect();
        let color_of = |id: &str| {
            let sel = e.selected.as_ref().is_some_and(|s| s.split('~').next() == Some(id));
            if sel {
                ACCENT
            } else if conflicted.iter().any(|c| c == id) {
                CONFLICT
            } else if e.is_construction(id) {
                CONSTRUCTION
            } else if e.solved.defined(id) {
                DEFINED
            } else {
                FREE
            }
        };
        for x in &e.solved.entities {
            let id = x.id();
            if let Some(pts) = closed_or_path(x) {
                line(&pts, &plane, 2.0, rgb(color_of(id)).into(), e.is_construction(id), window);
            }
        }
        for (id, mut pts) in e.polygons() {
            pts.push(pts[0]);
            line(&pts, &plane, 2.0, rgb(color_of(&id)).into(), e.is_construction(&id), window);
        }
        for d in e.dims(14.0 / self.px_per_mm()).into_iter().filter(|_| self.display.sketch.dimensions) {
            if !d.angle {
                line(&[d.from, d.to], &plane, 1.0, rgb_a(AID, 0.6), true, window);
            }
        }
        if let Some(pv) = e.preview() {
            if let Some(pts) = preview_points(pv, &e.params) {
                line(&pts, &plane, 1.5, rgb_a(PREVIEW, 0.8), true, window);
            }
        }
        if let Some(s) = &e.cursor {
            for g in &s.guides {
                line(&[*g, s.p], &plane, 1.0, rgb_a(SNAP, 0.6), true, window);
            }
            if s.kind != crate::sketch::snap::Kind::Free && s.kind != crate::sketch::snap::Kind::Grid {
                if let Some(c) = self.to_screen(plane.to_3d(s.p).as_vec3()) {
                    window.paint_quad(outline(Bounds::centered_at(c, size(px(10.), px(10.))), rgb(SNAP), BorderStyle::default()));
                }
            }
        }
    }
}

fn closed_or_path(x: &fundacad_sketch::Entity) -> Option<Vec<DVec2>> {
    crate::sketch::regions::outline(x)
        .map(|mut o| {
            o.push(o[0]);
            o
        })
        .or_else(|| crate::sketch::regions::path(x))
}

fn preview_points(mut pv: Value, params: &std::collections::HashMap<String, f64>) -> Option<Vec<DVec2>> {
    if pv["type"] == "polygon" {
        let n = pv["sides"].as_u64().unwrap_or(6) as usize;
        let (c, r, a) = (DVec2::new(pv["x"].as_f64()?, pv["y"].as_f64()?), pv["radius"].as_f64()?, pv["angle"].as_f64()?);
        let tau = std::f64::consts::TAU;
        return Some((0..=n).map(|k| c + DVec2::from_angle(a.to_radians() + k as f64 / n as f64 * tau) * r).collect());
    }
    pv["id"] = json!("_preview");
    closed_or_path(crate::sketch::solve::resolve(&[pv], params).first()?)
}

/// The sketch commands, in the Sketch group.
pub fn install(viewport: &Entity<Viewport>, cx: &mut App) {
    let on = |id: &'static str, label: Label, f: fn(&mut Viewport, &mut Context<Viewport>), cx: &mut App| {
        let v = viewport.clone();
        commands::register(cx, id, label, Group::Sketch, move |_, cx| v.update(cx, f));
    };
    on("sketch", Label::Key("tool.sketch"), Viewport::begin_sketch, cx);
    on("sketch-xy", Label::With("sketch.command.on", &[("plane", "XY")]), |v, cx| v.new_sketch(json!("XY"), cx), cx);
    on("sketch-xz", Label::With("sketch.command.on", &[("plane", "XZ")]), |v, cx| v.new_sketch(json!("XZ"), cx), cx);
    on("sketch-yz", Label::With("sketch.command.on", &[("plane", "YZ")]), |v, cx| v.new_sketch(json!("YZ"), cx), cx);
    on("edit-sketch", Label::Key("sketch.command.edit"), Viewport::edit_last_sketch, cx);
    on("finish-sketch", Label::Key("command.finish"), Viewport::finish_sketch, cx);
    on("sketch-extrude", Label::Key("sketch.command.finishExtrude"), |v, cx| v.sketch_extrude(false, cx), cx);
    on("sketch-revolve", Label::Key("sketch.command.finishRevolve"), |v, cx| v.sketch_extrude(true, cx), cx);
    let tools = [
        ("line", "tool.line", Tool::Line),
        ("rectangle", "tool.rectangle", Tool::Rectangle),
        ("circle", "tool.circle", Tool::Circle),
        ("arc", "tool.arc", Tool::Arc),
        ("polygon", "tool.polygon", Tool::Polygon),
        ("dimension", "tool.dimension", Tool::Dimension),
    ];
    for (id, label, tool) in tools {
        let v = viewport.clone();
        commands::register(cx, id, Label::Key(label), Group::Sketch, move |_, cx| {
            v.update(cx, |v, cx| {
                if v.sketch.is_none() {
                    v.new_sketch(json!("XY"), cx);
                }
                v.sketch_do(cx, |e| {
                    e.set_tool(tool);
                    None
                });
            })
        });
    }
    on(
        "construction",
        Label::Key("sketchPalette.toggle.construction"),
        |v, cx| v.sketch_do(cx, Editor::toggle_construction),
        cx,
    );
    on("horizontal", Label::Key("tool.horizontal"), |v, cx| v.sketch_do(cx, |e| e.constrain("horizontal")), cx);
    on("vertical", Label::Key("tool.vertical"), |v, cx| v.sketch_do(cx, |e| e.constrain("vertical")), cx);
    let v = viewport.clone();
    commands::register(cx, "escape", Label::Key("common.cancel"), Group::Edit, move |_, cx| {
        v.update(cx, |v, cx| v.carry_cancel(cx) || v.sketch_escape(cx));
    });
    let v = viewport.clone();
    commands::register(cx, "delete", Label::Key("menu.edit.delete"), Group::Edit, move |_, cx| {
        v.update(cx, |v, cx| v.sketch_do(cx, Editor::delete_selected));
    });
}
