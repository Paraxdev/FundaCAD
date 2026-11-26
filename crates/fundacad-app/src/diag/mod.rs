//! Diagnostics, FundaCAD 1's BugReportDialog.vue, ConsolePanel.vue and updates.ts: the log file and its console, the
//! crash report a panic leaves, the problem report that opens a filled GitHub issue, and the update check.

pub mod crash;
pub mod logfile;
pub mod report;
pub mod update;

use std::time::Duration;

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Textarea, TextareaState};

use crate::commands::{register, Group, Run};
use crate::i18n::{self, Label};
use crate::overlay::{self, Toast};
use crate::shell::modal::{button, modal, note};
use crate::theme::{ActiveTheme as _, Theme, FS_BODY, FS_MICRO, FS_SMALL, MONO_FONT, R_MD, S_1, S_2, S_3, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};

/// FundaCAD 1's LOG_TAIL.
const LOG_TAIL: u64 = 16 << 10;
const CRASH_CAP: usize = 8_000;
const LAUNCH_DELAY: Duration = Duration::from_secs(8);
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Before anything else, so the first lines and any panic land in the log folder.
pub fn start() {
    logfile::start();
    crash::install(logfile::log_dir());
}

struct Form {
    input: Entity<TextareaState>,
    include_log: bool,
    include_crash: bool,
    /// Read when the dialog opened, so typing does not move it.
    log: Option<String>,
    _changed: Subscription,
}

pub struct Diag {
    form: Option<Form>,
    console: bool,
    crash: Option<String>,
    focus: FocusHandle,
    console_scroll: ScrollHandle,
    _poll: Option<Task<()>>,
}

struct Handle(Entity<Diag>);

impl Global for Handle {}

pub fn init(cx: &mut App) {
    let crash = logfile::log_dir().and_then(|d| crash::take_pending(&d));
    let diag = cx.new(|cx| Diag {
        form: None,
        console: false,
        crash: crash.clone(),
        focus: cx.focus_handle(),
        console_scroll: ScrollHandle::new(),
        _poll: None,
    });
    cx.set_global(Handle(diag.clone()));
    let d = diag.clone();
    register(cx, "report-problem", Label::Command("command.reportProblem"), Group::Help, move |window, cx| {
        d.update(cx, |d, cx| d.open_report(window, cx))
    });
    let d = diag.clone();
    register(cx, "console", Label::Key("console.title"), Group::Help, move |_, cx| {
        d.update(cx, |d, cx| d.toggle_console(cx))
    });
    register(cx, "check-updates", Label::Command("menu.help.checkUpdates"), Group::Help, |_, cx| {
        check_updates(true, cx)
    });
    cx.bind_keys([KeyBinding::new("ctrl-`", Run::new("console"), None)]);

    let shot = std::env::var_os("FUNDA_SHOT").is_some();
    let auto = crate::settings::get::<bool>(cx, update::SETTING).unwrap_or(true);
    if auto && !cfg!(debug_assertions) && !shot {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(LAUNCH_DELAY).await;
            let _ = cx.update(|cx| check_updates(false, cx));
        })
        .detach();
    }
    if crash.is_some() {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = cx.update(|cx| {
                let toast = Toast::warning(i18n::t("diag.crashKept"))
                    .with_action(i18n::t("diag.report"), |window, cx| {
                        crate::commands::run("report-problem", window, cx)
                    });
                overlay::toast(cx, toast);
            });
        })
        .detach();
    }
}

/// Drawn by the shell over everything but the toasts.
pub fn view(cx: &App) -> Option<Entity<Diag>> {
    cx.try_global::<Handle>().map(|h| h.0.clone())
}

