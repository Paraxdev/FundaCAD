//! The radial menu's settings, FundaCAD 1's FundaCAD.Navigation plugin: off by default, on its key (W) and a mouse
//! trigger, and the commands each context shows.

#[cfg(test)]
mod tests;

use gpui::{App, Modifiers};
use serde::Deserialize;

use crate::settings;

const ON_KEY: &str = "radialMenu";
const DRAG_KEY: &str = "radialDrag";
const ITEMS_KEY: &str = "radialItems";

pub const HINT: &str = "A ring of commands at the cursor, chosen by what you are doing. Hold the trigger, move towards \
                        a command and let go, or tap the key and click. Its key is W unless you move it in Shortcuts.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drag {
    AltRight,
    Right,
    Middle,
    None,
}

impl Drag {
    pub const ALL: [Drag; 4] = [Drag::AltRight, Drag::Right, Drag::Middle, Drag::None];

    pub fn id(self) -> &'static str {
        match self {
            Drag::AltRight => "alt-right",
            Drag::Right => "right",
            Drag::Middle => "middle",
            Drag::None => "none",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Drag::AltRight => "Alt+right drag",
            Drag::Right => "Right drag",
            Drag::Middle => "Middle drag",
            Drag::None => "No mouse trigger, the key only",
        }
    }

    pub fn parse(v: Option<&str>) -> Drag {
        Self::ALL.into_iter().find(|d| Some(d.id()) == v).unwrap_or(Drag::AltRight)
    }
}

/// FundaCAD 1's tableFor: a trigger on a button whose plain drag already does something stays on the key only. FundaCAD
/// 2's buttons are fixed, right orbits and middle pans, so only Alt+right is free. Err is why the trigger is off.
pub fn mouse_trigger(on: bool, drag: Drag) -> Result<Option<Drag>, String> {
    match (on, drag) {
        (false, _) | (_, Drag::None) => Ok(None),
        (true, Drag::AltRight) => Ok(Some(Drag::AltRight)),
        (true, Drag::Right) => Err("Right drag already does orbit, so the radial menu is on its key only".into()),
        (true, Drag::Middle) => Err("Middle drag already does pan, so the radial menu is on its key only".into()),
    }
}

/// Whether a right press with `mods` held opens the ring once it travels.
pub fn gesture_press(on: bool, drag: Drag, mods: &Modifiers) -> bool {
    mods.alt && mouse_trigger(on, drag) == Ok(Some(Drag::AltRight))
}

pub fn on() -> bool {
    settings::read(ON_KEY).unwrap_or(false)
}

pub fn drag() -> Drag {
    Drag::parse(settings::read::<String>(DRAG_KEY).as_deref())
}

pub fn set_on(on: bool, cx: &mut App) {
    settings::write(ON_KEY, &on);
    cx.refresh_windows();
}

pub fn set_drag(d: Drag, cx: &mut App) {
    settings::write(DRAG_KEY, &d.id());
    cx.refresh_windows();
}

/// For the viewport's right press.
pub fn gesture_now(mods: &Modifiers) -> bool {
    gesture_press(on(), drag(), mods)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Situation {
    Model,
    Selection,
    Sketch,
}

pub fn context_of(sketching: bool, selected: usize) -> Situation {
    match (sketching, selected) {
        (true, _) => Situation::Sketch,
        (false, 0) => Situation::Model,
        _ => Situation::Selection,
    }
}

/// FundaCAD 1's DEFAULT_CONFIG.items, its sketch "extrude" (Finish & Extrude) as FundaCAD 2's sketch-extrude.
pub fn defaults(c: Situation) -> Vec<String> {
    let ids: &[&str] = match c {
        Situation::Model => {
            &["sketch", "extrude", "presspull", "measure", "fit", "reset-camera", "toggle-wireframe", "show-all-bodies"]
        }
        Situation::Selection => &["fillet", "chamfer", "move", "presspull", "split", "hide-selected", "measure", "fit"],
        Situation::Sketch => &["line", "rectangle", "circle", "arc", "dimension", "trim", "offset", "sketch-extrude"],
    };
    ids.iter().map(|s| s.to_string()).collect()
}

#[derive(Default, Deserialize)]
struct Stored {
    model: Option<Vec<String>>,
    selection: Option<Vec<String>>,
    sketch: Option<Vec<String>>,
}

/// The stored list for `c`, the default where it is missing or not a list of strings.
pub fn items_from(stored: Option<serde_json::Value>, c: Situation) -> Vec<String> {
    let s: Stored = stored.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let list = match c {
        Situation::Model => s.model,
        Situation::Selection => s.selection,
        Situation::Sketch => s.sketch,
    };
    list.unwrap_or_else(|| defaults(c))
}

pub fn items(c: Situation) -> Vec<String> {
    items_from(settings::read(ITEMS_KEY), c)
}
