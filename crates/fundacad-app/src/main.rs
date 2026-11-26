//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod shell;
mod theme;
mod viewport;

use gpui::*;

fn main() {
    init_logger();
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    let mesh = match &path {
        Some(path) => engine::open(path).unwrap_or_else(|e| {
            log::error!("{e}");
            Default::default()
        }),
        None => Default::default(),
    };
    let title: SharedString = match &path {
        Some(path) => format!("FundaCAD 2, {}", path.file_name().unwrap_or_default().to_string_lossy()),
        None => "FundaCAD 2".into(),
    }
    .into();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        theme::init(theme::Settings::default(), vec![], cx);
        theme::kit::bind(cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1400.), px(900.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, move |window, cx| {
            let viewport = cx.new(|_| viewport::Viewport::new(mesh));
            cx.new(|cx| shell::Shell::new(viewport, title, window, cx))
        })
        .expect("open the main window");
    });
}

fn init_logger() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    let _ = log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info));
}
