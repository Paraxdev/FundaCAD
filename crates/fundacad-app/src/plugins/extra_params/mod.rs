//! FundaCAD.ExtraParameters: sliders, toggles and choices for parameters, groups, named configurations and checks.
//! The data is the document's, so turning this off hides the panel and changes nothing about how a design builds.

mod model;

use std::cell::Cell;
use std::rc::Rc;

use fundacad_client::Doc;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputState};

use super::manager::switch;
use super::Native;
use crate::commands::Group as CmdGroup;
use crate::theme::{ActiveTheme as _, Theme, FS_BODY, FS_MICRO, FS_SMALL, R_MD, S_1, S_2, S_3, S_4, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};
use crate::viewport::Viewport;
use model::{Control, Row};

pub const ID: &str = "FundaCAD.ExtraParameters";

pub const NATIVE: Native = Native {
    manifest: include_str!("../../../../../plugins/FundaCAD.ExtraParameters/manifest.json"),
    install,
};

pub struct Tune {
    viewport: Entity<Viewport>,
    open: bool,
    setup: bool,
    /// A slider held down: its parameter and the value it shows until it is let go, one drag is one undo step.
    drag: Option<(String, f64)>,
    tracks: Rc<Cell<Vec<(String, Bounds<Pixels>)>>>,
    check_expr: Entity<InputState>,
    check_message: Entity<InputState>,
    refused: Option<String>,
    _observe: Subscription,
}

fn install(viewport: &Entity<Viewport>, window: &mut Window, cx: &mut App) -> AnyView {
    let vp = viewport.clone();
    let view = cx.new(|cx| {
        let observe = cx.observe(&vp, |_, _, cx| cx.notify());
        Tune {
            viewport: vp,
            open: std::env::var("FUNDA_PANEL").is_ok_and(|p| p == "tune"),
            setup: false,
            drag: None,
            tracks: Rc::default(),
            check_expr: cx.new(|cx| InputState::new(window, cx).placeholder("rule, as wall > 1")),
            check_message: cx.new(|cx| InputState::new(window, cx).placeholder("message when it fails")),
            refused: None,
            _observe: observe,
        }
    });
    let (a, b) = (view.clone(), view.clone());
    super::command(cx, ID, "tune-parameters", "Tune Parameters", CmdGroup::Tools, move |_, cx| {
        a.update(cx, |t, cx| {
            t.open = !t.open;
            cx.notify();
        })
    });
    super::command(cx, ID, "parameter-setup", "Parameter Setup\u{2026}", CmdGroup::Edit, move |_, cx| {
        b.update(cx, |t, cx| {
            (t.open, t.setup) = (true, true);
            cx.notify();
        })
    });
    view.into()
}

impl Tune {
    fn edit(
        &mut self,
        label: String,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) {
        let done = self.viewport.update(cx, |v, cx| v.edit_step(None, Some(label), f, cx));
        self.refused = done.err();
        cx.notify();
    }

    fn set_value(&mut self, name: String, value: f64, cx: &mut Context<Self>) {
        let n = name.clone();
        self.edit(format!("Set {name}"), move |d| model::set_value(d, &n, value), cx);
    }

    fn slider_value(&self, name: &str, x: Pixels, min: f64, max: f64) -> Option<f64> {
        let tracks = self.tracks.take();
        let b = tracks.iter().find(|(n, _)| n == name).map(|(_, b)| *b);
        self.tracks.set(tracks);
        let b = b?;
        let frac = ((x - b.origin.x) / b.size.width).clamp(0., 1.) as f64;
        Some(min + frac * (max - min))
    }

