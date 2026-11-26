//! What floats over the whole workspace: menus (the menu bar's and right click ones), the command palette, the
//! confirm dialog and the toasts. One entity holds them, the shell draws it last, and anything opened through the
//! functions here takes the keyboard until it closes.

mod confirm;
mod menu;
mod menubar;
mod palette;
mod score;
#[cfg(test)]
mod tests;
mod toast;

use gpui::prelude::FluentBuilder as _;
use gpui::*;

pub use confirm::Choice;
pub use menu::{MenuItem, MenuRow};
pub use menubar::menubar;
pub use toast::Toast;

use crate::commands::MODAL;
use crate::theme::ActiveTheme as _;

pub struct Overlay {
    menu: Option<menu::OpenMenu>,
    palette: Option<palette::Palette>,
    confirm: Option<confirm::Confirm>,
    toasts: toast::Stack,
    focus: FocusHandle,
    /// Where the keyboard was before the first overlay opened, given back when the last one closes.
    restore: Option<FocusHandle>,
    /// A press outside the open bar menu closed it, so the same press on its own title must not open it again.
    closed_by: Option<(usize, Point<Pixels>)>,
}

struct Handle(WeakEntity<Overlay>);

impl Global for Handle {}

pub fn init(cx: &mut App) {
    palette::bind(cx);
}

/// Made with the shell, which draws it.
pub fn new(cx: &mut App) -> Entity<Overlay> {
    let overlay = cx.new(|cx| Overlay {
        menu: None,
        palette: None,
        confirm: None,
        toasts: toast::Stack::default(),
        focus: cx.focus_handle(),
        restore: None,
        closed_by: None,
    });
    cx.set_global(Handle(overlay.downgrade()));
    overlay
}

fn handle(cx: &App) -> Option<Entity<Overlay>> {
    cx.try_global::<Handle>()?.0.upgrade()
}

/// Shows a toast. Before the shell is up it is only logged.
pub fn toast(cx: &mut App, toast: Toast) {
    log::info!("toast: {}", toast.message);
    let Some(overlay) = handle(cx) else { return };
    overlay.update(cx, |o, cx| o.push_toast(toast, cx));
}

/// Asks a question. The answer is the index of the choice picked, None when it was cancelled with Escape.
pub fn confirm(
    window: &mut Window,
    cx: &mut App,
    question: impl Into<SharedString>,
    choices: Vec<Choice>,
) -> async_channel::Receiver<Option<usize>> {
    let (tx, rx) = async_channel::bounded(1);
    match handle(cx) {
        Some(overlay) => overlay.update(cx, |o, cx| {
            o.take_keyboard(window, cx);
            o.confirm = Some(confirm::Confirm::new(question.into(), choices, tx));
            cx.notify();
        }),
        None => {
            let _ = tx.try_send(None);
        }
    }
    rx
}

/// A right click menu at `position`, in window coordinates.
pub fn open_menu(window: &mut Window, cx: &mut App, position: Point<Pixels>, rows: Vec<MenuRow>) {
    let Some(overlay) = handle(cx) else { return };
    overlay.update(cx, |o, cx| o.open_menu(menu::OpenMenu::new(rows, menu::At::Point(position)), window, cx));
}

/// Opens the menu bar's menu at `i`, File first.
#[cfg_attr(not(feature = "shot"), allow(dead_code, reason = "the shot feature drives it"))]
pub fn open_bar(window: &mut Window, cx: &mut App, i: usize) {
    let Some(overlay) = handle(cx) else { return };
    overlay.update(cx, |o, cx| o.open_bar(i, window, cx));
}

pub fn toggle_palette(window: &mut Window, cx: &mut App) {
    let Some(overlay) = handle(cx) else { return };
    overlay.update(cx, |o, cx| {
        if o.palette.is_some() {
            o.close_palette(window, cx);
        } else {
            o.take_keyboard(window, cx);
            o.palette = Some(palette::Palette::new(window, cx));
        }
        cx.notify();
    });
}

impl Overlay {
    fn modal(&self) -> bool {
        self.menu.is_some() || self.palette.is_some() || self.confirm.is_some()
    }

    fn take_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.modal() {
            self.restore = window.focused(cx).filter(|f| *f != self.focus);
        }
        window.focus(&self.focus, cx);
    }

    /// Gives the keyboard back once nothing is open.
    fn release_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal() {
            if self.palette.is_none() {
                window.focus(&self.focus, cx);
            }
            return;
        }
        match self.restore.take() {
            Some(f) => window.focus(&f, cx),
            None => window.blur(cx),
        }
        cx.notify();
    }

    fn push_toast(&mut self, toast: Toast, cx: &mut Context<Self>) {
        let hold = toast.hold();
        let (id, generation) = self.toasts.push(toast);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(hold).await;
            let _ = this.update(cx, |o, cx| {
                if o.toasts.expire(id, generation) {
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if self.confirm.is_some() {
            self.confirm_key(key, window, cx);
        } else if self.menu.is_some() {
            self.menu_key(key, window, cx);
        }
    }
}

impl Render for Overlay {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let t = &t;
        let modal = self.modal();
        let mut context = KeyContext::default();
        context.add(MODAL);
        div()
            .absolute()
            .inset_0()
            .when(modal, |d| {
                d.track_focus(&self.focus)
                    .key_context(context)
                    .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.on_key(e, window, cx)))
            })
            .child(self.render_toasts(t, cx))
            .when_some(self.render_point_menu(t, window, cx), |d, m| d.child(m))
            .when_some(self.render_palette(t, window, cx), |d, p| d.child(p))
            .when_some(self.render_confirm(t, cx), |d, c| d.child(c))
    }
}
