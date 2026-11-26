//! Import, export and insert: the File commands, the dialogs they ask through, and the requests they send off the UI
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
use fundacad_client::Client;
use gpui::*;

use super::modal::{self, button, note};
use super::Shell;
use crate::commands::{register, Group};
use crate::engine::Link;
use crate::overlay::{self, Toast};
use crate::theme::Theme;
use busy::Stop;

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

/// What the overlay's question cannot hold: the export form and the busy dialog with its Cancel.
enum Modal {
    Export(Box<export::ExportDialog>),
    Busy { label: String, client: Arc<Client>, cancelling: bool, stop: Stop, token: u64 },
}

pub struct Transfer {
    modal: Option<Modal>,
    focus: FocusHandle,
    tokens: busy::Tokens,
}

impl Transfer {
    pub fn new(cx: &mut App) -> Self {
        Self { modal: None, focus: cx.focus_handle(), tokens: busy::Tokens::default() }
    }
}

type Start = fn(&mut Shell, &mut Window, &mut Context<Shell>);

/// The File commands that go through the shell.
pub fn install(shell: WeakEntity<Shell>, cx: &mut App) {
    let commands: [(&'static str, &'static str, Start); 4] = [
        ("import", "Import", Shell::start_import),
        ("insert-document", "Insert FundaCAD Document", Shell::start_insert),
        ("export", "Export", Shell::open_export),
        ("check-links", "Check Linked Files", |s, w, cx| s.check_links(false, w, cx)),
    ];
    for (id, label, start) in commands {
        let shell = shell.clone();
        register(cx, id, label, Group::File, move |w, cx| {
            let _ = shell.update(cx, |s, cx| start(s, w, cx));
        });
    }
}

impl Shell {
    /// The open dialog, over everything but the overlay.
    pub(super) fn transfer_modal(&mut self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let close = {
            let this = cx.entity().downgrade();
            move |window: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |s, cx| s.close_modal(window, cx));
            }
        };
        let cancel = |id: &'static str, cx: &mut Context<Self>| {
            button(t, id, "Cancel", false, true)
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.close_modal(window, cx)))
                .into_any_element()
        };
        let (title, body, buttons): (SharedString, AnyElement, Vec<AnyElement>) = match self.transfer.modal.as_ref()? {
            Modal::Export(d) => {
                let (body, ok) = self.export_view(d, t, cx);
                ("Export".into(), body, vec![cancel("export-cancel", cx), ok])
            }
            Modal::Busy { label, cancelling, .. } => {
                let body = note(t, if *cancelling { "Cancelling..." } else { "Working, this can take a while." });
                (label.clone().into(), body.into_any_element(), vec![cancel("busy-cancel", cx)])
            }
        };
        Some(modal::modal(t, &self.transfer.focus, title, body, buttons, close))
    }

    fn open_modal(&mut self, m: Modal, window: &mut Window, cx: &mut Context<Self>) {
        self.transfer.modal = Some(m);
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

    /// The open document's engine link, or a toast saying there is none. Nothing starts while a dialog is open.
    fn transfer_link(&mut self, cx: &mut Context<Self>) -> Option<Link> {
        if self.transfer.modal.is_some() {
            return None;
        }
        let path = self.bench.files.read(cx).path().map(std::path::Path::to_path_buf);
        let link = self.viewport.read(cx).session_link(path.as_deref());
        if link.is_none() {
            overlay::toast(cx, Toast::error("Open a FundaCAD document first."));
        }
        link
    }
}
