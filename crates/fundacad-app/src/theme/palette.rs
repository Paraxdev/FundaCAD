//! The colour half of the theme: the palette tokens of src/styles/_tokens.scss and the shipped palettes of
//! src/ui/theme.ts. A palette that leaves a token out falls back to Noir, as the CSS falls back to :root.

use super::color::Rgb;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Mode {
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub bg: Rgb,
    pub panel: Rgb,
    pub panel_2: Rgb,
    pub raised: Rgb,
    pub raised_2: Rgb,
    pub viewport_bg: Rgb,
    pub line: Rgb,
    pub line_strong: Rgb,
    pub text: Rgb,
    pub text_dim: Rgb,
    pub text_mute: Rgb,
    /// Derived from text_mute and panel unless set.
    pub text_faint: Option<Rgb>,
    /// Derived from text per mode unless set.
    pub control_edge: Option<Rgb>,
    pub accent: Rgb,
    pub accent_hot: Rgb,
    pub accent_tint: Rgb,
    pub accent_tint_2: Rgb,
    pub on_accent: Rgb,
    pub ok: Rgb,
    pub warn: Rgb,
    pub error: Rgb,
    pub error_tint: Rgb,
    pub pick_line: Rgb,
    pub axis_x: Rgb,
    pub axis_y: Rgb,
    pub axis_z: Rgb,
    pub sketch_free: Rgb,
    pub sketch_defined: Rgb,
    pub sketch_construction: Rgb,
    pub sketch_projected: Rgb,
    pub sketch_projected_stale: Rgb,
    pub sketch_loose_open: Rgb,
    pub sketch_loose_untied: Rgb,
    pub sketch_aid: Rgb,
    pub sketch_snap: Rgb,
    pub sketch_preview: Rgb,
    pub sketch_fill: Rgb,
}

const fn h(v: u32) -> Rgb {
    Rgb::hex(v)
}

const fn a(r: u8, g: u8, b: u8, alpha: f32) -> Rgb {
    Rgb::rgba(r, g, b, alpha)
}

pub const NOIR: Palette = Palette {
    bg: h(0x050409),
    panel: h(0x1b1826),
    panel_2: h(0x272233),
    raised: h(0x322c42),
    raised_2: h(0x3d3651),
    viewport_bg: h(0x0b0912),
    line: h(0x322c42),
    line_strong: h(0x847c9a),
    text: h(0xf6f0e4),
    text_dim: h(0xc4bcd0),
    text_mute: h(0xa9a2ba),
    text_faint: None,
    control_edge: None,
    accent: h(0x9a9ff0),
    accent_hot: h(0xbcc0f7),
    accent_tint: a(154, 159, 240, 0.14),
    accent_tint_2: a(154, 159, 240, 0.24),
    on_accent: h(0x0c0d26),
    ok: h(0x17c99a),
    warn: h(0xffab2e),
    error: h(0xff5c5c),
    error_tint: a(255, 92, 92, 0.14),
    pick_line: h(0xb48cff),
    axis_x: h(0xff5a5a),
    axis_y: h(0x46d97a),
    axis_z: h(0x4d8dff),
    sketch_free: h(0x5b9bff),
    sketch_defined: h(0xffffff),
    sketch_construction: h(0xffa64d),
    sketch_projected: h(0xb07fe8),
    sketch_projected_stale: h(0xd9a24d),
    sketch_loose_open: h(0xe5484d),
    sketch_loose_untied: h(0xf5a524),
    sketch_aid: h(0x8fa4bd),
    sketch_snap: h(0xffaa33),
    sketch_preview: h(0xffffff),
    sketch_fill: h(0x3a7bd5),
};

/// Noir's shell with another accent, its tints at the same alphas.
const fn noir_tint(accent: u32, accent_hot: u32, on_accent: u32) -> Palette {
    let (r, g, b) = ((accent >> 16) as u8, (accent >> 8) as u8, accent as u8);
    Palette {
        accent: h(accent),
        accent_hot: h(accent_hot),
        accent_tint: a(r, g, b, 0.14),
        accent_tint_2: a(r, g, b, 0.24),
        on_accent: h(on_accent),
        ..NOIR
    }
}

