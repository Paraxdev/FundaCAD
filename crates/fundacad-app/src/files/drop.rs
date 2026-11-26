//! Files dropped on the window, FundaCAD 1's src/io/dropRouting.ts and DropHint.vue. The first document dropped
//! opens through the unsaved changes guard, the rest are named in a toast.

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use gpui::*;

use crate::overlay::{self, Toast};
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_SMALL, S_1, S_3, S_4, W_SEMIBOLD};
use crate::ui::text;

const OPENS: &[&str] = &["funda", "fundab", "stl"];
/// FundaCAD 1's outline-offset, the dashed outline sits this far inside the window.
const INSET: f32 = 10.;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub open: Option<PathBuf>,
    /// Further documents, only one is open at a time.
    pub skipped: Vec<PathBuf>,
    pub rejected: Vec<PathBuf>,
}

fn opens(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| OPENS.iter().any(|o| e.eq_ignore_ascii_case(o)))
}

pub fn plan(paths: &[PathBuf]) -> Plan {
    let mut plan = Plan::default();
    for path in paths {
        if !opens(path) {
            plan.rejected.push(path.clone());
        } else if plan.open.is_none() {
            plan.open = Some(path.clone());
        } else {
            plan.skipped.push(path.clone());
        }
    }
    plan
}

fn names(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// One sentence about what a drop left out, None when it took everything.
pub fn leftovers(plan: &Plan) -> Option<String> {
    let mut parts = Vec::new();
    if !plan.rejected.is_empty() {
        parts.push(format!("FundaCAD cannot open {}.", names(&plan.rejected)));
    }
    if !plan.skipped.is_empty() {
        parts.push(format!("Only one document opens at a time, so {} stayed closed.", names(&plan.skipped)));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

pub fn on_drop(paths: &ExternalPaths, window: &mut Window, cx: &mut App) {
    let plan = plan(paths.paths());
    if let Some(note) = leftovers(&plan) {
        overlay::toast(cx, Toast::warning(note));
    }
    if let Some(path) = plan.open {
        super::open_recent_path(path, window, cx);
    }
}

/// Covers the window while files are dragged over it. The panels and cards occlude the shell below, so the drop is
/// taken here, above them.
pub fn hint(t: &Theme) -> impl IntoElement {
    layer(t, on_drop)
}

fn layer(t: &Theme, on: impl Fn(&ExternalPaths, &mut Window, &mut App) + 'static) -> impl IntoElement {
    let card = div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(S_1 + 2.))
        .max_w(px(360.))
        .px(px(S_4 + 4.))
        .py(px(S_4))
        .rounded(px(FLOAT_CHIP_RADIUS + 2.))
        .bg(t.float_bg_solid)
        .text_center()
        .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).text_color(t.text).child("Drop to open"))
        .child(
            text(t, FS_SMALL).text_color(t.text_dim).child("A FundaCAD document or an STL opens in place of this one."),
        );
    let frame = div()
        .absolute()
        .inset(px(INSET))
        .flex()
        .items_center()
        .justify_center()
        .p(px(S_3 - 2.))
        .border_2()
        .border_dashed()
        .border_color(t.accent)
        .child(card);
    let tint = t.accent_tint;
    div()
        .id("drop-hint")
        .absolute()
        .inset_0()
        .opacity(0.)
        .drag_over::<ExternalPaths>(move |s, _, _, _| s.opacity(1.).bg(tint))
        .on_drop(on)
        .child(frame)
}
