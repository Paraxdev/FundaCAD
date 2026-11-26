//! The Funda theme: src/styles/_tokens.scss, _contrast.scss and src/ui/theme.ts in Rust.
//!
//! `init` once at startup, then read `cx.theme()` in render. A change goes through `update`, which resolves the
//! theme again and redraws every window, so dark and light switch live. While the choice is System, a root view
//! keeps the `follow_system` subscription so an OS switch comes through too.

pub mod color;
pub mod fonts;
pub mod palette;
pub mod tokens;

use std::{ops::Deref, time::Duration};

use gpui::{point, px, App, BoxShadow, Global, SharedString, Subscription, Window, WindowAppearance};

pub use color::Rgb;
pub use palette::{Mode, Palette};
pub use tokens::*;

pub const SYSTEM_ID: &str = "system";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Contrast {
    #[default]
    Standard,
    More,
    Maximum,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// A shipped or uploaded palette id, or SYSTEM_ID.
    pub choice: String,
    pub contrast: Contrast,
    pub motion: bool,
    pub large_targets: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { choice: SYSTEM_ID.into(), contrast: Contrast::Standard, motion: true, large_targets: false }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct OsAppearance {
    pub dark: bool,
    /// An OS high contrast mode. GPUI does not report it, the app sets it where the platform tells.
    pub contrast: bool,
}

impl OsAppearance {
    fn from_window(a: WindowAppearance, contrast: bool) -> Self {
        Self { dark: matches!(a, WindowAppearance::Dark | WindowAppearance::VibrantDark), contrast }
    }

    /// The shipped palette System stands for.
    pub fn palette_id(self) -> &'static str {
        match (self.contrast, self.dark) {
            (true, true) => palette::HIGH_CONTRAST_DARK_ID,
            (true, false) => palette::HIGH_CONTRAST_LIGHT_ID,
            (false, true) => palette::NOIR_ID,
            (false, false) => palette::LIGHT_ID,
        }
    }
}

/// An uploaded palette.
#[derive(Clone, Debug, PartialEq)]
pub struct Custom {
    pub id: String,
    pub label: String,
    pub mode: Mode,
    pub palette: Palette,
}

pub struct Entry {
    pub id: SharedString,
    pub label: SharedString,
    pub mode: Mode,
    pub custom: bool,
}

/// Every colour a view reads, finished: the palette after the Contrast setting, plus what the SCSS derives from it
/// with color-mix. Palette tokens read straight through, as in `theme.text`.
#[derive(Clone, Debug)]
pub struct Theme {
    /// The palette in use, System already resolved.
    pub id: SharedString,
    pub mode: Mode,
    palette: Palette,
    pub text_faint: Rgb,
    pub control_edge: Rgb,
    pub accent_wash: Rgb,
    pub float_bg: Rgb,
    pub float_bg_solid: Rgb,
    pub float_tile_bg: Rgb,
    pub float_chip_bg: Rgb,
    pub field_bg: Rgb,
    pub check_off: Rgb,
    pub hover_wash: Rgb,
    /// A dialog's scrim over its blurred backdrop.
    pub scrim: Rgb,
    /// A dialog's scrim where there is no blur to set the app behind apart.
    pub scrim_flat: Rgb,
    pub shadow_2: Vec<BoxShadow>,
    pub shadow_3: Vec<BoxShadow>,
    pub shadow_pill: Vec<BoxShadow>,
    pub float_shadow: Vec<BoxShadow>,
    pub focus_ring_width: f32,
    pub hit_min: f32,
    pub motion: bool,
}

impl Deref for Theme {
    type Target = Palette;
    fn deref(&self) -> &Palette {
        &self.palette
    }
}

/// A CSS box-shadow. GPUI's blur_radius is the Gaussian sigma, CSS blur is two sigma.
fn shadow(x: f32, y: f32, blur: f32, spread: f32, c: Rgb) -> BoxShadow {
    BoxShadow {
        color: c.into(),
        offset: point(px(x), px(y)),
        blur_radius: px(blur / 2.),
        spread_radius: px(spread),
        inset: false,
    }
}

