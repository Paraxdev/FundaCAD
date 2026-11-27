//! The key table, FundaCAD 1's input/shortcuts.ts with the combos it handled before the table (undo, files, palette)
//! as fixed rows a person cannot move or take.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ctx {
    Model,
    Sketch,
    Global,
}

impl Ctx {
    pub fn name(self) -> &'static str {
        match self {
            Ctx::Model => "model",
            Ctx::Sketch => "sketch",
            Ctx::Global => "global",
        }
    }

    pub fn overlaps(self, other: Ctx) -> bool {
        self == other || self == Ctx::Global || other == Ctx::Global
    }
}

/// A key with its modifiers. `key` is lowercase as FundaCAD 1 stored it: "b", "home", "arrowleft", "f6", "?".
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Combo {
    pub key: String,
    pub shift: bool,
    pub ctrl: bool,
}

/// Names a person may write, beside a single character, an arrow and F1 to F12.
const NAMED: [&str; 11] =
    ["home", "end", "escape", "delete", "backspace", "space", "tab", "enter", "pageup", "pagedown", "insert"];
const ARROWS: [&str; 4] = ["arrowleft", "arrowright", "arrowup", "arrowdown"];

impl Combo {
    pub fn new(key: &str, shift: bool, ctrl: bool) -> Self {
        Self { key: key.to_string(), shift, ctrl }
    }

    /// Reads "Ctrl+Shift+H", "Home", "Left" or "F6", as `fmt::Display` writes them, in any case. Alt is refused: the
    /// tools read Alt with a key.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut combo = Combo::new("", false, false);
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        // "Ctrl++" is Ctrl with the plus key.
        let (mods, key) = match parts.as_slice() {
            [mods @ .., a, b] if a.is_empty() && b.is_empty() => (mods, "+".to_string()),
            [mods @ .., key] => (mods, key.to_ascii_lowercase()),
            [] => return Err("no key".into()),
        };
        for m in mods {
            match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" | "cmd" => combo.ctrl = true,
                "shift" => combo.shift = true,
                "alt" | "option" => return Err("Alt is read by the tools, pick a key without it".into()),
                other => return Err(format!("{other} is not a modifier")),
            }
        }
        let key = match key.as_str() {
            "left" | "right" | "up" | "down" => format!("arrow{key}"),
            "esc" => "escape".into(),
            "del" => "delete".into(),
            _ => key,
        };
        let fkey = key.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n));
        let known = key.chars().count() == 1 || fkey || ARROWS.contains(&key.as_str()) || NAMED.contains(&key.as_str());
        if !known {
            return Err(format!("{text} is not a key"));
        }
        combo.key = key;
        Ok(combo)
    }

    /// The keystroke GPUI binds, as "ctrl-shift-h". A typed character such as "?" goes as itself, so the keyboard
    /// layout decides which key and shift make it.
    pub fn keystroke(&self) -> String {
        let key = self.key.strip_prefix("arrow").unwrap_or(&self.key);
        format!("{}{}{key}", if self.ctrl { "ctrl-" } else { "" }, if self.shift { "shift-" } else { "" })
    }
}