    fn control(&self, t: &Theme, r: &Row, cx: &mut Context<Self>) -> AnyElement {
        let name = r.name.clone();
        if !r.editable {
            return text(t, FS_SMALL).text_color(t.text_dim).child("expression").into_any_element();
        }
        match &r.control {
            Control::Toggle => {
                let on = r.value != 0.0;
                switch(t, SharedString::from(format!("tune-{name}")), on)
                    .on_click(cx.listener(move |this, _, _, cx| this.set_value(name.clone(), if on { 0. } else { 1. }, cx)))
                    .into_any_element()
            }
            Control::Choice(cs) => div()
                .flex()
                .flex_wrap()
                .gap(px(S_1))
                .children(cs.iter().enumerate().map(|(i, c)| {
                    let (n, v) = (name.clone(), c.value);
                    pill(t, SharedString::from(format!("tune-{name}-{i}")), &c.label, (c.value - r.value).abs() < 1e-9)
                        .on_click(cx.listener(move |this, _, _, cx| this.set_value(n.clone(), v, cx)))
                }))
                .into_any_element(),
            Control::Slider { min, max, .. } => {
                let (min, max) = (*min, *max);
                let shown = self.drag.as_ref().filter(|(n, _)| *n == name).map_or(r.value, |(_, v)| *v);
                let shown = model::clamp_to_control(Some(&r.control), shown);
                let frac = if max > min { ((shown - min) / (max - min)).clamp(0., 1.) as f32 } else { 0. };
                let tracks = self.tracks.clone();
                let key = name.clone();
                let (down, moved, up) = (name.clone(), name.clone(), name.clone());
                div()
                    .flex()
                    .items_center()
                    .gap(px(S_2))
                    .child(
                        div()
                            .id(SharedString::from(format!("tune-{name}")))
                            .relative()
                            .w(px(140.))
                            .h(px(16.))
                            .flex()
                            .items_center()
                            .child(canvas(
                                move |b, _, _| {
                                    let mut all = tracks.take();
                                    all.retain(|(n, _)| *n != key);
                                    all.push((key.clone(), b));
                                    tracks.set(all);
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .size_full())
                            .child(div().w_full().h(px(4.)).rounded(px(2.)).bg(t.raised_2))
                            .child(div().absolute().left_0().w(relative(frac)).h(px(4.)).rounded(px(2.)).bg(t.accent))
                            .child(
                                div()
                                    .absolute()
                                    .left(relative(frac))
                                    .ml(px(-6.))
                                    .size(px(12.))
                                    .rounded(px(6.))
                                    .bg(t.text),
                            )
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                                    if let Some(v) = this.slider_value(&down, e.position.x, min, max) {
                                        this.drag = Some((down.clone(), v));
                                        cx.notify();
                                    }
                                }),
                            )
                            .on_mouse_move(cx.listener(move |this, e: &MouseMoveEvent, _, cx| {
                                if e.pressed_button == Some(MouseButton::Left)
                                    && this.drag.as_ref().is_some_and(|(n, _)| *n == moved)
                                {
                                    if let Some(v) = this.slider_value(&moved, e.position.x, min, max) {
                                        this.drag = Some((moved.clone(), v));
                                        cx.notify();
                                    }
                                }
                            }))
                            .on_mouse_up(
                                MouseButton::Left,
                                cx.listener(move |this, _: &MouseUpEvent, _, cx| {
                                    if let Some((n, v)) = this.drag.take().filter(|(n, _)| *n == up) {
                                        this.set_value(n, v, cx);
                                    }
                                }),
                            ),
                    )
                    .child(text(t, FS_SMALL).w(px(56.)).child(format!("{} {}", fmt(shown), r.unit)))
                    .into_any_element()
            }
            Control::Number { step, .. } => {
                let step = step.unwrap_or(1.0);
                let (lo, hi) = (name.clone(), name.clone());
                let v = r.value;
                div()
                    .flex()
                    .items_center()
                    .gap(px(S_1))
                    .child(
                        pill(t, SharedString::from(format!("tune-{name}-dn")), "\u{2212}", false)
                            .on_click(cx.listener(move |this, _, _, cx| this.set_value(lo.clone(), v - step, cx))),
                    )
                    .child(text(t, FS_SMALL).min_w(px(56.)).flex().justify_center().child(format!("{} {}", fmt(v), r.unit)))
                    .child(
                        pill(t, SharedString::from(format!("tune-{name}-up")), "+", false)
                            .on_click(cx.listener(move |this, _, _, cx| this.set_value(hi.clone(), v + step, cx))),
                    )
                    .into_any_element()
            }
        }
    }

    fn setup_row(&self, t: &Theme, r: &Row, doc: &Doc, cx: &mut Context<Self>) -> Div {
        let groups = model::groups(doc);
        let current = doc
            .get("paramDefs")
            .and_then(|d| d.get(&r.name))
            .and_then(|d| d.get("group"))
            .and_then(|g| g.as_str())
            .map(str::to_owned);
        let group_label = current
            .as_ref()
            .and_then(|g| groups.iter().find(|(i, _)| i == g).map(|(_, n)| n.clone()))
            .unwrap_or_else(|| "No group".into());
        let next_group: Option<String> = match current.as_ref().and_then(|g| groups.iter().position(|(i, _)| i == g)) {
            None => groups.first().map(|(i, _)| i.clone()),
            Some(i) => groups.get(i + 1).map(|(i, _)| i.clone()),
        };
        let kinds = ["none"].into_iter().chain(model::KINDS);
        let on_kind = if r.control == (Control::Number { min: None, max: None, step: None })
            && doc.get("paramDefs").and_then(|d| d.get(&r.name)).and_then(|d| d.get("control")).is_none()
        {
            "none"
        } else {
            r.control.kind()
        };
        let mut chips = div().flex().flex_wrap().gap(px(S_1));
        for k in kinds {
            let (name, from, value) = (r.name.clone(), r.control.clone(), r.value);
            chips = chips.child(pill(t, SharedString::from(format!("kind-{}-{k}", r.name)), k, k == on_kind).on_click(
                cx.listener(move |this, _, _, cx| {
                    let (n, c) = (name.clone(), model::convert_control(Some(&from), k, value));
                    this.edit(format!("Control of {name}"), move |d| model::set_control(d, &n, c.as_ref()), cx);
                }),
            ));
        }
        let (gname, hname) = (r.name.clone(), r.name.clone());
        chips = chips
            .child(pill(t, SharedString::from(format!("group-{}", r.name)), &group_label, false).on_click(cx.listener(
                move |this, _, _, cx| {
                    let (n, g) = (gname.clone(), next_group.clone());
                    this.edit(format!("Group of {gname}"), move |d| model::set_group(d, &n, g.as_deref()), cx);
                },
            )))
            .child(pill(t, SharedString::from(format!("hide-{}", r.name)), "Hide", false).on_click(cx.listener(
                move |this, _, _, cx| {
                    let n = hname.clone();
                    this.edit(format!("Hide {hname}"), move |d| model::set_hidden(d, &n, true), cx);
                },
            )));
        div()
            .flex()
            .items_center()
            .gap(px(S_3))
            .py(px(S_1))
            .child(text(t, FS_SMALL).w(px(90.)).flex_none().truncate().child(r.name.clone()))
            .child(chips)
    }

    fn add_check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let expr = self.check_expr.read(cx).value().trim().to_string();
        let message = self.check_message.read(cx).value().trim().to_string();
        if expr.is_empty() {
            self.refused = Some("A check needs a rule.".into());
            cx.notify();
            return;
        }
        if let Some(doc) = self.viewport.read(cx).doc() {
            if let Err(e) = fundacad_core::params::edit::check_expr(doc, None, &expr) {
                self.refused = Some(format!("{expr}: {e}"));
                cx.notify();
                return;
            }
        }
        let message = if message.is_empty() { format!("{expr} does not hold") } else { message };
        let add = move |d: &mut Doc| {
            model::add_check(d, &expr, &message, false);
            Ok(())
        };
        self.edit("Add check".into(), add, cx);
        for i in [self.check_expr.clone(), self.check_message.clone()] {
            i.update(cx, |i, cx| i.set_value("", window, cx));
        }
    }
}