pub fn check_updates(interactive: bool, cx: &mut App) {
    let task = cx.background_executor().spawn(async move { update::check(VERSION) });
    cx.spawn(async move |cx| {
        let outcome = task.await;
        log::info!("update check: {outcome:?}");
        let _ = cx.update(|cx| {
            let message = outcome.message(VERSION);
            let toast = match &outcome {
                update::Outcome::Newer(_) => Toast::info(message)
                    .with_action(i18n::t("updates.download"), |_, cx| cx.open_url(update::DOWNLOAD_URL)),
                _ if !interactive => return,
                update::Outcome::UpToDate | update::Outcome::NoRelease => Toast::info(message),
                _ => Toast::warning(message)
                    .with_action(i18n::t("updates.downloadPage"), |_, cx| cx.open_url(update::DOWNLOAD_URL)),
            };
            overlay::toast(cx, toast);
        });
    })
    .detach();
}

impl Diag {
    fn open_report(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.form.is_none() {
            let input = cx.new(|cx| TextareaState::new(window, cx).placeholder(i18n::t("bugReport.placeholder")));
            let changed = cx.observe(&input, |_, _, cx| cx.notify());
            let log = logfile::log_dir().and_then(|d| logfile::tail(&d, LOG_TAIL));
            self.form = Some(Form { input, include_log: true, include_crash: true, log, _changed: changed });
        }
        if let Some(f) = &self.form {
            window.focus(&f.input.focus_handle(cx), cx);
        }
        cx.notify();
    }

    fn close_report(&mut self, cx: &mut Context<Self>) {
        self.form = None;
        cx.notify();
    }

