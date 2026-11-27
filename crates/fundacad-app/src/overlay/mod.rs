//! What floats over the whole workspace: menus (the menu bar's and right click ones), the command palette, the
//! confirm dialog and the toasts. One entity holds them, the shell draws it last, and anything opened through the
//! functions here takes the keyboard until it closes.

mod confirm;
mod menu;
mod menubar;
mod palette;
pub mod radial;
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

/// Drawn here rather than with gpui-kit's menu, dialog and notification: those carry the kit's own look and focus rules,
/// these copy FundaCAD 1's (ContextMenu.vue, ConfirmDialog.vue, the toast stack), give the keyboard back to where it
/// was, and keep the table's keys waiting through the `Modal` key context.
pub struct Overlay {
    menu: Option<menu::OpenMenu>,
    radial: Option<radial::Ring>,
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
        radial: None,
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

/// A window with the overlay up, for tests that ask, toast or run commands. Keep the overlay alive while it is used.
#[cfg(test)]
pub fn test_window(app: &mut TestAppContext) -> (&mut VisualTestContext, Entity<Overlay>) {
    let cx = app.add_empty_window();
    let overlay = cx.update(|_, cx| new(cx));
    (cx, overlay)
}

/// The question asked now and its choices, for tests.
#[cfg(test)]
pub fn asking(cx: &App) -> Option<(SharedString, Vec<SharedString>)> {
    let o = handle(cx)?;
    let c = o.read(cx).confirm.as_ref()?;
    Some((c.question.clone(), c.choices.iter().map(|c| c.label.clone()).collect()))
}

/// The messages of the toasts shown now, oldest first, for tests.
#[cfg(test)]
pub fn toasts(cx: &App) -> Vec<SharedString> {
    handle(cx).map_or_else(Vec::new, |o| o.read(cx).toasts.items.iter().map(|i| i.toast.message.clone()).collect())
}

/// Presses a key on the question asked now, as GPUI names it ("enter", "escape", "right"), for tests.
#[cfg(test)]
pub fn press(window: &mut Window, cx: &mut App, key: &str) {
    if let Some(o) = handle(cx) {
        o.update(cx, |o, cx| o.confirm_key(key, window, cx));
    }
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
        self.menu.is_some() || self.radial.is_some() || self.palette.is_some() || self.confirm.is_some()
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
        let (id, generation) = self.toasts.push_at(toast, Some(cx.background_executor().now()));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(hold).await;
            let _ = this.update(cx, |o, cx| {
                if o.toasts.expire(id, generation, Some(&**cx)) {
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
        } else if self.radial.is_some() {
            self.radial_key(key, window, cx);
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
                    .on_key_up(cx.listener(|this, e: &KeyUpEvent, window, cx| this.radial_key_up(e, window, cx)))
            })
            .child(self.render_toasts(t, window, cx))
            .when_some(self.render_point_menu(t, window, cx), |d, m| d.child(m))
            .when_some(self.render_radial(t, cx), |d, r| d.child(r))
            .when_some(self.render_palette(t, window, cx), |d, p| d.child(p))
            .when_some(self.render_confirm(t, cx), |d, c| d.child(c))
    }
}
