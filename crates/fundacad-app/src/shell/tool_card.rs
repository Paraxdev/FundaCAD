//! The card of a running tool, FundaCAD 1's tool panel in the inspector's style: the feature's rows, the target being
//! picked, OK and Cancel. Also the tool commands, the selection filter keys, and repicking a feature's targets.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::commands::{register, Group};
use crate::i18n::{self, tr, Label};
use crate::inspector as model;
use crate::overlay::{self, Toast};
use crate::selection::{Filter, Pick, PickKind};
use crate::motion::{glass_in, hover_bg, prompt_in};
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_SMALL, S_1, S_2, S_3, W_SEMIBOLD};
use crate::tools::{self, Target};
use crate::ui::{chip, text};
use crate::viewport::Viewport;

pub(super) fn install(viewport: &Entity<Viewport>, cx: &mut App) {
    for tool in tools::TOOLS.iter().filter(|t| !tools::HELD.contains(&t.id)) {
        let v = viewport.clone();
        register(cx, tool.id, Label::Key(tool.label), Group::Tools, move |_, cx| start(&v, tool, cx));
    }
    let filters =
        [("selmode-faces", Filter::Faces), ("selmode-bodies", Filter::Bodies), ("selmode-auto", Filter::Auto)];
    for (id, filter) in filters {
        let v = viewport.clone();
        register(cx, id, filter.label(), Group::Edit, move |_, cx| v.update(cx, |v, cx| v.set_filter(filter, cx)));
    }
    let v = viewport.clone();
    cx.intercept_keystrokes(move |e, window, cx| {
        let k = &e.keystroke;
        let m = k.modifiers;
        // Shift = types + on most layouts.
        let key = if m.shift && (k.key == "=" || k.key_char.as_deref() == Some("+")) { "+" } else { k.key.as_str() };
        let held = m.control || m.alt || m.platform || m.function || (m.shift && key != "+");
        if held || window.context_stack().iter().any(|c| c.contains("Input")) {
            return;
        }
        if v.update(cx, |v, cx| tool_key(v, key, cx)) {
            cx.stop_propagation();
        }
    })
    .detach();
    let v = viewport.clone();
    register(cx, "escape", Label::Key("common.cancel"), Group::Edit, move |_, cx| {
        v.update(cx, |v, cx| match v.running().is_some() {
            true => v.finish(false, cx),
            false if v.inspecting().card.is_some() => v.open_card(None, cx),
            false => v.clear_selection(cx),
        })
    });
}

/// A key the running tool answers, kept from the key table: [ ] - + and up and down for a pattern's count, X for a draft's pull axis.
fn tool_key(v: &mut Viewport, key: &str, cx: &mut Context<Viewport>) -> bool {
    let Some(id) = v.running().map(|r| r.feature.clone()) else { return false };
    let Some(f) = v.doc().and_then(|d| tools::feature(d, &id)).cloned() else { return false };
    let Some(new) = tools::press(&f, key, &v.shown_bodies()) else { return false };
    if let Err(why) = v.edit(move |d| tools::replace(d, &id, new.clone()), cx) {
        cx.defer(move |cx| toast(cx, why));
    }
    true
}

fn toast(cx: &mut App, words: String) {
    overlay::toast(cx, Toast::info(words));
}

fn start(viewport: &Entity<Viewport>, tool: &'static tools::Tool, cx: &mut App) {
    if viewport.read(cx).sketching() {
        match tool.id {
            "extrude" => return viewport.update(cx, |v, cx| v.sketch_extrude(false, cx)),
            "presspull" => viewport.update(cx, |v, cx| v.finish_sketch(cx)),
            _ => return toast(cx, "Finish the sketch first".into()),
        }
    }
    let v = viewport.read(cx);
    let Some(doc) = v.doc() else { return toast(cx, i18n::t("tool.openDocumentFirst")) };
    let boolean = tool.id.starts_with("boolean-");
    if boolean && v.body_count() < 2 {
        return toast(cx, tr!("tool.boolean.needTwo", tool = i18n::t(tool.label)));
    }
    let (id, start) = match tools::started(tool, doc, v.selection()) {
        Ok(s) => s,
        Err(why) => return toast(cx, why),
    };
    let tools::Fitted { start, before } = tools::fit(tool.id, start, doc, v.selection(), &v.shown_bodies());
    let mut shown = doc.clone();
    let _ = tools::insert(&mut shown, start.feature.clone());
    let label = tr!("step.label.add", step = crate::timeline::labels::name_of(&shown, &id));
    let feature = start.feature.clone();
    let offered = tools::offer(tool.id, v.selection());
    let begun = viewport.update(cx, |v, cx| {
        let need = start.need.clone();
        v.begin_tool(i18n::t(tool.label), label, id.clone(), need, move |d| {
            before.iter().try_for_each(|b| tools::insert(d, b.clone()))?;
            tools::insert(d, feature.clone())
        }, cx)?;
        v.clear_selection(cx);
        match start.arm() {
            // A boolean with its bodies picked is done at once, as in FundaCAD 1.
            None if boolean => v.finish(true, cx),
            None => match offered {
                Some(t) => v.offer_arm(t, cx),
                None => v.set_arm(None, cx),
            },
            arm => v.set_arm(arm, cx),
        }
        Ok::<(), String>(())
    });
    if let Err(why) = begun {
        toast(cx, why);
    }
}

