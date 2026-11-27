//! The Preferences window, FundaCAD 1's PreferencesDialog: categories down the left, the open one's cards on the
//! right. It holds the keyboard while open.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::{Background, SIZES};
use crate::commands::{self, MODAL};
use crate::i18n::{self, t, tr};
use crate::theme::{
    self, ActiveTheme as _, Contrast, Theme, FS_BODY, FS_SMALL, FS_TITLE, R_MD, R_SM, S_1, S_2, S_3, S_4,
};
use crate::theme::{W_MEDIUM, W_SEMIBOLD};
use crate::motion::{self, hover_bg, mix, Transition};
use crate::theme::Rgb;
use crate::ui::{icon, solid_card, text};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab {
    Appearance,
    Viewport,
    Access,
}

impl Tab {
    const ALL: [Tab; 3] = [Tab::Appearance, Tab::Viewport, Tab::Access];

    fn label(self) -> String {
        t(match self {
            Tab::Appearance => "prefs.tab.appearance",
            Tab::Viewport => "prefs.tab.viewport",
            Tab::Access => "prefs.tab.access",
        })
    }
}

pub struct PrefsWindow {
    tab: Tab,
    focus: FocusHandle,
    restore: Option<FocusHandle>,
}

#[derive(Default)]
struct Open(Option<Entity<PrefsWindow>>);

impl Global for Open {}

pub fn view(cx: &App) -> Option<Entity<PrefsWindow>> {
    cx.try_global::<Open>()?.0.clone()
}

pub fn open(window: &mut Window, cx: &mut App) {
    if let Some(open) = view(cx) {
        let focus = open.read(cx).focus.clone();
        window.focus(&focus, cx);
        return;
    }
    let restore = window.focused(cx);
    let entity = cx.new(|cx| PrefsWindow {
        tab: Tab::Appearance,
        focus: cx.focus_handle(),
        restore,
    });
    let focus = entity.read(cx).focus.clone();
    cx.set_global(Open(Some(entity)));
    window.focus(&focus, cx);
    cx.refresh_windows();
}

fn close(window: &mut Window, cx: &mut App) {
    let Some(open) = cx.default_global::<Open>().0.take() else { return };
    match open.read(cx).restore.clone() {
        Some(f) => window.focus(&f, cx),
        None => window.blur(cx),
    }
    cx.refresh_windows();
}