    fn toggle_console(&mut self, cx: &mut Context<Self>) {
        self.console = !self.console;
        self._poll = self.console.then(|| {
            cx.spawn(async move |this, cx| {
                let mut seen = usize::MAX;
                loop {
                    let now = logfile::written();
                    if now != seen {
                        seen = now;
                        if this
                            .update(cx, |d, cx| {
                                d.console_scroll.scroll_to_bottom();
                                cx.notify();
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    cx.background_executor().timer(Duration::from_millis(400)).await;
                }
            })
        });
        cx.notify();
    }

    fn input(&self, cx: &App) -> Option<report::Input> {
        let f = self.form.as_ref()?;
        let description = f.input.read(cx).value().to_string();
        let crash = self.crash.as_ref().filter(|_| f.include_crash).map(|c| {
            let c = report::redact(c);
            if c.len() <= CRASH_CAP {
                c
            } else {
                let mut end = CRASH_CAP;
                while !c.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{}\n\u{2026} (cut)", &c[..end])
            }
        });
        let log = if f.include_log {
            Some(f.log.clone().unwrap_or_else(|| "No log file for this run.".into()))
        } else {
            None
        };
        Some(report::Input {
            version: format!("{VERSION} (FundaCAD 2)"),
            system: report::system_line(),
            description: report::redact(&description),
            document: None,
            crash,
            log,
        })
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let Some(input) = self.input(cx) else { return };
        let built = report::build(&input, report::REPORT_CAP);
        let link = report::issue_url(&report::Fields {
            description: &input.description,
            version: &input.version,
            system: &input.system,
            report: &built.text,
        });
        cx.write_to_clipboard(ClipboardItem::new_string(built.text));
        cx.open_url(&link.url);
        let message = if link.report_in { i18n::t("diag.reportOpened") } else { i18n::t("diag.reportTooLong") };
        overlay::toast(cx, Toast::info(message));
        self.close_report(cx);
    }

    fn copy(&mut self, cx: &mut Context<Self>) {
        let Some(input) = self.input(cx) else { return };
        cx.write_to_clipboard(ClipboardItem::new_string(report::build(&input, report::REPORT_CAP).text));
        overlay::toast(cx, Toast::info(i18n::t("bugReport.copied")));
    }

    fn report_view(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let f = self.form.as_ref()?;
        let input = self.input(cx)?;
        let built = report::build(&input, report::REPORT_CAP);
        let has_text = !input.description.trim().is_empty();
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(S_2))
            .child(Textarea::new(&f.input).h(px(84.)))
            .child(self.check(t, "log", i18n::t("diag.includeLog"), f.include_log, cx));
        if self.crash.is_some() {
            body = body.child(self.check(t, "crash", i18n::t("diag.includeCrash"), f.include_crash, cx));
        }
        if built.log_cut {
            body = body.child(note(t, i18n::t("diag.logCut")));
        }
        body = body
            .child(text(t, FS_SMALL).text_color(t.text_dim).child(i18n::t("diag.preview")))
            .child(
                div()
                    .id("report-preview")
                    .max_h(px(200.))
                    .overflow_y_scroll()
                    .p(px(S_2))
                    .rounded(px(R_MD))
                    .bg(t.raised)
                    .font_family(MONO_FONT)
                    .text_size(px(FS_MICRO))
                    .text_color(t.text_dim)
                    .child(built.text),
            )
            .child(note(t, i18n::t("diag.nothingSent")));
        let buttons = vec![
            button(t, "report-cancel", i18n::t("common.cancel"), false, true)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close_report(cx)))
                .into_any_element(),
            button(t, "report-copy", i18n::t("bugReport.copy"), false, true)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.copy(cx)))
                .into_any_element(),
            button(t, "report-open", i18n::t("diag.openIssue"), true, has_text)
                .when(has_text, |b| b.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.send(cx))))
                .into_any_element(),
        ];
        let weak = cx.weak_entity();
        Some(modal(t, &self.focus, Label::Command("command.reportProblem").text(), body, buttons, move |_, cx| {
            let _ = weak.update(cx, |d, cx| d.close_report(cx));
        }))
    }

    fn check(&self, t: &Theme, id: &'static str, label: String, on: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let mark = div()
            .size(px(14.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(3.))
            .border_1()
            .border_color(if on { t.accent } else { t.control_edge })
            .when(on, |d| d.bg(t.accent).text_color(t.on_accent).text_size(px(FS_MICRO)).child("\u{2713}"));
        text(t, FS_SMALL).id(id).flex().items_center().gap(px(S_2)).cursor_pointer().child(mark).child(label).on_click(
            cx.listener(move |this, _: &ClickEvent, _, cx| {
                if let Some(f) = this.form.as_mut() {
                    match id {
                        "log" => f.include_log = !f.include_log,
                        _ => f.include_crash = !f.include_crash,
                    }
                }
                cx.notify();
            }),
        )
    }

    fn console_view(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        if !self.console {
            return None;
        }
        let lines = logfile::lines().into_iter().map(|l| {
            let color = match l.level {
                log::Level::Error => t.error,
                log::Level::Warn => t.warn,
                _ => t.text_dim,
            };
            div().text_color(color).child(report::redact(&l.text))
        });
        let header = div()
            .flex()
            .items_center()
            .gap(px(S_2))
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).flex_1().child(i18n::t("console.title")))
            .child(button(t, "console-folder", i18n::t("diag.openLogFolder"), false, true).on_click(|_, _, cx| {
                if let Some(dir) = logfile::log_dir() {
                    cx.reveal_path(&logfile::generation(&dir, 0));
                }
            }))
            .child(
                icon_button(t, "console-close", "close", 24., 14., t.text_dim)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_console(cx))),
            );
        Some(
            div().absolute().left(px(S_3)).right(px(S_3)).bottom(px(S_3)).flex().justify_center().child(
                solid_card(t)
                    .w(px(760.))
                    .h(px(300.))
                    .p(px(S_3))
                    .gap(px(S_1))
                    .bg(t.float_bg_solid)
                    .occlude()
                    .child(header)
                    .child(
                        div()
                            .id("console-lines")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .track_scroll(&self.console_scroll)
                            .font_family(MONO_FONT)
                            .text_size(px(FS_MICRO))
                            .children(lines),
                    ),
            ),
        )
    }
}

impl Render for Diag {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let t = &t;
        if !self.console && self.form.is_none() {
            return div();
        }
        div().absolute().inset_0().children(self.console_view(t, cx)).children(self.report_view(t, cx))
    }
}
