//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod commands;
mod diag;
mod document;
mod edgedrag;
mod engine;
mod files;
mod home;
mod i18n;
mod inspect;
mod inspector;
mod items;
mod motion;
mod overlay;
mod plastic;
mod prefs;
mod plugins;
mod recovery;
mod ribbon;
mod selection;
mod settings;
mod shell;
#[cfg(feature = "shot")]
mod shot;
mod sketch;
mod theme;
mod timeline;
mod tools;
mod ui;
mod viewport;
mod workbench;

use gpui::*;

fn main() {
    diag::start();
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        settings::init(cx);
        i18n::init(cx);
        let doc = document::Document::named(files::shown_name(path.as_deref()));
        let title: SharedString = files::window_title(&doc.name, false).into();
        let mut settings = prefs::theme_settings();
        // FUNDA_THEME=<palette id> overrides the stored theme, for the light capture.
        if let Ok(id) = std::env::var("FUNDA_THEME") {
            settings.choice = id;
        }
        theme::init(settings, vec![], cx);
        theme::kit::bind(cx);
        overlay::init(cx);
        prefs::install(cx);
        commands::bind(cx);
        diag::init(cx);
        home::init(cx, path.is_none());
        files::set_startup(cx, path);
        cx.bind_keys([KeyBinding::new("ctrl-alt-p", shell::OpenParameters, Some(commands::workspace_predicate()))]);
        let start_size = size(px(1440.), px(900.));
        #[cfg(feature = "shot")]
        let start_size = shot::window_size().unwrap_or(start_size);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, start_size, cx))),
            // Below this the left and right float clusters overlap.
            window_min_size: Some(size(px(1000.), px(640.))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        let (_window, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            prefs::apply_size(window, cx);
            let viewport = cx.new(|_| viewport::Viewport::new());
            cx.new(|cx| shell::Shell::new(viewport, doc, window, cx))
        })
        .expect("open the main window");
        #[cfg(feature = "shot")]
        shot::arm(_window, cx);
    });
}
