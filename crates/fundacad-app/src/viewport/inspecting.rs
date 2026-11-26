//! What the Inspect family keeps in the view: the open card, Measure's picks, the Section plane, Isolate, the
//! Overhang shading, the centre of mass marker and the engine checks' replies. All of it is a view, not the model,
//! so none of it is an undo step.

use glam::Vec3;
use gpui::*;
use serde_json::{Map, Value};

use super::pick::{self, Hit};
use super::Viewport;
use crate::inspect::measure::{self, Probe};
use crate::inspect::overhang;
use crate::inspect::section::{self, Section};
use crate::selection::Pick;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Card {
    Measure,
    Section,
    Properties,
    Overhang,
    Interference,
    Printability,
    BedFit,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Asked {
    Busy,
    Done(Map<String, Value>),
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shade {
    /// An index into `overhang::DIRECTIONS`.
    pub up: usize,
    pub threshold: f32,
}

impl Default for Shade {
    fn default() -> Self {
        Self { up: 0, threshold: 45.0 }
    }
}

#[derive(Default)]
pub struct Inspecting {
    pub card: Option<Card>,
    pub probes: Vec<Probe>,
    pub section: Option<Section>,
    /// A click picks the face the Section plane lies on.
    pub section_face: bool,
    pub isolate: Option<Vec<String>>,
    pub shade: Shade,
    pub marker: Option<Vec3>,
    pub asked: Option<(Card, Asked)>,
    ticket: u64,
    _task: Option<Task<()>>,
}

impl Inspecting {
    /// Measure's picks and the engine checks' replies point at the mesh before, so a new one drops them, a check
    /// still running included.
    pub fn rebuilt(&mut self) {
        self.probes.clear();
        self.asked = None;
        self.ticket += 1;
    }

    /// A fresh view of a newly opened document, with the cut it was saved with.
    pub fn opened(doc: Option<&Map<String, Value>>) -> Self {
        Self { section: doc.and_then(section::read), ..Self::default() }
    }
}

/// Measure's picks after one more: a third starts over.
pub fn add_probe(probes: &mut Vec<Probe>, p: Probe) {
    if probes.len() >= 2 {
        probes.clear();
    }
    probes.push(p);
}

impl Viewport {
    pub fn inspecting(&self) -> &Inspecting {
        &self.inspect
    }

    pub fn open_card(&mut self, card: Option<Card>, cx: &mut Context<Self>) {
        let i = &mut self.inspect;
        if i.card == card {
            return;
        }
        // As FundaCAD 1's measureTool, Measure starts and ends with nothing selected.
        let measure = i.card == Some(Card::Measure) || card == Some(Card::Measure);
        i.card = card;
        i.probes.clear();
        i.marker = None;
        i.section_face = false;
        if i.asked.as_ref().is_some_and(|(c, _)| Some(*c) != card) {
            i.asked = None;
        }
        if measure {
            self.clear_selection(cx);
        }
        cx.notify();
    }

    pub fn set_shade(&mut self, shade: Shade, cx: &mut Context<Self>) {
        self.inspect.shade = shade;
        cx.notify();
    }

    pub fn set_marker(&mut self, at: Option<Vec3>, cx: &mut Context<Self>) {
        if self.inspect.marker != at {
            self.inspect.marker = at;
            cx.notify();
        }
    }

    pub fn set_section(&mut self, section: Option<Section>, cx: &mut Context<Self>) {
        if self.inspect.section != section {
            // Saved with the document, so Files looks again at whether it differs from the file.
            self.changes += 1;
        }
        self.inspect.section = section;
        self.inspect.section_face = false;
        self.hover = None;
        cx.notify();
    }

    /// The document as a save writes it, with the cut shown now.
    pub fn doc_for_save(&self) -> Option<std::borrow::Cow<'_, Map<String, Value>>> {
        Some(section::for_save(self.doc()?, self.inspect.section.as_ref()))
    }

    pub fn pick_section_face(&mut self, on: bool, cx: &mut Context<Self>) {
        self.inspect.section_face = on;
        cx.notify();
    }

    /// The scene's centre and radius, for cuts through the middle and their steps.
    pub fn extent(&self) -> Option<(Vec3, f32)> {
        self.scene.bounds()
    }

    pub fn set_isolate(&mut self, keep: Option<Vec<String>>, cx: &mut Context<Self>) {
        self.inspect.isolate = keep;
        self.show_built();
        cx.notify();
    }

    pub fn scene_bodies(&self) -> &[super::scene::SceneBody] {
        &self.scene.bodies
    }

    /// The nearest hit along a ray that the Section plane keeps.
    pub(super) fn pick_ray(&self, origin: Vec3, dir: Vec3) -> Option<Hit> {
        match &self.inspect.section {
            Some(s) => pick::pick_kept(&self.scene, origin, dir, |p| s.keeps(p)),
            None => pick::pick(&self.scene, origin, dir),
        }
    }

    pub(super) fn clipped(&self, p: Vec3) -> bool {
        self.inspect.section.as_ref().is_some_and(|s| !s.keeps(p))
    }

    pub(super) fn clip_plane(&self) -> Option<[f32; 4]> {
        self.inspect.section.as_ref().map(Section::plane)
    }

    pub(super) fn shade_uniform(&self) -> Option<[f32; 4]> {
        (self.inspect.card == Some(Card::Overhang)).then(|| {
            let d = overhang::direction(overhang::DIRECTIONS[self.inspect.shade.up.min(5)]);
            [d.x, d.y, d.z, self.inspect.shade.threshold]
        })
    }

    /// Whether a click goes to an Inspect card instead of the selection.
    pub(super) fn inspect_takes_click(&self) -> bool {
        self.inspect.card == Some(Card::Measure) || self.inspect.section_face
    }

    pub(super) fn inspect_click(&mut self, face: Option<Pick>, edge: Option<(usize, usize, Pick)>, cx: &mut Context<Self>) {
        if self.inspect.section_face {
            if let Some(Pick::Face { point, normal, .. }) = face {
                let s = Section::on_face(Vec3::from(point), Vec3::from(normal));
                self.set_section(s, cx);
            }
            return;
        }
        let probe = match (edge, face) {
            (Some((bi, ei, _)), _) => self.picking.lines().get(bi).and_then(|l| l.get(ei)).cloned().and_then(measure::edge_probe),
            (None, Some(Pick::Face { body, face, .. })) => self
                .scene
                .body_index(&body)
                .and_then(|bi| measure::face_probe(measure::face_triangles(&self.scene.bodies[bi], face))),
            _ => None,
        };
        match probe {
            Some(p) => add_probe(&mut self.inspect.probes, p),
            None => self.inspect.probes.clear(),
        }
        cx.notify();
    }

    /// Runs an engine check for `card` off the UI thread, a later one replacing it.
    pub fn ask(&mut self, card: Card, op: &'static str, fields: Map<String, Value>, cx: &mut Context<Self>) {
        let Some(client) = self.session.as_ref().map(|s| s.client.clone()) else {
            self.inspect.asked = Some((card, Asked::Failed("Open a document first".into())));
            return cx.notify();
        };
        self.inspect.ticket += 1;
        let ticket = self.inspect.ticket;
        self.inspect.asked = Some((card, Asked::Busy));
        self.inspect._task = Some(cx.spawn(async move |this, cx| {
            let answer = cx.background_spawn(async move { client.request_built(op, fields) }).await;
            let _ = this.update(cx, |v, cx| {
                if v.inspect.ticket != ticket {
                    return;
                }
                let reply = match answer {
                    Ok(m) => match m.get("error") {
                        Some(e) => Asked::Failed(e.get("message").and_then(Value::as_str).map_or(e.to_string(), str::to_string)),
                        None => Asked::Done(m),
                    },
                    Err(r) => Asked::Failed(r.message),
                };
                v.inspect.asked = Some((card, reply));
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Measure's picks and the line between them, and the centre of mass marker, over the model.
    pub(super) fn paint_inspect(&self, bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
        let project = self.screen();
        let at = |p: Vec3| project(p).map(|s| point(bounds.origin.x + px(s.x), bounds.origin.y + px(s.y)));
        let stroke = |pts: Vec<Point<Pixels>>, width: f32, window: &mut Window| {
            if pts.len() < 2 {
                return;
            }
            let mut path = PathBuilder::stroke(px(width));
            path.move_to(pts[0]);
            for p in &pts[1..] {
                path.line_to(*p);
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        };
        let dot = |c: Point<Pixels>, r: f32, window: &mut Window| {
            let mut path = PathBuilder::fill();
            for k in 0..12 {
                let a = k as f32 / 12.0 * std::f32::consts::TAU;
                let p = point(c.x + px(r * a.cos()), c.y + px(r * a.sin()));
                if k == 0 {
                    path.move_to(p);
                } else {
                    path.line_to(p);
                }
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        };
        let probes = &self.inspect.probes;
        for p in probes {
            if let Probe::Edge { line, .. } = p {
                stroke(line.iter().filter_map(|q| at(*q)).collect(), 3.0, window);
            }
            if let Some(c) = at(p.point()) {
                dot(c, 3.5, window);
            }
        }
        if let [a, b] = probes.as_slice() {
            let near = measure::closest(a, b);
            if let (Some(pa), Some(pb)) = (at(near.pa), at(near.pb)) {
                stroke(vec![pa, pb], 2.0, window);
                dot(pa, 3.0, window);
                dot(pb, 3.0, window);
            }
        }
        if let Some(c) = self.inspect.marker.and_then(at) {
            stroke(vec![point(c.x - px(8.), c.y), point(c.x + px(8.), c.y)], 2.0, window);
            stroke(vec![point(c.x, c.y - px(8.)), point(c.x, c.y + px(8.))], 2.0, window);
            dot(c, 3.0, window);
        }
    }
}

#[cfg(test)]
mod tests;
