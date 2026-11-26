//! Toasts, FundaCAD 1's stores/toasts.ts: a bottom centre stack of at most three, a fourth pushing out the oldest one
//! without a button, so a pending Undo is the last to go.

use std::rc::Rc;
use std::time::Duration;

use gpui::{App, SharedString, Window};

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
    next: u64,
}

impl Stack {
    /// The id and generation the timer expires it by. The same toast showing already starts its time again.
    pub fn push(&mut self, toast: Toast) -> (u64, u64) {
        if let Some(same) = self.items.iter_mut().find(|i| i.toast.same(&toast)) {
            same.toast = toast;
            same.generation += 1;
            return (same.id, same.generation);
        }
        while self.items.len() >= MAX {
            let gone = self.items.iter().position(|i| i.toast.action.is_none()).unwrap_or(0);
            self.items.remove(gone);
        }
        self.next += 1;
        self.items.push(Item { id: self.next, toast, generation: 0 });
        (self.next, 0)
    }

    pub fn dismiss(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|i| i.id != id);
        self.items.len() != before
    }

    /// Removes the toast if no later push of it started its time again.
    pub fn expire(&mut self, id: u64, generation: u64) -> bool {
        match self.items.iter().position(|i| i.id == id && i.generation == generation) {
            Some(at) => {
                self.items.remove(at);
                true
            }
            None => false,
        }
    }
}

impl super::Overlay {
    /// `.toast-stack`: bottom centre, newest last.
    pub(super) fn render_toasts(&self, t: &crate::theme::Theme, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use crate::theme::{FS_BODY, R_MD, S_2, S_3, S_4};
        use gpui::prelude::FluentBuilder as _;
        use gpui::*;
        let mut stack =
            div().absolute().bottom(px(64.)).left_0().right_0().flex().flex_col().items_center().gap(px(S_2));
        for item in &self.toasts.items {
            let id = item.id;
            let border: Hsla = match item.toast.kind {
                Kind::Info => t.line.into(),
                Kind::Warning => rgb(0xd2a83b).into(),
                Kind::Error => t.error.into(),
            };
            let bg: Hsla = if item.toast.kind == Kind::Error { t.error_tint.into() } else { t.panel_2.into() };
            let action = item.toast.action.clone();
            stack = stack.child(
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
                    .child(div().flex_1().child(item.toast.message.clone()))
                    .when_some(action, |d, a| {
                        let accent = t.accent;
                        let wash = t.accent_wash;
                        d.child(
                            div()
                                .id(("toast-action", id))
                                .flex_none()
                                .px(px(S_2))
                                .rounded(px(R_MD))
                                .text_color(accent)
                                .hover(move |s| s.bg(wash))
                                .cursor_pointer()
                                .child(a.label.clone())
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.toasts.dismiss(id);
                                    cx.notify();
                                    let run = a.run.clone();
                                    window.defer(cx, move |window, cx| run(window, cx));
                                })),
                        )
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.toasts.dismiss(id) {
                            cx.notify();
                        }
                    })),
            );
        }
        stack.into_any_element()
    }
}
