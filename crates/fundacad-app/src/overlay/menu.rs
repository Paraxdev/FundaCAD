//! One menu piece for the menu bar and every right click menu, FundaCAD 1's ui/Menu.vue and _menu.scss.

use std::rc::Rc;

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Overlay;
use crate::commands;
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FLOAT_TILE_RADIUS, FS_BODY, FS_MICRO, S_1, S_2, S_3, S_4};
use crate::ui::{icon, text};

#[derive(Clone)]
pub enum Run {
    Command(SharedString),
    Call(Rc<dyn Fn(&mut Window, &mut App)>),
}

#[derive(Clone)]
pub struct MenuItem {
    pub label: SharedString,
    pub hint: Option<SharedString>,
    pub disabled: bool,
    pub checked: Option<bool>,
    pub run: Run,
}

impl MenuItem {
    /// A row for a command, its label, key and greying read from the command now.
    pub fn command(cx: &App, id: &str) -> Self {
        Self {
            label: commands::label(cx, id),
            hint: commands::hint(cx, id),
            disabled: !commands::enabled(cx, id),
            checked: None,
            run: Run::Command(SharedString::from(id.to_string())),
        }
    }

    pub fn call(label: impl Into<SharedString>, run: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        Self { label: label.into(), hint: None, disabled: false, checked: None, run: Run::Call(Rc::new(run)) }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(Clone)]
pub enum MenuRow {
    Item(MenuItem),
    Separator,
    Submenu { label: SharedString, rows: Vec<MenuRow> },
}

impl MenuRow {
    fn usable(&self) -> bool {
        match self {
            MenuRow::Item(i) => !i.disabled,
            MenuRow::Separator => false,
            MenuRow::Submenu { rows, .. } => rows.iter().any(MenuRow::usable),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum At {
    /// Under the menu bar title at this index.
    Bar(usize),
    Point(Point<Pixels>),
}

pub struct OpenMenu {
    pub rows: Vec<MenuRow>,
    pub at: At,
    pub active: Option<usize>,
    /// The open submenu's row and its own active row.
    pub sub: Option<(usize, Option<usize>)>,
}

impl OpenMenu {
    pub fn new(rows: Vec<MenuRow>, at: At) -> Self {
        Self { rows, at, active: None, sub: None }
    }
}

/// The next usable row from `from` in direction `step`, wrapping, None when there is none.
pub fn step(rows: &[MenuRow], from: Option<usize>, step: isize) -> Option<usize> {
    let n = rows.len() as isize;
    if n == 0 {
        return None;
    }
    let mut at = match from {
        Some(i) => i as isize,
        None if step > 0 => -1,
        None => n,
    };
    for _ in 0..n {
        at = (at + step).rem_euclid(n);
        if rows[at as usize].usable() {
            return Some(at as usize);
        }
    }
    None
}

impl Overlay {
    pub(super) fn open_menu(&mut self, menu: OpenMenu, window: &mut Window, cx: &mut Context<Self>) {
        self.take_keyboard(window, cx);
        self.menu = Some(menu);
        cx.notify();
    }

    pub(super) fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            self.release_keyboard(window, cx);
        }
    }

    /// Closes the menu, then runs the row once the overlay is no longer being updated.
    fn pick(&mut self, item: MenuItem, window: &mut Window, cx: &mut Context<Self>) {
        if item.disabled {
            return;
        }
        self.close_menu(window, cx);
        window.defer(cx, move |window, cx| match &item.run {
            Run::Command(id) => commands::run(id, window, cx),
            Run::Call(f) => f(window, cx),
        });
    }

    pub(super) fn menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(m) = &mut self.menu else { return };
        let in_sub = m.sub.and_then(|(row, active)| match &m.rows[row] {
            MenuRow::Submenu { rows, .. } => Some((row, active, rows.clone())),
            _ => None,
        });
        match (key, in_sub) {
            ("escape", Some((row, ..))) | ("left", Some((row, ..))) => {
                m.sub = None;
                m.active = Some(row);
            }
            ("escape", None) => return self.close_menu(window, cx),
            ("down" | "up", Some((row, active, rows))) => {
                m.sub = Some((row, step(&rows, active, if key == "down" { 1 } else { -1 })));
            }
            ("down" | "up", None) => {
                m.active = step(&m.rows, m.active, if key == "down" { 1 } else { -1 });
            }
            ("left" | "right", None) => {
                let open = m.active.filter(|&a| matches!(m.rows[a], MenuRow::Submenu { .. }));
                match (open, key, m.at) {
                    (Some(a), "right", _) => m.sub = Some((a, None)),
                    (_, _, At::Bar(i)) => {
                        let count = super::menubar::count();
                        let next = if key == "right" { (i + 1) % count } else { (i + count - 1) % count };
                        return self.open_bar(next, window, cx);
                    }
                    _ => return,
                }
            }
            ("enter" | "space", Some((_, Some(active), rows))) => {
                if let MenuRow::Item(item) = &rows[active] {
                    return self.pick(item.clone(), window, cx);
                }
            }
            ("enter" | "space", None) => match m.active.map(|a| (a, m.rows[a].clone())) {
                Some((_, MenuRow::Item(item))) => return self.pick(item, window, cx),
                Some((a, MenuRow::Submenu { .. })) => m.sub = Some((a, None)),
                _ => {}
            },
            _ => return,
        }
        cx.notify();
    }

