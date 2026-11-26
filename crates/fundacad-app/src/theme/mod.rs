//! The Funda theme: src/styles/_tokens.scss, _contrast.scss and src/ui/theme.ts in Rust.
//!
//! `init` once at startup, then read `cx.theme()` in render. A change goes through `update`, which resolves the
//! theme again and redraws every window, so dark and light switch live. While the choice is System, a root view
//! keeps the `follow_system` subscription so an OS switch comes through too. `kit` carries the result onto the
//! gpui-kit controls.

pub mod color;
pub mod fonts;
pub mod kit;
pub mod palette;
pub mod tokens;

use std::sync::Arc;
use std::{ops::Deref, time::Duration};

use gpui::{point, px, App, BoxShadow, Context, Global, SharedString, Subscription, Window, WindowAppearance};

pub use color::Rgb;
pub use palette::{Mode, Palette};
pub use tokens::*;

pub const SYSTEM_ID: &str = "system";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[allow(dead_code)]
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
    /// An OS high contrast mode. GPUI does not report it, `read_os_contrast` asks the platform.
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

#[allow(dead_code)]
pub struct Entry {
    pub id: SharedString,
    pub label: SharedString,
    pub mode: Mode,
    pub custom: bool,
}

/// Every colour a view reads, finished: the palette after the Contrast setting, plus what the SCSS derives from it
/// with color-mix. Palette tokens read straight through, as in `theme.text`.
#[derive(Clone, Debug)]
#[allow(dead_code)]
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

    /// A control size or hit area, lifted to the minimum hit area, which Larger click targets raises.
    pub fn hit(&self, base: f32) -> f32 {
        base.max(self.hit_min)
    }

    /// A transition length, near zero with motion off.
    #[allow(dead_code)]
    pub fn duration(&self, d: Duration) -> Duration {
        if self.motion {
            d
        } else {
            Duration::from_micros(10)
        }
    }
}

#[derive(Clone)]
pub struct ThemeState {
    settings: Settings,
    os: OsAppearance,
    custom: Vec<Custom>,
    /// Shared, so a render can hold the theme across `&mut cx` calls without copying its shadow lists.
    theme: Arc<Theme>,
}

impl Global for ThemeState {}

/// An upload cannot take the id of System, a shipped palette or an earlier upload, which it would shadow in the
/// Theme select.
fn sanitize(custom: Vec<Custom>) -> Vec<Custom> {
    let mut seen = std::collections::HashSet::new();
    custom
        .into_iter()
        .filter(|c| {
            let ok = c.id != SYSTEM_ID && palette::shipped(&c.id).is_none() && seen.insert(c.id.clone());
            if !ok {
                log::warn!("dropped the uploaded palette {:?}, its id is taken", c.id);
            }
            ok
        })
        .collect()
}

