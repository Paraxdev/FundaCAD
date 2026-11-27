//! FUNDA_SHOT=<file.png> saves the window after FUNDA_SHOT_AFTER_MS (3000 by default), then quits. FUNDA_SHOT_RUN
//! runs steps halfway there, split by `;`, see `run_step` for the step forms. FUNDA_SHOT_SIZE sets the window size.

use std::time::Duration;

use gpui::{AnyWindowHandle, App};

/// FUNDA_SHOT_SIZE=<w>x<h> opens the window at that size instead of 1440x900.
pub fn window_size() -> Option<gpui::Size<gpui::Pixels>> {
    let v = std::env::var("FUNDA_SHOT_SIZE").ok()?;
    let (w, h) = v.split_once('x')?;
    let side = |s: &str| s.trim().parse::<f32>().ok().filter(|n| n.is_finite() && *n > 0.);
    Some(gpui::size(gpui::px(side(w)?), gpui::px(side(h)?)))
}

/// A shot run opens its window unfocused and behind the others, so it never takes input from the user's work.
pub fn active() -> bool {
    std::env::var_os("FUNDA_SHOT").is_some()
}

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
            if let Some(at) = step.strip_prefix("click:") {
                // A frame between press and release, GPUI's on_click only sees a release once a press was painted.
                let _ = window.update(cx, |_, window, cx| mouse(at, Some(true), window, cx));
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let _ = window.update(cx, |_, window, cx| mouse(at, Some(false), window, cx));
                continue;
            }
            if let Some(at) = step.strip_prefix("rclick:") {
                let n: Vec<f32> = at.split(',').filter_map(|v| v.trim().parse().ok()).collect();
                let [x, y] = n[..] else {
                    log::error!("shot: rclick:{at} wants x,y");
                    continue;
                };
                let p = gpui::point(gpui::px(x), gpui::px(y));
                let _ = window.update(cx, |_, window, cx| right(p, Some(true), window, cx));
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let _ = window.update(cx, |_, window, cx| right(p, Some(false), window, cx));
                continue;
            }
            if let Some(at) = step.strip_prefix("drag:") {
                let hold = at.ends_with(",hold");
                let n: Vec<f32> = at.split(',').filter_map(|v| v.trim().parse().ok()).collect();
                let [x, y, x2, y2] = n[..] else {
                    let _ = window.update(cx, |_, window, cx| run_step(step, window, cx));
                    continue;
                };
                let _ = window.update(cx, |_, window, cx| mouse(&format!("{x},{y}"), Some(true), window, cx));
                for i in 1..=10 {
                    cx.background_executor().timer(Duration::from_millis(60)).await;
                    let t = i as f32 / 10.0;
                    let p = gpui::point(gpui::px(x + (x2 - x) * t), gpui::px(y + (y2 - y) * t));
                    let _ = window.update(cx, |_, window, cx| {
                        let event = gpui::MouseMoveEvent {
                            position: p,
                            modifiers: Default::default(),
                            pressed_button: Some(gpui::MouseButton::Left),
                        };
                        window.dispatch_event(gpui::PlatformInput::MouseMove(event), cx);
                    });
                }
                if !hold {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    let _ = window.update(cx, |_, window, cx| mouse(&format!("{x2},{y2}"), Some(false), window, cx));
                }
                continue;
            }
            if let Some(at) = step.strip_prefix("orbit:") {
                let n: Vec<f32> = at.split(',').filter_map(|v| v.trim().parse().ok()).collect();
                let [x, y, x2, y2, ms] = n[..] else {
                    log::error!("shot: orbit:{at} wants x,y,x2,y2,ms");
                    continue;
                };
                let frames = (ms / 8.0).max(1.0) as usize;
                let at = |t: f32| gpui::point(gpui::px(x + (x2 - x) * t), gpui::px(y + (y2 - y) * t));
                let _ = window.update(cx, |_, window, cx| right(at(0.0), Some(true), window, cx));
                for i in 1..=frames {
                    cx.background_executor().timer(Duration::from_millis(8)).await;
                    let p = at(i as f32 / frames as f32);
                    let _ = window.update(cx, |_, window, cx| right(p, None, window, cx));
                }
                let _ = window.update(cx, |_, window, cx| right(at(1.0), Some(false), window, cx));
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

/// A command id, `menu:<index>`, `toast:<text>`, `ask:<question>`, `key:<keystroke>` such as `key:ctrl-k`,
/// `click:<x>,<y>` (`,ctrl` or `,shift` to add, `,double` for a double click), `move:<x>,<y>` or `hover:<x>,<y>` in window pixels, `down:`, `drag:`
/// and `up:` for a held left button, `drag:<x>,<y>,<x2>,<y2>` to sweep with it held (`,hold` keeps it down),
/// `orbit:<x>,<y>,<x2>,<y2>,<ms>` to sweep with the right button over `ms`, `rclick:<x>,<y>` for a right click, `radial:<x>,<y>[,<hot>]` opens the radial menu there without moving the pointer, `wheel:<x>,<y>,<pixels>`, or `wait:<ms>`.
/// The timed ones (click, sweeps, wait) run in the shot loop, the rest here.
fn run_step(step: &str, window: &mut gpui::Window, cx: &mut App) {
    if let Some(i) = step.strip_prefix("menu:").and_then(|i| i.parse().ok()) {
        crate::overlay::open_bar(window, cx, i);
    } else if let Some(at) = step.strip_prefix("radial:") {
        let n: Vec<f32> = at.split(',').filter_map(|v| v.trim().parse().ok()).collect();
        let (x, y, hot) = match n[..] {
            [x, y] => (x, y, None),
            [x, y, h] => (x, y, Some(h as usize)),
            _ => return log::error!("shot: radial:{at} wants x,y or x,y,hot"),
        };
        crate::shell::radial::open_at(gpui::point(gpui::px(x), gpui::px(y)), hot, window, cx);
    } else if let Some(text) = step.strip_prefix("toast:") {
        let toast = crate::overlay::Toast::info(text.to_string()).with_action("Undo", |_, _| {});
        crate::overlay::toast(cx, toast);
    } else if let Some(at) = step.strip_prefix("move:") {
        mouse(at, None, window, cx);
    } else if let Some(at) = step.strip_prefix("down:") {
        mouse(at, Some(true), window, cx);
    } else if let Some(at) = step.strip_prefix("up:") {
        mouse(at, Some(false), window, cx);
    } else if let Some(at) = step.strip_prefix("drag:") {
        mouse(&format!("{at},held"), None, window, cx);
    } else if let Some(key) = step.strip_prefix("key:") {
        match gpui::Keystroke::parse_with_os(key, cx.platform_info().os) {
            Ok(k) => drop(window.dispatch_keystroke(k, cx)),
            Err(e) => log::error!("shot: {key}: {e:?}"),
        }
    } else if let Some(at) = step.strip_prefix("hover:") {
        mouse(at, None, window, cx);
    } else if let Some(at) = step.strip_prefix("wheel:") {
        let n: Vec<f32> = at.split(',').filter_map(|v| v.trim().parse().ok()).collect();
        let [x, y, dy] = n[..] else { return log::error!("shot: wheel:{at} wants x,y,pixels") };
        let event = gpui::ScrollEvent {
            position: gpui::point(gpui::px(x), gpui::px(y)),
            delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(dy))),
            ..Default::default()
        };
        window.dispatch_event(gpui::PlatformInput::Scroll(event), cx);
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

fn mouse(at: &str, press: Option<bool>, window: &mut gpui::Window, cx: &mut App) {
    use gpui::{point, px, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput};
    let mut parts = at.split(',').map(str::trim);
    let (Some(Ok(x)), Some(Ok(y))) = (parts.next().map(str::parse::<f32>), parts.next().map(str::parse::<f32>)) else {
        return log::error!("shot: click:{at} wants x,y");
    };
    let modifiers = match parts.next() {
        Some("ctrl") => Modifiers { control: true, ..Default::default() },
        Some("shift") => Modifiers { shift: true, ..Default::default() },
        _ => Modifiers::default(),
    };
    let held = at.ends_with(",held").then_some(MouseButton::Left);
    let click_count = if at.ends_with(",double") { 2 } else { 1 };
    let position = point(px(x), px(y));
    let button = MouseButton::Left;
    let event = match press {
        None => PlatformInput::MouseMove(MouseMoveEvent { position, modifiers, pressed_button: held }),
        Some(true) => {
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent { position, modifiers, pressed_button: None }),
                cx,
            );
            PlatformInput::MouseDown(MouseDownEvent { button, position, modifiers, click_count, first_mouse: false })
        }
        Some(false) => PlatformInput::MouseUp(MouseUpEvent { button, position, modifiers, click_count }),
    };
    window.dispatch_event(event, cx);
}

fn right(position: gpui::Point<gpui::Pixels>, press: Option<bool>, window: &mut gpui::Window, cx: &mut App) {
    use gpui::{MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput};
    let (button, modifiers) = (MouseButton::Right, Default::default());
    let event = match press {
        None => PlatformInput::MouseMove(MouseMoveEvent { position, modifiers, pressed_button: Some(button) }),
        Some(true) => {
            PlatformInput::MouseDown(MouseDownEvent { button, position, modifiers, click_count: 1, first_mouse: false })
        }
        Some(false) => PlatformInput::MouseUp(MouseUpEvent { button, position, modifiers, click_count: 1 }),
    };
    window.dispatch_event(event, cx);
}