/// The pick a target row takes.
fn target_of(field: &'static str, kind: model::TargetKind) -> Target {
    let kind = match kind {
        model::TargetKind::Edge => PickKind::Edge,
        model::TargetKind::Face => PickKind::Face,
        model::TargetKind::Body => PickKind::Body,
        model::TargetKind::Area => PickKind::Area,
    };
    let single = matches!(
        field,
        "face" | "profile" | "upTo" | "target" | "ground" | "startFace" | "upToFace" | "upToFace2" | "axisEdge"
    );
    Target { field, kind, many: !single }
}

pub(super) fn prompt(arm: &Target) -> String {
    tr!("tool.target.click", many = if arm.many { "yes" } else { "no" }, kind = tools::run::noun(arm.kind, false))
}

impl Shell {
    pub(super) fn tool_feature(&self, cx: &App) -> Option<String> {
        self.viewport.read(cx).running().map(|s| s.feature.clone())
    }

    /// A click on a Target row: arms it in the running tool, or starts picking it again for the feature.
    pub(super) fn target_click(&mut self, id: &str, label: &str, cx: &mut Context<Self>) {
        let Some(doc) = self.source.as_ref() else { return };
        let Some((field, kind)) = model::target_field(doc, id, label) else { return };
        let target = target_of(field, kind);
        let name = crate::timeline::labels::name_of(doc, id);
        let id = id.to_string();
        self.viewport.update(cx, |v, cx| {
            if v.running().is_some_and(|s| s.feature != id) {
                return v.say(i18n::t("geometry.browser.finishTool"), cx);
            }
            let armed = v.running().and_then(|s| s.arm).is_some_and(|a| a.field == field);
            if v.running().is_none() {
                let title = tr!("sketch.name.of", label = i18n::t(label), subject = name);
                let words = title.clone();
                if let Err(why) = v.begin_tool(title, words, id.clone(), Vec::new(), |_| Ok(()), cx) {
                    return v.say(why, cx);
                }
            }
            v.set_arm((!armed).then_some(target), cx);
        });
    }

    /// The items browser's bodies, sketches and planes as the view's selection.
    pub(super) fn picks_from_items(&mut self, cx: &mut Context<Self>) {
        let Some(doc) = self.source.as_ref() else { return };
        let ty = |id: &str| {
            doc.get("features")
                .and_then(|f| f.as_array())
                .and_then(|fs| fs.iter().find(|f| f.get("id").and_then(|v| v.as_str()) == Some(id)))
                .and_then(|f| f.get("type").and_then(|t| t.as_str()).map(str::to_string))
        };
        let picks: Vec<Pick> = self
            .items
            .selection
            .keys
            .iter()
            .filter_map(|k| {
                let (prefix, id) = k.split_once(':')?;
                match (prefix, ty(id).as_deref()) {
                    ("b", _) => Some(Pick::Body { body: id.into() }),
                    ("o", _) => Some(Pick::Plane { id: id.into() }),
                    (_, Some("datumPlane")) => Some(Pick::Plane { id: id.into() }),
                    (_, Some("sketch")) => Some(Pick::Sketch { feature: id.into() }),
                    _ => None,
                }
            })
            .collect();
        self.viewport.update(cx, |v, cx| {
            if v.running().is_none() {
                v.set_selection(picks, cx);
            }
        });
    }