fn apply_contrast(p: &mut Palette, c: Contrast) {
    match c {
        Contrast::Standard => {}
        Contrast::More => {
            p.text_mute = p.text_dim;
            p.control_edge = Some(p.text_dim);
        }
        Contrast::Maximum => {
            p.text_dim = p.text;
            p.text_mute = p.text;
            p.line_strong = p.text;
            p.control_edge = Some(p.text);
        }
    }
}

impl Theme {
    pub fn resolve(id: &str, mode: Mode, mut p: Palette, s: &Settings) -> Self {
        apply_contrast(&mut p, s.contrast);
        let text_faint = p.text_faint.unwrap_or(p.text_mute.mix(0.7, p.panel));
        let accent_wash = p.accent.fade(0.2);
        let scrim = Rgb::rgba(5, 4, 9, 0.35);
        let scrim_flat = Rgb::rgba(5, 4, 9, 0.6);
        let focus_ring_width = if s.contrast == Contrast::Standard { 2. } else { 3. };
        let hit_min = if s.large_targets { HIT_MIN_LARGE } else { HIT_MIN };
        let base = |control_edge: Rgb| Theme {
            id: SharedString::from(id.to_string()),
            mode,
            palette: p,
            text_faint,
            control_edge: p.control_edge.unwrap_or(control_edge),
            accent_wash,
            float_bg: Rgb::TRANSPARENT,
            float_bg_solid: Rgb::TRANSPARENT,
            float_tile_bg: Rgb::TRANSPARENT,
            float_chip_bg: Rgb::TRANSPARENT,
            field_bg: Rgb::TRANSPARENT,
            check_off: Rgb::TRANSPARENT,
            hover_wash: Rgb::TRANSPARENT,
            scrim,
            scrim_flat,
            shadow_2: vec![],
            shadow_3: vec![],
            shadow_pill: vec![],
            float_shadow: vec![],
            focus_ring_width,
            hit_min,
            motion: s.motion,
        };
        match mode {
            Mode::Dark => {
                let float_bg = p.panel.fade(0.72);
                let slab = |o: f32, a: f32| vec![shadow(o, o, 0., 0., Rgb::rgba(0, 0, 0, a))];
                Theme {
                    float_bg,
                    float_bg_solid: p.panel.fade(0.92),
                    float_tile_bg: Rgb::WHITE.mix(0.05, float_bg),
                    float_chip_bg: Rgb::WHITE.mix(0.10, float_bg),
                    field_bg: Rgb::rgba(0, 0, 0, 0.3),
                    check_off: Rgb::rgba(0, 0, 0, 0.45),
                    hover_wash: Rgb::rgba(255, 255, 255, 0.07),
                    shadow_2: slab(4., 0.85),
                    shadow_3: slab(6., 0.9),
                    shadow_pill: slab(4., 0.85),
                    float_shadow: vec![
                        shadow(0., 2., 5., 0., Rgb::rgba(0, 0, 0, 0.32)),
                        shadow(0., 16., 34., -14., Rgb::rgba(0, 0, 0, 0.62)),
                    ],
                    ..base(p.text.fade(0.5))
                }
            }
            // A black offset slab reads as a hole on paper, so light inks soft shadows in the text colour.
            Mode::Light => {
                let float_bg_solid = p.raised.mix(0.7, p.bg);
                let ink = |a: f32| p.text.fade(a);
                let shadow_2 = vec![shadow(0., 2., 6., 0., ink(0.16)), shadow(0., 14., 30., -12., ink(0.40))];
                Theme {
                    float_bg: float_bg_solid.fade(0.97),
                    float_bg_solid,
                    float_tile_bg: p.raised.mix(0.7, p.panel),
                    float_chip_bg: p.panel.mix(0.9, p.raised),
                    field_bg: p.text.mix(0.11, float_bg_solid),
                    check_off: ink(0.24),
                    hover_wash: ink(0.06),
                    shadow_pill: shadow_2.clone(),
                    shadow_2,
                    shadow_3: vec![shadow(0., 2., 8., 0., ink(0.18)), shadow(0., 24., 48., -16., ink(0.45))],
                    float_shadow: vec![shadow(0., 1., 3., 0., ink(0.16)), shadow(0., 12., 28., -10., ink(0.42))],
                    ..base(p.text.fade(0.68))
                }
            }
        }
    }

