//! FUNDA_SHOT=<file.png> saves the window after FUNDA_SHOT_AFTER_MS (3000 by default), then quits. FUNDA_SHOT_RUN
//! runs steps halfway there, split by `;`: a command id, `menu:<index>`, `toast:<text>`,
//! `ask:<question>`, `key:<keystroke>` such as `key:ctrl-k`, `click:<x>,<y>` and `move:<x>,<y>` in window
//! pixels, or `wait:<ms>`.

use std::time::Duration;

use gpui::{AnyWindowHandle, App};

pub fn arm(window: AnyWindowHandle, cx: &mut App) {
    let Some(path) = std::env::var_os("FUNDA_SHOT") else { return };
    let after = std::env::var("FUNDA_SHOT_AFTER_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(3000);
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(after / 2)).await;
        let steps = std::env::var("FUNDA_SHOT_RUN").unwrap_or_default();
        for step in steps.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(ms) = step.strip_prefix("wait:").and_then(|ms| ms.parse().ok()) {
                cx.background_executor().timer(Duration::from_millis(ms)).await;
                continue;
            }
            let _ = window.update(cx, |_, window, cx| run_step(step, window, cx));
        }
        cx.background_executor().timer(Duration::from_millis(after - after / 2)).await;
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

fn run_step(step: &str, window: &mut gpui::Window, cx: &mut App) {
    if let Some(i) = step.strip_prefix("menu:").and_then(|i| i.parse().ok()) {
        crate::overlay::open_bar(window, cx, i);
    } else if let Some(text) = step.strip_prefix("toast:") {
        let toast = crate::overlay::Toast::info(text.to_string()).with_action("Undo", |_, _| {});
        crate::overlay::toast(cx, toast);
    } else if let Some(at) = step.strip_prefix("click:").or_else(|| step.strip_prefix("move:")) {
        use gpui::{px, point, MouseButton, PlatformInput};
        let Some((x, y)) = at.split_once(',').and_then(|(x, y)| Some((x.trim().parse::<f32>().ok()?, y.trim().parse::<f32>().ok()?))) else {
            return log::error!("shot: {step}: not x,y");
        };
        let position = point(px(x), px(y));
        let modifiers = gpui::Modifiers::default();
        let moved = gpui::MouseMoveEvent { position, pressed_button: None, modifiers };
        window.dispatch_event(PlatformInput::MouseMove(moved), cx);
        if step.starts_with("click:") {
            let (button, click_count, first_mouse) = (MouseButton::Left, 1, false);
            let down = gpui::MouseDownEvent { button, position, modifiers, click_count, first_mouse };
            window.dispatch_event(PlatformInput::MouseDown(down), cx);
            let up = gpui::MouseUpEvent { button, position, modifiers, click_count };
            window.dispatch_event(PlatformInput::MouseUp(up), cx);
        }
    } else if let Some(key) = step.strip_prefix("key:") {
        match gpui::Keystroke::parse_with_os(key, cx.platform_info().os) {
            Ok(k) => drop(window.dispatch_keystroke(k, cx)),
            Err(e) => log::error!("shot: {key}: {e:?}"),
        }
    } else if let Some(question) = step.strip_prefix("ask:") {
        use crate::overlay::Choice;
        let choices = vec![
            Choice::primary("Save"),
            Choice::danger("Don't save").hint("lose the changes"),
            Choice::plain("Cancel"),
        ];
        drop(crate::overlay::confirm(window, cx, question.to_string(), choices));
    } else {
        crate::commands::run(step, window, cx);
    }
}