impl PrefsWindow {
    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = k.modifiers;
        if k.key == "escape" && !(m.control || m.platform || m.shift || m.alt) {
            cx.stop_propagation();
            close(window, cx);
        }
    }

    fn appearance(&self, t_: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let lang = i18n::setting();
        let mut langs = vec![(i18n::SYSTEM.to_string(), t("prefs.theme.system"))];
        langs.extend(i18n::choices().into_iter().map(|c| (c.code, c.native)));
        let langs = langs.into_iter().enumerate().map(|(i, (code, label))| {
            chip(t_, ("lang", i), label, code == lang)
                .on_click(move |_, _, cx| {
                    i18n::choose(cx, &code);
                })
                .into_any_element()
        });
        let state = theme::state(cx);
        let choice = state.settings().choice.clone();
        let themes = state.entries().into_iter().enumerate().map(|(i, e)| {
            let label: SharedString = if e.id == theme::SYSTEM_ID { t("prefs.theme.system").into() } else { e.label };
            let id = e.id.to_string();
            chip(t_, ("theme", i), label, id == choice)
                .on_click(move |_, _, cx| super::set_theme(cx, |s| s.choice = id.clone()))
                .into_any_element()
        });
        let now = super::size();
        let sizes = SIZES.into_iter().map(|s| {
            chip(t_, ("size", s as usize), format!("{s}%"), s == now)
                .on_click(move |_, w, cx| {
                    super::set_size(s, w, cx);
                    cx.refresh_windows();
                })
                .into_any_element()
        });
        vec![
            card(t_, t("prefs.language.title"), Some(t("prefs.language.hint")), row(langs)),
            card(t_, t("prefs.theme.title"), None, row(themes)),
            card(t_, t("prefs.size.title"), Some(tr!("prefs.size.hint", keys = t("prefs.size.keys"))), row(sizes)),
        ]
    }

    fn viewport(&self, t_: &Theme) -> Vec<AnyElement> {
        let now = super::background();
        let chips = Background::ALL.into_iter().map(|b| {
            chip(t_, ("bg", b as usize), t(&format!("prefs.background.{}", b.id())), b == now)
                .on_click(move |_, _, cx| super::set_background(b, cx))
                .into_any_element()
        });
        vec![card(t_, t("prefs.background.title"), None, row(chips))]
    }

    fn access(&self, t_: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let s = theme::state(cx).settings().clone();
        let contrasts = [Contrast::Standard, Contrast::More, Contrast::Maximum].into_iter().map(|c| {
            chip(t_, ("contrast", c as usize), t(&format!("prefs.contrast.{}", super::contrast_id(c))), c == s.contrast)
                .on_click(move |_, _, cx| super::set_theme(cx, |s| s.contrast = c))
                .into_any_element()
        });
        let motion = [(true, "prefs.animations.on"), (false, "prefs.animations.off")].into_iter().map(|(on, key)| {
            chip(t_, ("motion", usize::from(on)), t(key), on == s.motion)
                .on_click(move |_, _, cx| super::set_theme(cx, |s| s.motion = on))
                .into_any_element()
        });
        let targets = s.large_targets;
        let single = commands::single_keys(cx);
        vec![
            card(t_, t("prefs.contrast.title"), None, row(contrasts)),
            card(t_, t("prefs.animations.title"), None, row(motion)),
            card(
                t_,
                None::<String>,
                Some(t("prefs.targets.hint")),
                checkbox(t_, "targets", t("prefs.targets.title"), targets)
                    .on_click(move |_, _, cx| super::set_theme(cx, |s| s.large_targets = !targets))
                    .into_any_element(),
            ),
            card(
                t_,
                None::<String>,
                Some(t("prefs.singleKeys.hint")),
                checkbox(t_, "single-keys", t("prefs.singleKeys.title"), single)
                    .on_click(move |_, _, cx| commands::set_single_keys(cx, !single))
                    .into_any_element(),
            ),
        ]
    }
}

impl Render for PrefsWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t_ = cx.theme().clone();
        let t_ = &t_;
        let mut context = KeyContext::default();
        context.add(MODAL);
        let cards = match self.tab {
            Tab::Appearance => self.appearance(t_, cx),
            Tab::Viewport => self.viewport(t_),
            Tab::Access => self.access(t_, cx),
        };
        let nav = Tab::ALL.into_iter().enumerate().map(|(i, tab)| {
            let on = tab == self.tab;
            let el = text(t_, FS_BODY)
                .id(("tab", i))
                .px(px(S_3))
                .h(px(t_.hit(30.)))
                .flex()
                .items_center()
                .rounded(px(R_MD))
                .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
                .text_color(if on { t_.text } else { t_.text_dim })
                .when(!on, |d| d.cursor_pointer())
                .child(tab.label());
            motion::row_bg(("tab-bg", i), el, on, t_.hover_wash, t_.accent_wash).on_click(cx.listener(move |this, _, _, cx| {
                    this.tab = tab;
                    cx.notify();
                }))
        });
        div().absolute().inset_0().flex().items_center().justify_center().bg(hsla(0., 0., 0., 0.45)).occlude().child(
            solid_card(t_)
                .id("prefs")
                .track_focus(&self.focus)
                .key_context(context)
                .on_key_down(cx.listener(Self::on_key))
                .w(px(780.))
                .h(px(560.))
                .max_w(relative(0.95))
                .max_h(relative(0.92))
                .bg(t_.panel)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .px(px(S_4))
                        .pt(px(S_4))
                        .pb(px(S_2))
                        .child(text(t_, FS_TITLE).flex_1().font_weight(W_SEMIBOLD).child(t("prefs.title"))),
                )
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_h_0()
                        .child(div().w(px(180.)).flex_none().flex().flex_col().gap(px(S_1)).p(px(S_3)).children(nav))
                        .child(
                            div()
                                .id("prefs-pane")
                                .flex_1()
                                .min_w_0()
                                .overflow_y_scroll()
                                .p(px(S_3))
                                .flex()
                                .flex_col()
                                .gap(px(S_3))
                                .child(text(t_, FS_BODY).font_weight(W_SEMIBOLD).child(self.tab.label()))
                                .children(cards),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .px(px(S_4))
                        .py(px(S_3))
                        .child(button(t_, "done", t("prefs.done"), true).on_click(|_, w, cx| close(w, cx))),
                ),
        )
    }
}

