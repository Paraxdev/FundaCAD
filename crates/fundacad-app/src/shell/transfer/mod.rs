//! Import, export and insert: the File menu, the dialogs they ask through, and the requests they send off the UI
//! thread. The decisions are fundacad_client::transfer's.

mod busy;
mod export;
mod import;
mod logic;
mod picker;

#[cfg(test)]
mod busy_tests;
#[cfg(test)]
mod logic_tests;
#[cfg(test)]
mod picker_tests;

use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use fundacad_client::transfer::export::ExportSettings;
use fundacad_client::transfer::import::SPEC_UNIT;
use fundacad_client::transfer::insert::StaleLinks;
use fundacad_client::Client;
use gpui::*;

use super::modal::{self, button, note};
use super::toast::{self, Kind, Toasts};
use super::Shell;
use crate::engine::Link;
use crate::theme::{Theme, FS_BODY, FS_SMALL, R_MD, S_1, S_3};
use crate::ui::{solid_card, text};
use busy::Stop;

actions!(file, [Export, Import, InsertDocument, CheckLinks, FileMenu]);

/// What the transfer dialogs remember between uses.
pub struct TransferPrefs {
    pub export: ExportSettings,
    /// Where the last export went, the next save dialog opens there.
    pub export_dir: Option<String>,
    pub import_unit: &'static str,
}

/// Kept in memory for now, the one place a preferences store would back.
pub fn prefs() -> MutexGuard<'static, TransferPrefs> {
    static PREFS: LazyLock<Mutex<TransferPrefs>> = LazyLock::new(|| {
        Mutex::new(TransferPrefs { export: ExportSettings::default(), export_dir: None, import_unit: SPEC_UNIT })
    });
    PREFS.lock().unwrap_or_else(PoisonError::into_inner)
}

enum Modal {
    Export(Box<export::ExportDialog>),
    Busy { label: String, client: Arc<Client>, cancelling: bool, stop: Stop, token: u64 },
    ImportUnit { paths: Vec<String>, unit: &'static str },
    InsertMode { path: String },
    Links(StaleLinks),
}

pub struct Transfer {
    modal: Option<Modal>,
    focus: FocusHandle,
    toasts: Toasts,
    menu_open: bool,
    tokens: busy::Tokens,
}

impl Transfer {
    pub fn new(cx: &mut App) -> Self {
        Self {
            modal: None,
            focus: cx.focus_handle(),
            toasts: Toasts::default(),
            menu_open: false,
            tokens: busy::Tokens::default(),
        }
    }
}

type MenuEntry = (&'static str, &'static str, fn() -> Box<dyn Action>);

const MENU: [MenuEntry; 4] = [
    ("Import...", "Ctrl+I", || Box::new(Import)),
    ("Insert FundaCAD document...", "Ctrl+Shift+I", || Box::new(InsertDocument)),
    ("Export...", "Ctrl+E", || Box::new(Export)),
    ("Check linked files", "", || Box::new(CheckLinks)),
];

impl Shell {
    pub(super) fn transfer_actions(&self, root: Div, cx: &mut Context<Self>) -> Div {
        root.on_action(cx.listener(|this, _: &Export, window, cx| this.open_export(window, cx)))
            .on_action(cx.listener(|this, _: &Import, window, cx| this.start_import(window, cx)))
            .on_action(cx.listener(|this, _: &InsertDocument, window, cx| this.start_insert(window, cx)))
            .on_action(cx.listener(|this, _: &CheckLinks, window, cx| this.check_links(false, window, cx)))
            .on_action(cx.listener(|this, _: &FileMenu, _, cx| {
                this.transfer.menu_open = !this.transfer.menu_open;
                cx.notify();
            }))
    }

    /// The File menu, the open dialog and the toasts, over everything else.
    pub(super) fn transfer_overlay(&mut self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let mut layer = div().absolute().inset_0().child(toast::stack(t, &self.transfer.toasts));
        if self.transfer.menu_open {
            layer = layer.child(self.file_menu(t, cx));
        }
        if let Some(m) = self.modal_view(t, cx) {
            layer = layer.child(m);
        }
        layer
    }