impl ThemeState {
    fn new(settings: Settings, os: OsAppearance, custom: Vec<Custom>) -> Self {
        let custom = sanitize(custom);
        let theme = Arc::new(Self::build(&settings, os, &custom));
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

    /// The state after `f`, or None when `f` changed nothing.
    fn edited(&self, f: impl FnOnce(&mut Settings, &mut Vec<Custom>)) -> Option<Self> {
        let (mut settings, mut custom) = (self.settings.clone(), self.custom.clone());
        f(&mut settings, &mut custom);
        let custom = sanitize(custom);
        (settings != self.settings || custom != self.custom).then(|| Self::new(settings, self.os, custom))
    }

    /// The state under another OS appearance, or None when it is the same one.
    fn with_os(&self, os: OsAppearance) -> Option<Self> {
        (os != self.os).then(|| Self::new(self.settings.clone(), os, self.custom.clone()))
    }

    pub fn theme(&self) -> &Arc<Theme> {
        &self.theme
    }

    #[allow(dead_code)]
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    #[allow(dead_code)]
    pub fn custom(&self) -> &[Custom] {
        &self.custom
    }

    /// System, then the shipped palettes, then the uploaded ones, as the Theme select lists them.
    #[allow(dead_code)]
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
    fn theme(&self) -> &Arc<Theme>;
}

impl ActiveTheme for App {
    fn theme(&self) -> &Arc<Theme> {
        &self.global::<ThemeState>().theme
    }
}

/// Bundled fonts in, theme global set. Persisted settings and uploads come from the app's settings store.
pub fn init(settings: Settings, custom: Vec<Custom>, cx: &mut App) {
    fonts::register(cx);
    let os = OsAppearance::from_window(cx.window_appearance(), read_os_contrast());
    cx.set_global(ThemeState::new(settings, os, custom));
    sync_window_chrome(cx);
}

pub fn state(cx: &App) -> &ThemeState {
    cx.global::<ThemeState>()
}

/// Change the settings or the uploaded palettes, then redraw every window in the new theme.
#[allow(dead_code)]
pub fn update(cx: &mut App, f: impl FnOnce(&mut Settings, &mut Vec<Custom>)) {
    let Some(next) = state(cx).edited(f) else { return };
    cx.set_global(next);
    sync_window_chrome(cx);
    cx.refresh_windows();
}

fn set_os(os: OsAppearance, cx: &mut App) {
    let Some(next) = state(cx).with_os(os) else { return };
    let follows = next.settings.choice == SYSTEM_ID;
    cx.set_global(next);
    if follows {
        cx.refresh_windows();
    }
}

/// Whether Windows High Contrast is on, which System answers with a high contrast palette.
#[cfg(windows)]
pub fn read_os_contrast() -> bool {
    use windows::Win32::UI::{
        Accessibility::HIGHCONTRASTW,
        WindowsAndMessaging::{SystemParametersInfoW, SPI_GETHIGHCONTRAST, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS},
    };
    let mut hc = HIGHCONTRASTW { cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32, ..Default::default() };
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            hc.cbSize,
            Some(&mut hc as *mut HIGHCONTRASTW as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    read.is_ok() && high_contrast_on(hc.dwFlags.0)
}

#[cfg(not(windows))]
pub fn read_os_contrast() -> bool {
    false
}

/// HCF_HIGHCONTRASTON in a HIGHCONTRAST's dwFlags.
fn high_contrast_on(flags: u32) -> bool {
    flags & 1 != 0
}

fn refresh_os(window: &Window, cx: &mut App) {
    set_os(OsAppearance::from_window(window.appearance(), read_os_contrast()), cx);
}

/// Keep this while the window lives, so System follows the OS from light to dark and back, and into High Contrast.
/// GPUI sends no message for High Contrast itself, so it is read again on an appearance change and whenever the
/// window is activated, which covers a switch made in Settings or by the Alt+Shift+PrintScreen shortcut.
pub fn follow_system<T: 'static>(window: &mut Window, cx: &mut Context<T>) -> Subscription {
    let appearance = cx.observe_window_appearance(window, |_, window, cx| refresh_os(window, cx));
    let activation = cx.observe_window_activation(window, |_, window, cx| refresh_os(window, cx));
    Subscription::new(move || drop((appearance, activation)))
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

    fn state(s: Settings, os: OsAppearance, custom: Vec<Custom>) -> ThemeState {
        ThemeState::new(s, os, custom)
    }

    fn custom(id: &str, mode: Mode, palette: Palette) -> Custom {
        Custom { id: id.into(), label: id.into(), mode, palette }
    }

    #[test]
    fn update_ignores_a_change_that_changes_nothing() {
        let st = state(Settings::default(), OsAppearance::default(), vec![custom("mine", Mode::Dark, palette::NOIR)]);
        assert!(st.edited(|_, _| {}).is_none());
        assert!(st.edited(|s, _| s.choice = SYSTEM_ID.into()).is_none());
        assert!(st.edited(|_, c| c[0] = c[0].clone()).is_none());
        let next = st.edited(|s, _| s.contrast = Contrast::More).expect("a new contrast is a change");
        assert_eq!(next.settings().contrast, Contrast::More);
        assert_eq!(next.theme().focus_ring_width, 3.);
        assert!(st.edited(|_, c| c.clear()).is_some());
    }

    #[test]
    fn a_taken_id_does_not_make_a_palette() {
        let taken = |id: &str| custom(id, Mode::Light, palette::LIGHT);
        let st = state(
            Settings::default(),
            OsAppearance::default(),
            vec![taken(palette::NOIR_ID), taken(SYSTEM_ID), taken("mine"), taken("mine"), taken("other")],
        );
        let ids: Vec<_> = st.custom().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["mine", "other"]);
        let listed: Vec<_> = st.entries().iter().map(|e| e.id.to_string()).collect();
        let mut unique = listed.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(listed.len(), unique.len());
        // An edit that adds one is a no-op.
        assert!(st.edited(|_, c| c.push(taken(palette::LIGHT_ID))).is_none());
    }

    #[test]
    fn set_os_reaches_system_only() {
        let system = state(Settings::default(), OsAppearance::default(), vec![]);
        assert!(system.with_os(OsAppearance::default()).is_none());
        let dark = system.with_os(OsAppearance { dark: true, contrast: false }).expect("dark is a change");
        assert_eq!(dark.theme().id, palette::NOIR_ID);
        let hc = dark.with_os(OsAppearance { dark: true, contrast: true }).expect("contrast is a change");
        assert_eq!(hc.theme().id, palette::HIGH_CONTRAST_DARK_ID);
        let hc_light = hc.with_os(OsAppearance { dark: false, contrast: true }).unwrap();
        assert_eq!(hc_light.theme().id, palette::HIGH_CONTRAST_LIGHT_ID);

        let pinned = Settings { choice: palette::NOIR_ID.into(), ..Default::default() };
        let fixed = state(pinned, OsAppearance::default(), vec![]);
        let moved = fixed.with_os(OsAppearance { dark: false, contrast: true }).unwrap();
        assert_eq!(moved.theme().id, palette::NOIR_ID);
        assert!(moved.os.contrast);
    }

