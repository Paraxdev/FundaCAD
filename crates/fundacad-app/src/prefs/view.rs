//! The Preferences window, FundaCAD 1's PreferencesDialog: categories down the left, the open one's cards on the
//! right. It holds the keyboard while open, and a shortcut being changed takes the next key pressed.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::{Background, SIZES};
use crate::commands::keymap::{self, Clash};
use crate::commands::keys::{Combo, Ctx, Shortcut};
use crate::commands::{self, MODAL};
use crate::i18n::{self, t, tr};
use crate::theme::{
    self, ActiveTheme as _, Contrast, Theme, FS_BODY, FS_SMALL, FS_TITLE, R_MD, R_SM, S_0, S_1, S_2, S_3, S_4,
};
use crate::theme::{W_MEDIUM, W_SEMIBOLD};
use crate::ui::{icon, solid_card, text};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab {
    Appearance,
    Viewport,
    Access,
    Shortcuts,
}

impl Tab {
    const ALL: [Tab; 4] = [Tab::Appearance, Tab::Viewport, Tab::Access, Tab::Shortcuts];

    fn label(self) -> String {
        t(match self {
            Tab::Appearance => "prefs.tab.appearance",
            Tab::Viewport => "prefs.tab.viewport",
            Tab::Access => "prefs.tab.access",
            Tab::Shortcuts => "shortcuts.title",
        })
    }
}

/// A key another row has, waiting on Replace or Cancel.
struct Ask {
    id: String,
    combo: Combo,
    other: String,
    by: &'static str,
}

