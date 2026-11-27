//! The Sketch Palette's switches, FundaCAD 1's stores/sketchPalette.ts. They live outside the editor so they carry from
//! one sketch to the next. Construction is the editor's own, the palette only shows and flips it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Toggle {
    LockView,
    Construction,
    Reference,
    Grid,
    Snap,
    Profile,
    Dimensions,
    Constraints,
}

pub const TOGGLES: [(Toggle, &str); 8] = [
    (Toggle::LockView, "sketchPalette.toggle.lockView"),
    (Toggle::Construction, "sketchPalette.toggle.construction"),
    (Toggle::Reference, "sketchPalette.toggle.reference"),
    (Toggle::Grid, "sketchPalette.toggle.grid"),
    (Toggle::Snap, "sketchPalette.toggle.snap"),
    (Toggle::Profile, "sketchPalette.toggle.profile"),
    (Toggle::Dimensions, "sketchPalette.toggle.dimensions"),
    (Toggle::Constraints, "sketchPalette.toggle.constraints"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub lock_view: bool,
    pub reference: bool,
    pub grid: bool,
    pub snap: bool,
    pub profile: bool,
    pub dimensions: bool,
    pub constraints: bool,
}

impl Default for Palette {
    fn default() -> Self {
        // Lock to Plane is off: entry already squares the view, the lock is for people who want the camera nailed down.
        Self { lock_view: false, reference: false, grid: true, snap: true, profile: true, dimensions: true, constraints: true }
    }
}

impl Palette {
    /// None for Construction, which the editor holds.
    pub fn get(&self, t: Toggle) -> Option<bool> {
        Some(match t {
            Toggle::LockView => self.lock_view,
            Toggle::Construction => return None,
            Toggle::Reference => self.reference,
            Toggle::Grid => self.grid,
            Toggle::Snap => self.snap,
            Toggle::Profile => self.profile,
            Toggle::Dimensions => self.dimensions,
            Toggle::Constraints => self.constraints,
        })
    }

    pub fn set(&mut self, t: Toggle, on: bool) {
        let slot = match t {
            Toggle::LockView => &mut self.lock_view,
            Toggle::Construction => return,
            Toggle::Reference => &mut self.reference,
            Toggle::Grid => &mut self.grid,
            Toggle::Snap => &mut self.snap,
            Toggle::Profile => &mut self.profile,
            Toggle::Dimensions => &mut self.dimensions,
            Toggle::Constraints => &mut self.constraints,
        };
        *slot = on;
    }
}
