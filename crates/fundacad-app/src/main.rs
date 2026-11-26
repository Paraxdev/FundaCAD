//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod commands;
mod document;
mod engine;
mod files;
mod home;
mod inspector;
mod items;
mod overlay;
mod plastic;
mod settings;
mod shell;
#[cfg(feature = "shot")]
mod shot;
mod sketch;
mod theme;
mod timeline;
mod ui;
mod viewport;
mod workbench;

use gpui::*;

fn main() {
    init_logger();
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    let doc = document::Document::named(files::shown_name(path.as_deref()));
    let title: SharedString = files::window_title(&doc.name, false).into();

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        settings::init(cx);
        let mut settings = theme::Settings::default();
        // FUNDA_THEME=<palette id> picks a palette until the settings store lands, for the light capture.
        if let Ok(id) = std::env::var("FUNDA_THEME") {
            settings.choice = id;
        }
        theme::init(settings, vec![], cx);
        theme::kit::bind(cx);
        overlay::init(cx);
        commands::bind(cx);
        home::init(cx, path.is_none());
        files::set_startup(cx, path);
        cx.bind_keys([KeyBinding::new("ctrl-alt-p", shell::OpenParameters, None)]);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1440.), px(900.)), cx))),
            // Below this the left and right float clusters overlap.
            window_min_size: Some(size(px(1000.), px(640.))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        let (_window, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            let viewport = cx.new(|_| viewport::Viewport::new());
            cx.new(|cx| shell::Shell::new(viewport, doc, window, cx))
        })
        .expect("open the main window");
        #[cfg(feature = "shot")]
        shot::arm(_window, cx);
    });
}

static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn init_logger() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                let start = START.get_or_init(std::time::Instant::now);
                eprintln!("{:>8.3} [{}] {}", start.elapsed().as_secs_f64(), r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    START.get_or_init(std::time::Instant::now);
    let _ = log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info));
}