pub struct PrefsWindow {
    tab: Tab,
    focus: FocusHandle,
    restore: Option<FocusHandle>,
    /// The row whose new key the next press sets.
    recording: Option<String>,
    ask: Option<Ask>,
    note: Option<String>,
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
        recording: None,
        ask: None,
        note: None,
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
        let bare = !(m.control || m.platform || m.shift || m.alt);
        if let Some(id) = self.recording.clone() {
            cx.stop_propagation();
            if k.key == "escape" && bare {
                self.recording = None;
            } else {
                match keymap::combo_of(&k.key, k.key_char.as_deref(), m.control || m.platform, m.shift, m.alt) {
                    Ok(None) => return,
                    Ok(Some(combo)) => self.offer(id, combo, cx),
                    Err(_) => {
                        self.recording = None;
                        self.note = Some(t("shortcuts.problem.alt"));
                    }
                }
            }
            cx.notify();
        } else if k.key == "escape" && bare {
            cx.stop_propagation();
            if self.ask.take().is_none() {
                close(window, cx);
            }
            cx.notify();
        }
    }

    fn offer(&mut self, id: String, combo: Combo, cx: &mut Context<Self>) {
        self.recording = None;
        let (rows, _) = commands::rows(cx);
        match keymap::clash(&rows, &id, &combo) {
            None => self.commit(&id, Some(&combo), None, cx),
            Some(Clash::Taken { by }) => {
                self.note = Some(tr!("shortcuts.problem.taken", keys = combo.to_string(), action = by));
            }
            Some(Clash::Used { by, id: other }) => self.ask = Some(Ask { id, combo, other, by }),
        }
    }

    fn commit(&mut self, id: &str, combo: Option<&Combo>, replaced: Option<&str>, cx: &mut Context<Self>) {
        let user = keymap::rebind(&commands::user_keys(cx), id, combo, replaced);
        commands::set_user_keys(cx, &user);
        (self.ask, self.note) = (None, None);
        cx.notify();
    }

    fn reset(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        let user = id.map_or_else(Vec::new, |id| keymap::reset(&commands::user_keys(cx), id));
        commands::set_user_keys(cx, &user);
        if id.is_none() {
            self.note = Some(t("shortcuts.resetPage.done"));
        }
        cx.notify();
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

    fn shortcuts(&self, t_: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let (rows, problems) = commands::rows(cx);
        let user = commands::user_keys(cx);
        let mut out = Vec::new();
        if let Some(ask) = &self.ask {
            let line = tr!("shortcuts.problem.used", keys = ask.combo.to_string(), action = ask.by);
            let buttons = div()
                .flex()
                .gap(px(S_2))
                .child(button(t_, "replace", t("shortcuts.replace"), true).on_click(cx.listener(|this, _, _, cx| {
                    if let Some(a) = this.ask.take() {
                        this.commit(&a.id, Some(&a.combo), Some(&a.other), cx);
                    }
                })))
                .child(button(t_, "cancel", t("shortcuts.cancel"), false).on_click(cx.listener(|this, _, _, cx| {
                    this.ask = None;
                    cx.notify();
                })));
            out.push(card(t_, line, None, buttons.into_any_element()));
        } else if let Some(note) = &self.note {
            out.push(text(t_, FS_SMALL).text_color(t_.warn).child(note.clone()).into_any_element());
        }
        let clashes = problems.iter().filter(|p| matches!(p, keymap::Problem::Conflict { .. }));
        out.extend(clashes.map(|p| {
            let keymap::Problem::Conflict { first, second, .. } = p else { unreachable!() };
            let line = tr!("shortcuts.conflict", first = *first, second = *second);
            text(t_, FS_SMALL).text_color(t_.warn).child(line).into_any_element()
        }));
        out.push(
            div()
                .flex()
                .justify_end()
                .child(
                    button(t_, "reset-all", t("shortcuts.resetAll"), false)
                        .on_click(cx.listener(|this, _, _, cx| this.reset(None, cx))),
                )
                .into_any_element(),
        );
        let lines = rows.iter().enumerate().map(|(i, r)| {
            let changed = user.iter().any(|u| u.id == r.id);
            self.shortcut_row(t_, i, r, changed, cx)
        });
        out.push(div().flex().flex_col().children(lines).into_any_element());
        out
    }

    fn shortcut_row(&self, t_: &Theme, i: usize, r: &Shortcut, changed: bool, cx: &mut Context<Self>) -> AnyElement {
        let recording = self.recording.as_deref() == Some(r.id.as_str());
        let shown =
            if recording { "…".to_string() } else { r.combo.as_ref().map(Combo::to_string).unwrap_or_default() };
        let place = t(match r.context {
            Ctx::Model => "shortcuts.group.model",
            Ctx::Sketch => "tool.sketch",
            Ctx::Global => "shortcuts.group.global",
        });
        let tag = if r.fixed { Some(t("shortcuts.fixed")) } else { changed.then(|| t("shortcuts.changed")) };
        let key = text(t_, FS_SMALL)
            .id(("key", i))
            .w(px(120.))
            .h(px(t_.hit(24.)))
            .px(px(S_2))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(R_SM))
            .border_1()
            .border_color(if recording { t_.accent } else { t_.control_edge })
            .font_weight(W_MEDIUM)
            .child(shown);
        let key = if r.fixed {
            key.opacity(0.6).into_any_element()
        } else {
            let id = r.id.clone();
            key.cursor_pointer()
                .hover(|s| s.bg(t_.raised_2))
                .on_click(cx.listener(move |this, _, _, cx| {
                    (this.recording, this.ask, this.note) = (Some(id.clone()), None, None);
                    cx.notify();
                }))
                .into_any_element()
        };
        let id = r.id.clone();
        div()
            .flex()
            .items_center()
            .gap(px(S_2))
            .py(px(S_0))
            .border_b_1()
            .border_color(t_.line)
            .child(text(t_, FS_BODY).flex_1().min_w_0().truncate().child(r.label))
            .child(text(t_, FS_SMALL).w(px(64.)).text_color(t_.text_mute).child(place))
            .child(text(t_, FS_SMALL).w(px(56.)).text_color(t_.text_dim).children(tag))
            .child(key)
            .child(div().w(px(56.)).when(changed && !r.fixed, |d| {
                d.child(
                    button(t_, ("reset", i), t("shortcuts.reset"), false)
                        .on_click(cx.listener(move |this, _, _, cx| this.reset(Some(&id), cx))),
                )
            }))
            .into_any_element()
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
            Tab::Shortcuts => self.shortcuts(t_, cx),
        };
        let nav = Tab::ALL.into_iter().enumerate().map(|(i, tab)| {
            let on = tab == self.tab;
            text(t_, FS_BODY)
                .id(("tab", i))
                .px(px(S_3))
                .h(px(t_.hit(30.)))
                .flex()
                .items_center()
                .rounded(px(R_MD))
                .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
                .text_color(if on { t_.text } else { t_.text_dim })
                .when(on, |d| d.bg(t_.accent_wash))
                .when(!on, |d| d.cursor_pointer().hover(|s| s.bg(t_.hover_wash)))
                .child(tab.label())
                .on_click(cx.listener(move |this, _, _, cx| {
                    (this.tab, this.recording, this.ask, this.note) = (tab, None, None, None);
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

fn chip(t_: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Stateful<Div> {
    let hover = t_.hover_wash;
    text(t_, FS_SMALL)
        .id(id)
        .h(px(t_.hit(26.)))
        .px(px(S_3))
        .flex()
        .items_center()
        .rounded(px(R_SM))
        .border_1()
        .border_color(if on { t_.accent } else { t_.control_edge })
        .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
        .text_color(if on { t_.accent_hot } else { t_.text_dim })
        .when(on, |d| d.bg(t_.accent_wash))
        .when(!on, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
        .child(label.into())
}

/// A themed checkbox with its label, the whole row toggling it.
fn checkbox(t_: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, on: bool) -> Stateful<Div> {
    let mark = div()
        .size(px(16.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(R_SM))
        .border_1()
        .border_color(if on { t_.accent } else { t_.control_edge })
        .when(on, |d| d.bg(t_.accent).child(icon("check", 12., t_.on_accent)));
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

fn button(t_: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>, primary: bool) -> Stateful<Div> {
    let hover = if primary { t_.accent_hot } else { t_.raised_2 };
    text(t_, FS_BODY)
        .id(id)
        .h(px(t_.hit(28.)))
        .px(px(S_4))
        .flex()
        .items_center()
        .rounded(px(R_MD))
        .font_weight(W_MEDIUM)
        .cursor_pointer()
        .map(|d| if primary { d.bg(t_.accent).text_color(t_.on_accent) } else { d.bg(t_.raised_2) })
        .hover(move |s| s.bg(hover))
        .child(label.into())
}