fn row(items: impl IntoIterator<Item = AnyElement>) -> AnyElement {
    div().flex().flex_wrap().gap(px(S_1)).children(items).into_any_element()
}

fn card(t_: &Theme, title: impl Into<Option<String>>, hint: Option<String>, control: AnyElement) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(S_2))
        .p(px(S_3))
        .rounded(px(R_MD))
        .bg(t_.raised)
        .when_some(title.into(), |d, title| d.child(text(t_, FS_BODY).font_weight(W_MEDIUM).child(title)))
        .child(control)
        .when_some(hint, |d, h| d.child(text(t_, FS_SMALL).text_color(t_.text_mute).child(h)))
        .into_any_element()
}

fn chip(t_: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Transition<Stateful<Div>> {
    let (hover, edge, accent, wash, hot, dim) =
        (t_.hover_wash, t_.control_edge, t_.accent, t_.accent_wash, t_.accent_hot, t_.text_dim);
    let id = id.into();
    let el = text(t_, FS_SMALL)
        .id(id.clone())
        .h(px(t_.hit(26.)))
        .px(px(S_3))
        .flex()
        .items_center()
        .rounded(px(R_SM))
        .border_1()
        .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
        .when(!on, |d| d.cursor_pointer())
        .child(label.into());
    // `.ui-segment`: background and colour on --t-fast, the hover wash only while not selected.
    motion::hover(id, el, move |d, m| {
        d.bg(mix(mix(Rgb::TRANSPARENT, hover, m.hover * (1. - m.on)), wash, m.on))
            .border_color(mix(edge, accent, m.on))
            .text_color(mix(dim, hot, m.on))
    })
    .on(on)
}

/// A themed checkbox with its label, the whole row toggling it.
fn checkbox(t_: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Stateful<Div> {
    let id = id.into();
    let (edge, accent, ink) = (t_.control_edge, t_.accent, t_.on_accent);
    let mark = div().size(px(16.)).flex_none().flex().items_center().justify_center().rounded(px(R_SM)).border_1();
    // `.ui-checkbox-mark`: the fill on --t-fast, the tick fading in from 0.6 of its size.
    let mark = motion::toggle((id.clone(), "mark"), on, mark, move |d, m| {
        d.bg(mix(Rgb::TRANSPARENT, accent, m.on))
            .border_color(mix(edge, accent, m.on))
            .when(m.on > 0., |d| d.child(icon("check", 12. * (0.6 + 0.4 * m.on), ink).opacity(m.on)))
    });
    text(t_, FS_BODY)
        .id(id)
        .flex()
        .items_center()
        .gap(px(S_2))
        .min_h(px(t_.hit(24.)))
        .cursor_pointer()
        .font_weight(W_MEDIUM)
        .child(mark)
        .child(label.into())
}

pub(super) fn button(
    t_: &Theme,
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
) -> Transition<Stateful<Div>> {
    let (rest, hover) = if primary { (t_.accent, t_.accent_hot) } else { (t_.raised_2, t_.raised_2) };
    let id = id.into();
    let el = text(t_, FS_BODY)
        .id(id.clone())
        .h(px(t_.hit(28.)))
        .px(px(S_4))
        .flex()
        .items_center()
        .rounded(px(R_MD))
        .font_weight(W_MEDIUM)
        .cursor_pointer()
        .when(primary, |d| d.text_color(t_.on_accent))
        .child(label.into());
    hover_bg(id, el, rest, hover)
}
