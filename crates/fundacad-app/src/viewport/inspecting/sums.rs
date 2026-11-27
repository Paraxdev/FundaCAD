//! Properties' and Overhang's sums, kept until the bodies or the settings they read change, since a card asks on
//! every frame and each sum walks every triangle.

use std::cell::RefCell;
use std::sync::Arc;

use glam::Vec3;

use crate::inspect::props::{self, Props};
use crate::inspect::{isolate, overhang};
use crate::viewport::scene::Body;
use crate::viewport::Viewport;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct Properties {
    /// The names of the picked bodies, empty for all of them.
    pub picked: Vec<String>,
    pub faults: Vec<String>,
    pub found: Option<Props>,
}

impl Properties {
    pub fn centre_of_mass(&self) -> Option<Vec3> {
        self.found.filter(|_| self.faults.is_empty()).map(|p| p.com.as_vec3())
    }
}

type Ptrs = Vec<usize>;

#[derive(Default)]
pub struct Memo {
    properties: RefCell<Option<(Ptrs, Vec<String>, Properties)>>,
    overhang: RefCell<Option<((Ptrs, usize, u32), [f64; 3])>>,
}

fn ptrs<'a>(bodies: impl IntoIterator<Item = &'a Arc<Body>>) -> Ptrs {
    bodies.into_iter().map(|b| Arc::as_ptr(b) as usize).collect()
}

/// Properties of the `picked` bodies among `shown`, or of every shown body when none is picked.
pub fn properties(shown: &[Arc<Body>], picked: &[String]) -> Properties {
    let bodies: Vec<Arc<Body>> = shown.iter().filter(|b| picked.is_empty() || picked.contains(&b.id)).cloned().collect();
    let names = bodies.iter().filter(|b| picked.contains(&b.id)).map(|b| b.name.clone()).collect();
    let faults =
        bodies.iter().filter_map(|b| props::fault(b).map(|f| format!("{} is not a sound solid, {f}", b.name))).collect();
    let found = props::of(bodies.iter().map(|b| &**b));
    Properties { picked: names, faults, found }
}

impl Viewport {
    pub fn properties(&self) -> Properties {
        let shown = self.shown_bodies();
        let picked = isolate::unique(self.selection().picks.iter().filter_map(|p| p.body().map(str::to_string)));
        let key = ptrs(&shown);
        let mut memo = self.inspect.memo.properties.borrow_mut();
        if let Some((k, p, out)) = memo.as_ref() {
            if *k == key && *p == picked {
                return out.clone();
            }
        }
        let out = properties(&shown, &picked);
        *memo = Some((key, picked, out.clone()));
        out
    }

    /// Overhang's areas of the drawn bodies under the current shading.
    pub fn overhang_areas(&self) -> [f64; 3] {
        let shade = self.inspect.shade;
        let key = (ptrs(self.scene.bodies.iter().map(|b| &b.source)), shade.up, shade.threshold.to_bits());
        let mut memo = self.inspect.memo.overhang.borrow_mut();
        if let Some((k, areas)) = memo.as_ref() {
            if *k == key {
                return *areas;
            }
        }
        let areas = overhang::areas(&self.scene.bodies, overhang::direction(overhang::DIRECTIONS[shade.up]), shade.threshold);
        *memo = Some((key, areas));
        areas
    }
}
