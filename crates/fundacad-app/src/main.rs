//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod plastic;
mod shell;
#[cfg(feature = "shot")]
mod shot;
mod theme;
mod viewport;

use gpui::*;

fn main() {
    init_logger();
    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    let title: SharedString = match &path {
        Some(path) => format!("FundaCAD 2, {}", path.file_name().unwrap_or_default().to_string_lossy()),
        None => "FundaCAD 2".into(),
    }
    .into();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        gpui_kit::component::Theme::change(gpui_kit::component::ThemeMode::Dark, None, cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1400.), px(900.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        let _window = gpui_kit::open_window(options, cx, move |_, cx| {
            let viewport = cx.new(|cx| {
                let mut viewport = viewport::Viewport::new();
                if let Some(path) = &path {
                    viewport.open(path, cx);
                }
                viewport
            });
            cx.new(|cx| shell::Shell::new(viewport, title, cx))
        })
        .expect("open the main window");
        #[cfg(feature = "shot")]
        shot::arm(_window.0, cx);
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
