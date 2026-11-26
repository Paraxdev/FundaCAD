//! The commands this build has: file, edit, view and help.

use gpui::*;

use super::{register, set_enabled, Group};
use crate::files::{self, Files};
use crate::i18n::{tr, Label, LabelArgs};
use crate::overlay::{self, Toast};
use crate::viewport::{View, Viewport};

const MANUAL_URL: &str = "https://fundacad.dev/dev/";
const ISSUES_URL: &str = "https://github.com/Paraxdev/fundacad/issues";

pub fn install(viewport: &Entity<Viewport>, files: &Entity<Files>, cx: &mut App) {
    let f = files.clone();
    register(cx, "new", Label::Command("command.new"), Group::File, move |w, cx| files::new(f.clone(), w, cx));
    let f = files.clone();
    register(cx, "open", Label::Command("command.open"), Group::File, move |w, cx| files::open(f.clone(), w, cx));
    let f = files.clone();
    register(cx, "save", Label::Command("command.save"), Group::File, move |w, cx| files::save(f.clone(), false, w, cx));
    let f = files.clone();
    register(cx, "save-as", Label::Command("command.saveAs"), Group::File, move |w, cx| files::save(f.clone(), true, w, cx));

    let v = viewport.clone();
    register(cx, "undo", Label::Command("command.undo"), Group::Edit, move |_, cx| v.update(cx, |v, cx| v.undo(cx)));
    let v = viewport.clone();
    set_enabled(cx, "undo", move |cx| v.read(cx).can_undo());
    let v = viewport.clone();
    register(cx, "redo", Label::Command("command.redo"), Group::Edit, move |_, cx| v.update(cx, |v, cx| v.redo(cx)));
    let v = viewport.clone();
    set_enabled(cx, "redo", move |cx| v.read(cx).can_redo());
    register(cx, "palette", Label::Key("palette.title"), Group::Edit, overlay::toggle_palette);
    // Escape closes whatever is open before it reaches here, a bare one has nothing to cancel yet.
    register(cx, "escape", Label::Key("common.cancel"), Group::Edit, |_, _| {});

    let v = viewport.clone();
    register(cx, "fit", Label::Command("command.fit"), Group::View, move |_, cx| v.update(cx, |v, cx| v.fit_view(cx)));
    let v = viewport.clone();
    register(cx, "reset-camera", Label::Command("command.resetCamera"), Group::View, move |_, cx| v.update(cx, |v, cx| v.reset_camera(cx)));
    let views: [(&str, LabelArgs, View); 7] = [
        ("front", &[("view", "front")], View::Front),
        ("back", &[("view", "back")], View::Back),
        ("left", &[("view", "left")], View::Left),
        ("right", &[("view", "right")], View::Right),
        ("top", &[("view", "top")], View::Top),
        ("bottom", &[("view", "bottom")], View::Bottom),
        ("iso", &[("view", "iso")], View::Iso),
    ];
    for (id, args, view) in views {
        let v = viewport.clone();
        register(cx, id, Label::With("view.command", args), Group::View, move |_, cx| v.update(cx, |v, cx| v.look_from(view, cx)));
    }

    register(cx, "manual", Label::Command("command.manual"), Group::Help, |_, cx| cx.open_url(MANUAL_URL));
    register(cx, "issues", Label::Key("menu.help.issueTracker"), Group::Help, |_, cx| cx.open_url(ISSUES_URL));
    register(cx, "about", Label::With("menu.help.about", &[("name", "FundaCAD 2")]), Group::Help, |_, cx| {
        overlay::toast(cx, Toast::info(format!("FundaCAD 2, {}", tr!("updates.version", version = env!("CARGO_PKG_VERSION")))));
    });
}