    #[test]
    fn follow_system_reads_the_window_and_the_platform_flag() {
        use WindowAppearance::*;
        for (w, dark) in [(Dark, true), (VibrantDark, true), (Light, false), (VibrantLight, false)] {
            assert_eq!(OsAppearance::from_window(w, false), OsAppearance { dark, contrast: false });
            assert_eq!(OsAppearance::from_window(w, true), OsAppearance { dark, contrast: true });
        }
        // HCF_HIGHCONTRASTON is bit 0 of dwFlags, the other flags (available, hotkey) do not turn it on.
        assert!(high_contrast_on(0x1));
        assert!(high_contrast_on(0x1 | 0x4 | 0x40));
        assert!(!high_contrast_on(0));
        assert!(!high_contrast_on(0x2 | 0x4));
        let os = OsAppearance::from_window(Dark, high_contrast_on(0x1));
        let st = state(Settings::default(), OsAppearance::default(), vec![]).with_os(os).unwrap();
        assert_eq!(st.theme().id, palette::HIGH_CONTRAST_DARK_ID);
    }

    #[test]
    fn more_contrast_keeps_a_palette_text_faint() {
        let set = Rgb::hex(0x123456);
        let mine = custom("mine", Mode::Dark, Palette { text_faint: Some(set), ..palette::NOIR });
        let more = Settings { choice: "mine".into(), contrast: Contrast::More, ..Default::default() };
        let t = ThemeState::build(&more, OsAppearance::default(), &[mine.clone()]);
        same(t.text_faint, set);
        same(t.text_mute, palette::NOIR.text_dim);
        let max = Settings { contrast: Contrast::Maximum, ..more };
        same(ThemeState::build(&max, OsAppearance::default(), &[mine]).text_faint, set);
        // Left out, it follows the swapped text_mute.
        let t = theme(palette::NOIR_ID, Settings { contrast: Contrast::More, ..Default::default() });
        same(t.text_faint, palette::NOIR.text_dim.mix(0.7, palette::NOIR.panel));
    }

    #[test]
    fn hit_honours_larger_click_targets() {
        let normal = theme(palette::NOIR_ID, Settings::default());
        assert_eq!(normal.hit(20.), HIT_MIN);
        assert_eq!(normal.hit(40.), 40.);
        let large = theme(palette::NOIR_ID, Settings { large_targets: true, ..Default::default() });
        assert_eq!(large.hit(20.), HIT_MIN_LARGE);
        assert_eq!(large.hit(24.), HIT_MIN_LARGE);
        assert_eq!(large.hit(40.), 40.);
    }

    /// The minimum ratios of ui/contrast.ts: text and lines or edges, 4.5 and 3 as shipped, 7 and 4.5 in the High
    /// Contrast themes.
    fn bar(id: &str) -> (f32, f32) {
        if id == palette::HIGH_CONTRAST_DARK_ID || id == palette::HIGH_CONTRAST_LIGHT_ID {
            (7., 4.5)
        } else {
            (4.5, 3.)
        }
    }

    #[test]
    fn text_reads_on_the_solid_float_over_a_white_model() {
        for sh in palette::SHIPPED {
            let t = theme(sh.id, Settings::default());
            let solid = t.float_bg_solid.over(Rgb::WHITE);
            let (text, _) = bar(sh.id);
            for (name, fg) in [("text", t.text), ("text_dim", t.text_dim), ("text_mute", t.text_mute)] {
                let c = fg.contrast(solid);
                assert!(c >= text, "{} {name} on float_bg_solid is {c:.2}", sh.id);
            }
        }
    }

    #[test]
    fn a_field_edge_stands_clear_of_the_well_and_what_is_around_it() {
        for sh in palette::SHIPPED {
            let t = theme(sh.id, Settings::default());
            let (_, edge) = bar(sh.id);
            let glass = t.float_bg.over(t.viewport_bg);
            for (on, under) in [("panel", t.panel), ("panel_2", t.panel_2), ("glass", glass)] {
                let well = t.field_bg.over(under);
                let line = t.control_edge.over(well);
                let (outer, inner) = (line.contrast(under), line.contrast(well));
                assert!(outer >= edge, "{} edge on the field against {on} is {outer:.2}", sh.id);
                assert!(inner >= edge, "{} edge on the field well on {on} is {inner:.2}", sh.id);
            }
        }
    }

    #[test]
    fn accent_and_its_label_read_each_other() {
        for sh in palette::SHIPPED {
            let t = theme(sh.id, Settings::default());
            let (text, ring) = bar(sh.id);
            let label = t.on_accent.contrast(t.accent);
            assert!(label >= text, "{} on_accent on accent is {label:.2}", sh.id);
            for (on, bg) in [("panel", t.panel), ("panel_2", t.panel_2), ("raised", t.raised), ("raised_2", t.raised_2)]
            {
                let c = t.accent.contrast(bg);
                assert!(c >= ring, "{} focus ring on {on} is {c:.2}", sh.id);
            }
        }
    }
}
