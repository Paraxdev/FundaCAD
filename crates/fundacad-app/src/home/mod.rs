//! Home: New and Open, the recent documents and the examples, over the stage while the title bar stays live.

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use fundacad_client::Doc;
use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::files::recent::{self, Recent};
use crate::theme::{
    Mode, Theme, FLOAT_GAP, FLOAT_TILE_RADIUS, FS_BODY, FS_MICRO, FS_SMALL, R_MD, R_PILL, S_0, S_1, S_2, S_3, S_4, S_5,
    W_SEMIBOLD,
};
use crate::ui::{icon, icon_button, solid_card, text};

const SIDE_W: f32 = 220.;
const CARD_W: f32 = 200.;
const NEW_W: f32 = 90.;
const LOGO_H: f32 = 30.;
/// The lockup's viewBox is 640 by 124.
const LOGO_W: f32 = 640. * LOGO_H / 124.;

pub struct Example {
    pub id: &'static str,
    pub name: &'static str,
    pub caption: &'static str,
    pub hint: &'static str,
    pub icon: &'static str,
    /// The document it starts, None while the example is only a placeholder.
    pub text: Option<&'static str>,
}

macro_rules! template {
    ($id:literal) => {
        Some(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/templates/", $id, ".funda")))
    };
}

/// Home's cards in the order of examples/templates/examples.json, with the 3D printer after them.
pub const EXAMPLES: &[Example] = &[
    Example {
        id: "wall-bracket",
        name: "Wall bracket",
        caption: "Find where it bends",
        hint: "An L bracket on a wall. Open the Stress panel and run it to see where it bends most",
        icon: "stress",
        text: template!("wall-bracket"),
    },
    Example {
        id: "box-with-lid",
        name: "Box with a lid",
        caption: "A lid that fits, ready to print",
        hint: "A box and a lid laid out for printing. Change innerWidth in Parameters and both parts follow",
        icon: "shell",
        text: template!("box-with-lid"),
    },
    Example {
        id: "capsule-holder",
        name: "Capsule holder",
        caption: "A screw-on cap, ready to print",
        hint: "A tube and a screw-on cap laid out for printing. Change innerDiameter in Parameters and both threads follow",
        icon: "thread",
        text: template!("capsule-holder"),
    },
    Example {
        id: "plate",
        name: "Plate",
        caption: "Change a size, the holes follow",
        hint: "A plate with four holes. Change width or depth in Parameters and the holes stay in their corners",
        icon: "box",
        text: template!("plate"),
    },
    Example {
        id: "pinned-lever",
        name: "Pinned lever",
        caption: "See the load on a pin",
        hint: "A lever on a pin. Open the Stress panel and run it to see the load around the pin",
        icon: "rotate",
        text: template!("pinned-lever"),
    },
    // Placeholder: the person picked an open printer design whose license allows shipping it, the STEP is not in yet.
    Example {
        id: "printer",
        name: "3D printer",
        caption: "Open design, coming soon",
        hint: "An open source 3D printer of many parts, to come with a later build",
        icon: "assembly",
        text: None,
    },
];

pub fn example_doc(example: &Example) -> Option<Doc> {
    serde_json::from_str(example.text?).ok()
}

struct State {
    shown: bool,
    focus: FocusHandle,
    /// Home was just shown and takes the keyboard on its next frame.
    claim: bool,
}

impl Global for State {}

pub fn init(cx: &mut App, shown: bool) {
    let focus = cx.focus_handle();
    cx.set_global(State { shown, focus, claim: shown });
    crate::commands::register(cx, "home", "Home", crate::commands::Group::View, |_, cx| set(cx, !is_shown(cx)));
}

pub fn is_shown(cx: &App) -> bool {
    cx.try_global::<State>().is_some_and(|s| s.shown)
}

pub fn set(cx: &mut App, shown: bool) {
    if cx.has_global::<State>() {
        let s = cx.global_mut::<State>();
        s.claim = shown && !s.shown;
        s.shown = shown;
    }
    cx.refresh_windows();
}

/// The file's name without its extension, and the name of the folder it is in.
pub fn card_names(path: &Path) -> (String, String) {
    let name = path.file_stem().map_or_else(|| path.display().to_string(), |s| s.to_string_lossy().into());
    let folder = path.parent().and_then(Path::file_name).map(|s| s.to_string_lossy().into()).unwrap_or_default();
    (name, folder)
}

/// When a recent file was opened, in words, from milliseconds since the Unix epoch.
pub fn opened_line(now: u64, at: u64) -> String {
    const MIN: u64 = 60_000;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;
    let ago = now.saturating_sub(at);
    let plural = |n: u64, unit: &str| format!("Opened {n} {unit}{} ago", if n == 1 { "" } else { "s" });
    match ago {
        a if a < MIN => "Opened just now".into(),
        a if a < HOUR => plural(a / MIN, "minute"),
        a if a < DAY => plural(a / HOUR, "hour"),
        a if a < 2 * DAY => "Opened yesterday".into(),
        a if a < 7 * DAY => plural(a / DAY, "day"),
        _ => format!("Opened on {}", date(at)),
    }
}

/// A UTC date as "12 Nov 2026".
fn date(ms: u64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    // Howard Hinnant's days to civil date.
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{day} {} {year}", MONTHS[(month - 1) as usize])
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn start_example(doc: Doc, window: &mut Window, cx: &mut App) {
    if let Some(files) = crate::files::current(cx) {
        crate::files::new_from(files, doc, window, cx);
    }
}

fn run(id: &'static str) -> impl Fn(&ClickEvent, &mut Window, &mut App) {
    move |_, window, cx| crate::commands::run(id, window, cx)
}

/// Home over the stage, None while it is closed.
pub fn view(t: &Theme, window: &mut Window, cx: &mut App) -> Option<Stateful<Div>> {
    if !is_shown(cx) {
        return None;
    }
    let state = cx.global_mut::<State>();
    let focus = state.focus.clone();
    if std::mem::take(&mut state.claim) {
        window.focus(&focus, cx);
    }
    let recents = recent::list(cx);
    let now = now();

    let mut scroll = div().id("home-scroll").flex_1().min_h_0().overflow_y_scroll().flex().flex_col();
    if recents.is_empty() {
        scroll = scroll.child(section(t, "Start here")).child(examples(t));
    } else {
        let cards = recents.iter().enumerate().map(|(i, r)| recent_card(t, i, r, now));
        scroll = scroll.child(grid().children(cards)).child(section(t, "Examples")).child(examples(t));
    }

    let main = div()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(S_4))
                .px(px(S_5))
                .pt(px(S_5))
                .pb(px(S_3))
                .child(new_strip(t))
                .child(div().flex_1())
                .child(icon_button(t, "home-close", "close", 28., 15., t.text_dim).on_click(|_, _, cx| set(cx, false))),
        )
        .child(scroll);

    Some(
        div()
            .id("home")
            .absolute()
            .size_full()
            .track_focus(&focus)
            .on_key_down(|e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" {
                    set(cx, false);
                    cx.stop_propagation();
                }
            })
            .occlude()
            .bg(t.bg)
            .flex()
            .child(side(t))
            .child(main),
    )
}