/// Sketch colours on paper, shared by Light and Solarized Light.
const PAPER_SKETCH: Palette = Palette {
    sketch_free: h(0x1f62c9),
    sketch_defined: h(0x1d1b26),
    sketch_construction: h(0xa85500),
    sketch_projected: h(0x7b3fc4),
    sketch_projected_stale: h(0x7a5a00),
    sketch_loose_open: h(0xc62828),
    sketch_loose_untied: h(0x8a5a00),
    sketch_aid: h(0x5a6b82),
    sketch_snap: h(0x9a4d00),
    sketch_preview: h(0x1d1b26),
    sketch_fill: h(0x1f62c9),
    ..NOIR
};

pub const LIGHT: Palette = Palette {
    bg: h(0xf5f3f9),
    panel: h(0xebe8f2),
    panel_2: h(0xe0dcea),
    raised: h(0xffffff),
    raised_2: h(0xf2f0f7),
    viewport_bg: h(0xe8e5ef),
    line: h(0xd0cadd),
    line_strong: h(0x7a7390),
    text: h(0x1b1826),
    text_dim: h(0x3d3651),
    text_mute: h(0x585170),
    accent: h(0x4a4fb5),
    accent_hot: h(0x30348a),
    accent_tint: a(74, 79, 181, 0.14),
    accent_tint_2: a(74, 79, 181, 0.24),
    on_accent: h(0xffffff),
    ok: h(0x0a6b55),
    warn: h(0x80560a),
    error: h(0x841714),
    error_tint: a(132, 23, 20, 0.12),
    pick_line: h(0x7b3fe0),
    axis_x: h(0xc4302b),
    axis_y: h(0x23803d),
    axis_z: h(0x2b5fd0),
    ..PAPER_SKETCH
};

const HIGH_CONTRAST_DARK: Palette = Palette {
    bg: h(0x000000),
    panel: h(0x0a0a0a),
    panel_2: h(0x161616),
    raised: h(0x202020),
    raised_2: h(0x2a2a2a),
    viewport_bg: h(0x000000),
    line: h(0x5c5c5c),
    line_strong: h(0xa6a6a6),
    text: h(0xffffff),
    text_dim: h(0xebebeb),
    text_mute: h(0xd4d4d4),
    control_edge: Some(h(0xc2c2c2)),
    accent: h(0x5cd6ff),
    accent_hot: h(0xa8ebff),
    accent_tint: a(92, 214, 255, 0.16),
    accent_tint_2: a(92, 214, 255, 0.28),
    on_accent: h(0x000000),
    ok: h(0x38d985),
    warn: h(0xffe066),
    error: h(0xff6a6a),
    error_tint: a(255, 106, 106, 0.18),
    pick_line: h(0xff7ae0),
    axis_x: h(0xff6b6b),
    axis_y: h(0x5ef08f),
    axis_z: h(0x6ba6ff),
    ..NOIR
};

