//! How the view draws, as set from the view controls column: shading, projection, overlays, X-ray, wireframe and
//! the sketch switches. Kept in the settings store under FundaCAD 1's names, X-ray and wireframe only for the run.

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::f32::consts::FRAC_PI_2;
use std::cell::Cell;

use gpui::Context;
use serde::{Deserialize, Serialize};

use super::camera::{Camera, PITCH_LIMIT};
use super::Viewport;
use crate::selection::Filter;
use crate::sketch::palette::Palette;
use crate::settings;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Matcap,
    #[default]
    Realtime,
    Pathtraced,
}

impl ViewMode {
    pub const ALL: [ViewMode; 3] = [ViewMode::Matcap, ViewMode::Realtime, ViewMode::Pathtraced];

    pub fn label(self) -> &'static str {
        match self {
            ViewMode::Matcap => "Matcap",
            ViewMode::Realtime => "Realtime",
            ViewMode::Pathtraced => "Path traced",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            ViewMode::Matcap => "view-matcap",
            ViewMode::Realtime => "view-realtime",
            ViewMode::Pathtraced => "view-pathtraced",
        }
    }

    /// The next mode round the list, the one before it when `back`.
    pub fn step(self, back: bool) -> ViewMode {
        let at = Self::ALL.iter().position(|m| *m == self).unwrap_or(1);
        let n = Self::ALL.len();
        Self::ALL[if back { (at + n - 1) % n } else { (at + 1) % n }]
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Matcap {
    #[default]
    Studio,
    Clay,
    Metal,
    Wax,
}

impl Matcap {
    pub const ALL: [Matcap; 4] = [Matcap::Studio, Matcap::Clay, Matcap::Metal, Matcap::Wax];

    pub fn label(self) -> &'static str {
        match self {
            Matcap::Studio => "studio",
            Matcap::Clay => "clay",
            Matcap::Metal => "metal",
            Matcap::Wax => "wax",
        }
    }

    /// The swatch's lit and shadowed colour, standing in for FundaCAD 1's rendered sphere.
    pub fn swatch(self) -> (u32, u32) {
        match self {
            Matcap::Studio => (0xe8ecf2, 0x5b6573),
            Matcap::Clay => (0xe9c9a8, 0x8a5a3c),
            Matcap::Metal => (0xf4f6f8, 0x3a3f46),
            Matcap::Wax => (0xf3e6c4, 0xa07c4a),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Persp,
    Ortho,
    #[default]
    Auto,
}

impl Projection {
    pub const ALL: [Projection; 3] = [Projection::Persp, Projection::Ortho, Projection::Auto];

    pub fn label(self) -> &'static str {
        match self {
            Projection::Persp => "Perspective",
            Projection::Ortho => "Orthographic",
            Projection::Auto => "Automatic",
        }
    }

    pub fn hint(self) -> Option<&'static str> {
        (self == Projection::Auto).then_some("orthographic when looking straight on")
    }

    /// Whether `cam` draws orthographic under this mode.
    pub fn ortho_for(self, cam: &Camera) -> bool {
        match self {
            Projection::Persp => false,
            Projection::Ortho => true,
            Projection::Auto => straight_on(cam),
        }
    }
}

/// Looking along an axis: a standard view, or orbited onto the top or bottom stop.
pub fn straight_on(cam: &Camera) -> bool {
    const E: f32 = 1e-3;
    if cam.pitch.abs() >= PITCH_LIMIT - E {
        return true;
    }
    let q = cam.yaw.rem_euclid(FRAC_PI_2);
    cam.pitch.abs() < E && (q < E || q > FRAC_PI_2 - E)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayKind {
    Edges,
    Highlight,
    Grid,
    Origin,
    Sketches,
    SketchLabels,
    Handles,
    Stress,
    Section,
    References,
}

impl OverlayKind {
    pub const ALL: [OverlayKind; 10] = [
        OverlayKind::Edges,
        OverlayKind::Highlight,
        OverlayKind::Grid,
        OverlayKind::Origin,
        OverlayKind::Sketches,
        OverlayKind::SketchLabels,
        OverlayKind::Handles,
        OverlayKind::Stress,
        OverlayKind::Section,
        OverlayKind::References,
    ];

    /// FundaCAD 1's OVERLAY_KINDS name, the key it is saved under.
    pub fn id(self) -> &'static str {
        match self {
            OverlayKind::Edges => "edges",
            OverlayKind::Highlight => "highlight",
            OverlayKind::Grid => "grid",
            OverlayKind::Origin => "origin",
            OverlayKind::Sketches => "sketches",
            OverlayKind::SketchLabels => "sketchLabels",
            OverlayKind::Handles => "handles",
            OverlayKind::Stress => "stress",
            OverlayKind::Section => "section",
            OverlayKind::References => "references",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OverlayKind::Edges => "Edge outlines",
            OverlayKind::Highlight => "Selection and hover",
            OverlayKind::Grid => "Grid",
            OverlayKind::Origin => "Origin and planes",
            OverlayKind::Sketches => "Sketches",
            OverlayKind::SketchLabels => "Sketch dimensions",
            OverlayKind::Handles => "Gizmos and handles",
            OverlayKind::Stress => "Stress glyphs",
            OverlayKind::Section => "Section plane",
            OverlayKind::References => "Reference images",
        }
    }
}

