//! FundaCAD 1's CSS motion: the keyframed entrances of _titlebar.scss, _glass.scss and _utilities.scss, and the
//! `transition` every hover, press and on state eased by. GPUI has no transform on a div, so the scale part of a
//! keyframe is left out and a slide is a relative offset, which moves the paint and leaves the layout alone.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::*;

use crate::theme::{ease, eased, Rgb, T_FAST, T_MED};

/// `pop-in`: menus, context menus and toasts, a 4px drop and a fade over --t-fast.
pub fn pop_in<E: Styled + IntoElement + 'static>(id: impl Into<ElementId>, el: E) -> AnimationElement<E> {
    el.with_animation(id, eased(T_FAST), |el, p| el.opacity(p).top(px(-4. * (1. - p))))
}

/// `glass-in`: glass popovers and cards, a 4px slide from the left and a fade over --t-med.
pub fn glass_in<E: Styled + IntoElement + 'static>(id: impl Into<ElementId>, el: E) -> AnimationElement<E> {
    glass_in_after(id, Duration::ZERO, el)
}

/// `glass-in` held back by `delay`, `animation-fill-mode: both`, for the staggered tiles of a flyout.
pub fn glass_in_after<E: Styled + IntoElement + 'static>(
    id: impl Into<ElementId>,
    delay: Duration,
    el: E,
) -> AnimationElement<E> {
    let total = delay + T_MED;
    let lead = delay.as_secs_f32() / total.as_secs_f32();
    let anim = Animation::new(total).with_easing(move |t| ease(((t - lead) / (1. - lead)).max(0.)));
    el.with_animation(id, anim, |el, p| el.opacity(p).left(px(-4. * (1. - p))))
}

/// `prompt-in`: the tool prompt, a 6px drop and a fade over --t-med.
pub fn prompt_in<E: Styled + IntoElement + 'static>(id: impl Into<ElementId>, el: E) -> AnimationElement<E> {
    el.with_animation(id, eased(T_MED), |el, p| el.opacity(p).top(px(-6. * (1. - p))))
}

/// `color-mix` of `from` toward `to` by `p`, premultiplied as a CSS transition blends.
pub fn mix(from: impl Into<Rgb>, to: impl Into<Rgb>, p: f32) -> Hsla {
    let (from, to) = (from.into(), to.into());
    if p <= 0. {
        from.into()
    } else if p >= 1. {
        to.into()
    } else {
        to.mix(p, from).into()
    }
}

/// Where each eased state of a [`Transition`] is, 0 at rest and 1 fully on.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Motion {
    pub hover: f32,
    pub press: f32,
    pub on: f32,
}

#[derive(Clone, Copy)]
struct Channel {
    target: bool,
    from: f32,
    since: Option<Instant>,
}

impl Channel {
    fn rest(target: bool) -> Self {
        Self { target, from: if target { 1. } else { 0. }, since: None }
    }

    fn value(&self, now: Instant, d: Duration) -> (f32, bool) {
        let to = if self.target { 1. } else { 0. };
        let Some(since) = self.since else { return (to, true) };
        let t = now.saturating_duration_since(since).as_secs_f32() / d.as_secs_f32().max(1e-6);
        if t >= 1. {
            return (to, true);
        }
        (self.from + (to - self.from) * ease(t), false)
    }

    /// Turns toward `target` from wherever it is now, as a CSS transition reverses midway.
    fn aim(&mut self, target: bool, now: Instant, d: Duration, snap: bool) -> bool {
        if target == self.target {
            return false;
        }
        let (at, _) = self.value(now, d);
        *self = if snap { Self::rest(target) } else { Self { target, from: at, since: Some(now) } };
        true
    }
}

struct State {
    hover: Channel,
    press: Channel,
    on: Channel,
    /// Set by the mouse listeners between frames, read into `press` at the next layout.
    held: Rc<Cell<bool>>,
}

impl State {
    fn new(on: bool) -> Self {
        Self { hover: Channel::rest(false), press: Channel::rest(false), on: Channel::rest(on), held: Rc::default() }
    }
}

/// A CSS `transition` for an element GPUI would restyle at once: `animator` gets the eased hover, press and on
/// states each frame. Hover and press are read off a hitbox over the element, the on state is given.
pub struct Transition<E> {
    id: ElementId,
    element: Option<E>,
    animator: Box<dyn Fn(E, Motion) -> E>,
    on: bool,
    track_hover: bool,
    track_press: bool,
    duration: Duration,
}

impl<E> Transition<E> {
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    pub fn press(mut self) -> Self {
        self.track_press = true;
        self
    }

    #[allow(dead_code)]
    pub fn duration(mut self, d: Duration) -> Self {
        self.duration = d;
        self
    }
}

