//! Toasts, FundaCAD 1's stores/toasts.ts: a bottom centre stack of at most three, a fourth pushing out the oldest one
//! without a button, so a pending Undo is the last to go.

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{App, SharedString, Window};

use crate::motion::Leave;

pub const MAX: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Info,
    Warning,
    Error,
}

#[derive(Clone)]
pub struct ToastAction {
    pub label: SharedString,
    pub run: Rc<dyn Fn(&mut Window, &mut App)>,
}

#[derive(Clone)]
pub struct Toast {
    pub message: SharedString,
    pub kind: Kind,
    pub action: Option<ToastAction>,
}

impl Toast {
    pub fn info(message: impl Into<SharedString>) -> Self {
        Self { message: message.into(), kind: Kind::Info, action: None }
    }

    pub fn warning(message: impl Into<SharedString>) -> Self {
        Self { message: message.into(), kind: Kind::Warning, action: None }
    }

    pub fn error(message: impl Into<SharedString>) -> Self {
        Self { message: message.into(), kind: Kind::Error, action: None }
    }

    /// A button, such as Undo, that runs `run` and closes the toast.
    pub fn with_action(
        mut self,
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.action = Some(ToastAction { label: label.into(), run: Rc::new(run) });
        self
    }

    /// How long it stays, FundaCAD 1's noticeTime.ts at the normal setting.
    pub fn hold(&self) -> Duration {
        let ms = match self.kind {
            Kind::Info => 5000,
            Kind::Warning => 8000,
            Kind::Error => 10000,
        };
        Duration::from_millis(if self.action.is_some() { ms.max(15000) } else { ms })
    }

    fn same(&self, other: &Toast) -> bool {
        self.message == other.message
            && self.kind == other.kind
            && self.action.as_ref().map(|a| &a.label) == other.action.as_ref().map(|a| &a.label)
    }
}

pub struct Item {
    pub id: u64,
    pub toast: Toast,
    /// Bumped when the same toast comes again, so the timer of the earlier push lets it be.
    pub generation: u64,
}

#[derive(Default)]
pub struct Stack {
    pub items: Vec<Item>,
    /// Gone from `items` and fading out, `.toast-out`, each with the place it held.
    leaving: Vec<(usize, Item, Leave)>,
    next: u64,
}

fn clock(cx: &App) -> Instant {
    cx.background_executor().now()
}

impl Stack {
    #[cfg(test)]
    pub fn push(&mut self, toast: Toast) -> (u64, u64) {
        self.push_at(toast, None)
    }

    /// The id and generation the timer expires it by. The same toast showing already starts its time again.
    /// One pushed out by [`MAX`] fades from `now`, without a clock it just goes.
    pub fn push_at(&mut self, toast: Toast, now: Option<Instant>) -> (u64, u64) {
        if let Some(same) = self.items.iter_mut().find(|i| i.toast.same(&toast)) {
            same.toast = toast;
            same.generation += 1;
            return (same.id, same.generation);
        }
        while self.items.len() >= MAX {
            let gone = self.items.iter().position(|i| i.toast.action.is_none()).unwrap_or(0);
            self.leave(gone, now);
        }
        self.next += 1;
        self.items.push(Item { id: self.next, toast, generation: 0 });
        (self.next, 0)
    }

    #[cfg(test)]
    pub fn dismiss(&mut self, id: u64) -> bool {
        self.dismiss_fading(id, None)
    }

    /// Dismisses it and fades it out where it stood.
    pub fn dismiss_fading(&mut self, id: u64, cx: Option<&App>) -> bool {
        match self.items.iter().position(|i| i.id == id) {
            Some(at) => {
                self.leave(at, cx.map(clock));
                true
            }
            None => false,
        }
    }

    fn leave(&mut self, at: usize, now: Option<Instant>) {
        let item = self.items.remove(at);
        if let Some(now) = now {
            self.leaving.push((at, item, Leave::since(now)));
        }
    }

    #[cfg(test)]
    pub fn leaving(&self) -> Vec<u64> {
        self.leaving.iter().map(|(_, i, _)| i.id).collect()
    }

