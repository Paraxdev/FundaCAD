//! How selected each face shows, kept by body and face rather than by vertex, so a fade carries across a rebuild that
//! remakes the vertex buffers and a new selection starts from what is on screen.

use std::collections::HashMap;

use super::super::renderer::Selected;

/// Per body a level for its faces at large, and the faces that differ from it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Levels {
    bodies: HashMap<usize, (f32, HashMap<u32, f32>)>,
}

impl Levels {
    pub fn of(selected: &[Selected]) -> Self {
        let bodies = selected
            .iter()
            .map(|(b, faces)| match faces {
                None => (*b, (1.0, HashMap::new())),
                Some(faces) => (*b, (0.0, faces.iter().map(|f| (*f, 1.0)).collect())),
            })
            .collect();
        Self { bodies }
    }

    pub fn at(&self, body: usize, face: u32) -> f32 {
        self.bodies.get(&body).map_or(0.0, |(all, faces)| faces.get(&face).copied().unwrap_or(*all))
    }

    /// What shows `p` of the way from `self` to `to`.
    pub fn blend(&self, to: &Levels, p: f32) -> Levels {
        let p = p.clamp(0.0, 1.0);
        let lerp = |a: f32, b: f32| a + (b - a) * p;
        let mut bodies = HashMap::new();
        for &b in self.bodies.keys().chain(to.bodies.keys()) {
            if bodies.contains_key(&b) {
                continue;
            }
            let all = |l: &Levels| l.bodies.get(&b).map_or(0.0, |(a, _)| *a);
            let mut faces = HashMap::new();
            for l in [self, to] {
                for &f in l.bodies.get(&b).into_iter().flat_map(|(_, fs)| fs.keys()) {
                    faces.insert(f, lerp(self.at(b, f), to.at(b, f)));
                }
            }
            bodies.insert(b, (lerp(all(self), all(to)), faces));
        }
        Levels { bodies }
    }
}

/// The selection fade the renderer draws: per vertex `from` and `to`, mixed by the view's eased ramp.
#[derive(Clone, Debug, Default)]
pub struct Blend {
    pub from: Levels,
    pub to: Levels,
}

impl Blend {
    /// A new selection, eased from what showed at `shown` of the last one. `snap` lands at once, for a first draw or a
    /// rebuild that is not mid fade, where face ids may have moved.
    pub fn retarget(&mut self, selected: &[Selected], shown: f32, snap: bool) {
        let to = Levels::of(selected);
        self.from = if snap { to.clone() } else { self.from.blend(&self.to, shown) };
        self.to = to;
    }

    pub fn pair(&self, body: usize, face: u32) -> [f32; 2] {
        [self.from.at(body, face), self.to.at(body, face)]
    }
}

#[cfg(test)]
mod tests;
