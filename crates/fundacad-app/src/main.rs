//! FundaCAD 2, the native app (docs/dev/NATIVE-DIRECTION.md).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod document;
mod engine;
mod shell;
// The full token set lands ahead of the panels that use it.
#[allow(dead_code)]
mod theme;
mod ui;
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
    log::info!("{} triangles", mesh.triangles());
    let mut doc = document::Document::sample();
    if let Some(name) = path.as_ref().and_then(|p| p.file_stem()) {
        doc.name = name.to_string_lossy().to_string().into();
        doc.dirty = false;
    }
    let title: SharedString = format!("{}, FundaCAD 2", doc.name).into();
    // With --features shot, FUNDA_SHOT=out.png draws one frame at 1440x900, saves it and quits, for the side by side
    // with the Vue app.
    #[cfg(feature = "shot")]
    let shot = std::env::var_os("FUNDA_SHOT").map(std::path::PathBuf::from);

    gpui_kit::application().with_assets(assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        theme::init(theme::Settings::default(), vec![], cx);
        sync_kit_theme(cx);
        cx.observe_global::<theme::ThemeState>(sync_kit_theme).detach();
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1440.), px(900.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some(title.clone()), ..Default::default() }),
            ..Default::default()
        };
        let (_window, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            let viewport = cx.new(|_| viewport::Viewport::new(mesh));
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

/// The kit's own controls (inputs, popups, scrollbars) follow our light or dark mode.
fn sync_kit_theme(cx: &mut App) {
    use gpui_kit::component::{Theme, ThemeMode};
    let mode = match theme::state(cx).theme().mode {
        theme::Mode::Dark => ThemeMode::Dark,
        theme::Mode::Light => ThemeMode::Light,
    };
    if Theme::global(cx).mode != mode {
        Theme::change(mode, None, cx);
    }
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