    /// A transition length, near zero with motion off.
    pub fn duration(&self, d: Duration) -> Duration {
        if self.motion {
            d
        } else {
            Duration::from_micros(10)
        }
    }
}

pub struct ThemeState {
    settings: Settings,
    os: OsAppearance,
    custom: Vec<Custom>,
    theme: Theme,
}

impl Global for ThemeState {}

impl ThemeState {
    fn new(settings: Settings, os: OsAppearance, custom: Vec<Custom>) -> Self {
        let theme = Self::build(&settings, os, &custom);
        Self { settings, os, custom, theme }
    }

    fn build(s: &Settings, os: OsAppearance, custom: &[Custom]) -> Theme {
        let id = if s.choice == SYSTEM_ID { os.palette_id() } else { s.choice.as_str() };
        if let Some(sh) = palette::shipped(id) {
            return Theme::resolve(sh.id, sh.mode, sh.palette, s);
        }
        if let Some(c) = custom.iter().find(|c| c.id == id) {
            return Theme::resolve(&c.id, c.mode, c.palette, s);
        }
        // An id that no longer exists (an uploaded palette since removed) falls back to System.
        let sh = palette::shipped(os.palette_id()).expect("System resolves to a shipped palette");
        Theme::resolve(sh.id, sh.mode, sh.palette, s)
    }

    fn rebuild(&mut self) {
        self.theme = Self::build(&self.settings, self.os, &self.custom);
    }

    pub fn theme(&self) -> &Theme {
        &self.theme
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn custom(&self) -> &[Custom] {
        &self.custom
    }

    /// System, then the shipped palettes, then the uploaded ones, as the Theme select lists them.
    pub fn entries(&self) -> Vec<Entry> {
        let sys_mode = palette::shipped(self.os.palette_id()).map(|s| s.mode).unwrap_or(Mode::Dark);
        let mut out = vec![Entry { id: SYSTEM_ID.into(), label: "System".into(), mode: sys_mode, custom: false }];
        out.extend(palette::SHIPPED.iter().map(|s| Entry {
            id: s.id.into(),
            label: s.label.into(),
            mode: s.mode,
            custom: false,
        }));
        out.extend(self.custom.iter().map(|c| Entry {
            id: c.id.clone().into(),
            label: c.label.clone().into(),
            mode: c.mode,
            custom: true,
        }));
        out
    }
}

pub trait ActiveTheme {
    fn theme(&self) -> &Theme;
}

impl ActiveTheme for App {
    fn theme(&self) -> &Theme {
        &self.global::<ThemeState>().theme
    }
}

/// Bundled fonts in, theme global set. Persisted settings and uploads come from the app's settings store.
pub fn init(settings: Settings, custom: Vec<Custom>, cx: &mut App) {
    fonts::register(cx);
    let os = OsAppearance::from_window(cx.window_appearance(), false);
    cx.set_global(ThemeState::new(settings, os, custom));
    sync_window_chrome(cx);
}

pub fn state(cx: &App) -> &ThemeState {
    cx.global::<ThemeState>()
}

/// Change the settings or the uploaded palettes, then redraw every window in the new theme.
pub fn update(cx: &mut App, f: impl FnOnce(&mut Settings, &mut Vec<Custom>)) {
    let st = cx.global_mut::<ThemeState>();
    let before = (st.settings.clone(), st.custom.clone());
    f(&mut st.settings, &mut st.custom);
    if (&st.settings, &st.custom) == (&before.0, &before.1) {
        return;
    }
    st.rebuild();
    sync_window_chrome(cx);
    cx.refresh_windows();
}

pub fn set_os_contrast(contrast: bool, cx: &mut App) {
    set_os(OsAppearance { contrast, ..state(cx).os }, cx);
}

fn set_os(os: OsAppearance, cx: &mut App) {
    let st = cx.global_mut::<ThemeState>();
    if st.os == os {
        return;
    }
    st.os = os;
    if st.settings.choice == SYSTEM_ID {
        st.rebuild();
        cx.refresh_windows();
    }
}

/// Keep this while the window lives, so System follows the OS from light to dark and back.
pub fn follow_system(window: &mut Window, _cx: &mut App) -> Subscription {
    window.observe_window_appearance(|window, cx| {
        let contrast = state(cx).os.contrast;
        set_os(OsAppearance::from_window(window.appearance(), contrast), cx);
    })
}

/// The native window frame (macOS) follows a fixed palette's mode, and the OS while System is chosen.
fn sync_window_chrome(cx: &mut App) {
    let st = state(cx);
    let forced = (st.settings.choice != SYSTEM_ID).then(|| match st.theme.mode {
        Mode::Dark => WindowAppearance::Dark,
        Mode::Light => WindowAppearance::Light,
    });
    cx.set_window_appearance(forced);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: Rgb, b: Rgb) {
        let d = [(a.r, b.r), (a.g, b.g), (a.b, b.b), (a.a, b.a)].iter().map(|(x, y)| (x - y).abs()).fold(0., f32::max);
        assert!(d < 1e-4, "{a:?} != {b:?}");
    }