impl fmt::Display for Combo {
    /// "Shift+H", "Ctrl+U", "Home", "Left", as FundaCAD 1's formatShortcut.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = self.key.strip_prefix("arrow").unwrap_or(&self.key);
        let mut chars = name.chars();
        let key = match chars.next() {
            Some(c) if name.chars().count() == 1 => c.to_uppercase().collect::<String>(),
            Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        };
        write!(f, "{}{}{key}", if self.ctrl { "Ctrl+" } else { "" }, if self.shift { "Shift+" } else { "" })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shortcut {
    /// None when the row is unbound.
    pub combo: Option<Combo>,
    pub action: &'static str,
    pub context: Ctx,
    pub label: &'static str,
    /// What a person's own key is stored against: the action, context and the key it ships with.
    pub id: String,
    pub fixed: bool,
}

impl Shortcut {
    fn new(key: &str, mods: &str, action: &'static str, context: Ctx, label: &'static str, fixed: bool) -> Self {
        let combo = (!key.is_empty()).then(|| Combo::new(key, mods.contains('s'), mods.contains('c')));
        let shown = combo.as_ref().map(Combo::to_string).unwrap_or_default();
        Self { id: format!("{action}|{}|{shown}", context.name()), combo, action, context, label, fixed }
    }
}

use Ctx::{Global as G, Model as M, Sketch as S};

/// (key, modifiers "s" and or "c", action, context, label)
type Row = (&'static str, &'static str, &'static str, Ctx, &'static str);

const FIXED: &[Row] = &[
    ("z", "c", "undo", G, "Undo"),
    ("y", "c", "redo", G, "Redo"),
    ("z", "cs", "redo", G, "Redo"),
    ("n", "c", "new", G, "New"),
    ("o", "c", "open", G, "Open"),
    ("s", "c", "save", G, "Save"),
    ("s", "cs", "save-as", G, "Save As"),
    ("e", "c", "export", G, "Export"),
    ("f", "c", "find", G, "Find"),
    ("k", "c", "palette", G, "Command palette"),
    (",", "c", "preferences", G, "Preferences"),
    ("escape", "", "escape", G, "Cancel"),
    ("delete", "", "delete", G, "Delete"),
    ("backspace", "", "delete", G, "Delete"),
    ("?", "", "shortcut-help", G, "Shortcut help"),
];

/// Keys the app holds outside the table, which no row may take, as FundaCAD 1's RESERVED.
pub const RESERVED: &[(&str, &str)] = &[
    ("Ctrl+Shift+1", "Items"),
    ("Ctrl+Shift+2", "History"),
    ("Ctrl+`", "Console"),
    ("Ctrl+Shift+`", "Console"),
    ("Ctrl+=", "Interface size"),
    ("Ctrl++", "Interface size"),
    ("Ctrl+Shift+=", "Interface size"),
    ("Ctrl+Shift++", "Interface size"),
    ("Ctrl+-", "Interface size"),
    ("Ctrl+0", "Interface size"),
    ("Tab", "Box select filter"),
];

const TABLE: &[Row] = &[
    ("s", "", "sketch", M, "Sketch"),
    ("e", "", "extrude", M, "Extrude"),
    ("q", "", "presspull", M, "Press/Pull"),
    ("f", "", "fillet", M, "Fillet"),
    ("b", "", "chamfer", M, "Chamfer (bevel)"),
    ("m", "", "move", M, "Move"),
    ("i", "", "measure", M, "Measure"),
    ("k", "", "split", M, "Split Body"),
    ("u", "c", "boolean-union", M, "Union"),
    ("b", "c", "boolean-subtract", M, "Subtract"),
    ("i", "c", "boolean-intersect", M, "Intersect"),
    ("u", "", "clean-up", M, "Clean Up"),
    ("o", "", "offset-plane", M, "Offset Plane"),
    ("h", "", "hide-selected", M, "Hide selected bodies"),
    ("h", "s", "show-all-bodies", M, "Show All Bodies"),
    ("1", "", "selmode-faces", M, "Select faces"),
    ("3", "", "selmode-auto", M, "Select a body, then its faces"),
    ("2", "", "selmode-bodies", M, "Select bodies"),
    ("x", "", "toggle-xray", M, "See through (select what is behind)"),
    ("x", "s", "toggle-wireframe", M, "Wireframe (edges only)"),
    ("l", "", "line", S, "Line"),
    ("c", "", "circle", S, "Circle"),
    ("r", "", "rectangle", S, "Rectangle"),
    ("a", "", "arc", S, "Arc"),
    ("d", "", "dimension", S, "Dimension"),
    ("t", "", "trim", S, "Trim"),
    ("o", "", "offset", S, "Offset"),
    ("f", "", "fillet-sketch", S, "Sketch Fillet"),
    ("p", "", "project", S, "Project"),
    ("m", "", "move-sketch", S, "Move/Rotate"),
    ("e", "", "extrude", S, "Finish & Extrude"),
    ("q", "", "presspull", S, "Finish & Press/Pull"),
    ("h", "", "horizontal", S, "Horizontal"),
    ("v", "", "vertical", S, "Vertical"),
    ("i", "", "coincident", S, "Coincident or on curve"),
    ("g", "", "tangent", S, "Tangent"),
    ("n", "", "perpendicular", S, "Perpendicular"),
    ("p", "s", "parallel", S, "Parallel"),
    ("e", "s", "equal", S, "Equal"),
    ("l", "s", "collinear", S, "Collinear"),
    ("c", "s", "concentric", S, "Concentric"),
    ("m", "s", "midpoint", S, "Midpoint"),
    ("s", "s", "symmetric", S, "Symmetric"),
    ("f", "s", "fix", S, "Fix"),
    ("l", "", "line", M, "Sketch: Line"),
    ("c", "", "circle", M, "Sketch: Circle"),
    ("r", "", "rectangle", M, "Sketch: Rectangle"),
    ("a", "", "arc", M, "Sketch: Arc"),
    ("p", "", "project", M, "Sketch: Project"),
    ("home", "", "fit", G, "Fit View"),
    ("home", "s", "reset-camera", G, "Reset Camera"),
    ("1", "c", "front", G, "Front view"),
    ("2", "c", "back", G, "Back view"),
    ("3", "c", "left", G, "Left view"),
    ("4", "c", "right", G, "Right view"),
    ("5", "c", "top", G, "Top view"),
    ("6", "c", "bottom", G, "Bottom view"),
    ("7", "c", "iso", G, "Isometric view"),
    ("f6", "", "region-next", G, "Next region"),
    ("f6", "s", "region-prev", G, "Previous region"),
    ("", "", "next-face", G, "Next Face"),
    ("", "", "previous-face", G, "Previous Face"),
    ("", "", "next-edge", G, "Next Edge"),
    ("", "", "previous-edge", G, "Previous Edge"),
    ("", "", "browse-geometry", G, "Browse Faces and Edges"),
    ("", "", "describe-model", G, "Describe the model"),
    ("", "", "describe-selection", G, "Describe the selection"),
    ("arrowleft", "", "view-step-left", G, "Turn the view left 15°"),
    ("arrowright", "", "view-step-right", G, "Turn the view right 15°"),
    ("arrowup", "", "view-step-up", G, "Tilt the view up 15°"),
    ("arrowdown", "", "view-step-down", G, "Tilt the view down 15°"),
    ("arrowleft", "s", "view-step-left-fine", G, "Turn the view left 5°"),
    ("arrowright", "s", "view-step-right-fine", G, "Turn the view right 5°"),
    ("arrowup", "s", "view-step-up-fine", G, "Tilt the view up 5°"),
    ("arrowdown", "s", "view-step-down-fine", G, "Tilt the view down 5°"),
    ("z", "", "viewmode-cycle", G, "Next View Mode"),
    ("z", "s", "viewmode-cycle-back", G, "Previous view mode"),
    ("v", "s", "clean-view", G, "Clean view (hide every overlay, again to bring them back)"),
    ("w", "", "navigation.radial", G, "Radial menu"),
];

/// Every row as shipped, the fixed ones first.
pub fn table() -> Vec<Shortcut> {
    let fixed = FIXED.iter().map(|&(k, m, a, c, l)| Shortcut::new(k, m, a, c, l, true));
    fixed.chain(TABLE.iter().map(|&(k, m, a, c, l)| Shortcut::new(k, m, a, c, l, false))).collect()
}