fn fmt(v: f64) -> String {
    let r = (v * 1000.).round() / 1000.;
    let s = format!("{r}");
    s.strip_suffix(".0").map(str::to_owned).unwrap_or(s)
}

pub fn pill(t: &Theme, id: impl Into<ElementId>, label: &str, on: bool) -> Stateful<Div> {
    let hover = t.raised_2;
    text(t, FS_MICRO)
        .id(id)
        .px(px(S_2))
        .h(px(20.))
        .flex()
        .items_center()
        .rounded(px(R_MD))
        .map(|d| if on { d.bg(t.accent).text_color(t.on_accent) } else { d.bg(t.raised).text_color(t.text) })
        .hover(move |s| s.bg(hover))
        .child(label.to_string())
}

fn section(t: &Theme, label: impl Into<SharedString>) -> Div {
    text(t, FS_MICRO).font_weight(W_SEMIBOLD).text_color(t.text_mute).mt(px(S_3)).mb(px(S_1)).child(label.into())
}

impl Render for Tune {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open || !super::enabled(cx, ID) {
            return div().into_any_element();
        }
        let t = cx.theme().clone();
        let t = &t;
        let doc = self.viewport.read(cx).doc().cloned().unwrap_or_default();
        let setup = self.setup;
        let head = div()
            .flex()
            .items_center()
            .gap(px(S_2))
            .child(
                text(t, FS_BODY)
                    .flex_1()
                    .font_weight(W_SEMIBOLD)
                    .text_color(t.accent_hot)
                    .child(if setup { "Parameter Setup" } else { "Parameters" }),
            )
            .child(pill(t, "tune-setup", "Setup", setup).on_click(cx.listener(|this, _, _, cx| {
                this.setup = !this.setup;
                cx.notify();
            })))
            .child(icon_button(t, "tune-close", "close", 28., 14., t.text_mute).on_click(cx.listener(
                |this, _, _, cx| {
                    this.open = false;
                    cx.notify();
                },
            )));
        let mut body = div().id("tune-body").flex().flex_col().min_h_0().overflow_y_scroll();