fn side(t: &Theme) -> Div {
    let recent_row = text(t, FS_SMALL)
        .flex()
        .items_center()
        .gap(px(S_2))
        .h(px(28.))
        .px(px(S_3))
        .rounded(px(R_MD))
        .bg(t.accent_wash)
        .text_color(t.accent_hot)
        .font_weight(W_SEMIBOLD)
        .child(icon("history", 14., t.accent_hot))
        .child("Recent");
    solid_card(t)
        .bg(t.float_bg_solid)
        .w(px(SIDE_W))
        .flex_none()
        .m(px(FLOAT_GAP))
        .px(px(S_4))
        .py(px(S_5))
        .gap(px(S_4))
        .child(
            img(match t.mode {
                Mode::Dark => "brand/fundacad-lockup-app.svg",
                Mode::Light => "brand/fundacad-lockup-app-light.svg",
            })
            .h(px(LOGO_H))
            .w(px(LOGO_W.min(SIDE_W - 2. * S_4)))
            .flex_none(),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(S_0))
                .child(text(t, FS_MICRO).px(px(S_3)).pb(px(S_1)).text_color(t.text_mute).child("DOCUMENTS"))
                .child(recent_row),
        )
}

fn new_strip(t: &Theme) -> Div {
    let tile = |id: &'static str, glyph: &'static str, name: &'static str, line: Option<&'static str>| {
        card(t, id)
            .w(px(NEW_W))
            .child(
                div()
                    .h(px(64.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(t.panel_2)
                    .child(icon(glyph, 24., t.text_dim)),
            )
            .child(text(t, FS_SMALL).px(px(S_2)).pt(px(S_2)).font_weight(W_SEMIBOLD).child(name))
            .children(line.map(|l| text(t, FS_MICRO).px(px(S_2)).text_color(t.text_dim).child(l)))
    };
    div()
        .flex()
        .gap(px(S_3))
        .child(tile("home-new", "plus", "Blank", None).on_click(run("new")))
        .child(tile("home-open", "open", "Open...", Some("Documents and STL")).on_click(run("open")))
}

fn section(t: &Theme, label: &'static str) -> Div {
    div().flex().px(px(S_5)).pt(px(S_2)).child(
        div()
            .rounded(px(R_PILL))
            .bg(t.float_bg_solid)
            .px(px(S_3))
            .py(px(S_1))
            .child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).text_color(t.text_dim).child(label)),
    )
}

