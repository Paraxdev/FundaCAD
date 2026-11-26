//! The shape half of src/styles/_tokens.scss, the same in every palette. The items allowed as dead code wait for the
//! shell panels that adopt them.

use std::time::Duration;

use gpui::{px, FontWeight, Pixels};

pub const UI_FONT: &str = "Space Grotesk";
#[allow(dead_code)]
pub const MONO_FONT: &str = "JetBrains Mono";

/// Type scale. No text goes under FS_MICRO, error text uses FS_SMALL or larger.
#[allow(dead_code)]
pub const FS_MICRO: f32 = 11.;
pub const FS_SMALL: f32 = 12.;
pub const FS_BODY: f32 = 13.;
#[allow(dead_code)]
pub const FS_TITLE: f32 = 15.;
#[allow(dead_code)]
pub const FS_DISPLAY: f32 = 18.;

#[allow(dead_code)]
pub const W_REGULAR: FontWeight = FontWeight::NORMAL;
#[allow(dead_code)]
pub const W_MEDIUM: FontWeight = FontWeight::MEDIUM;
/// The app ships Space Grotesk 400, 500 and 700 only, so a CSS 600 resolves to the 700 face.
#[allow(dead_code)]
pub const W_SEMIBOLD: FontWeight = FontWeight::BOLD;
#[allow(dead_code)]
pub const W_BOLD: FontWeight = FontWeight::BOLD;

/// `line-height: normal` as Chrome lays it out: the font's ascent and descent, each rounded to a whole pixel.
pub fn line_normal(fs: f32) -> Pixels {
    px((0.984 * fs).round() + (0.292 * fs).round())
}

#[allow(dead_code)]
pub fn line_normal_mono(fs: f32) -> Pixels {
    px((1.02 * fs).round() + (0.3 * fs).round())
}

#[allow(dead_code)]
pub const R_XS: f32 = 2.;
#[allow(dead_code)]
pub const R_SM: f32 = 3.;
#[allow(dead_code)]
pub const R_MD: f32 = 4.;
#[allow(dead_code)]
pub const R_LG: f32 = 5.;
#[allow(dead_code)]
pub const R_PILL: f32 = 999.;

#[allow(dead_code)]
pub const S_0: f32 = 2.;
#[allow(dead_code)]
pub const S_1: f32 = 4.;
pub const S_2: f32 = 8.;
pub const S_3: f32 = 12.;
#[allow(dead_code)]
pub const S_4: f32 = 16.;
#[allow(dead_code)]
pub const S_5: f32 = 20.;
#[allow(dead_code)]
pub const S_6: f32 = 28.;
#[allow(dead_code)]
pub const S_7: f32 = 36.;

/// The squircle values of --float-radius and friends, as the fork's GPUI draws squircle corners.
#[allow(dead_code)]
pub const FLOAT_RADIUS: f32 = 26.;
#[allow(dead_code)]
pub const FLOAT_TILE_RADIUS: f32 = 17.;
#[allow(dead_code)]
pub const FLOAT_CHIP_RADIUS: f32 = 12.;
#[allow(dead_code)]
pub const FLOAT_GAP: f32 = 12.;
#[allow(dead_code)]
pub const RAIL_TILE: f32 = 40.;

/// The smallest hit area of a control (WCAG 2.5.8), and with Settings, Accessibility, Larger click targets.
pub const HIT_MIN: f32 = 24.;
pub const HIT_MIN_LARGE: f32 = 32.;

#[allow(dead_code)]
pub const T_FAST: Duration = Duration::from_millis(110);
#[allow(dead_code)]
pub const T_MED: Duration = Duration::from_millis(160);

/// `backdrop-filter: blur(r) saturate(s)`, for the viewport pass that blurs what lies under a panel.
#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(dead_code)]
pub struct BackdropBlur {
    /// The CSS blur radius, which is the Gaussian's standard deviation.
    pub radius: f32,
    pub saturate: f32,
}

/// --float-blur, behind every floating panel and dialog.
#[allow(dead_code)]
pub const FLOAT_BLUR: BackdropBlur = BackdropBlur { radius: 24., saturate: 1.08 };
/// Behind a dialog's scrim.
#[allow(dead_code)]
pub const SCRIM_BLUR: BackdropBlur = BackdropBlur { radius: 6., saturate: 1.05 };

/// --ease, `cubic-bezier(0.2, 0, 0.15, 1)`, for `with_animation`.
#[allow(dead_code)]
pub fn ease(t: f32) -> f32 {
    cubic_bezier(0.2, 0., 0.15, 1.)(t)
}

/// CSS `cubic-bezier(x1, y1, x2, y2)` as an easing function of 0 to 1.
#[allow(dead_code)]
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 {
    let curve = |a: f32, b: f32, s: f32| {
        let u = 1. - s;
        3. * u * u * s * a + 3. * u * s * s * b + s * s * s
    };
    let slope = |a: f32, b: f32, s: f32| {
        let u = 1. - s;
        3. * u * u * a + 6. * u * s * (b - a) + 3. * s * s * (1. - b)
    };
    move |t: f32| {
        let t = t.clamp(0., 1.);
        if t == 0. || t == 1. {
            return t;
        }
        let mut s = t;
        for _ in 0..8 {
            let d = slope(x1, x2, s);
            if d.abs() < 1e-6 {
                break;
            }
            s = (s - (curve(x1, x2, s) - t) / d).clamp(0., 1.);
        }
        // Newton can stall on a flat stretch, bisection finishes the job.
        if (curve(x1, x2, s) - t).abs() > 1e-4 {
            let (mut lo, mut hi) = (0f32, 1f32);
            for _ in 0..30 {
                s = (lo + hi) / 2.;
                if curve(x1, x2, s) < t {
                    lo = s;
                } else {
                    hi = s;
                }
            }
        }
        curve(y1, y2, s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_heights_match_chrome() {
        // 13, 15 and 18 measured off the Vue page, 11 and 12 from Chrome's rounding of ascent and descent apart.
        for (fs, lh) in [(11., 14.), (12., 16.), (13., 17.), (15., 19.), (18., 23.)] {
            assert_eq!(line_normal(fs), px(lh), "{fs}");
        }
    }

    #[test]
    fn bezier_matches_known_points() {
        let linear = cubic_bezier(0., 0., 1., 1.);
        for t in [0.1, 0.5, 0.9] {
            assert!((linear(t) - t).abs() < 1e-3);
        }
        // CSS `ease` at 0.5 is 0.8024.
        let e = cubic_bezier(0.25, 0.1, 0.25, 1.);
        assert!((e(0.5) - 0.8024).abs() < 1e-3);
        assert_eq!(ease(0.), 0.);
        assert_eq!(ease(1.), 1.);
        assert!(ease(0.5) > 0.5);
    }
}