    /// Removes the toast if no later push of it started its time again.
    pub fn expire(&mut self, id: u64, generation: u64, cx: Option<&App>) -> bool {
        match self.items.iter().position(|i| i.id == id && i.generation == generation) {
            Some(at) => {
                self.leave(at, cx.map(clock));
                true
            }
            None => false,
        }
    }
}

impl super::Overlay {
    /// `.toast-stack`: bottom centre of the stretch the cards leave free, newest last. A toast pops in, `.toast`,
    /// and fades out where it stood.
    pub(super) fn render_toasts(
        &mut self,
        t: &crate::theme::Theme,
        window: &mut Window,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::AnyElement {
        use crate::theme::{S_2, T_TOAST_OUT};
        use gpui::*;
        // Over the status line and in the same free stretch of the row, so neither runs into the other or the rail.
        let (left, right) = crate::shell::status::span(window.viewport_size().width / px(1.));
        let bottom = px(64.).max(crate::shell::status::reach());
        let mut stack =
            div().absolute().bottom(bottom).left(px(left)).right(px(right)).flex().flex_col().items_center().gap(px(S_2));
        let mut leaving: Vec<(usize, AnyElement)> = Vec::new();
        self.toasts.leaving.retain_mut(|(at, item, leave)| match leave.opacity(T_TOAST_OUT, window, cx) {
            Some(o) => {
                leaving.push((*at, toast_card(t, item, None, cx).opacity(o).into_any_element()));
                true
            }
            None => false,
        });
        let mut shown: Vec<AnyElement> = self
            .toasts
            .items
            .iter()
            .map(|item| {
                let action = item.toast.action.clone();
                let el = toast_card(t, item, action, cx);
                crate::motion::pop_in(("toast-in", item.id), el).into_any_element()
            })
            .collect();
        // Reversed, so each removal is undone in turn and two that left one after another keep their order.
        for (at, el) in leaving.into_iter().rev() {
            shown.insert(at.min(shown.len()), el);
        }
        stack = stack.children(shown);
        stack.into_any_element()
    }
}

fn toast_card(
    t: &crate::theme::Theme,
    item: &Item,
    action: Option<ToastAction>,
    cx: &mut gpui::Context<super::Overlay>,
) -> gpui::Stateful<gpui::Div> {
    use crate::theme::{FS_BODY, R_MD, S_2, S_3, S_4};
    use gpui::prelude::FluentBuilder as _;
    use gpui::*;
    let id = item.id;
    let border: Hsla = match item.toast.kind {
        Kind::Info => t.line.into(),
        Kind::Warning => rgb(0xd2a83b).into(),
        Kind::Error => t.error.into(),
    };
    let bg: Hsla = if item.toast.kind == Kind::Error { t.error_tint.into() } else { t.panel_2.into() };
    crate::ui::text(t, FS_BODY)
        .id(("toast", id))
        .occlude()
        .flex()
        .items_center()
        .gap(px(S_4))
        .max_w(px(560.))
        .py(px(S_3))
        .px(px(S_4))
        .rounded(px(R_MD))
        .bg(bg)
        .border_1()
        .border_color(border)
        .shadow(t.shadow_3.clone())
        .child(div().flex_1().min_w_0().child(item.toast.message.clone()))
        .when_some(action, |d, a| {
            let wash = t.accent_wash;
            let link = div()
                .id(("toast-action", id))
                .flex_none()
                .px(px(S_2))
                .rounded(px(R_MD))
                .text_color(t.accent)
                .cursor_pointer()
                .child(a.label.clone())
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.toasts.dismiss_fading(id, Some(&**cx));
                    cx.notify();
                    let run = a.run.clone();
                    window.defer(cx, move |window, cx| run(window, cx));
                }));
            d.child(crate::motion::hover_bg(("toast-action-bg", id), link, crate::theme::Rgb::TRANSPARENT, wash))
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            if this.toasts.dismiss_fading(id, Some(&**cx)) {
                cx.notify();
            }
        }))
}
