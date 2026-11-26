//! Minimal toasts: a short line in the corner that goes away on its own.

use std::time::Duration;

use gpui::*;

use crate::theme::{Theme, FS_SMALL, S_2, S_3};
use crate::ui::{solid_card, text};

pub const SHOWN_FOR: Duration = Duration::from_secs(6);
const MOST: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Info,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub id: u64,
    pub kind: Kind,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct Toasts {
    next: u64,
    list: Vec<Toast>,
}

impl Toasts {
    /// Adds one and returns its id, dropping the oldest past the most shown at once.
    pub fn push(&mut self, kind: Kind, text: impl Into<String>) -> u64 {
        self.next += 1;
        self.list.push(Toast { id: self.next, kind, text: text.into() });
        if self.list.len() > MOST {
            self.list.remove(0);
        }
        self.next
    }

    pub fn dismiss(&mut self, id: u64) {
        self.list.retain(|t| t.id != id);
    }

    pub fn shown(&self) -> &[Toast] {
        &self.list
    }
}

pub fn stack(t: &Theme, toasts: &Toasts) -> Div {
    div().absolute().right(px(S_3)).bottom(px(48.)).flex().flex_col().items_end().gap(px(S_2)).children(
        toasts.shown().iter().map(|toast| {
            let edge = match toast.kind {
                Kind::Info => t.accent,
                Kind::Error => t.error,
            };
            solid_card(t)
                .max_w(px(420.))
                .bg(t.float_bg_solid)
                .border_l_2()
                .border_color(edge)
                .px(px(S_3))
                .py(px(S_2))
                .child(text(t, FS_SMALL).child(toast.text.clone()))
        }),
    )
}