/// Eases `el` over --t-fast as the pointer comes onto it and leaves.
pub fn hover<E: IntoElement + 'static>(
    id: impl Into<ElementId>,
    el: E,
    animator: impl Fn(E, Motion) -> E + 'static,
) -> Transition<E> {
    Transition {
        id: id.into(),
        element: Some(el),
        animator: Box::new(animator),
        on: false,
        track_hover: true,
        track_press: false,
        duration: T_FAST,
    }
}

/// Eases `el` over --t-fast as `on` changes, a switch knob or a selected segment.
pub fn toggle<E: IntoElement + 'static>(
    id: impl Into<ElementId>,
    on: bool,
    el: E,
    animator: impl Fn(E, Motion) -> E + 'static,
) -> Transition<E> {
    Transition { on, track_hover: false, ..hover(id, el, animator) }
}

impl<E: IntoElement + 'static> Element for Transition<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let (d, on, snap) = (self.duration, self.on, cx.reduce_motion());
        let now = cx.background_executor().now();
        let motion = window.with_element_state(global_id.unwrap(), |state: Option<State>, window| {
            let mut s = state.unwrap_or_else(|| State::new(on));
            s.on.aim(on, now, d, snap);
            s.press.aim(s.held.get(), now, d, snap);
            let (hover, a) = s.hover.value(now, d);
            let (press, b) = s.press.value(now, d);
            let (on, c) = s.on.value(now, d);
            if !(a && b && c) {
                window.request_animation_frame();
            }
            (Motion { hover, press, on }, s)
        });
        let el = self.element.take().expect("laid out once");
        let mut el = (self.animator)(el, motion).into_any_element();
        (el.request_layout(window, cx), el)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        el: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Hitbox> {
        el.prepaint(window, cx);
        // After the element, so its own occluding hitbox does not hide this one.
        (self.track_hover || self.track_press).then(|| window.insert_hitbox(bounds, HitboxBehavior::Normal))
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        el: &mut AnyElement,
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        el.paint(window, cx);
        let Some(hitbox) = hitbox.clone() else { return };
        let (d, snap, track_hover) = (self.duration, cx.reduce_motion(), self.track_hover);
        let now = cx.background_executor().now();
        let hovered = track_hover && hitbox.is_hovered(window);
        let held = window.with_element_state(global_id.unwrap(), |state: Option<State>, window| {
            let mut s = state.unwrap_or_else(|| State::new(self.on));
            if s.hover.aim(hovered, now, d, snap) {
                window.request_animation_frame();
            }
            (s.held.clone(), s)
        });
        if track_hover {
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) != hovered {
                    window.refresh();
                }
            });
        }
        if self.track_press {
            let down = held.clone();
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && e.button == MouseButton::Left && hitbox.is_hovered(window) {
                    down.set(true);
                    window.refresh();
                }
            });
            window.on_mouse_event(move |_: &MouseUpEvent, phase, window, _| {
                if phase == DispatchPhase::Capture && held.replace(false) {
                    window.refresh();
                }
            });
        }
    }
}

impl<E: Styled> Styled for Transition<E> {
    fn style(&mut self) -> &mut StyleRefinement {
        self.element.as_mut().expect("styled before layout").style()
    }
}

impl<E: InteractiveElement> InteractiveElement for Transition<E> {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.element.as_mut().expect("built before layout").interactivity()
    }
}

impl<E: StatefulInteractiveElement> StatefulInteractiveElement for Transition<E> {}

impl<E: ParentElement> ParentElement for Transition<E> {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        if let Some(el) = &mut self.element {
            el.extend(elements);
        }
    }
}

/// `transition: background var(--t-fast)`, `from` at rest and `to` under the pointer.
pub fn hover_bg<E: Styled + IntoElement + 'static>(
    id: impl Into<ElementId>,
    el: E,
    from: impl Into<Rgb>,
    to: impl Into<Rgb>,
) -> Transition<E> {
    let (from, to) = (from.into(), to.into());
    hover(id, el, move |d, m| d.bg(mix(from, to, m.hover)))
}

/// A list row: `hover` under the pointer and `picked` while selected, both eased over --t-fast.
pub fn row_bg<E: Styled + IntoElement + 'static>(
    id: impl Into<ElementId>,
    el: E,
    selected: bool,
    hover_wash: impl Into<Rgb>,
    picked: impl Into<Rgb>,
) -> Transition<E> {
    let (wash, picked) = (hover_wash.into(), picked.into());
    hover(id, el, move |d, m| d.bg(mix(mix(Rgb::TRANSPARENT, wash, m.hover * (1. - m.on)), picked, m.on))).on(selected)
}

/// The solid background `d` was given before the animator runs, transparent without one.
pub fn base_bg(d: &mut impl Styled) -> Rgb {
    d.style().background.as_ref().and_then(|f| f.color()).and_then(|b| b.as_solid()).map_or(Rgb::TRANSPARENT, Rgb::from)
}