        let configs = model::configurations(&doc);
        let active = model::active_configuration(&doc);
        if !configs.is_empty() || setup {
            let mut row = div().flex().flex_wrap().gap(px(S_1));
            for (id, name) in &configs {
                let drift = active.as_deref() == Some(id) && !model::configuration_drift(&doc, id).is_empty();
                let label = if drift { format!("{name} (changed)") } else { name.clone() };
                let apply = id.clone();
                row = row.child(
                    pill(t, SharedString::from(format!("cfg-{id}")), &label, active.as_deref() == Some(id)).on_click(
                        cx.listener(move |this, _, _, cx| {
                            let id = apply.clone();
                            this.edit("Apply configuration".into(), move |d| model::apply_configuration(d, &id), cx);
                        }),
                    ),
                );
                if setup {
                    let gone = id.clone();
                    row = row.child(pill(t, SharedString::from(format!("cfg-x-{id}")), "\u{d7}", false).on_click(
                        cx.listener(move |this, _, _, cx| {
                            let id = gone.clone();
                            this.edit(
                                "Delete configuration".into(),
                                move |d| {
                                    model::remove_extra(d, "configurations", &id);
                                    Ok(())
                                },
                                cx,
                            );
                        }),
                    ));
                }
            }
            if setup {
                let n = configs.len() + 1;
                row = row.child(pill(t, "cfg-add", "+ Save current", false).on_click(cx.listener(move |this, _, _, cx| {
                    this.edit(
                        "Save configuration".into(),
                        move |d| {
                            model::add_configuration(d, &format!("Configuration {n}"));
                            Ok(())
                        },
                        cx,
                    );
                })));
            }
            body = body.child(section(t, "Configurations")).child(row);
        }

        let checks = model::check_results(&doc);
        let failing: Vec<_> = checks.iter().filter(|c| !c.ok).collect();
        if !failing.is_empty() || setup {
            body = body.child(section(t, "Checks"));
            for c in if setup { checks.iter().collect::<Vec<_>>() } else { failing } {
                let colour = if c.ok { t.text_dim } else if c.error_level { t.error } else { t.warn };
                let line = match &c.error {
                    Some(e) => format!("{} ({e})", c.message),
                    None => c.message.clone(),
                };
                let gone = c.id.clone();
                body = body.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(S_2))
                        .child(text(t, FS_SMALL).flex_1().text_color(colour).child(line))
                        .when(setup, |d| {
                            d.child(pill(t, SharedString::from(format!("check-x-{}", c.id)), "\u{d7}", false).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    let id = gone.clone();
                                    this.edit(
                                        "Delete check".into(),
                                        move |d| {
                                            model::remove_extra(d, "checks", &id);
                                            Ok(())
                                        },
                                        cx,
                                    );
                                }),
                            ))
                        }),
                );
            }
            if setup {
                body = body.child(
                    div()
                        .flex()
                        .gap(px(S_2))
                        .mt(px(S_1))
                        .child(Input::new(&self.check_expr).text_size(px(FS_SMALL)).flex_1())
                        .child(Input::new(&self.check_message).text_size(px(FS_SMALL)).flex_1())
                        .child(pill(t, "check-add", "+ Add", false).on_click(cx.listener(|this, _, w, cx| this.add_check(w, cx)))),
                );
            }
        }

        let groups = model::tune_groups(&doc);
        if groups.is_empty() {
            body = body.child(text(t, FS_SMALL).text_color(t.text_dim).mt(px(S_3)).child(
                "No user parameters yet. Add one in Tools, Parameters, then give it a slider, toggle or choice here.",
            ));
        }
        for g in &groups {
            body = body.child(section(t, if g.name.is_empty() { "Parameters".to_owned() } else { g.name.clone() }));
            for r in &g.rows {
                body = body.child(if setup {
                    self.setup_row(t, r, &doc, cx)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .py(px(S_1))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(S_3))
                                .child(text(t, FS_SMALL).w(px(100.)).flex_none().truncate().child(r.name.clone()))
                                .child(self.control(t, r, cx)),
                        )
                        .children(r.problem.clone().map(|p| text(t, FS_MICRO).text_color(t.warn).pl(px(100. + S_3)).child(p)))
                });
            }
        }
        if setup {
            let n = model::groups(&doc).len() + 1;
            body = body.child(div().mt(px(S_2)).child(pill(t, "group-add", "+ Group", false).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.edit(
                        "Add group".into(),
                        move |d| {
                            model::add_group(d, &format!("Group {n}"));
                            Ok(())
                        },
                        cx,
                    );
                },
            ))));
        }
        div()
            .absolute()
            .top(px(56.))
            .bottom(px(56.))
            .left(px(470.))
            .w(px(420.))
            .flex()
            .flex_col()
            .child(
                solid_card(t)
                    .max_h_full()
                    .min_h_0()
                    .p(px(S_4))
                    .gap(px(S_1))
                    .child(head)
                    .child(body)
                    .children(self.refused.clone().map(|r| text(t, FS_MICRO).text_color(t.error).child(r))),
            )
            .into_any_element()
    }
}
