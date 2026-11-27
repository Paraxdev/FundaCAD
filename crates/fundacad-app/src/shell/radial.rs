//! Opens the radial menu, FundaCAD 1's FundaCAD.Navigation openRadial: the commands for what you are doing, on the
//! W key (held picks on release, tapped leaves the ring up to click) and the Alt+right drag the viewport reports.

#[cfg(test)]
mod tests;

use std::cell::RefCell;

use gpui::*;

use super::Shell;
use crate::commands::{self, register, Group};
use crate::overlay::radial::{self, RadialItem, Trigger};
use crate::overlay::MenuItem;
use crate::prefs::radial as prefs;
use crate::viewport::{CanvasGesture, Viewport};

pub const ACTION: &str = "navigation.radial";
/// More than this and the rest go in a "More" ring.
pub const RING_SLOTS: usize = 8;

/// FundaCAD 1's ICONS.
pub fn icon_of(id: &str) -> Option<&'static str> {
    Some(match id {
        "sketch" => "sketch",
        "extrude" | "sketch-extrude" => "extrude",
        "presspull" => "presspull",
        "measure" => "measure",
        "fit" => "view-fit",
        "reset-camera" => "view-reset",
        "toggle-wireframe" => "wireframe",
        "show-all-bodies" => "visible",
        "fillet" | "fillet-sketch" => "fillet",
        "chamfer" => "chamfer",
        "move" => "move",
        "split" => "split",
        "hide-selected" => "hidden",
        "line" => "line",
        "rectangle" => "rectangle",
        "circle" => "circle",
        "arc" => "arc",
        "dimension" => "dimension",
        "trim" => "trim",
        "offset" => "offset",
        "boolean-union" => "booleanUnion",
        "boolean-subtract" => "booleanSubtract",
        "boolean-intersect" => "booleanIntersect",
        "hole" => "hole",
        "shell" => "shell",
        "project" => "project",
        "undo" => "undo",
        "redo" => "redo",
        "section" => "section",
        _ => return None,
    })
}

/// A ring of `ids` with a command behind them, the overflow under "More". Ids with nothing behind them are left out.
pub fn ring_of<T>(ids: &[String], make: impl Fn(&str) -> Option<T>, more: impl FnOnce(Vec<T>) -> T) -> Vec<T> {
    let mut all: Vec<T> = ids.iter().filter(|id| !id.is_empty()).filter_map(|id| make(id)).collect();
    if all.len() <= RING_SLOTS {
        return all;
    }
    let rest = all.split_off(RING_SLOTS - 1);
    all.push(more(rest));
    all
}

fn items(viewport: &Entity<Viewport>, cx: &App) -> Vec<RadialItem> {
    let v = viewport.read(cx);
    let ids = prefs::items(prefs::context_of(v.sketching(), v.selection().picks.len()));
    let make = |id: &str| {
        commands::registered(cx, id).then(|| RadialItem::new(MenuItem::command(cx, id), icon_of(id)))
    };
    ring_of(&ids, make, |rest| RadialItem::group("More", Some("more"), rest))
}

thread_local! {
    /// The key of the keystroke being dispatched now, so the command knows whether its key is held.
    static TYPED: RefCell<Option<String>> = const { RefCell::new(None) };
    #[cfg(feature = "shot")]
    static VIEWPORT: RefCell<Option<WeakEntity<Viewport>>> = const { RefCell::new(None) };
}

fn bound_key(cx: &App) -> Option<String> {
    let (rows, _) = commands::rows(cx);
    rows.into_iter().find(|r| r.action == ACTION).and_then(|r| r.combo).map(|c| c.key)
}

pub(super) fn install(viewport: &Entity<Viewport>, window: &mut Window, cx: &mut Context<Shell>) {
    cx.subscribe_in(viewport, window, |this, _, e: &CanvasGesture, window, cx| match *e {
        CanvasGesture::Start(at) => {
            let items = items(&this.viewport, cx);
            radial::open_radial(window, cx, at, items, Some(Trigger::Button(MouseButton::Right)));
        }
        CanvasGesture::Release(at) => radial::radial_release(window, cx, MouseButton::Right, at),
    })
    .detach();
    // Note: GPUI skips keystroke observers when a key handler stops propagation (a field, the shortcut capture), so
    // the clear is deferred to the end of this dispatch instead, else a stale W makes a menu click open a held ring.
    cx.intercept_keystrokes(|e, _, cx| {
        TYPED.set(Some(e.keystroke.key.to_lowercase()));
        cx.defer(|_| TYPED.set(None));
    })
    .detach();
    #[cfg(feature = "shot")]
    VIEWPORT.set(Some(viewport.downgrade()));
    let v = viewport.clone();
    register(cx, ACTION, "Radial menu", Group::View, move |window, cx| {
        if radial::radial_open(cx) {
            return;
        }
        let typed = TYPED.with_borrow(Clone::clone);
        let held = typed.filter(|k| Some(k) == bound_key(cx).as_ref());
        let (items, at) = (items(&v, cx), window.mouse_position());
        radial::open_radial(window, cx, at, items, held.map(Trigger::Key));
    });
    commands::set_enabled(cx, ACTION, |_| prefs::on());
}

/// Opens the ring at `at` for click picking with item `hot` lit, for shots, no pointer moved.
#[cfg(feature = "shot")]
pub fn open_at(at: Point<Pixels>, hot: Option<usize>, window: &mut Window, cx: &mut App) {
    let Some(v) = VIEWPORT.with_borrow(Clone::clone).and_then(|v| v.upgrade()) else { return };
    let items = items(&v, cx);
    radial::open_radial(window, cx, at, items, None);
    if let Some(i) = hot {
        radial::light(cx, i);
    }
}
