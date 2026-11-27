//! A menu at the cursor drawn as a ring, FundaCAD 1's ui/radialMenu.ts and RadialMenuHost.vue. Item 0 sits at the top
//! and the rest follow clockwise. While the button or key that opened it is held, moving lights an item and the
//! release runs it; opened without one, a click runs it.

#[cfg(test)]
mod tests;

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::menu::{MenuItem, Run};
use super::Overlay;
use crate::commands;
use crate::motion::{self, mix};
use crate::theme::{eased, Theme, FS_SMALL, T_FAST, T_MED};
use crate::ui::{icon, text};

/// Pointer travel inside this radius picks nothing.
pub const DEADZONE: f32 = 24.;
/// Ring radius the items are drawn at.
pub const RADIUS: f32 = 84.;
/// Dragging this far out over an item with children opens its ring there.
pub const SUBMENU: f32 = 130.;
/// Each item is centred in a box this size, GPUI has no `translate(-50%)`.
const CELL: Size<f32> = Size { width: 150., height: 28. };

#[derive(Clone)]
pub struct RadialItem {
    pub item: MenuItem,
    pub icon: Option<&'static str>,
    pub children: Vec<RadialItem>,
}

impl RadialItem {
    pub fn new(item: MenuItem, icon: Option<&'static str>) -> Self {
        Self { item, icon, children: Vec::new() }
    }

    pub fn group(label: impl Into<SharedString>, icon: Option<&'static str>, children: Vec<RadialItem>) -> Self {
        Self { item: MenuItem::call(label, |_, _| {}), icon, children }
    }
}

/// What opened the ring and is still held.
#[derive(Clone, Debug, PartialEq)]
pub enum Trigger {
    Button(MouseButton),
    /// Lowercase, as GPUI names the key.
    Key(String),
}

/// The item a pointer offset points at, None inside the dead zone.
pub fn pick(count: usize, dx: f32, dy: f32) -> Option<usize> {
    if count == 0 || dx.hypot(dy) < DEADZONE {
        return None;
    }
    let tau = std::f32::consts::TAU;
    let turn = dx.atan2(-dy).rem_euclid(tau);
    Some((turn / (tau / count as f32)).round() as usize % count)
}

/// Where item `i` of `count` is drawn, relative to the centre.
pub fn slot(i: usize, count: usize, r: f32) -> (f32, f32) {
    let a = i as f32 / count.max(1) as f32 * std::f32::consts::TAU;
    (a.sin() * r, -a.cos() * r)
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Stay,
    Close,
    /// Close and run the item at this index of the ring as it was.
    Run(usize),
}

pub struct Ring {
    pub at: Point<Pixels>,
    pub items: Vec<RadialItem>,
    pub hot: Option<usize>,
    pub gesture: Option<Trigger>,
    /// Counts the rings opened in this session, so each new one plays its entrance.
    pub depth: usize,
}

fn dist(a: Point<Pixels>, b: Point<Pixels>) -> (f32, f32) {
    (f32::from(b.x - a.x), f32::from(b.y - a.y))
}

impl Ring {
    pub fn new(at: Point<Pixels>, items: Vec<RadialItem>, gesture: Option<Trigger>) -> Self {
        Self { at, items, hot: None, gesture, depth: 0 }
    }

    fn hit(&self, p: Point<Pixels>) -> Option<usize> {
        let (dx, dy) = dist(self.at, p);
        pick(self.items.len(), dx, dy)
    }

    fn sub(&mut self, at: Point<Pixels>, i: usize, gesture: Option<Trigger>) {
        let children = std::mem::take(&mut self.items[i].children);
        *self = Self { at, items: children, hot: None, gesture, depth: self.depth + 1 };
    }

    /// Lights what the pointer points at. Held out past SUBMENU over an item with children, its ring opens there.
    pub fn moved(&mut self, p: Point<Pixels>) -> bool {
        let hot = self.hit(p);
        let changed = hot != self.hot;
        self.hot = hot;
        let Some(i) = hot else { return changed };
        let it = &self.items[i];
        let (dx, dy) = dist(self.at, p);
        if self.gesture.is_some() && !it.children.is_empty() && !it.item.disabled && dx.hypot(dy) >= SUBMENU {
            self.sub(p, i, self.gesture.clone());
            return true;
        }
        changed
    }

