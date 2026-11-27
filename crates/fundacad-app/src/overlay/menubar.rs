//! The title bar's File, Edit, View and Help menus, FundaCAD 1's app/menubarDef.ts and shell/MenuBar.vue.

use std::cell::RefCell;

use gpui::*;

use super::menu::{At, OpenMenu};
use super::{handle, MenuItem, MenuRow, Overlay};
use crate::files;
use crate::i18n::{t, tr};
use crate::motion::{self, mix};
use crate::theme::{Rgb, Theme, FS_BODY, S_4};
use crate::ui::text;

const TITLES: [&str; 4] = ["menu.file", "menu.edit", "menu.view", "menu.help"];
const RECENT_SHOWN: usize = 15;

thread_local! {
    /// Where each title was drawn last frame, the bar menu opens under it.
    static PLACED: RefCell<[Bounds<Pixels>; 4]> = RefCell::new([Bounds::default(); 4]);
}

pub fn count() -> usize {
    TITLES.len()
}

/// Where the menu of title `i` opens, in window coordinates.
pub fn anchor(i: usize) -> Point<Pixels> {
    PLACED.with(|p| p.borrow().get(i).map_or_else(Point::default, |b| b.bottom_left() + point(px(0.), px(6.))))
}

fn item(cx: &App, id: &str) -> MenuRow {
    MenuRow::Item(MenuItem::command(cx, id))
}

fn recent_rows(cx: &App) -> Vec<MenuRow> {
    let list = files::recent::list(cx);
    if list.is_empty() {
        return vec![MenuRow::Item(MenuItem::call(t("menu.file.noRecent"), |_, _| {}).disabled(true))];
    }
    let mut rows: Vec<MenuRow> = list
        .into_iter()
        .take(RECENT_SHOWN)
        .map(|r| {
            let name = r.path.file_name().map_or_else(|| r.path.display().to_string(), |n| n.to_string_lossy().into());
            let path = r.path;
            MenuRow::Item(MenuItem::call(name, move |window, cx| files::open_recent_path(path.clone(), window, cx)))
        })
        .collect();
    rows.push(MenuRow::Separator);
    rows.push(MenuRow::Item(MenuItem::call(t("menu.file.clearRecent"), |_, cx| files::recent::clear(cx))));
    rows
}

/// The rows of each menu, read again every time one opens.
pub fn menus(cx: &App) -> [Vec<MenuRow>; 4] {
    let views = ["front", "back", "left", "right", "top", "bottom", "iso"];
    [
        vec![
            item(cx, "new"),
            item(cx, "open").label_more(),
            MenuRow::Submenu { label: t("menu.file.openRecent").into(), rows: recent_rows(cx) },
            MenuRow::Separator,
            item(cx, "save"),
            item(cx, "save-as").label_more(),
            MenuRow::Separator,
            item(cx, "import").label_more(),
            item(cx, "insert-document").label_more(),
            item(cx, "export").label_more(),
            item(cx, "check-links"),
        ],
        vec![
            item(cx, "undo"),
            item(cx, "redo"),
            MenuRow::Separator,
            item(cx, "delete"),
            MenuRow::Separator,
            item(cx, "palette"),
            item(cx, "preferences").label_more(),
        ],
        std::iter::once(item(cx, "fit"))
            .chain([item(cx, "reset-camera"), MenuRow::Separator])
            .chain(views.iter().map(|id| item(cx, id)))
            .collect(),
        vec![
            item(cx, "shortcut-help"),
            MenuRow::Separator,
            item(cx, "manual"),
            item(cx, "issues"),
            item(cx, "report-problem").label_more(),
            item(cx, "console"),
            MenuRow::Separator,
            item(cx, "check-updates"),
            item(cx, "about"),
        ],
    ]
}

trait More {
    fn label_more(self) -> Self;
}

impl More for MenuRow {
    /// FundaCAD 1 ends a row that opens a dialog with an ellipsis.
    fn label_more(self) -> Self {
        match self {
            MenuRow::Item(i) => {
                let label = format!("{}…", i.label);
                MenuRow::Item(i.label(label))
            }
            other => other,
        }
    }
}

impl Overlay {
    pub(super) fn open_bar(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rows) = menus(cx).into_iter().nth(i) else { return };
        self.open_menu(OpenMenu::new(rows, At::Bar(i)), window, cx);
    }

    fn open_bar_index(&self) -> Option<usize> {
        match self.menu.as_ref()?.at {
            At::Bar(i) => Some(i),
            At::Point(_) => None,
        }
    }
}

/// The four titles for the title bar.
pub fn menubar(t: &Theme, cx: &App) -> Div {
    let open = handle(cx).and_then(|o| o.read(cx).open_bar_index());
    let mut bar = div().flex().items_center();
    for (i, label) in TITLES.into_iter().enumerate() {
        let hover = t.raised;
        let wash = t.accent_wash;
        let el = text(t, FS_BODY)
                .id(label)
                .relative()
                .h(px(20.))
                .px(px(S_4))
                .mx(px(1.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .child(tr!(label))
                .child(
                    canvas(move |bounds, _, _| PLACED.with(|p| p.borrow_mut()[i] = bounds), |_, _, _, _| {})
                        .absolute()
                        .size_full(),
                )
                .on_mouse_down(MouseButton::Left, move |e, window, cx| {
                    let Some(overlay) = handle(cx) else { return };
                    overlay.update(cx, |o, cx| {
                        if o.closed_by.take() == Some((i, e.position)) {
                            return;
                        }
                        if o.open_bar_index() == Some(i) {
                            o.close_menu(window, cx);
                        } else {
                            o.open_bar(i, window, cx);
                        }
                    });
                })
                .on_mouse_move(move |_, window, cx| {
                    let Some(overlay) = handle(cx) else { return };
                    overlay.update(cx, |o, cx| {
                        if o.open_bar_index().is_some_and(|at| at != i) {
                            o.open_bar(i, window, cx);
                        }
                    });
                });
        let el = motion::hover(("bar-lit", i), el, move |d, m| {
            d.bg(mix(mix(Rgb::TRANSPARENT, hover, m.hover * (1. - m.on)), wash, m.on))
        });
        bar = bar.child(el.on(open == Some(i)));
    }
    bar
}
