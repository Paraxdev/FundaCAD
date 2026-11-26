//! FUNDA_SHOT=<file.png> saves the window after FUNDA_SHOT_AFTER_MS (3000 by default), then quits.

use std::time::Duration;

use gpui::{AnyWindowHandle, App};

pub fn arm(window: AnyWindowHandle, cx: &mut App) {
    let Some(path) = std::env::var_os("FUNDA_SHOT") else { return };
    let after = std::env::var("FUNDA_SHOT_AFTER_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(3000);
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(after)).await;
        let image = window.update(cx, |_, window, _| window.render_to_image());
        match image {
            Ok(Ok(image)) => match image.save(&path) {
                Ok(()) => log::info!("shot: saved {}x{} to {}", image.width(), image.height(), path.to_string_lossy()),
                Err(e) => log::error!("shot: {e}"),
            },
            Ok(Err(e)) => log::error!("shot: {e:#}"),
            Err(e) => log::error!("shot: {e:#}"),
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}
