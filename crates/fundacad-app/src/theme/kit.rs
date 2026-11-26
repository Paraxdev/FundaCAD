//! The Funda theme carried onto gpui-kit, so its inputs, popups, lists, tabs and scrollbars paint in the palette
//! in use and not in the kit's own light or dark.

use gpui::{App, Hsla};
use gpui_kit::component::{Theme as Kit, ThemeColor, ThemeMode};

use super::{state, Mode, Rgb, Theme};

/// Keep the kit in step with the Funda theme from now on.
pub fn bind(cx: &mut App) {
    sync(cx);
    cx.observe_global::<super::ThemeState>(sync).detach();
}

pub fn sync(cx: &mut App) {
    let theme = state(cx).theme().clone();
    let mode = match theme.mode {
        Mode::Dark => ThemeMode::Dark,
        Mode::Light => ThemeMode::Light,
    };
    // Changing the mode loads the kit's own colours, so it goes first and ours go over it.
    if Kit::global(cx).mode != mode {
        Kit::change(mode, None, cx);
    }
    let want = colors(&theme, Kit::global(cx).colors);
    if Kit::global(cx).colors != want {
        Kit::update(cx, |kit| kit.colors = want);
    }
}

fn h(c: Rgb) -> Hsla {
    c.into()
}

/// Text on a signal colour, whichever of white and black reads better.
fn on(c: Rgb) -> Rgb {
    if Rgb::WHITE.contrast(c) >= Rgb::BLACK.contrast(c) {
        Rgb::WHITE
    } else {
        Rgb::BLACK
    }
}

