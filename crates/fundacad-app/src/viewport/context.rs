//! The right click on the canvas, FundaCAD 1's openCanvasMenu: a right press that never travelled is a click, and the
//! viewport tells the shell what is under it. A right drag stays an orbit or a pan.

#[cfg(test)]
mod tests;

use gpui::*;

use super::Viewport;
use super::inspecting::Card;
use crate::selection::{self, Pick};

/// What a right click landed on, in FundaCAD 1's order: a plane square over the model, then what a left click would
/// select there.
#[derive(Clone, Debug, PartialEq)]
pub enum CanvasTarget {
    /// A world plane (XY, XZ, YZ) or a datum plane's feature id.
    Plane(String),
    Body(String),
    Face(Pick),
    Edge(Pick),
    Empty,
}

#[derive(Clone, Debug)]
pub struct CanvasClick {
    pub at: Point<Pixels>,
    pub target: CanvasTarget,
}

impl EventEmitter<CanvasClick> for Viewport {}

#[derive(Default)]
pub(super) struct RightPress {
    from: Option<Point<Pixels>>,
    moved: bool,
}

impl RightPress {
    pub(super) fn down(&mut self, at: Point<Pixels>) {
        *self = Self { from: Some(at), moved: false };
    }

    /// Once it has travelled it is a drag for good, even when it comes back to where it started.
    pub(super) fn moved(&mut self, at: Point<Pixels>) {
        if self.from.is_some_and(|f| Viewport::dragged(f, at)) {
            self.moved = true;
        }
    }

    /// Where the click was, None when the press dragged or never started here.
    pub(super) fn up(&mut self, at: Point<Pixels>) -> Option<Point<Pixels>> {
        let from = self.from.take()?;
        (!self.moved && !Viewport::dragged(from, at)).then_some(at)
    }
}

/// The target for what a left click would pick, `plane` the plane square in front of the model if any.
pub fn target_of(plane: Option<Pick>, picked: Option<Pick>) -> CanvasTarget {
    match plane.or(picked) {
        Some(Pick::Plane { id }) => CanvasTarget::Plane(id),
        Some(Pick::Body { body }) => CanvasTarget::Body(body),
        Some(p @ Pick::Face { .. }) => CanvasTarget::Face(p),
        Some(p @ Pick::Edge { .. }) => CanvasTarget::Edge(p),
        _ => CanvasTarget::Empty,
    }
}

impl Viewport {
    pub(super) fn right_up(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(at) = self.right.up(at) else { return };
        // FundaCAD 1's toolOwnsScreen: a running tool, a sketch or a drag keeps the right click to itself.
        let busy = self.tool.is_some()
            || self.sketch.is_some()
            || self.sketch_ui.picking
            || self.blend.is_some()
            || self.push.as_ref().is_some_and(|p| !p.released);
        if busy || self.session.is_none() {
            return;
        }
        let target = self.canvas_target(at);
        cx.emit(CanvasClick { at, target });
    }

    fn canvas_target(&self, at: Point<Pixels>) -> CanvasTarget {
        let (face, edge) = self.picks_at(at);
        let picked = selection::resolve(self.picking.filter, &self.picking.selection, face, edge.map(|(_, _, p)| p));
        target_of(self.plane_pick(at), picked)
    }

    /// Whether `pick` is a flat face, the kind a sketch or an offset plane sits on.
    pub fn flat_face(&self, pick: &Pick) -> bool {
        let Pick::Face { body, face, normal, .. } = pick else { return false };
        let Some(b) = self.scene.bodies.iter().find(|b| b.source.id == *body) else { return false };
        super::drag::flat(b, *face, glam::Vec3::from(*normal))
    }

    /// Opens Measure with the face or edge at `at` as its first pick, FundaCAD 1's measure.startWith.
    pub fn measure_from(&mut self, at: Point<Pixels>, edge: bool, cx: &mut Context<Self>) {
        self.open_card(Some(Card::Measure), cx);
        let (face, near) = self.picks_at(at);
        match edge {
            true => self.inspect_click(None, near, cx),
            false => self.inspect_click(face, None, cx),
        }
    }
}