    /// Runs or opens what is under `p`, None when that is the dead zone.
    fn choose(&mut self, p: Point<Pixels>) -> Option<Outcome> {
        let i = self.hit(p)?;
        let it = &self.items[i];
        if it.item.disabled {
            return Some(Outcome::Stay);
        }
        if !it.children.is_empty() {
            self.sub(p, i, None);
            return Some(Outcome::Stay);
        }
        Some(Outcome::Run(i))
    }

    /// The held button or key came up.
    pub fn release(&mut self, p: Point<Pixels>) -> Outcome {
        let Some(gesture) = self.gesture.take() else { return Outcome::Stay };
        if let Some(o) = self.choose(p) {
            return o;
        }
        // A key tapped without a move leaves the ring up to click, a drag let go in the middle is a change of mind.
        match gesture {
            Trigger::Key(_) => Outcome::Stay,
            Trigger::Button(_) => Outcome::Close,
        }
    }

    pub fn click(&mut self, p: Point<Pixels>) -> Outcome {
        if self.gesture.is_some() {
            return Outcome::Stay;
        }
        self.choose(p).unwrap_or(Outcome::Close)
    }

    pub fn held_by(&self, t: &Trigger) -> bool {
        self.gesture.as_ref() == Some(t)
    }
}

fn overlay(cx: &App) -> Option<Entity<Overlay>> {
    super::handle(cx)
}

/// Opens a ring at `at` in window pixels. With `gesture`, that button or key is held now and its release picks.
pub fn open_radial(
    window: &mut Window,
    cx: &mut App,
    at: Point<Pixels>,
    items: Vec<RadialItem>,
    gesture: Option<Trigger>,
) {
    let Some(o) = overlay(cx) else { return };
    o.update(cx, |o, cx| {
        o.close_menu(window, cx);
        o.take_keyboard(window, cx);
        o.radial = Some(Ring::new(at, items, gesture));
        cx.notify();
    });
}

/// A held button came up outside the overlay's own layer, before it was first drawn.
pub fn radial_release(window: &mut Window, cx: &mut App, button: MouseButton, at: Point<Pixels>) {
    let Some(o) = overlay(cx) else { return };
    o.update(cx, |o, cx| o.radial_up(Trigger::Button(button), at, window, cx));
}

/// Closes the ring without running anything whenever the window loses focus, as FundaCAD 1's window blur does,
/// since the held key or button can come up where the window never hears it.
pub fn close_on_blur(window: &mut Window, cx: &mut App) -> Option<Subscription> {
    let o = overlay(cx)?;
    Some(o.update(cx, |_, cx| {
        cx.observe_window_activation(window, |o, window, cx| {
            if !window.is_window_active() && o.radial.is_some() {
                o.close_radial(window, cx);
                cx.notify();
            }
        })
    }))
}

pub fn radial_open(cx: &App) -> bool {
    overlay(cx).is_some_and(|o| o.read(cx).radial.is_some())
}

/// Lights item `hot` of the open ring, for shots.
#[cfg(feature = "shot")]
pub fn light(cx: &mut App, hot: usize) {
    let Some(o) = overlay(cx) else { return };
    o.update(cx, |o, cx| {
        if let Some(r) = &mut o.radial {
            r.hot = (hot < r.items.len()).then_some(hot);
            cx.notify();
        }
    });
}

impl Overlay {
    pub(super) fn close_radial(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.radial.take().is_some() {
            self.release_keyboard(window, cx);
        }
    }

    fn radial_outcome(&mut self, o: Outcome, window: &mut Window, cx: &mut Context<Self>) {
        match o {
            Outcome::Stay => cx.notify(),
            Outcome::Close => self.close_radial(window, cx),
            Outcome::Run(i) => {
                let Some(item) = self.radial.as_ref().and_then(|r| r.items.get(i)).map(|r| r.item.clone()) else {
                    return;
                };
                self.close_radial(window, cx);
                window.defer(cx, move |window, cx| match &item.run {
                    Run::Command(id) => commands::run(id, window, cx),
                    Run::Call(f) => f(window, cx),
                });
            }
        }
    }

