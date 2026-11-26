//! The one way anything runs: a key, a menu row and a palette row all dispatch `Run` with a command id, and the id's
//! handler, registered here by whichever part of the app owns it, does the work.

mod builtin;
pub mod keymap;
pub mod keys;
#[cfg(test)]
mod tests;

use std::rc::Rc;

use gpui::*;

pub use builtin::install;
use keys::{Ctx, Shortcut};

/// Runs the command with this id.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = funda, no_json)]
pub struct Run(pub SharedString);

impl Run {
    pub fn new(id: impl Into<SharedString>) -> Self {
        Self(id.into())
    }
}

/// The key context every overlay that holds the keyboard sets, so the table's keys wait until it closes.
pub const MODAL: &str = "Modal";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[allow(dead_code, reason = "the sketch lane switches to Sketch")]
pub enum Mode {
    #[default]
    Model,
    Sketch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code, reason = "the tool and sketch lanes register into these")]
pub enum Group {
    File,
    Edit,
    View,
    Go,
    Help,
    Tools,
    Sketch,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::File => "File",
            Group::Edit => "Edit",
            Group::View => "View",
            Group::Go => "Go",
            Group::Help => "Help",
            Group::Tools => "Tools",
            Group::Sketch => "Sketch",
        }
    }
}

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
type Check = Rc<dyn Fn(&App) -> bool>;

#[derive(Clone)]
pub struct Command {
    pub id: &'static str,
    pub label: SharedString,
    pub group: Group,
    pub context: Ctx,
    run: Handler,
    enabled: Option<Check>,
}

#[derive(Default)]
struct Registry {
    commands: Vec<Command>,
    rows: Vec<Shortcut>,
    problems: Vec<keymap::Problem>,
    mode: Mode,
}

impl Global for Registry {}

fn registry(cx: &mut App) -> &mut Registry {
    cx.default_global::<Registry>()
}

/// Adds or replaces the handler of `id`.
pub fn register(
    cx: &mut App,
    id: &'static str,
    label: impl Into<SharedString>,
    group: Group,
    run: impl Fn(&mut Window, &mut App) + 'static,
) {
    register_in(cx, id, label, group, Ctx::Global, run);
}

pub fn register_in(
    cx: &mut App,
    id: &'static str,
    label: impl Into<SharedString>,
    group: Group,
    context: Ctx,
    run: impl Fn(&mut Window, &mut App) + 'static,
) {
    let command = Command { id, label: label.into(), group, context, run: Rc::new(run), enabled: None };
    let commands = &mut registry(cx).commands;
    match commands.iter_mut().find(|c| c.id == id) {
        Some(c) => *c = command,
        None => commands.push(command),
    }
}

/// Greys the command in menus and leaves it out of the palette while `check` says no.
pub fn set_enabled(cx: &mut App, id: &str, check: impl Fn(&App) -> bool + 'static) {
    if let Some(c) = registry(cx).commands.iter_mut().find(|c| c.id == id) {
        c.enabled = Some(Rc::new(check));
    }
}

/// A command this build does not have stays enabled, running it says so.
pub fn enabled(cx: &App, id: &str) -> bool {
    let Some(r) = cx.try_global::<Registry>() else { return true };
    r.commands.iter().find(|c| c.id == id).is_none_or(|c| c.enabled.as_ref().is_none_or(|f| f(cx)))
}

/// The label of a command, from its handler or the key table, else the id.
pub fn label(cx: &App, id: &str) -> SharedString {
    let r = cx.try_global::<Registry>();
    if let Some(c) = r.and_then(|r| r.commands.iter().find(|c| c.id == id)) {
        return c.label.clone();
    }
    let table = r.map_or_else(keys::table, |r| if r.rows.is_empty() { keys::table() } else { r.rows.clone() });
    table.iter().find(|s| s.action == id).map_or_else(|| SharedString::from(id.to_string()), |s| s.label.into())
}

pub fn run(id: &str, window: &mut Window, cx: &mut App) {
    let found = cx.try_global::<Registry>().and_then(|r| r.commands.iter().find(|c| c.id == id).cloned());
    match found {
        Some(c) if c.enabled.as_ref().is_none_or(|f| f(cx)) => (c.run)(window, cx),
        Some(_) => {}
        None => {
            let label = label(cx, id);
            crate::overlay::toast(cx, crate::overlay::Toast::info(format!("{label} is not in FundaCAD 2 yet")));
        }
    }
}

