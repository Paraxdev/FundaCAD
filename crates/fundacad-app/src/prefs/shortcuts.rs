//! FundaCAD 1's ShortcutsDialog, opened by `?` and Help > Keyboard Shortcuts: laid out like Preferences, a card per
//! group, a search over every row. A key is changed by clicking it and pressing the new one.

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::tooltip::Tooltip;

use super::view::button;
use crate::commands::keymap::{self, Clash, Problem};
use crate::commands::keys::{Combo, Ctx, Shortcut};
use crate::commands::{self, MODAL};
use crate::i18n::{t, tr};
use crate::motion::{self, hover_bg, mix};
use crate::theme::{
    ActiveTheme as _, Rgb, Theme, FS_MICRO, FS_SMALL, R_LG, R_SM, S_0, S_1, S_2, S_3, S_4, S_5, W_MEDIUM,
    W_SEMIBOLD,
};
use crate::ui::{icon, solid_card, text};

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub label: String,
    pub changed: bool,
    /// None for a row that cannot be changed here.
    pub id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    /// A catalog key.
    pub name: &'static str,
    pub rows: Vec<Row>,
}

impl Group {
    pub fn wide(&self) -> bool {
        matches!(self.name, "shortcuts.group.conflicts" | "shortcuts.group.mouse" | "shortcuts.group.always")
    }
}

fn fixed(key: impl Into<String>, label: String) -> Row {
    Row { key: key.into(), label, changed: false, id: None }
}

fn gesture(button: &str, kind: &str) -> String {
    tr!("shortcuts.mouse.gesture", button = button, kind = kind)
}

/// The dialog's General page, generated from the table so it cannot drift from the dispatcher.
pub fn groups(rows: &[Shortcut], problems: &[Problem], user: &[keymap::UserKey]) -> Vec<Group> {
    let mut out = Vec::new();
    let clashes: Vec<Row> = problems
        .iter()
        .filter_map(|p| match p {
            Problem::Conflict { first, second, key, .. } => {
                Some(fixed(key.clone(), tr!("shortcuts.conflict", first = *first, second = *second)))
            }
            _ => None,
        })
        .collect();
    if !clashes.is_empty() {
        out.push(Group { name: "shortcuts.group.conflicts", rows: clashes });
    }
    for (name, ctx) in
        [("shortcuts.group.model", Ctx::Model), ("tool.sketch", Ctx::Sketch), ("shortcuts.group.global", Ctx::Global)]
    {
        let rows: Vec<Row> = rows
            .iter()
            .filter(|r| r.context == ctx)
            .map(|r| Row {
                key: r.combo.as_ref().map(Combo::to_string).unwrap_or_default(),
                label: r.label.to_owned(),
                changed: user.iter().any(|u| u.id == r.id),
                id: (!r.fixed).then(|| r.id.clone()),
            })
            .collect();
        if !rows.is_empty() {
            out.push(Group { name, rows });
        }
    }
    out.push(Group {
        name: "shortcuts.group.mouse",
        rows: vec![
            fixed(gesture("right", "drag"), t("shortcuts.mouse.orbit")),
            fixed(tr!("shortcuts.mouse.gestureHeld", mods = "Shift", button = "right", kind = "drag"), t("shortcuts.mouse.pan")),
            fixed(gesture("middle", "drag"), t("shortcuts.mouse.pan")),
            fixed(t("shortcuts.mouse.wheel"), t("shortcuts.mouse.zoom")),
            fixed(gesture("left", "drag"), t("shortcuts.mouse.boxSelect")),
            fixed(gesture("left", "click"), t("shortcuts.mouse.pick")),
        ],
    });
    out.push(Group {
        name: "shortcuts.group.always",
        rows: vec![
            fixed("Ctrl+K", t("shortcuts.always.palette")),
            fixed("Ctrl+Z / Ctrl+Y", t("shortcuts.always.undoRedo")),
            fixed("Ctrl+S / Ctrl+Shift+S", t("shortcuts.always.save")),
            fixed("Ctrl+N / Ctrl+O / Ctrl+E", t("shortcuts.always.newOpenExport")),
            fixed("Ctrl+= / Ctrl+- / Ctrl+0", t("shortcuts.always.size")),
            fixed("Del", t("shortcuts.always.delete")),
            fixed("Esc", t("shortcuts.always.cancel")),
            fixed(t("shortcuts.mouse.drag"), t("shortcuts.always.drag")),
            fixed(format!("Shift+{}", t("shortcuts.mouse.drag")), t("shortcuts.always.dragAdd")),
            fixed("Tab", t("shortcuts.always.tab")),
        ],
    });
    out
}

