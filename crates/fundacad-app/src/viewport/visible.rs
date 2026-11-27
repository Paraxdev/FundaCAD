//! Hidden bodies stay out of the scene. The engine builds every body whatever the eyes say, so the view filters the
//! latest mesh by the document's `bodyVisibility`, again right after an edit so a hide does not wait for the rebuild.

use std::sync::Arc;

use fundacad_client::Doc;

use super::scene::Body;
use super::Viewport;

pub fn shown(doc: Option<&Doc>, bodies: &[Arc<Body>]) -> Vec<Arc<Body>> {
    let hidden = |id: &str| {
        doc.and_then(|d| d.get("bodyVisibility")).and_then(|m| m.get(id)).and_then(|v| v.as_bool()) == Some(false)
    };
    bodies.iter().filter(|b| !hidden(&b.id)).cloned().collect()
}

impl Viewport {
    /// Every body the latest rebuild made, hidden ones included.
    pub fn bodies(&self) -> &[Arc<Body>] {
        &self.built
    }

    pub fn shown_bodies(&self) -> Vec<Arc<Body>> {
        shown(self.doc(), &self.built)
    }

    pub(super) fn show_built(&mut self) {
        let mut bodies = shown(self.doc(), &self.built);
        super::placing::hold_landing(&mut bodies, self.carry.landing.as_ref());
        if bodies.len() != self.scene.bodies.len()
            || bodies.iter().zip(&self.scene.bodies).any(|(a, b)| !Arc::ptr_eq(a, &b.source))
        {
            self.hover = None;
            self.show(&bodies);
        }
    }

    /// A face the Geometry list points at, drawn like the hover, by body id and the body's own face index.
    pub fn set_highlight(&mut self, face: Option<(String, u32)>, cx: &mut gpui::Context<Self>) {
        if self.highlight != face {
            self.highlight = face;
            cx.notify();
        }
    }

    /// Drops the highlight only while it is still `face`, so leaving one row after entering the next keeps the new one.
    pub fn clear_highlight(&mut self, face: &(String, u32), cx: &mut gpui::Context<Self>) {
        if self.highlight.as_ref() == Some(face) {
            self.set_highlight(None, cx);
        }
    }

    pub(super) fn highlighted(&self) -> Option<(usize, u32, bool)> {
        let (id, face) = self.highlight.as_ref()?;
        Some((self.scene.body_index(id)?, *face, true))
    }
}

#[cfg(test)]
mod tests;
