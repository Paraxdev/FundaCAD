//! How the bodies draw for a frame, read off the Display settings: FundaCAD 1's Matcap view mode, its x-ray and its
//! wireframe (bodyFinish.ts), packed for the shader. Path traced is not built yet and draws as Realtime.

#[cfg(test)]
mod tests;

use super::display::{Display, Matcap, ViewMode};

/// bodyFinish.ts XRAY_OPACITY.
pub const XRAY_OPACITY: f32 = 0.35;

/// viewport.ts EDGE_WIRE, the wire colour as sRGB: dark idle edges would vanish with no faces behind them.
pub const EDGE_WIRE: u32 = 0xc4ced9;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Shading {
    #[default]
    Lit,
    Matcap { style: Matcap, tint: bool },
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Faces {
    #[default]
    Solid,
    /// Blended at this opacity, writing no depth.
    SeeThrough(f32),
    /// Drawn as nothing but the hover and selection on them, so only the edges show, hidden ones included.
    Hidden,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Look {
    pub shading: Shading,
    pub faces: Faces,
}

impl Look {
    pub fn of(d: &Display) -> Self {
        let shading = match d.view_mode {
            ViewMode::Matcap => Shading::Matcap { style: d.matcap, tint: d.matcap_tint },
            ViewMode::Realtime | ViewMode::Pathtraced => Shading::Lit,
        };
        // Wireframe turns colour writes off over whatever opacity x-ray left, so it wins.
        let faces = if d.wireframe {
            Faces::Hidden
        } else if d.xray {
            Faces::SeeThrough(XRAY_OPACITY)
        } else {
            Faces::Solid
        };
        Self { shading, faces }
    }

    /// Whether the faces blend over what is behind them instead of hiding it.
    pub fn blended(self) -> bool {
        self.faces != Faces::Solid
    }

    /// Whether the body edges draw as wire lines.
    pub fn wire(self) -> bool {
        self.faces == Faces::Hidden
    }

    /// The shader's `look`: x 1 for matcap, y the matcap style, z 1 to tint it with the body colour, w the face opacity.
    pub fn uniform(self) -> [f32; 4] {
        let alpha = match self.faces {
            Faces::Solid => 1.0,
            Faces::SeeThrough(a) => a,
            Faces::Hidden => 0.0,
        };
        match self.shading {
            Shading::Lit => [0.0, 0.0, 0.0, alpha],
            Shading::Matcap { style, tint } => {
                let at = Matcap::ALL.iter().position(|m| *m == style).unwrap_or(0);
                [1.0, at as f32, f32::from(u8::from(tint)), alpha]
            }
        }
    }
}

/// An sRGB colour as linear RGBA.
pub fn linear(rgb: u32, alpha: f32) -> [f32; 4] {
    let c = |shift: u32| {
        let v = ((rgb >> shift) & 0xff) as f32 / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    [c(16), c(8), c(0), alpha]
}