/// The groups with only the rows whose name or key holds `query`, empty groups dropped.
pub fn filter(groups: Vec<Group>, query: &str) -> Vec<Group> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return groups;
    }
    groups
        .into_iter()
        .map(|mut g| {
            g.rows.retain(|r| format!("{} {}", r.label, r.key).to_lowercase().contains(&q));
            g
        })
        .filter(|g| !g.rows.is_empty())
        .collect()
}

/// A key that could not be set as asked, shown under its row.
struct Pending {
    id: String,
    words: String,
    /// The key and the row that has it, for Replace.
    replace: Option<(Combo, String)>,
}

pub struct ShortcutsWindow {
    focus: FocusHandle,
    restore: Option<FocusHandle>,
    search: Entity<InputState>,
    /// The row whose new key the next press sets.
    capturing: Option<String>,
    pending: Option<Pending>,
    _events: Subscription,
}

#[derive(Default)]
struct Open(Option<Entity<ShortcutsWindow>>);

impl Global for Open {}

pub fn view(cx: &App) -> Option<Entity<ShortcutsWindow>> {
    cx.try_global::<Open>()?.0.clone()
}

pub fn toggle(window: &mut Window, cx: &mut App) {
    if view(cx).is_some() {
        return close(window, cx);
    }
    let restore = window.focused(cx);
    let entity = cx.new(|cx| {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(t("shortcuts.search")));
        let events = cx.subscribe(&search, |_, _, e: &InputEvent, cx| {
            if matches!(e, InputEvent::Change) {
                cx.notify();
            }
        });
        ShortcutsWindow { focus: cx.focus_handle(), restore, search, capturing: None, pending: None, _events: events }
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

impl ShortcutsWindow {
    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().to_string()
    }

    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = k.modifiers;
        let bare = !(m.control || m.platform || m.shift || m.alt);
        if let Some(id) = self.capturing.clone() {
            cx.stop_propagation();
            if k.key == "escape" && bare {
                self.capturing = None;
            } else {
                match keymap::combo_of(&k.key, k.key_char.as_deref(), m.control || m.platform, m.shift, m.alt) {
                    Ok(None) => return,
                    Ok(Some(combo)) => self.offer(id, combo, cx),
                    Err(_) => {
                        self.capturing = None;
                        self.pending = Some(Pending { id, words: t("shortcuts.problem.alt"), replace: None });
                    }
                }
            }
            cx.notify();
        } else if k.key == "escape" && bare {
            cx.stop_propagation();
            if self.pending.take().is_some() {
            } else if !self.query(cx).is_empty() {
                self.search.update(cx, |s, cx| s.set_value("", window, cx));
                window.focus(&self.focus, cx);
            } else {
                close(window, cx);
            }
            cx.notify();
        }
    }

    fn offer(&mut self, id: String, combo: Combo, cx: &mut Context<Self>) {
        self.capturing = None;
        let (rows, _) = commands::rows(cx);
        self.pending = match keymap::clash(&rows, &id, &combo) {
            None => return self.commit(&id, Some(&combo), None, cx),
            Some(Clash::Taken { by }) => {
                Some(Pending { id, words: tr!("shortcuts.problem.taken", keys = combo.to_string(), action = by), replace: None })
            }
            Some(Clash::Used { by, id: other }) => Some(Pending {
                id,
                words: tr!("shortcuts.problem.used", keys = combo.to_string(), action = by),
                replace: Some((combo, other)),
            }),
        };
    }

    fn commit(&mut self, id: &str, combo: Option<&Combo>, replaced: Option<&str>, cx: &mut Context<Self>) {
        let user = keymap::rebind(&commands::user_keys(cx), id, combo, replaced);
        commands::set_user_keys(cx, &user);
        (self.capturing, self.pending) = (None, None);
        cx.notify();
    }

    fn reset(&mut self, ids: &[String], cx: &mut Context<Self>) {
        let user = ids.iter().fold(commands::user_keys(cx), |u, id| keymap::reset(&u, id));
        commands::set_user_keys(cx, &user);
        self.pending = None;
        cx.notify();
    }

    fn row(&self, t_: &Theme, g: usize, i: usize, r: &Row, mine: bool, cx: &mut Context<Self>) -> AnyElement {
        let capturing = r.id.is_some() && self.capturing == r.id;
        let tag = |key: &str| text(t_, FS_MICRO).text_color(t_.accent).child(t(key));
        let kbd = |s: String| {
            text(t_, FS_SMALL)
                .min_w(px(64.))
                .px(px(S_2))
                .py(px(S_0))
                .flex()
                .justify_center()
                .rounded(px(R_SM))
                .border_1()
                .border_b_2()
                .border_color(t_.line_strong)
                .bg(t_.bg)
                .text_color(t_.accent_hot)
                .child(s)
        };
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(S_3))
            .gap_y(px(S_2))
            .min_h(px(30.))
            .child(text(t_, FS_SMALL).flex_1().min_w_0().text_color(t_.text_dim).child(r.label.clone()))
            .when(r.changed, |d| d.child(tag("shortcuts.changed")));
        match &r.id {
            None => {
                row = row.child(kbd(r.key.clone())).child(text(t_, FS_MICRO).text_color(t_.text_mute).child(t("shortcuts.fixed")));
            }
            Some(id) => {
                let (shown, unset) = match (capturing, r.key.is_empty()) {
                    (true, _) => (t("shortcuts.pressKeys"), false),
                    (false, true) => (t("shortcuts.notSet"), true),
                    (false, false) => (r.key.clone(), false),
                };
                let (line, accent, tint) = (t_.line_strong, t_.accent, t_.accent_tint);
                let key_id = SharedString::from(format!("sc-key:{id}"));
                let el = text(t_, FS_SMALL)
                    .id(key_id)
                    .min_w(px(64.))
                    .h(px(t_.hit(26.)))
                    .px(px(S_2))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(R_SM))
                    .border_1()
                    .border_b_2()
                    .cursor_pointer()
                    .text_color(if unset { t_.text_mute } else { t_.accent_hot })
                    .child(shown);
                let bg = t_.bg;
                let pick = id.clone();
                let tip = t(if capturing { "shortcuts.captureTip" } else { "shortcuts.changeTip" });
                let el = el
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        (this.capturing, this.pending) = (Some(pick.clone()), None);
                        window.focus(&this.focus, cx);
                        cx.notify();
                    }));
                row = row.child(
                    motion::hover(SharedString::from(format!("sc-key-bg:{id}")), el, move |d, m| {
                        d.bg(mix(bg, tint, m.on)).border_color(mix(mix(line, accent, m.hover), accent, m.on))
                    })
                    .on(capturing),
                );
                if capturing {
                    let clear = id.clone();
                    row = row.child(link(t_, ("sc-clear", g * 1000 + i), t("shortcuts.clear")).on_click(cx.listener(
                        move |this, _, _, cx| this.commit(&clear, None, None, cx),
                    )));
                }
                if mine {
                    let reset = id.clone();
                    row = row.child(
                        link(t_, ("sc-reset", g * 1000 + i), t("shortcuts.reset"))
                            .on_click(cx.listener(move |this, _, _, cx| this.reset(std::slice::from_ref(&reset), cx))),
                    );
                }
            }
        }
        if let Some(p) = self.pending.as_ref().filter(|p| Some(&p.id) == r.id.as_ref()) {
            let replace = p.replace.is_some();
            row = row.child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(S_2))
                    .px(px(S_3))
                    .py(px(S_1))
                    .border_l_2()
                    .border_color(t_.accent)
                    .child(text(t_, FS_SMALL).flex_1().child(p.words.clone()))
                    .when(replace, |d| {
                        d.child(button(t_, "sc-replace", t("shortcuts.replace"), true).on_click(cx.listener(|this, _, _, cx| {
                            if let Some(Pending { id, replace: Some((combo, other)), .. }) = this.pending.take() {
                                this.commit(&id, Some(&combo), Some(&other), cx);
                            }
                        })))
                    })
                    .child(button(t_, "sc-cancel", t("shortcuts.cancel"), false).on_click(cx.listener(|this, _, _, cx| {
                        this.pending = None;
                        cx.notify();
                    }))),
            );
        }
        row.into_any_element()
    }
}

