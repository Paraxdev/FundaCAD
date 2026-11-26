//! What the shell holds besides its panels: the overlay it draws last and the document's file, with the commands wired
//! to them.

use gpui::*;

use crate::files::{self, Files};
use crate::overlay::{self, Overlay};
use crate::viewport::Viewport;

pub struct Bench {
    pub overlay: Entity<Overlay>,
    pub files: Entity<Files>,
}

impl Bench {
    pub fn new<T: 'static>(viewport: &Entity<Viewport>, window: &mut Window, cx: &mut Context<T>) -> Self {
        let overlay = overlay::new(cx);
        let files = cx.new(|cx| Files::new(viewport.clone(), window, cx));
        files::set_current(cx, &files);
        crate::commands::install(viewport, &files, cx);
        crate::commands::report_problems(cx);
        let guard = files.clone();
        window.on_window_should_close(cx, move |window, cx| files::should_close(&guard, window, cx));
        let start = files.clone();
        window.defer(cx, move |window, cx| files::start(&start, window, cx));
        crate::recovery::install(viewport, &files, window, cx);
        Self { overlay, files }
    }
}
