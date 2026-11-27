//! Tools, Plugins: every plugin found, what it adds and a switch for each, as FundaCAD 1's Preferences, Plugins.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::commands::Group;
use crate::i18n::{self, tr, Label};
use crate::theme::{ActiveTheme as _, Theme, FS_BODY, FS_MICRO, FS_SMALL, R_MD, S_1, S_2, S_3, S_4, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};

pub struct Manager {
    open: bool,
}

pub fn install(_window: &mut Window, cx: &mut App) -> AnyView {
    // FUNDA_PANEL=plugins opens it at start, for captures.
    let open = std::env::var("FUNDA_PANEL").is_ok_and(|p| p == "plugins");
    let view = cx.new(|_| Manager { open });
    let v = view.clone();
    crate::commands::register(cx, "plugins", Label::Key("plugins.command"), Group::Tools, move |_, cx| {
        v.update(cx, |m, cx| {
            m.open = !m.open;
            cx.notify();
        })
    });
    view.into()
}

/// A pill switch, on to the right.
pub fn switch(t: &Theme, id: impl Into<ElementId>, on: bool) -> Stateful<Div> {
    let (track, knob) = if on { (t.accent, t.on_accent) } else { (t.raised_2, t.text_dim) };
    div()
        .id(id)
        .w(px(30.))
        .h(px(16.))
        .flex_none()
        .flex()
        .items_center()
        .px(px(2.))
        .rounded(px(8.))
        .bg(track)
        .when(on, |d| d.justify_end())
        .child(div().size(px(12.)).rounded(px(6.)).bg(knob))
}

impl Manager {
    fn row(&self, t: &Theme, f: &super::Found, cx: &mut Context<Self>) -> Div {
        let m = &f.manifest;
        let on = super::enabled(cx, &m.id);
        let id = m.id.clone();
        let origin = match (f.native, &f.dir) {
            (true, _) => i18n::t("plugins.origin.bundled"),
            (false, _) => i18n::t("plugins.origin.installed"),
        };
        let mut info = vec![format!("{origin} \u{b7} {} \u{b7} v{}", m.kind, m.version)];
        if !m.grants.is_empty() {
            info.push(tr!("plugins.mayUse", grants = m.grants.join(", ")));
        }
        info.extend(f.engine_part());
        div()
            .flex()
            .gap(px(S_3))
            .py(px(S_2))
            .border_b_1()
            .border_color(t.line)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(m.name.clone()))
                    .child(text(t, FS_MICRO).text_color(t.text_dim).child(m.summary.clone()))
                    .children(info.into_iter().map(|l| text(t, FS_MICRO).text_color(t.text_mute).child(l)))
                    .children(f.problem.clone().map(|p| text(t, FS_MICRO).text_color(t.warn).child(p))),
            )
            .child(
                switch(t, SharedString::from(format!("plugin-{}", m.id)), on)
                    .on_click(cx.listener(move |_, _, _, cx| super::set_enabled(cx, &id, !on))),
            )
    }
}

impl Render for Manager {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }
        let t = cx.theme().clone();
        let t = &t;
        let found = super::found(cx);
        let mut list = div().id("plugins-list").flex().flex_col().min_h_0().overflow_y_scroll();
        for f in &found {
            list = list.child(self.row(t, f, cx));
        }
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).text_color(t.accent_hot).child(i18n::t("plugins.title")))
            .child(icon_button(t, "plugins-close", "close", 28., 14., t.text_mute).on_click(cx.listener(
                |this, _, _, cx| {
                    this.open = false;
                    cx.notify();
                },
            )));
        let note = text(t, FS_MICRO).text_color(t.text_dim).mt(px(S_1)).child(i18n::t("plugins.offKeepsData"));
        div()
            .absolute()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                solid_card(t)
                    .w(px(520.))
                    .max_h(px(620.))
                    .p(px(S_4))
                    .gap(px(S_2))
                    .rounded(px(R_MD + 4.))
                    .child(head)
                    .child(list)
                    .child(note),
            )
            .into_any_element()
    }
}