    /// A Target row, which a click arms for picking, lit while armed.
    pub(super) fn target_row(
        &self,
        t: &Theme,
        id: &str,
        label: &'static str,
        line: Div,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let v = self.viewport.read(cx);
        let armed = v.running().filter(|s| s.feature == id).and_then(|s| s.arm).map(|a| a.field);
        let on = armed.is_some_and(|field| {
            self.source.as_ref().is_some_and(|d| model::target_field(d, id, label).is_some_and(|(f, _)| f == field))
        });
        let id = id.to_string();
        div()
            .id(ElementId::Name(format!("target:{id}:{label}").into()))
            .mx(px(-S_2))
            .px(px(S_2))
            .py(px(S_1))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .border_1()
            .border_color(if on { t.accent } else { t.line })
            .when(on, |d| d.bg(t.accent_wash))
            .cursor_pointer()
            .child(line)
            .on_click(cx.listener(move |this, _, _, cx| this.target_click(&id, label, cx)))
            .into_any_element()
    }

    pub(super) fn tool_card(&self, t: &Theme, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let v = self.viewport.read(cx);
        let s = v.running()?;
        let (title, feature, arm) = (s.title.clone(), s.feature.clone(), s.arm);
        let missing = v.doc().and_then(|d| s.missing(d));
        let rows = self.source.as_ref().map(|d| model::rows(d, &feature, v.feature_issues())).unwrap_or_default();
        let rows: Vec<AnyElement> = rows.iter().map(|r| self.row(t, &feature, r, window, cx)).collect();
        let button = |label: &'static str, primary: bool| {
            let (rest, lit) = match primary {
                true => (t.accent, t.accent_hot),
                false => (t.field_bg, crate::motion::layer(t.hover_wash, t.field_bg)),
            };
            let el = text(t, FS_SMALL)
                .id(ElementId::Name(format!("tool:{label}").into()))
                .h(px(28.))
                .px(px(S_3))
                .flex()
                .items_center()
                .rounded(px(FLOAT_CHIP_RADIUS))
                .font_weight(W_SEMIBOLD)
                .cursor_pointer()
                .map(|d| match primary {
                    true => d.text_color(t.on_accent),
                    false => d.border_1().border_color(t.control_edge).text_color(t.text),
                })
                .child(i18n::t(label));
            hover_bg(ElementId::Name(format!("tool-bg:{label}").into()), el, rest, lit)
        };
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).child(title.clone()))
            .child(text(t, FS_SMALL).text_color(t.text_mute).child(i18n::t("mirror.escCancel")));
        let picking = arm.as_ref().map(|a| {
            let line = prompt(a);
            let key = SharedString::from(format!("tool-prompt:{line}"));
            let el = div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(S_2))
                .child(text(t, FS_SMALL).flex_1().min_w_0().text_color(t.accent).child(line))
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .gap(px(S_1))
                        .child(button("tool.target.clear", false).on_click(cx.listener(|this, _, _, cx| {
                            this.viewport.update(cx, |v, cx| v.clear_target(cx));
                        })))
                        .when(a.many, |d| {
                            d.child(button("common.done", false).on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.update(cx, |v, cx| v.set_arm(None, cx));
                            })))
                        }),
                );
            prompt_in(key, el)
        });
        let foot = div()
            .flex()
            .justify_end()
            .gap(px(S_2))
            .child(button("common.cancel", false).on_click(cx.listener(|this, _, _, cx| {
                this.viewport.update(cx, |v, cx| v.finish(false, cx));
            })))
            .child(button("common.ok", true).when(missing.is_some(), |d| d.opacity(0.5)).on_click(cx.listener(
                |this, _, _, cx| {
                    this.viewport.update(cx, |v, cx| v.finish(true, cx));
                },
            )));
        // FundaCAD 1's .tgt-panel: parked under Items, not beside the view controls, its height capped so the
        // rows scroll and Items gives way rather than the card.
        let cap = (window.viewport_size().height * 0.46).min(px(360.));
        // The padding keeps the target rows' outset borders inside the scroll clip, the margin cancels it.
        let rows = (!rows.is_empty()).then(|| {
            div()
                .id("tool-rows")
                .flex()
                .flex_col()
                .gap(px(S_2))
                .min_h_0()
                .overflow_y_scroll()
                .mx(px(-S_2))
                .px(px(S_2))
                .children(rows)
        });
        let card = chip(t)
                .id("tool-card")
                .w(px(super::items::WIDTH))
                .flex_none()
                .max_h(cap)
                .p(px(S_3))
                .flex()
                .flex_col()
                .gap(px(S_2))
                .occlude()
                .child(head)
                .children(picking)
                .children(rows)
                .child(foot);
        Some(glass_in(SharedString::from(format!("tool-card-in:{title}")), card).into_any_element())
    }
}
