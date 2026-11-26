//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod document;
mod engine;
mod plastic;
mod shell;
#[cfg(feature = "shot")]
mod shot;
mod theme;
mod ui;
mod viewport;

use gpui::*;

fn main() {
    init_logger();
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    // The sample history stands in for the Vue capture until the engine link reads a file's own.
    let doc = match path.as_ref().and_then(|p| p.file_stem()) {
        Some(name) => document::Document::named(name.to_string_lossy().to_string().into()),
        None => document::Document::sample(),
    };
    let title: SharedString = format!("{}, FundaCAD 2", doc.name).into();

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let mut settings = theme::Settings::default();
        // FUNDA_THEME=<palette id> picks a palette until the settings store lands, for the light capture.
        if let Ok(id) = std::env::var("FUNDA_THEME") {
            settings.choice = id;
        }
        theme::init(settings, vec![], cx);
        theme::kit::bind(cx);
        cx.bind_keys([
            KeyBinding::new("ctrl-z", viewport::Undo, None),
            KeyBinding::new("ctrl-y", viewport::Redo, None),
            KeyBinding::new("ctrl-shift-z", viewport::Redo, None),
            KeyBinding::new("ctrl-alt-p", shell::OpenParameters, None),
        ]);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1440.), px(900.)), cx))),
            // Below this the left and right float clusters overlap.
            window_min_size: Some(size(px(1000.), px(640.))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        let (_window, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            let viewport = cx.new(|cx| {
                let mut viewport = viewport::Viewport::new();
                if let Some(path) = &path {
                    viewport.open(path, cx);
                }
                viewport
            });
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