    fn theme(id: &str, s: Settings) -> Theme {
        ThemeState::build(&Settings { choice: id.into(), ..s }, OsAppearance::default(), &[])
    }

    #[test]
    fn system_follows_the_os() {
        let s = Settings::default();
        let dark = OsAppearance { dark: true, contrast: false };
        assert_eq!(ThemeState::build(&s, dark, &[]).id, palette::NOIR_ID);
        assert_eq!(ThemeState::build(&s, OsAppearance::default(), &[]).id, palette::LIGHT_ID);
        let hc = OsAppearance { dark: true, contrast: true };
        assert_eq!(ThemeState::build(&s, hc, &[]).id, palette::HIGH_CONTRAST_DARK_ID);
    }

    #[test]
    fn a_removed_upload_falls_back_to_system() {
        let t = theme("custom-gone", Settings::default());
        assert_eq!(t.id, palette::LIGHT_ID);
    }

    #[test]
    fn derived_fills_follow_the_mode() {
        let noir = theme(palette::NOIR_ID, Settings::default());
        same(noir.float_bg_solid, palette::NOIR.panel.alpha(0.92));
        same(noir.control_edge, palette::NOIR.text.alpha(0.5));
        let light = theme(palette::LIGHT_ID, Settings::default());
        assert_eq!(light.mode, Mode::Light);
        same(light.float_bg_solid, Rgb::WHITE.mix(0.7, palette::LIGHT.bg));
        same(light.control_edge, palette::LIGHT.text.alpha(0.68));
        assert_eq!(light.shadow_3.len(), 2);
        // High contrast sets its own edge, which beats the mode's.
        let hc = theme(palette::HIGH_CONTRAST_LIGHT_ID, Settings::default());
        same(hc.control_edge, Rgb::hex(0x333333));
    }

    #[test]
    fn contrast_setting_swaps_tokens() {
        let more = theme(palette::NOIR_ID, Settings { contrast: Contrast::More, ..Default::default() });
        same(more.text_mute, palette::NOIR.text_dim);
        same(more.control_edge, palette::NOIR.text_dim);
        assert_eq!(more.focus_ring_width, 3.);
        let max = theme(palette::NOIR_ID, Settings { contrast: Contrast::Maximum, ..Default::default() });
        same(max.text_dim, palette::NOIR.text);
        same(max.line_strong, palette::NOIR.text);
        same(max.text_faint, palette::NOIR.text.mix(0.7, palette::NOIR.panel));
    }

    #[test]
    fn shipped_text_reads_on_its_panel() {
        for sh in palette::SHIPPED {
            let t = theme(sh.id, Settings::default());
            for (name, fg) in [("text", t.text), ("text_dim", t.text_dim), ("text_mute", t.text_mute)] {
                let c = fg.contrast(t.panel);
                assert!(c >= 4.5, "{} {name} on panel is {c:.2}", sh.id);
            }
        }
    }
}
