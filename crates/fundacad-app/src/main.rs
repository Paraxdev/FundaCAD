//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod document;
mod engine;
mod plastic;
mod shell;
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
    // With --features shot, FUNDA_SHOT=out.png draws one frame at 1440x900, saves it and quits, for the side by side
    // with the Vue app.
    #[cfg(feature = "shot")]
    let shot = std::env::var_os("FUNDA_SHOT").map(std::path::PathBuf::from);

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let mut settings = theme::Settings::default();
        // FUNDA_THEME=<palette id> picks a palette until the settings store lands, for the light capture.
        if let Ok(id) = std::env::var("FUNDA_THEME") {
            settings.choice = id;
        }
        theme::init(settings, vec![], cx);
        theme::kit::bind(cx);
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
        if let Some(out) = shot {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(2500)).await;
                let _ = _window.update(cx, |_, window, _| match window.render_to_image() {
                    Ok(img) => img.save(&out).map_err(|e| log::error!("save {}: {e}", out.display())).unwrap_or(()),
                    Err(e) => log::error!("render_to_image: {e}, FUNDA_GPUI_RENDERER=dx can capture"),
                });
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
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