const HIGH_CONTRAST_LIGHT: Palette = Palette {
    bg: h(0xffffff),
    panel: h(0xf4f4f4),
    panel_2: h(0xe9e9e9),
    raised: h(0xffffff),
    raised_2: h(0xf0f0f0),
    viewport_bg: h(0xe0e0e0),
    line: h(0x8c8c8c),
    line_strong: h(0x4a4a4a),
    text: h(0x000000),
    text_dim: h(0x1a1a1a),
    text_mute: h(0x333333),
    control_edge: Some(h(0x333333)),
    accent: h(0x0b3fb8),
    accent_hot: h(0x082d85),
    accent_tint: a(11, 63, 184, 0.12),
    accent_tint_2: a(11, 63, 184, 0.22),
    on_accent: h(0xffffff),
    ok: h(0x00664f),
    warn: h(0x7a5500),
    error: h(0x7a000e),
    error_tint: a(122, 0, 14, 0.1),
    pick_line: h(0xa3007d),
    axis_x: h(0xc41a1a),
    axis_y: h(0x1d7a2e),
    axis_z: h(0x1f4fd6),
    sketch_free: h(0x0b4fb0),
    sketch_defined: h(0x000000),
    sketch_construction: h(0x7f3f00),
    sketch_projected: h(0x5f2aa3),
    sketch_projected_stale: h(0x5e4500),
    sketch_loose_open: h(0xa8151b),
    sketch_loose_untied: h(0x6b4600),
    sketch_aid: h(0x455468),
    sketch_snap: h(0x6b3400),
    sketch_preview: h(0x000000),
    sketch_fill: h(0x0b4fb0),
    ..NOIR
};

const DRACULA: Palette = Palette {
    bg: h(0x282a36),
    panel: h(0x2b2d3a),
    panel_2: h(0x343746),
    raised: h(0x3d4052),
    raised_2: h(0x454858),
    viewport_bg: h(0x1e1f29),
    line: h(0x44475a),
    line_strong: h(0x808db5),
    text: h(0xf8f8f2),
    text_dim: h(0xd6d4da),
    text_mute: h(0xb5bac7),
    accent: h(0xbd93f9),
    accent_hot: h(0xd6acff),
    accent_tint: a(189, 147, 249, 0.14),
    accent_tint_2: a(189, 147, 249, 0.24),
    on_accent: h(0x1b0f2e),
    ok: h(0x50fa7b),
    warn: h(0xf6b168),
    error: h(0xff7676),
    error_tint: a(255, 85, 85, 0.14),
    pick_line: h(0xff79c6),
    ..NOIR
};

const SOLARIZED_LIGHT: Palette = Palette {
    bg: h(0xfdf6e3),
    panel: h(0xeee8d5),
    panel_2: h(0xe3ddc7),
    raised: h(0xffffff),
    raised_2: h(0xf5efdc),
    viewport_bg: h(0xeee8d5),
    line: h(0xd6cfb4),
    line_strong: h(0x657b83),
    text: h(0x073642),
    text_dim: h(0x3a4f55),
    text_mute: h(0x4d6165),
    accent: h(0x25669b),
    accent_hot: h(0x173f5f),
    accent_tint: a(37, 102, 155, 0.14),
    accent_tint_2: a(37, 102, 155, 0.24),
    on_accent: h(0xfdf6e3),
    ok: h(0x1c6b65),
    warn: h(0x7a5d00),
    error: h(0x8a1f1d),
    error_tint: a(220, 50, 47, 0.14),
    pick_line: h(0xd33682),
    axis_x: h(0xdc322f),
    axis_y: h(0x738400),
    axis_z: h(0x2381c4),
    ..PAPER_SKETCH
};

// Simulation checked so no two signal colours collapse under protanopia, deuteranopia or tritanopia, see theme.ts.
const COLORBLIND_SAFE: Palette = Palette {
    bg: h(0x0e1116),
    panel: h(0x161b22),
    panel_2: h(0x1c232c),
    raised: h(0x232c37),
    raised_2: h(0x2b3542),
    viewport_bg: h(0x0b0e13),
    line: h(0x2b3542),
    line_strong: h(0x687887),
    text: h(0xf5f7fa),
    text_dim: h(0xb5c0cc),
    text_mute: h(0x97a2ae),
    accent: h(0x9b6cff),
    accent_hot: h(0xb89aff),
    accent_tint: a(155, 108, 255, 0.14),
    accent_tint_2: a(155, 108, 255, 0.24),
    on_accent: h(0x0d0a1f),
    ok: h(0x2ec4b6),
    warn: h(0xf4c542),
    error: h(0xff5c5c),
    error_tint: a(255, 92, 92, 0.16),
    pick_line: h(0xff8fc8),
    axis_x: h(0xe5483a),
    axis_y: h(0xeedf6b),
    axis_z: h(0x6aaef0),
    sketch_free: h(0x3d8fe0),
    sketch_defined: h(0xf5f7fa),
    sketch_construction: h(0xe69f00),
    sketch_projected: h(0xf0e442),
    sketch_projected_stale: h(0x98a3b0),
    sketch_loose_open: h(0xff5c5c),
    sketch_loose_untied: h(0xf4c542),
    sketch_aid: h(0xa6b4c4),
    sketch_snap: h(0xe69f00),
    sketch_preview: h(0xf5f7fa),
    sketch_fill: h(0x3d8fe0),
    ..NOIR
};