fn link(t_: &Theme, id: impl Into<ElementId>, label: String) -> Stateful<Div> {
    text(t_, 12.).id(id).text_color(t_.text_dim).underline().cursor_pointer().hover(|d| d.text_color(t_.text)).child(label)
}

impl Render for ShortcutsWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t_ = cx.theme().clone();
        let t_ = &t_;
        let mut context = KeyContext::default();
        context.add(MODAL);
        let (rows, problems) = commands::rows(cx);
        let user = commands::user_keys(cx);
        let query = self.query(cx);
        let all = groups(&rows, &problems, &user);
        let resettable: Vec<String> =
            all.iter().flat_map(|g| &g.rows).filter(|r| r.changed).filter_map(|r| r.id.clone()).collect();
        let shown = filter(all, &query);
        let searching = !query.trim().is_empty();
        let mine = |r: &Row| r.id.as_ref().is_some_and(|id| user.iter().any(|u| &u.id == id));

        let nav = {
            let on = !searching;
            let el = text(t_, 14.)
                .id("sc-page-general")
                .px(px(S_3))
                .py(px(S_2))
                .rounded(px(R_LG))
                .border_1()
                .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
                .cursor_pointer()
                .child(t("shortcuts.page.general"));
            let (wash, tint, tint2, dim, hot) = (t_.hover_wash, t_.accent_tint, t_.accent_tint_2, t_.text_dim, t_.accent_hot);
            motion::hover("sc-page-general-bg", el, move |d, m| {
                d.bg(mix(mix(Rgb::TRANSPARENT, wash, m.hover), tint, m.on))
                    .border_color(mix(Rgb::TRANSPARENT, tint2, m.on))
                    .text_color(mix(dim, hot, m.on))
            })
            .on(on)
            .on_click(cx.listener(|this, _, window, cx| {
                this.search.update(cx, |s, cx| s.set_value("", window, cx));
                cx.notify();
            }))
        };

        let cards = shown.iter().enumerate().map(|(gi, g)| {
            let rows: Vec<AnyElement> = g.rows.iter().enumerate().map(|(i, r)| self.row(t_, gi, i, r, mine(r), cx)).collect();
            div()
                .when(g.wide(), |d| d.w_full())
                .when(!g.wide(), |d| d.flex_1().min_w(px(290.)))
                .flex()
                .flex_col()
                .gap(px(S_2))
                .p(px(S_4))
                .rounded(px(8.))
                .border_1()
                .border_color(t_.line)
                .bg(t_.panel_2)
                .child(div().min_h(px(30.)).flex().items_center().child(text(t_, 14.).font_weight(W_SEMIBOLD).child(t(g.name))))
                .children(rows)
        }).collect::<Vec<_>>();
        let head = div()
            .flex()
            .items_baseline()
            .justify_between()
            .gap(px(S_3))
            .mb(px(S_3))
            .child(text(t_, 18.).font_weight(W_SEMIBOLD).child(t("shortcuts.page.general")))
            .when(!searching && !resettable.is_empty(), |d| {
                d.child(button(t_, "sc-reset-all", t("shortcuts.resetAll"), false).on_click(cx.listener(move |this, _, _, cx| {
                    this.reset(&resettable, cx)
                })))
            });
        let pane = div()
            .id("sc-pane")
            .flex_1()
            .min_w_0()
            .overflow_y_scroll()
            .p(px(S_5))
            .child(
                div()
                    .my(px(S_2))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(t_.line)
                    .bg(t_.panel_2)
                    .child(Input::new(&self.search).appearance(false).bordered(false).focus_bordered(false).text_size(px(12.))),
            )
            .when(shown.is_empty(), |d| d.child(text(t_, 12.5).text_color(t_.text_mute).child(t("shortcuts.empty"))))
            .when(!shown.is_empty(), |d| d.child(head).child(div().flex().flex_wrap().gap(px(S_3)).children(cards)));

        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(hsla(0., 0., 0., 0.45))
            .occlude()
            .id("sc-scrim")
            .on_click(|_, w, cx| close(w, cx))
            .child(
                solid_card(t_)
                    .id("shortcuts")
                    .track_focus(&self.focus)
                    .key_context(context)
                    .on_key_down(cx.listener(Self::on_key))
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .w(px(960.))
                    .h(px(680.))
                    .max_w(relative(0.94))
                    .max_h(relative(0.88))
                    .bg(t_.panel)
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .px(px(S_4))
                            .pt(px(S_4))
                            .pb(px(S_2))
                            .child(text(t_, 16.).flex_1().font_weight(W_SEMIBOLD).child(t("shortcuts.title")))
                            .child(
                                hover_bg("sc-close", div().id("sc-close").p(px(S_1)).rounded(px(R_SM)).cursor_pointer(), Rgb::TRANSPARENT, t_.raised_2)
                                    .child(icon("close", 16., t_.text_dim))
                                    .on_click(|_, w, cx| close(w, cx)),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_h_0()
                            .child(
                                div()
                                    .w(px(190.))
                                    .flex_none()
                                    .flex()
                                    .flex_col()
                                    .gap(px(S_1))
                                    .px(px(S_3))
                                    .py(px(S_4))
                                    .border_r_1()
                                    .border_color(t_.line)
                                    .child(nav),
                            )
                            .child(pane),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .px(px(S_4))
                            .py(px(S_3))
                            .child(button(t_, "sc-done", t("shortcuts.done"), true).on_click(|_, w, cx| close(w, cx))),
                    ),
            )
    }
}
