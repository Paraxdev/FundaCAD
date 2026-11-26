//! Hover and click picking in the view, the selection it keeps and the edges it draws over the model.

use glam::{Vec2, Vec3};
use gpui::*;

use super::edges;
use super::pick;
use super::renderer::Selected;
use super::resolve::resolve;
use super::scene::Scene;
use super::Viewport;
use crate::i18n::tr;
use crate::selection::{self, Filter, Mods, Pick, PickKind, Selection};

/// How far the cursor may be from an edge on screen and still take it, and how far a press travels before it drags.
const EDGE_REACH: f32 = 6.0;
const DRAG_START: f32 = 4.0;

#[derive(Default)]
pub struct Picking {
    pub selection: Selection,
    pub filter: Filter,
    /// The edge under the cursor, by scene body and edge index.
    pub hover_edge: Option<(usize, usize)>,
    /// Where the left button went down, while it has not moved far enough to drag.
    pub pressed: Option<(Point<Pixels>, Mods)>,
    /// Each scene body's edges.
    lines: Vec<Vec<Vec<Vec3>>>,
    pub revision: u64,
}

impl Picking {
    pub fn rescan(&mut self, scene: &Scene) {
        self.lines = scene.bodies.iter().map(|b| edges::polylines(&b.source)).collect();
        self.hover_edge = None;
        let before = self.selection.picks.clone();
        self.selection.retain_bodies(|id| scene.body_index(id).is_some());
        let lines = &self.lines;
        self.selection.picks.retain_mut(|p| match p.selector() {
            Some(s) => resolve(scene, lines, &s).map(|found| *p = found).is_some(),
            None => true,
        });
        if self.selection.picks != before {
            self.revision += 1;
        }
    }

    pub fn lines(&self) -> &[Vec<Vec<Vec3>>] {
        &self.lines
    }

    /// The faces and bodies of `picks` by scene index, for the renderer's tint.
    pub fn tinted<'a>(picks: impl Iterator<Item = &'a Pick>, scene: &Scene) -> Vec<Selected> {
        let mut out: Vec<Selected> = Vec::new();
        for p in picks {
            let Some(i) = p.body().and_then(|b| scene.body_index(b)) else { continue };
            let slot = match out.iter().position(|(b, _)| *b == i) {
                Some(at) => at,
                None => {
                    out.push((i, Some(Vec::new())));
                    out.len() - 1
                }
            };
            match (p, &mut out[slot].1) {
                (Pick::Body { .. }, faces) => *faces = None,
                (Pick::Face { face, .. }, Some(faces)) => faces.push(*face),
                _ => {}
            }
        }
        out.retain(|(_, f)| f.as_ref().is_none_or(|f| !f.is_empty()));
        out
    }
}

pub fn mods(m: &Modifiers) -> Mods {
    Mods { ctrl: m.control || m.platform, shift: m.shift }
}

impl Viewport {
    pub(super) fn tint(&self) -> Vec<Selected> {
        let armed = self.arm_picks();
        Picking::tinted(self.picking.selection.picks.iter().chain(&armed), &self.scene)
    }

    pub fn selection(&self) -> &Selection {
        &self.picking.selection
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.picking.filter = filter;
        self.say(tr!("viewport.filterSaid", filter = filter.label().to_lowercase()), cx);
    }

    pub fn set_selection(&mut self, picks: Vec<Pick>, cx: &mut Context<Self>) {
        if self.picking.selection.picks != picks {
            self.picking.selection.picks = picks;
            self.picking.revision += 1;
            cx.notify();
        }
    }