#[allow(dead_code)]
pub struct Shipped {
    pub id: &'static str,
    /// The i18n key of the name, as in src/i18n.
    pub label_key: &'static str,
    pub label: &'static str,
    pub mode: Mode,
    pub palette: Palette,
}

pub const NOIR_ID: &str = "fundacad";
pub const LIGHT_ID: &str = "fundacad-light";
pub const HIGH_CONTRAST_DARK_ID: &str = "high-contrast-dark";
pub const HIGH_CONTRAST_LIGHT_ID: &str = "high-contrast-light";

pub const SHIPPED: &[Shipped] = &[
    Shipped {
        id: NOIR_ID,
        label_key: "prefs.theme.name.noir",
        label: "FundaCAD Noir",
        mode: Mode::Dark,
        palette: NOIR,
    },
    Shipped {
        id: LIGHT_ID,
        label_key: "prefs.theme.name.light",
        label: "FundaCAD Light",
        mode: Mode::Light,
        palette: LIGHT,
    },
    Shipped {
        id: HIGH_CONTRAST_DARK_ID,
        label_key: "prefs.theme.name.highContrastDark",
        label: "High Contrast Dark",
        mode: Mode::Dark,
        palette: HIGH_CONTRAST_DARK,
    },
    Shipped {
        id: HIGH_CONTRAST_LIGHT_ID,
        label_key: "prefs.theme.name.highContrastLight",
        label: "High Contrast Light",
        mode: Mode::Light,
        palette: HIGH_CONTRAST_LIGHT,
    },
    Shipped {
        id: "dracula",
        label_key: "prefs.theme.name.dracula",
        label: "Dracula",
        mode: Mode::Dark,
        palette: DRACULA,
    },
    Shipped {
        id: "solarized-light",
        label_key: "prefs.theme.name.solarizedLight",
        label: "Solarized Light",
        mode: Mode::Light,
        palette: SOLARIZED_LIGHT,
    },
    Shipped {
        id: "colorblind-safe",
        label_key: "prefs.theme.name.colourBlindSafe",
        label: "Colour-Blind Safe",
        mode: Mode::Dark,
        palette: COLORBLIND_SAFE,
    },
    Shipped {
        id: "noir-blue",
        label_key: "prefs.theme.name.noirBlue",
        label: "Noir Blue",
        mode: Mode::Dark,
        palette: noir_tint(0x3fa9f5, 0x7ecbff, 0x001522),
    },
    Shipped {
        id: "noir-red",
        label_key: "prefs.theme.name.noirRed",
        label: "Noir Red",
        mode: Mode::Dark,
        palette: noir_tint(0xff4d6d, 0xff8098, 0x2a0008),
    },
    Shipped {
        id: "noir-orange",
        label_key: "prefs.theme.name.noirOrange",
        label: "Noir Orange",
        mode: Mode::Dark,
        palette: noir_tint(0xff8a3d, 0xffb374, 0x2b1200),
    },
];

pub fn shipped(id: &str) -> Option<&'static Shipped> {
    SHIPPED.iter().find(|s| s.id == id)
}

