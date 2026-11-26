//! Preferences: what FundaCAD 1's PreferencesDialog set that FundaCAD 2 has something behind, kept in the settings
//! store under FundaCAD 1's names and applied the moment it changes.

#[cfg(test)]
mod tests;
mod view;

use gpui::*;

use crate::commands::{register, Group, Run};
use crate::i18n::Label;
use crate::settings;
use crate::theme::{self, Contrast, Theme};

pub use view::view;

pub const SIZES: [u32; 8] = [80, 90, 100, 110, 125, 150, 175, 200];
const SIZE_KEY: &str = "interfaceSize";
const THEME_KEY: &str = "theme";
const CONTRAST_KEY: &str = "contrast";
const ANIMATIONS_KEY: &str = "animations";
const TARGETS_KEY: &str = "largeTargets";
const BACKGROUND_KEY: &str = "background";

/// A stored size that is not one of SIZES snaps to the nearest one.
pub fn as_size(v: Option<f64>) -> u32 {
    let Some(v) = v.filter(|v| v.is_finite()) else { return 100 };
    SIZES.into_iter().min_by(|a, b| (f64::from(*a) - v).abs().total_cmp(&(f64::from(*b) - v).abs())).unwrap_or(100)
}

/// The size one step larger or smaller, held at the ends.
pub fn step(size: u32, up: bool) -> u32 {
    let at = SIZES.iter().position(|s| *s == as_size(Some(f64::from(size)))).unwrap_or(2);
    let to = if up { (at + 1).min(SIZES.len() - 1) } else { at.saturating_sub(1) };
    SIZES[to]
}

pub fn size() -> u32 {
    as_size(settings::read(SIZE_KEY))
}

/// Zooms the window to the stored size.
pub fn apply_size(window: &mut Window) {
    window.set_ui_zoom(size() as f32 / 100.);
}

pub fn set_size(size: u32, window: &mut Window) {
    settings::write(SIZE_KEY, &as_size(Some(f64::from(size))));
    apply_size(window);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Background {
    Theme,
    Dark,
    Grey,
    Light,
}

impl Background {
    pub const ALL: [Background; 4] = [Background::Theme, Background::Dark, Background::Grey, Background::Light];

    pub fn id(self) -> &'static str {
        match self {
            Background::Theme => "theme",
            Background::Dark => "dark",
            Background::Grey => "grey",
            Background::Light => "light",
        }
    }

    pub fn parse(v: Option<&str>) -> Background {
        Self::ALL.into_iter().find(|b| Some(b.id()) == v).unwrap_or(Background::Theme)
    }

    /// FundaCAD 1's BACKGROUND_COLOR, None for the theme's own.
    pub fn rgb(self) -> Option<[u8; 3]> {
        match self {
            Background::Theme => None,
            Background::Dark => Some([0x0e, 0x10, 0x13]),
            Background::Grey => Some([0x4a, 0x4f, 0x57]),
            Background::Light => Some([0xd8, 0xdb, 0xe0]),
        }
    }
}

pub fn background() -> Background {
    Background::parse(settings::read::<String>(BACKGROUND_KEY).as_deref())
}

pub fn set_background(b: Background, cx: &mut App) {
    settings::write(BACKGROUND_KEY, &b.id());
    cx.refresh_windows();
}

/// What the viewport is drawn against.
pub fn viewport_bg(t: &Theme) -> [u8; 3] {
    background().rgb().unwrap_or_else(|| t.viewport_bg.bytes())
}

pub fn contrast_id(c: Contrast) -> &'static str {
    match c {
        Contrast::Standard => "standard",
        Contrast::More => "more",
        Contrast::Maximum => "maximum",
    }
}

/// The theme settings from what was stored, anything unreadable at its default.
pub fn theme_from(
    choice: Option<String>,
    contrast: Option<&str>,
    animations: Option<&str>,
    targets: Option<bool>,
) -> theme::Settings {
    let d = theme::Settings::default();
    theme::Settings {
        choice: choice.filter(|c| !c.is_empty()).unwrap_or(d.choice),
        contrast: [Contrast::Standard, Contrast::More, Contrast::Maximum]
            .into_iter()
            .find(|c| Some(contrast_id(*c)) == contrast)
            .unwrap_or(d.contrast),
        motion: animations != Some("off"),
        large_targets: targets.unwrap_or(d.large_targets),
    }
}

pub fn theme_settings() -> theme::Settings {
    let contrast: Option<String> = settings::read(CONTRAST_KEY);
    let animations: Option<String> = settings::read(ANIMATIONS_KEY);
    theme_from(settings::read(THEME_KEY), contrast.as_deref(), animations.as_deref(), settings::read(TARGETS_KEY))
}

/// Applies a theme change and stores it.
pub fn set_theme(cx: &mut App, f: impl FnOnce(&mut theme::Settings)) {
    theme::update(cx, |s, _| f(s));
    let s = theme::state(cx).settings().clone();
    settings::write(THEME_KEY, &s.choice);
    settings::write(CONTRAST_KEY, &contrast_id(s.contrast));
    settings::write(ANIMATIONS_KEY, &if s.motion { "on" } else { "off" });
    settings::write(TARGETS_KEY, &s.large_targets);
}

/// The Preferences command and the interface size keys, which FundaCAD 1 held outside the key table.
pub fn install(cx: &mut App) {
    register(cx, "preferences", Label::Command("command.preferences"), Group::Edit, view::open);
    type To = fn(u32) -> u32;
    let sizes: [(&'static str, &'static str, To); 3] = [
        ("interface-larger", "Interface size larger", |s| step(s, true)),
        ("interface-smaller", "Interface size smaller", |s| step(s, false)),
        ("interface-reset", "Interface size 100%", |_| 100),
    ];
    for (id, label, to) in sizes {
        register(cx, id, label, Group::View, move |w, cx| {
            set_size(to(size()), w);
            cx.refresh_windows();
        });
    }
    let keys = [
        ("ctrl-=", "interface-larger"),
        ("ctrl-+", "interface-larger"),
        ("ctrl-shift-=", "interface-larger"),
        ("ctrl-shift-+", "interface-larger"),
        ("ctrl--", "interface-smaller"),
        ("ctrl-0", "interface-reset"),
    ];
    cx.bind_keys(keys.map(|(k, id)| KeyBinding::new(k, Run::new(id), None)));
}