fn grid() -> Div {
    div().flex().flex_wrap().gap(px(S_4)).px(px(S_5)).pt(px(S_3)).pb(px(S_5))
}

/// A tile of glass that does not blur, Home scrolls and a blurred patch would not follow the clip.
fn card(t: &Theme, id: impl Into<ElementId>) -> Stateful<Div> {
    let hover = t.raised;
    div()
        .id(id)
        .flex()
        .flex_col()
        .flex_none()
        .pb(px(S_3))
        .gap(px(S_0))
        .overflow_hidden()
        .rounded(px(FLOAT_TILE_RADIUS))
        .bg(t.float_bg_solid)
        .shadow(t.float_shadow.clone())
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
}

fn picture(t: &Theme, glyph: &str) -> Div {
    div()
        .h(px(CARD_W * 5. / 8.))
        .mb(px(S_2))
        .flex()
        .items_center()
        .justify_center()
        .bg(t.panel_2)
        .child(icon(glyph, 36., t.text_dim))
}

fn card_line(t: &Theme, fs: f32) -> Div {
    let d = text(t, fs).px(px(S_3)).min_w_0().truncate();
    if fs == FS_BODY {
        d.font_weight(W_SEMIBOLD)
    } else {
        d.text_color(t.text_dim)
    }
}

fn recent_card(t: &Theme, i: usize, r: &Recent, now: u64) -> Stateful<Div> {
    let (name, folder) = card_names(&r.path);
    let missing = !r.path.exists();
    let path = r.path.clone();
    let menu_path = r.path.clone();
    let tip = r.path.display().to_string();
    card(t, ("home-recent", i))
        .w(px(CARD_W))
        .when(missing, |d| d.opacity(0.55))
        .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx))
        .child(picture(t, "body"))
        .child(card_line(t, FS_BODY).child(name))
        .child(card_line(t, FS_MICRO).child(folder))
        .child(card_line(t, FS_MICRO).child(if missing { "Not found".into() } else { opened_line(now, r.opened_at) }))
        .on_click(move |_, window, cx| open_path(path.clone(), window, cx))
        .on_mouse_down(MouseButton::Right, move |e, window, cx| {
            crate::overlay::open_menu(window, cx, e.position, recent_menu(menu_path.clone()));
            cx.stop_propagation();
        })
}

fn open_path(path: PathBuf, window: &mut Window, cx: &mut App) {
    crate::files::open_recent_path(path, window, cx);
}

fn recent_menu(path: PathBuf) -> Vec<crate::overlay::MenuRow> {
    use crate::overlay::{MenuItem, MenuRow};
    let (open, gone, copied) = (path.clone(), path.clone(), path);
    vec![
        MenuRow::Item(MenuItem::call("Open", move |window, cx| open_path(open.clone(), window, cx))),
        MenuRow::Item(MenuItem::call("Remove from list", move |_, cx| {
            recent::forget(cx, &gone);
            cx.refresh_windows();
        })),
        MenuRow::Separator,
        MenuRow::Item(MenuItem::call("Copy path", move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copied.display().to_string()));
        })),
    ]
}

fn examples(t: &Theme) -> Div {
    grid().children(EXAMPLES.iter().enumerate().map(|(i, ex)| {
        let ready = ex.text.is_some();
        let hint = ex.hint;
        card(t, ex.id)
            .w(px(CARD_W))
            .when(!ready, |d| d.opacity(0.55).cursor_default())
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(hint).build(window, cx))
            .child(picture(t, ex.icon))
            .child(card_line(t, FS_BODY).child(ex.name))
            .child(card_line(t, FS_MICRO).child(ex.caption))
            .when(ready, |d| {
                d.on_click(move |_, window, cx| {
                    if let Some(doc) = example_doc(&EXAMPLES[i]) {
                        start_example(doc, window, cx);
                    }
                })
            })
    }))
}