impl Palette {
    /// Sets one token by its CSS name, as an uploaded palette file names it. False for a name that is not a palette
    /// token (the retired `--accent-glow`, the legacy `--accent-blue`) or a value that is not a colour.
    #[allow(dead_code)]
    pub fn set_css(&mut self, name: &str, value: &str) -> bool {
        let Some(c) = Rgb::parse(value) else { return false };
        let slot = match name.trim().to_ascii_lowercase().as_str() {
            "--bg" => &mut self.bg,
            "--panel" => &mut self.panel,
            "--panel-2" => &mut self.panel_2,
            "--raised" => &mut self.raised,
            "--raised-2" => &mut self.raised_2,
            "--viewport-bg" => &mut self.viewport_bg,
            "--line" => &mut self.line,
            "--line-strong" => &mut self.line_strong,
            "--text" => &mut self.text,
            "--text-dim" => &mut self.text_dim,
            "--text-mute" => &mut self.text_mute,
            "--text-faint" => {
                self.text_faint = Some(c);
                return true;
            }
            "--control-edge" => {
                self.control_edge = Some(c);
                return true;
            }
            "--accent" => &mut self.accent,
            "--accent-hot" => &mut self.accent_hot,
            "--accent-tint" => &mut self.accent_tint,
            "--accent-tint-2" => &mut self.accent_tint_2,
            "--on-accent" => &mut self.on_accent,
            "--ok" => &mut self.ok,
            "--warn" => &mut self.warn,
            "--error" => &mut self.error,
            "--error-tint" => &mut self.error_tint,
            "--pick-line" => &mut self.pick_line,
            "--axis-x" => &mut self.axis_x,
            "--axis-y" => &mut self.axis_y,
            "--axis-z" => &mut self.axis_z,
            "--sketch-free" => &mut self.sketch_free,
            "--sketch-defined" => &mut self.sketch_defined,
            "--sketch-construction" => &mut self.sketch_construction,
            "--sketch-projected" => &mut self.sketch_projected,
            "--sketch-projected-stale" => &mut self.sketch_projected_stale,
            "--sketch-loose-open" => &mut self.sketch_loose_open,
            "--sketch-loose-untied" => &mut self.sketch_loose_untied,
            "--sketch-aid" => &mut self.sketch_aid,
            "--sketch-snap" => &mut self.sketch_snap,
            "--sketch-preview" => &mut self.sketch_preview,
            "--sketch-fill" => &mut self.sketch_fill,
            _ => return false,
        };
        *slot = c;
        true
    }

    /// Noir with the tokens a palette file sets, and how many it set.
    #[allow(dead_code)]
    pub fn from_css<'a>(tokens: impl IntoIterator<Item = (&'a str, &'a str)>) -> (Palette, usize) {
        let mut p = NOIR;
        let n = tokens.into_iter().filter(|(k, v)| p.set_css(k, v)).count();
        (p, n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        for (i, s) in SHIPPED.iter().enumerate() {
            assert!(SHIPPED[i + 1..].iter().all(|o| o.id != s.id), "{}", s.id);
        }
    }

    #[test]
    fn noir_tints_keep_the_shell() {
        let blue = shipped("noir-blue").unwrap().palette;
        assert_eq!(blue.panel, NOIR.panel);
        assert_eq!(blue.accent, Rgb::hex(0x3fa9f5));
        assert_eq!(blue.accent_tint, Rgb::rgba(0x3f, 0xa9, 0xf5, 0.14));
    }

    #[test]
    fn a_file_overrides_only_what_it_names() {
        let (p, n) = Palette::from_css([
            ("--bg", "#141414"),
            ("--ACCENT", " #f0982d "),
            ("--accent-glow", "#fff"),
            ("--panel", "nope"),
        ]);
        assert_eq!(n, 2);
        assert_eq!(p.bg, Rgb::hex(0x141414));
        assert_eq!(p.accent, Rgb::hex(0xf0982d));
        assert_eq!(p.panel, NOIR.panel);
    }
}