/// FundaCAD 1's OverlayState: the master switch leaves `kinds` as they were, which Clean view turns back on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Overlays {
    pub on: bool,
    #[serde(default)]
    pub kinds: BTreeMap<String, bool>,
}

impl Default for Overlays {
    fn default() -> Self {
        Self { on: true, kinds: BTreeMap::new() }
    }
}

impl Overlays {
    /// The kind's own switch, whatever the master says.
    pub fn kind(&self, k: OverlayKind) -> bool {
        self.kinds.get(k.id()).copied().unwrap_or(true)
    }

    pub fn set(&mut self, k: OverlayKind, on: bool) {
        self.kinds.insert(k.id().to_string(), on);
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Display {
    pub view_mode: ViewMode,
    pub matcap: Matcap,
    pub matcap_tint: bool,
    pub overlays: Overlays,
    pub xray: bool,
    pub wireframe: bool,
    pub projection: Projection,
    /// The Sketch Palette's switches, which the Snapping popover shows too.
    pub sketch: Palette,
}

const VIEW_MODE_KEY: &str = "viewMode";
const MATCAP_KEY: &str = "matcapStyle";
const TINT_KEY: &str = "matcapTint";
const OVERLAYS_KEY: &str = "overlaysModel";
const PROJECTION_KEY: &str = "projection";
const SKETCH_KEY: &str = "sketchPalette";

impl Display {
    pub fn load() -> Self {
        Self {
            view_mode: settings::read(VIEW_MODE_KEY).unwrap_or_default(),
            matcap: settings::read(MATCAP_KEY).unwrap_or_default(),
            matcap_tint: settings::read(TINT_KEY).unwrap_or(true),
            overlays: settings::read(OVERLAYS_KEY).unwrap_or_default(),
            xray: false,
            wireframe: false,
            projection: settings::read(PROJECTION_KEY).unwrap_or_default(),
            sketch: settings::read(SKETCH_KEY).unwrap_or_default(),
        }
    }

    pub fn save(&self) {
        settings::write(VIEW_MODE_KEY, &self.view_mode);
        settings::write(MATCAP_KEY, &self.matcap);
        settings::write(TINT_KEY, &self.matcap_tint);
        settings::write(OVERLAYS_KEY, &self.overlays);
        settings::write(PROJECTION_KEY, &self.projection);
        settings::write(SKETCH_KEY, &self.sketch);
    }

    /// Whether an overlay draws: its own switch under the master one.
    pub fn shows(&self, k: OverlayKind) -> bool {
        self.overlays.on && self.overlays.kind(k)
    }
}

// Note: motion.rs builds a Camera field by field and must not change here, so the mode the camera's projection
// reads lives beside it instead of on it, per thread so tests running side by side keep their own.
thread_local! {
    static PROJECTION: Cell<Projection> = const { Cell::new(Projection::Persp) };
    static SKETCH_FLAT: Cell<bool> = const { Cell::new(false) };
}

/// The mode the camera draws with: the one picked, orthographic while a sketch is open, as FundaCAD 1's setSketchFlat.
pub(super) fn projection() -> Projection {
    if SKETCH_FLAT.get() {
        Projection::Ortho
    } else {
        PROJECTION.get()
    }
}

fn publish(p: Projection) {
    PROJECTION.set(p);
}

pub(super) fn set_sketch_flat(on: bool) {
    SKETCH_FLAT.set(on);
}

impl Viewport {
    pub(super) fn load_display() -> Display {
        let d = Display::load();
        publish(d.projection);
        d
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn set_display(&mut self, d: Display, cx: &mut Context<Self>) {
        if d == self.display {
            return;
        }
        d.save();
        publish(d.projection);
        self.display = d;
        self.apply_sketch_switches();
        cx.notify();
    }

    pub fn filter(&self) -> Filter {
        self.picking.filter
    }

    /// One square of the ground grid at the orbit target in millimetres, as FundaCAD 1's readout shows it.
    pub fn grid_step_mm(&self) -> f64 {
        super::ground::cell(self.camera.per_pixel(self.bounds.size.height.as_f32())) as f64
    }
}