    fn radial_up(&mut self, t: Trigger, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.radial.as_mut().filter(|r| r.held_by(&t)) else { return };
        let o = r.release(at);
        self.radial_outcome(o, window, cx);
    }

    pub(super) fn radial_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if key == "escape" {
            self.close_radial(window, cx);
        }
    }

    pub(super) fn radial_key_up(&mut self, e: &KeyUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = e.keystroke.key.to_lowercase();
        self.radial_up(Trigger::Key(key), window.mouse_position(), window, cx);
    }

    pub(super) fn render_radial(&mut self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let r = self.radial.as_ref()?;
        let layer = div()
            .id("radial-input")
            .absolute()
            .inset_0()
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                if this.radial.as_mut().is_some_and(|r| r.moved(e.position)) {
                    cx.notify();
                }
            }))
            .on_any_mouse_down(cx.listener(|this, e: &MouseDownEvent, window, cx| {
                let Some(r) = this.radial.as_mut().filter(|r| r.gesture.is_none()) else { return };
                if r.hit(e.position).is_some() {
                    cx.stop_propagation();
                }
                let o = r.click(e.position);
                this.radial_outcome(o, window, cx);
            }));
        let layer = [MouseButton::Left, MouseButton::Right, MouseButton::Middle].into_iter().fold(layer, |d, b| {
            d.on_mouse_up(b, cx.listener(move |this, e: &MouseUpEvent, window, cx| {
                this.radial_up(Trigger::Button(b), e.position, window, cx)
            }))
        });
        Some(div().child(layer).child(deferred(ring(t, r)).with_priority(2)).into_any_element())
    }
}

fn ring(t: &Theme, r: &Ring) -> impl IntoElement {
    let key = format!("radial:{}:{}:{}", f32::from(r.at.x) as i32, f32::from(r.at.y) as i32, r.depth);
    let hub = div()
        .absolute()
        .left(r.at.x - px(DEADZONE))
        .top(r.at.y - px(DEADZONE))
        .size(px(DEADZONE * 2.))
        .rounded_full()
        .border_1()
        .border_color(t.line_strong)
        .bg(t.float_bg_solid.alpha(0.7));
    let n = r.items.len();
    let hub = hub.with_animation(SharedString::from(format!("{key}:hub")), eased(T_FAST), |d, p| d.opacity(p));
    let mut root = div().absolute().inset_0().child(hub);
    for (i, it) in r.items.iter().enumerate() {
        let (sx, sy) = slot(i, n, RADIUS);
        let (cx0, cy0) = (f32::from(r.at.x), f32::from(r.at.y));
        let pill = pill(t, (SharedString::from(format!("{key}:hot")), i), it, r.hot == Some(i));
        let cell = div()
            .absolute()
            .w(px(CELL.width))
            .h(px(CELL.height))
            .flex()
            .items_center()
            .justify_center()
            .child(pill);
        // The pills come out from the hub, FundaCAD 1 drew them in place: a reduced motion setting snaps them there.
        root = root.child(cell.with_animation(
            SharedString::from(format!("{key}:{i}")),
            eased(T_MED),
            move |d, p| {
                let k = 0.6 + 0.4 * p;
                d.left(px(cx0 + sx * k - CELL.width / 2.)).top(px(cy0 + sy * k - CELL.height / 2.)).opacity(p)
            },
        ));
    }
    root
}

fn pill(t: &Theme, id: impl Into<ElementId>, it: &RadialItem, hot: bool) -> impl IntoElement {
    let el = text(t, FS_SMALL)
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .px(px(10.))
        .py(px(5.))
        .whitespace_nowrap()
        .rounded_full()
        .border_1()
        .shadow(t.float_shadow.clone())
        .when(it.item.disabled, |d| d.opacity(0.45))
        .when_some(it.icon, |d, name| d.child(icon(name, 16., t.text)))
        .child(it.item.label.clone())
        .when(!it.children.is_empty(), |d| d.child(icon("caretRight", 10., t.text)));
    let (solid, line, accent) = (t.float_bg_solid, t.line_strong, t.accent);
    let lit = accent.mix(0.22, solid);
    motion::toggle(id, hot, el, move |d, m| d.bg(mix(solid, lit, m.on)).border_color(mix(line, accent, m.on)))
}