/// For the window root's `on_action`.
pub fn on_run(action: &Run, window: &mut Window, cx: &mut App) {
    run(&action.0, window, cx);
}

pub fn mode(cx: &App) -> Mode {
    cx.try_global::<Registry>().map(|r| r.mode).unwrap_or_default()
}

/// The sketch editor switches to `Sketch` while a sketch is open, so the sketch keys apply.
#[allow(dead_code, reason = "the sketch lane calls it")]
pub fn set_mode(cx: &mut App, mode: Mode) {
    registry(cx).mode = mode;
    cx.refresh_windows();
}

/// The key context of the workspace root, which the table's predicates read.
pub fn key_context(cx: &App) -> KeyContext {
    let mut context = KeyContext::default();
    context.add("Workspace");
    context.add(match mode(cx) {
        Mode::Model => "Model",
        Mode::Sketch => "Sketch",
    });
    context
}

fn predicate(row: &Shortcut) -> String {
    let ctx = match row.context {
        Ctx::Model => "Model",
        Ctx::Sketch => "Sketch",
        Ctx::Global => "Workspace",
    };
    let combo = row.combo.as_ref();
    // A bare key or Escape types into or belongs to a focused field, Ctrl combos reach the table from a field too.
    let bare = combo.is_some_and(|c| !c.ctrl);
    format!("{ctx}{} && !{MODAL}", if bare { " && !Input" } else { "" })
}

/// Binds the table with the person's keys from the settings, and toasts what clashes.
pub fn bind(cx: &mut App) {
    let user: Vec<keymap::UserKey> = crate::settings::get(cx, keymap::SETTING).unwrap_or_default();
    let (rows, problems) = keymap::apply(keys::table(), &user);
    // The latest binding wins a key GPUI finds twice, so the rows go in backwards and the first row wins.
    let bindings: Vec<KeyBinding> = rows
        .iter()
        .rev()
        .filter_map(|r| {
            let combo = r.combo.as_ref()?;
            let context = KeyBindingContextPredicate::parse(&predicate(r)).ok()?;
            KeyBinding::load(&combo.keystroke(), Box::new(Run::new(r.action)), Some(Rc::new(context)), false, None, cx)
                .map_err(|e| log::warn!("shortcuts: {} is not a key GPUI reads: {e:?}", combo))
                .ok()
        })
        .collect();
    cx.bind_keys(bindings);
    for p in &problems {
        log::warn!("shortcuts: {}", p.describe());
    }
    let r = registry(cx);
    r.rows = rows;
    r.problems = problems;
}

/// One line for the problems binding found, None when there were none.
pub fn summary(problems: &[keymap::Problem]) -> Option<String> {
    let first = problems.first()?.describe();
    Some(match problems.len() - 1 {
        0 => first,
        more => format!("{first}, and {more} more"),
    })
}

/// Toasts what binding found, once the overlay is up to show it.
pub fn report_problems(cx: &mut App) {
    let line = cx.try_global::<Registry>().and_then(|r| summary(&r.problems));
    if let Some(line) = line {
        crate::overlay::toast(cx, crate::overlay::Toast::warning(line));
    }
}

/// The key that runs `id` now, as "Ctrl+S", for menus and the palette.
pub fn hint(cx: &App, id: &str) -> Option<SharedString> {
    let r = cx.try_global::<Registry>()?;
    let ctx = match r.mode {
        Mode::Model => Ctx::Model,
        Mode::Sketch => Ctx::Sketch,
    };
    let row = r.rows.iter().find(|s| s.action == id && s.combo.is_some() && s.context.overlaps(ctx))?;
    row.combo.as_ref().map(|c| SharedString::from(c.to_string()))
}

/// Every command the palette offers now: registered, enabled and live in the current mode.
pub fn available(cx: &App) -> Vec<Command> {
    let Some(r) = cx.try_global::<Registry>() else { return Vec::new() };
    let ctx = match r.mode {
        Mode::Model => Ctx::Model,
        Mode::Sketch => Ctx::Sketch,
    };
    r.commands.iter().filter(|c| c.context.overlaps(ctx) && c.enabled.as_ref().is_none_or(|f| f(cx))).cloned().collect()
}

/// The table as bound and the problems binding it found, for the shortcuts sheet.
#[allow(dead_code, reason = "the shortcuts sheet reads it")]
pub fn rows(cx: &App) -> (Vec<Shortcut>, Vec<keymap::Problem>) {
    cx.try_global::<Registry>().map(|r| (r.rows.clone(), r.problems.clone())).unwrap_or_default()
}
