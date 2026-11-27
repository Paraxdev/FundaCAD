//! What one Escape does in a sketch, FundaCAD 1's sketch/escapeLayers.ts: a stack, most local first, so a half drawn
//! shape is never lost along with the session, and leaving takes at most two presses from any state.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub dragging: bool,
    /// A half finished shape, a typed dimension or a first constraint pick.
    pub pending: bool,
    pub selection: bool,
    /// A tool other than the resting Select.
    pub armed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    CancelDrag,
    CancelPending,
    ClearSelection,
    ArmSelect,
    Close,
}

pub fn action(s: State) -> Action {
    if s.dragging {
        Action::CancelDrag
    } else if s.pending {
        Action::CancelPending
    } else if s.selection {
        Action::ClearSelection
    } else if s.armed {
        Action::ArmSelect
    } else {
        Action::Close
    }
}

#[cfg(test)]
#[path = "escape_tests.rs"]
mod tests;