    pub(super) fn render_point_menu(
        &mut self,
        t: &Theme,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let m = self.menu.as_ref()?;
        let position = match m.at {
            At::Point(p) => p,
            At::Bar(i) => super::menubar::anchor(i),
        };
        let popup = self.popup(t, cx);
        Some(deferred(anchored().position(position).snap_to_window_with_margin(px(4.)).child(popup)).into_any_element())
    }

    /// The open menu's card, its submenu beside it.
    pub(super) fn popup(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(m) = &self.menu else { return div().into_any_element() };
        let sub = m.sub;
        let mut card = card(t).on_mouse_down_out(cx.listener(|this, e: &MouseDownEvent, window, cx| {
            if let Some(At::Bar(i)) = this.menu.as_ref().map(|m| m.at) {
                this.closed_by = Some((i, e.position));
            }
            this.close_menu(window, cx);
        }));
        for (i, row) in m.rows.iter().enumerate() {
            let active = m.active == Some(i);
            card = card.child(match row {
                MenuRow::Separator => separator(t).into_any_element(),
                MenuRow::Item(item) => {
                    let item2 = item.clone();
                    row_element(t, ("row", i), &item.label, item.hint.clone(), item.checked, item.disabled, active)
                        .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| this.hover_row(i, None, cx)))
                        .on_click(cx.listener(move |this, _, window, cx| this.pick(item2.clone(), window, cx)))
                        .into_any_element()
                }
                MenuRow::Submenu { label, rows } => {
                    let open = sub.is_some_and(|(r, _)| r == i);
                    let mut el = row_element(t, ("row", i), label, None, None, !row.usable(), active || open)
                        .relative()
                        .child(icon("caretRight", 12., t.text_dim))
                        .on_mouse_move(
                            cx.listener(move |this, _: &MouseMoveEvent, _, cx| this.hover_row(i, Some(None), cx)),
                        );
                    if open {
                        let active_sub = sub.and_then(|(_, a)| a);
                        el = el.child(
                            div().absolute().top(px(-5.)).left_full().child(
                                anchored()
                                    .snap_to_window_with_margin(px(4.))
                                    .child(self.sub_card(t, i, rows, active_sub, cx)),
                            ),
                        );
                    }
                    el.into_any_element()
                }
            });
        }
        card.into_any_element()
    }

    fn sub_card(
        &self,
        t: &Theme,
        parent: usize,
        rows: &[MenuRow],
        active: Option<usize>,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut card = card(t).ml(px(4.));
        for (j, row) in rows.iter().enumerate() {
            card = card.child(match row {
                MenuRow::Item(item) => {
                    let item2 = item.clone();
                    row_element(
                        t,
                        ("sub", j),
                        &item.label,
                        item.hint.clone(),
                        item.checked,
                        item.disabled,
                        active == Some(j),
                    )
                    .on_mouse_move(
                        cx.listener(move |this, _: &MouseMoveEvent, _, cx| this.hover_row(parent, Some(Some(j)), cx)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| this.pick(item2.clone(), window, cx)))
                    .into_any_element()
                }
                _ => separator(t).into_any_element(),
            });
        }
        card
    }

    /// `sub` is None for a plain row, Some for a submenu row or a row inside it.
    fn hover_row(&mut self, row: usize, sub: Option<Option<usize>>, cx: &mut Context<Self>) {
        let Some(m) = &mut self.menu else { return };
        let (active, open) = match sub {
            None => (Some(row), None),
            Some(inner) => (Some(row), Some((row, inner))),
        };
        if m.active != active || m.sub != open {
            m.active = active;
            m.sub = open;
            cx.notify();
        }
    }
}

/// `.ui-menu`
pub fn card(t: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .min_w(px(168.))
        .p(px(5.))
        .rounded(px(FLOAT_TILE_RADIUS))
        .bg(t.panel)
        .border_1()
        .border_color(transparent_black())
        .shadow(t.float_shadow.clone())
        .text_color(t.text)
        .occlude()
}

fn separator(t: &Theme) -> Div {
    div().h(px(1.)).mx(px(S_2)).my(px(S_1)).bg(t.line)
}

/// `.ui-menu-item`: the check column, the label and the key.
fn row_element(
    t: &Theme,
    id: impl Into<ElementId>,
    label: &SharedString,
    hint: Option<SharedString>,
    checked: Option<bool>,
    disabled: bool,
    active: bool,
) -> Stateful<Div> {
    let wash = t.accent_wash;
    let hot = t.accent_hot;
    text(t, FS_BODY)
        .id(id)
        .flex()
        .items_center()
        .gap(px(S_3))
        .px(px(S_4))
        .py(px(S_2 - 2.))
        .rounded(px(FLOAT_CHIP_RADIUS))
        .whitespace_nowrap()
        .when(disabled, |d| d.opacity(0.45))
        .when(active && !disabled, move |d| d.bg(wash).text_color(hot))
        .when_some(checked, |d, on| {
            d.child(div().w(px(12.)).flex_none().when(on, |d| d.child(icon("check", 12., t.text))))
        })
        .child(div().flex_1().child(label.clone()))
        .when_some(hint, |d, h| d.child(text(t, FS_MICRO).flex_none().pl(px(S_4)).text_color(t.text_dim).child(h)))
}