    fn file_menu(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let hover = t.hover_wash;
        let entries = MENU.iter().enumerate().map(|(i, (label, keys, action))| {
            let action = *action;
            text(t, FS_BODY)
                .id(("file-menu", i))
                .h(px(t.hit(26.)))
                .px(px(S_3))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(S_3))
                .rounded(px(R_MD))
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.transfer.menu_open = false;
                    window.dispatch_action(action(), cx);
                    cx.notify();
                }))
                .child(*label)
                .child(text(t, FS_SMALL).text_color(t.text_mute).child(*keys))
        });
        div()
            .absolute()
            .inset_0()
            .child(div().absolute().inset_0().occlude().on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| {
                    this.transfer.menu_open = false;
                    cx.notify();
                }),
            ))
            .child(
                solid_card(t)
                    .absolute()
                    .top(px(34.))
                    .left(px(super::titlebar::file_menu_left(t)))
                    .min_w(px(280.))
                    .bg(t.float_bg_solid)
                    .p(px(S_1))
                    .children(entries),
            )
    }

    fn modal_view(&mut self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let close = {
            let this = cx.entity().downgrade();
            move |window: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |s, cx| s.close_modal(window, cx));
            }
        };
        let cancel = |id: &'static str, label: &'static str, cx: &mut Context<Self>| {
            button(t, id, label, false, true)
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.close_modal(window, cx)))
                .into_any_element()
        };
        let (title, body, buttons): (SharedString, AnyElement, Vec<AnyElement>) = match self.transfer.modal.as_ref()? {
            Modal::Export(d) => {
                let (body, ok) = self.export_view(d, t, cx);
                ("Export".into(), body, vec![cancel("export-cancel", "Cancel", cx), ok])
            }
            Modal::Busy { label, cancelling, .. } => {
                let body = note(t, if *cancelling { "Cancelling..." } else { "Working, this can take a while." });
                (label.clone().into(), body.into_any_element(), vec![cancel("busy-cancel", "Cancel", cx)])
            }
            Modal::ImportUnit { paths, unit } => {
                let (body, ok) = self.import_unit_view(paths, unit, t, cx);
                ("Import units".into(), body, vec![cancel("unit-cancel", "Cancel", cx), ok])
            }
            Modal::InsertMode { path } => {
                let (body, mut buttons) = self.insert_view(path, t, cx);
                buttons.insert(0, cancel("insert-cancel", "Cancel", cx));
                ("Insert FundaCAD document".into(), body, buttons)
            }
            Modal::Links(stale) => {
                let (body, mut buttons) = self.links_view(stale, t, cx);
                buttons.insert(0, cancel("links-later", "Later", cx));
                ("Linked files".into(), body, buttons)
            }
        };
        Some(modal::modal(t, &self.transfer.focus, title, body, buttons, close))
    }

    fn open_modal(&mut self, m: Modal, window: &mut Window, cx: &mut Context<Self>) {
        self.transfer.modal = Some(m);
        self.transfer.menu_open = false;
        window.focus(&self.transfer.focus, cx);
        cx.notify();
    }

    /// Escape or Cancel. While a request runs it asks the engine to stop, the reply then closes the dialog.
    fn close_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Modal::Busy { client, cancelling, stop, .. }) = &mut self.transfer.modal {
            stop.set();
            client.cancel_requests();
            *cancelling = true;
        } else {
            self.transfer.modal = None;
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    pub(in crate::shell) fn busy(&self) -> bool {
        matches!(self.transfer.modal, Some(Modal::Busy { .. }))
    }

    /// Opens the busy dialog, the task keeps its token to end it and the stop to see Cancel.
    fn set_busy(
        &mut self,
        label: impl Into<String>,
        client: Arc<Client>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (u64, Stop) {
        let (token, stop) = (self.transfer.tokens.next(), Stop::default());
        let busy = Modal::Busy { label: label.into(), client, cancelling: false, stop: stop.clone(), token };
        self.open_modal(busy, window, cx);
        (token, stop)
    }

    fn end_busy(&mut self, token: u64, window: &mut Window, cx: &mut Context<Self>) {
        let open = match &self.transfer.modal {
            Some(Modal::Busy { token, .. }) => Some(*token),
            _ => None,
        };
        if busy::ends(open, token) {
            self.transfer.modal = None;
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    fn toast(&mut self, kind: Kind, text: impl Into<String>, cx: &mut Context<Self>) {
        let id = self.transfer.toasts.push(kind, text);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(toast::SHOWN_FOR).await;
            let _ = this.update(cx, |s, cx| {
                s.transfer.toasts.dismiss(id);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The open document's engine link, or a toast saying there is none. Nothing starts while a dialog is open.
    fn transfer_link(&mut self, cx: &mut Context<Self>) -> Option<Link> {
        if self.transfer.modal.is_some() {
            return None;
        }
        let link = self.viewport.read(cx).session_link();
        if link.is_none() {
            self.toast(Kind::Error, "Open a FundaCAD document first.", cx);
        }
        link
    }
}
