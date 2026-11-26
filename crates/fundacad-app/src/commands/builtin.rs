//! The commands this build has: file, edit, view and help.

use gpui::*;

use super::{register, set_enabled, Group};
use crate::files::{self, Files};
use crate::overlay::{self, Toast};
use crate::viewport::{View, Viewport};

const MANUAL_URL: &str = "https://fundacad.dev/dev/";
const ISSUES_URL: &str = "https://github.com/Paraxdev/fundacad/issues";

pub fn install(viewport: &Entity<Viewport>, files: &Entity<Files>, cx: &mut App) {
    let f = files.clone();
    register(cx, "new", "New", Group::File, move |w, cx| files::new(f.clone(), w, cx));
    let f = files.clone();
    register(cx, "open", "Open", Group::File, move |w, cx| files::open(f.clone(), w, cx));
    let f = files.clone();
    register(cx, "save", "Save", Group::File, move |w, cx| files::save(f.clone(), false, w, cx));
    let f = files.clone();
    register(cx, "save-as", "Save As", Group::File, move |w, cx| files::save(f.clone(), true, w, cx));

    let v = viewport.clone();
    register(cx, "undo", "Undo", Group::Edit, move |_, cx| v.update(cx, |v, cx| v.undo(cx)));
    let v = viewport.clone();
    set_enabled(cx, "undo", move |cx| v.read(cx).can_undo());
    let v = viewport.clone();
    register(cx, "redo", "Redo", Group::Edit, move |_, cx| v.update(cx, |v, cx| v.redo(cx)));
    let v = viewport.clone();
    set_enabled(cx, "redo", move |cx| v.read(cx).can_redo());
    register(cx, "palette", "Command Palette", Group::Edit, overlay::toggle_palette);
    // Escape closes whatever is open before it reaches here, a bare one has nothing to cancel yet.
    register(cx, "escape", "Cancel", Group::Edit, |_, _| {});

    let v = viewport.clone();
    register(cx, "fit", "Fit View", Group::View, move |_, cx| v.update(cx, |v, cx| v.fit_view(cx)));
    let v = viewport.clone();
    register(cx, "reset-camera", "Reset Camera", Group::View, move |_, cx| v.update(cx, |v, cx| v.reset_camera(cx)));
    let views = [
        ("front", "Front View", View::Front),
        ("back", "Back View", View::Back),
        ("left", "Left View", View::Left),
        ("right", "Right View", View::Right),
        ("top", "Top View", View::Top),
        ("bottom", "Bottom View", View::Bottom),
        ("iso", "Isometric View", View::Iso),
    ];
    for (id, label, view) in views {
        let v = viewport.clone();
        register(cx, id, label, Group::View, move |_, cx| v.update(cx, |v, cx| v.look_from(view, cx)));
    }

    register(cx, "manual", "Manual", Group::Help, |_, cx| cx.open_url(MANUAL_URL));
    register(cx, "issues", "Issue Tracker", Group::Help, |_, cx| cx.open_url(ISSUES_URL));
    register(cx, "about", "About FundaCAD 2", Group::Help, |_, cx| {
        overlay::toast(cx, Toast::info(format!("FundaCAD 2, version {}", env!("CARGO_PKG_VERSION"))));
    });
}