    pub fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.set_selection(Vec::new(), cx);
    }

    fn screen(&self) -> impl Fn(Vec3) -> Option<Vec2> + '_ {
        let b = self.bounds;
        let (w, h) = (b.size.width.as_f32().max(1.0), b.size.height.as_f32().max(1.0));
        let m = self.camera.projection(w / h) * self.camera.view();
        move |p: Vec3| {
            let c = m * p.extend(1.0);
            (c.w > 1e-6).then(|| Vec2::new((c.x / c.w + 1.0) * 0.5 * w, (1.0 - c.y / c.w) * 0.5 * h))
        }
    }

    /// The face and the edge under `position`, an edge hidden behind the face hit left out.
    pub(super) fn picks_at(&self, position: Point<Pixels>) -> (Option<Pick>, Option<(usize, usize, Pick)>) {
        let (origin, dir) = self.ray_at(position);
        let hit = pick::pick(&self.scene, origin, dir);
        let face = hit.map(|h| {
            let body = self.scene.bodies[h.body].source.id.clone();
            Pick::Face { body, face: h.face, point: h.point.to_array(), normal: h.normal.to_array() }
        });
        let local = position - self.bounds.origin;
        let cursor = Vec2::new(local.x.as_f32(), local.y.as_f32());
        let eye = self.camera.eye();
        let limit = hit.map(|h| h.point.distance(eye) + self.radius * 0.02);
        let project = self.screen();
        let mut best: Option<(usize, edges::Near)> = None;
        for (bi, lines) in self.picking.lines.iter().enumerate() {
            let Some(n) = edges::nearest(lines, &project, cursor, EDGE_REACH) else { continue };
            if limit.is_some_and(|l| n.point.distance(eye) > l) {
                continue;
            }
            if best.as_ref().is_none_or(|(_, b)| n.distance < b.distance) {
                best = Some((bi, n));
            }
        }
        let edge = best.and_then(|(bi, n)| {
            let mid = edges::midpoint(&self.picking.lines[bi][n.edge])?;
            let body = self.scene.bodies[bi].source.id.clone();
            Some((bi, n.edge, Pick::Edge { body, edge: n.edge as u32, mid: mid.to_array() }))
        });
        (face, edge)
    }

    pub(super) fn hover_edge_at(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let took = match self.picking.filter {
            Filter::Bodies => None,
            _ => self.picks_at(position).1.map(|(b, e, _)| (b, e)),
        };
        let took = took.filter(|_| self.arm().is_none_or(|a| a.kind == PickKind::Edge));
        if took != self.picking.hover_edge {
            self.picking.hover_edge = took;
            cx.notify();
        }
    }

    /// A click that did not drag: a target pick while one is armed, else the selection.
    pub(super) fn click(&mut self, position: Point<Pixels>, mods: Mods, cx: &mut Context<Self>) {
        let (face, edge) = self.picks_at(position);
        let edge = edge.map(|(_, _, p)| p);
        if let Some(arm) = self.arm() {
            let body = face.as_ref().or(edge.as_ref()).and_then(|p| p.body()).map(|b| Pick::Body { body: b.into() });
            let pick = match arm.kind {
                PickKind::Edge => edge,
                PickKind::Face => face,
                PickKind::Body => body,
                PickKind::Sketch | PickKind::Plane => None,
            };
            if let Some(pick) = pick {
                self.pick_target(pick, cx);
            }
            return;
        }
        let pick = selection::resolve(self.picking.filter, &self.picking.selection, face, edge);
        let before = self.picking.selection.clone();
        self.picking.selection.click(pick, mods);
        if before != self.picking.selection {
            self.picking.revision += 1;
            cx.notify();
        }
    }

    /// Whether a press at `from` has moved far enough to `to` to be a drag.
    pub(super) fn dragged(from: Point<Pixels>, to: Point<Pixels>) -> bool {
        let d = to - from;
        Vec2::new(d.x.as_f32(), d.y.as_f32()).length() > DRAG_START
    }

    /// Draws the hovered edge and the selected ones over the model.
    pub(super) fn paint_edges(&self, bounds: Bounds<Pixels>, picked: Hsla, hover: Hsla, window: &mut Window) {
        let project = self.screen();
        let mut draw = |bi: usize, ei: usize, color: Hsla, width: f32| {
            let Some(line) = self.picking.lines.get(bi).and_then(|l| l.get(ei)) else { return };
            let pts: Vec<Point<Pixels>> = line
                .iter()
                .filter_map(|p| project(*p))
                .map(|s| point(bounds.origin.x + px(s.x), bounds.origin.y + px(s.y)))
                .collect();
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
        for p in &self.picking.selection.picks {
            let Pick::Edge { body, edge, .. } = p else { continue };
            if let Some(bi) = self.scene.body_index(body) {
                draw(bi, *edge as usize, picked, 3.0);
            }
        }
        for (bi, ei) in self.arm_edges() {
            draw(bi, ei, picked, 3.0);
        }
        if let Some((bi, ei)) = self.picking.hover_edge {
            draw(bi, ei, hover, 2.0);
        }
    }
}