/// `base` with every colour the Funda tokens speak for replaced.
pub fn colors(t: &Theme, mut k: ThemeColor) -> ThemeColor {
    let clear = Rgb::TRANSPARENT;

    k.background = h(t.bg);
    k.foreground = h(t.text);
    k.muted = h(t.panel_2);
    k.muted_foreground = h(t.text_dim);
    k.border = h(t.line);
    k.input = h(t.control_edge);
    k.caret = h(t.text);
    k.selection = h(t.accent_wash);
    k.ring = h(t.accent);
    k.accent = h(t.accent_tint);
    k.accent_foreground = h(t.text);
    // The kit's dialog backdrop is a plain fill with no blur behind it, the `html.no-glass-blur .modal-overlay` case.
    k.overlay = h(t.scrim_flat);
    k.window_border = h(t.line);
    k.link = h(t.accent);
    k.link_hover = h(t.accent_hot);
    k.link_active = h(t.accent_hot);
    k.drag_border = h(t.accent);
    k.drop_target = h(t.accent_wash);

    k.popover = h(t.float_bg_solid);
    k.popover_foreground = h(t.text);

    k.primary = h(t.accent);
    k.primary_hover = h(t.accent_hot);
    k.primary_active = h(t.accent_hot);
    k.primary_foreground = h(t.on_accent);
    k.secondary = h(t.raised);
    k.secondary_hover = h(t.raised_2);
    k.secondary_active = h(t.raised_2);
    k.secondary_foreground = h(t.text);

    k.button = h(t.raised);
    k.button_hover = h(t.raised_2);
    k.button_active = h(t.raised_2);
    k.button_foreground = h(t.text);
    k.button_primary = k.primary;
    k.button_primary_hover = k.primary_hover;
    k.button_primary_active = k.primary_active;
    k.button_primary_foreground = k.primary_foreground;
    k.button_secondary = k.secondary;
    k.button_secondary_hover = k.secondary_hover;
    k.button_secondary_active = k.secondary_active;
    k.button_secondary_foreground = k.secondary_foreground;

    for (fill, hot, fg, token) in [
        (&mut k.danger, &mut k.danger_hover, &mut k.danger_foreground, t.error),
        (&mut k.success, &mut k.success_hover, &mut k.success_foreground, t.ok),
        (&mut k.warning, &mut k.warning_hover, &mut k.warning_foreground, t.warn),
        (&mut k.info, &mut k.info_hover, &mut k.info_foreground, t.accent),
    ] {
        *fill = h(token);
        *hot = h(token.mix(0.85, t.text));
        *fg = h(on(token));
    }
    k.danger_active = k.danger_hover;
    k.success_active = k.success_hover;
    k.warning_active = k.warning_hover;
    k.info_active = k.info_hover;
    k.button_danger = k.danger;
    k.button_danger_hover = k.danger_hover;
    k.button_danger_active = k.danger_active;
    k.button_danger_foreground = k.danger_foreground;
    k.button_success = k.success;
    k.button_success_hover = k.success_hover;
    k.button_success_active = k.success_active;
    k.button_success_foreground = k.success_foreground;
    k.button_warning = k.warning;
    k.button_warning_hover = k.warning_hover;
    k.button_warning_active = k.warning_active;
    k.button_warning_foreground = k.warning_foreground;
    k.button_info = k.info;
    k.button_info_hover = k.info_hover;
    k.button_info_active = k.info_active;
    k.button_info_foreground = k.info_foreground;

    k.list = h(clear);
    k.list_hover = h(t.hover_wash);
    k.list_active = h(t.accent_tint);
    k.list_active_border = h(t.accent);
    k.list_even = h(clear);
    k.list_head = h(t.panel_2);
    k.table = h(clear);
    k.table_hover = h(t.hover_wash);
    k.table_active = h(t.accent_tint);
    k.table_active_border = h(t.accent);
    k.table_even = h(clear);
    k.table_head = h(t.panel_2);
    k.table_head_foreground = h(t.text_dim);
    k.table_foot = h(t.panel_2);
    k.table_foot_foreground = h(t.text_dim);
    k.table_row_border = h(t.line);

    k.tab = h(clear);
    k.tab_active = h(t.raised);
    k.tab_foreground = h(t.text_dim);
    k.tab_active_foreground = h(t.text);
    k.tab_bar = h(t.panel_2);
    k.tab_bar_segmented = h(t.panel_2);

    k.sidebar = h(t.panel);
    k.sidebar_foreground = h(t.text);
    k.sidebar_border = h(t.line);
    k.sidebar_accent = h(t.accent_tint);
    k.sidebar_accent_foreground = h(t.text);
    k.sidebar_primary = h(t.accent);
    k.sidebar_primary_foreground = h(t.on_accent);
    k.title_bar = h(t.panel);
    k.title_bar_border = h(t.line);
    k.status_bar = h(t.panel);
    k.status_bar_border = h(t.line);

    k.group_box = h(t.panel_2);
    k.group_box_foreground = h(t.text);
    k.accordion = h(t.panel_2);
    k.description_list_label = h(t.panel_2);
    k.description_list_label_foreground = h(t.text_dim);
    k.skeleton = h(t.raised);
    k.progress_bar = h(t.accent);
    k.slider_bar = h(t.accent);
    k.slider_thumb = h(t.text);
    k.switch = h(t.raised_2);
    k.switch_thumb = h(t.text);

    k.scrollbar = h(clear);
    k.scrollbar_thumb = h(t.text_mute.alpha(0.6));
    k.scrollbar_thumb_hover = h(t.text_dim);

    k
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{palette, Settings, ThemeState};

    fn kit_for(id: &str) -> (Theme, ThemeColor) {
        let s = Settings { choice: id.into(), ..Default::default() };
        let t = ThemeState::build(&s, Default::default(), &[]);
        let k = colors(&t, ThemeColor::default());
        (t, k)
    }

    #[test]
    fn kit_surfaces_take_the_funda_tokens() {
        let (t, k) = kit_for(palette::NOIR_ID);
        assert_eq!(k.popover, h(t.float_bg_solid));
        assert_eq!(k.border, h(t.line));
        assert_eq!(k.input, h(t.control_edge));
        assert_eq!(k.accent, h(t.accent_tint));
        assert_eq!(k.selection, h(t.accent_wash));
        assert_eq!(k.primary, h(t.accent));
        assert_eq!(k.scrollbar_thumb_hover, h(t.text_dim));
        assert_eq!(k.button_danger, h(t.error));
        assert_eq!(k.overlay, h(t.scrim_flat));
    }

    #[test]
    fn a_palette_change_reaches_the_kit() {
        let (_, noir) = kit_for(palette::NOIR_ID);
        for sh in palette::SHIPPED.iter().filter(|s| s.id != palette::NOIR_ID) {
            let (_, k) = kit_for(sh.id);
            // The Noir tints keep its shell and change the accent.
            assert!(k.popover != noir.popover || k.primary != noir.primary, "{}", sh.id);
        }
    }

    #[test]
    fn the_kit_reads_on_its_own_surfaces() {
        for sh in palette::SHIPPED {
            let (t, k) = kit_for(sh.id);
            let opaque = |c: Hsla| Rgb::from(c).over(t.panel);
            for (what, fg, bg) in [
                ("foreground on background", k.foreground, k.background),
                ("popover_foreground on popover", k.popover_foreground, k.popover),
                ("primary_foreground on primary", k.primary_foreground, k.primary),
                ("danger_foreground on danger", k.danger_foreground, k.danger),
                ("tab_active_foreground on tab_active", k.tab_active_foreground, k.tab_active),
            ] {
                let c = opaque(fg).contrast(opaque(bg));
                assert!(c >= 4.5, "{} {what} is {c:.2}", sh.id);
            }
        }
    }

    #[test]
    fn signal_text_picks_black_or_white() {
        assert_eq!(on(Rgb::hex(0xf5d000)), Rgb::BLACK);
        assert_eq!(on(Rgb::hex(0x101040)), Rgb::WHITE);
    }
}
