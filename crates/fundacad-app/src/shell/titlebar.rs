use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::theme::{Mode, Theme, FS_MICRO, FS_SMALL, R_SM, S_1, S_2, S_3, S_4, W_BOLD, W_MEDIUM, W_SEMIBOLD};
use crate::ui::{icon, icon_button, text};

/// The lockup's viewBox is 640 by 124, shown 22 high as in the Vue title bar.
const LOCKUP_W: f32 = 640. * 22. / 124.;

impl Shell {
    pub(super) fn titlebar(&self, t: &Theme, cx: &App) -> Div {
        let doc = &self.doc;
        let home_ink = if crate::home::is_shown(cx) { t.accent_hot } else { t.text_dim };
        let (can_undo, can_redo) = (crate::commands::enabled(cx, "undo"), crate::commands::enabled(cx, "redo"));

        div()
            .h(px(36.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(S_4))
            .px(px(S_4))
            .bg(t.panel)
            .border_b_1()
            .border_color(t.line)
            .child(
                // The wordmark ink is fixed in the SVG, so the light themes get the dark ink asset.
                img(match t.mode {
                    Mode::Dark => "brand/fundacad-lockup-app.svg",
                    Mode::Light => "brand/fundacad-lockup-app-light.svg",
                })
                .h(px(22.))
                .w(px(LOCKUP_W))
                .flex_none(),
            )
            .child(
                icon_button(t, "home", "home", 24., 15., home_ink)
                    .on_click(|_, window, cx| crate::commands::run("home", window, cx)),
            )
            .child(crate::overlay::menubar(t, cx))
            .child(
                icon_button(t, "undo", "undo", 24., 15., t.text_dim)
                    .when(!can_undo, |d| d.opacity(0.5))
                    .on_click(|_, window, cx| crate::commands::run("undo", window, cx)),
            )
            .child(
                icon_button(t, "redo", "redo", 24., 15., t.text_dim)
                    .when(!can_redo, |d| d.opacity(0.5))
                    .on_click(|_, window, cx| crate::commands::run("redo", window, cx)),
            )
            .child(
                text(t, FS_MICRO)
                    .font_weight(W_BOLD)
                    // GPUI has no letter-spacing, the CSS .8px across five letters goes into the padding.
                    .px(px(S_3 + 2.))
                    .py(px(S_1))
                    .rounded(px(R_SM))
                    .bg(t.panel_2)
                    .text_color(t.text_dim)
                    .child("SOLID"),
            )
            .child(
                text(t, FS_SMALL)
                    .id("doc-name")
                    .min_w_0()
                    .flex()
                    .on_mouse_down(MouseButton::Right, |e, window, cx| {
                        crate::overlay::open_menu(window, cx, e.position, doc_menu(cx));
                    })
                    .font_weight(W_MEDIUM)
                    .text_color(if doc.dirty { t.text } else { t.text_mute })
                    .child(div().min_w_0().truncate().child(doc.name.clone()))
                    .when(doc.dirty, |d| d.child(div().flex_none().text_color(t.accent).child("*"))),
            )
            .child(div().flex_1())
            .child(self.workspace_toggle(t))
    }

    fn workspace_toggle(&self, t: &Theme) -> Div {
        let segment = |glyph: &'static str, label: &'static str, on: bool| {
            text(t, FS_SMALL)
                .h(px(20.))
                .px(px(S_2))
                .flex()
                .items_center()
                .gap(px(S_1))
                .rounded(px(3.))
                .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
                .text_color(if on { t.accent_hot } else { t.text_dim })
                .when(on, |d| d.bg(t.accent_wash))
                .child(icon(glyph, 12., if on { t.accent_hot } else { t.text_dim }))
                .child(label)
        };
        div()
            .flex()
            .gap(px(2.))
            .p(px(1.))
            .rounded(px(4.))
            .bg(t.field_bg)
            .border_1()
            .border_color(t.control_edge)
            .child(segment("primitive", "Model", true))
            .child(segment("sync", "Render", false))
    }
}

/// The document name's right click menu.
fn doc_menu(cx: &App) -> Vec<crate::overlay::MenuRow> {
    use crate::overlay::{MenuItem, MenuRow};
    let mut rows = vec![MenuRow::Item(MenuItem::command(cx, "save")), MenuRow::Item(MenuItem::command(cx, "save-as"))];
    let path = crate::files::current(cx).and_then(|f| f.read(cx).path().map(std::path::Path::to_path_buf));
    rows.push(MenuRow::Separator);
    let missing = path.is_none();
    rows.push(MenuRow::Item(
        MenuItem::call("Show in Folder", move |_, cx| {
            if let Some(p) = &path {
                cx.reveal_path(p);
            }
        })
        .disabled(missing),
    ));
    rows
}
