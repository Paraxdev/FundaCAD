//! The Inspect family's cards, FundaCAD 1's overlays/*Panel.vue in the tool card's style: Measure, Section View,
//! Properties, Overhang, Interference, Printability and Bed Fit, plus the Isolate and Section chips.

mod cards;

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Shell;
use crate::commands::{register, Group};
use crate::inspect::filament::Prefs as Filament;
use crate::inspect::printcheck::Settings;
use crate::inspect::section::Section;
use crate::inspect::{bedfit, isolate, Row};
use crate::overlay::{self, Toast};
use crate::theme::{Rgb, Theme, FLOAT_CHIP_RADIUS, FS_BODY, FS_SMALL, S_1, S_2, S_3, W_SEMIBOLD};
use crate::ui::{chip, text};
use crate::viewport::inspecting::Card;
use crate::viewport::Viewport;

/// What the cards remember between openings, for the session.
pub(super) struct Prefs {
    pub filament: Filament,
    pub bed: &'static str,
    pub custom_bed: [f64; 3],
    pub check: Settings,
    pub clearance: Option<f64>,
}

impl Global for Prefs {}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            filament: Filament::default(),
            bed: bedfit::DEFAULT,
            custom_bed: [220.0, 220.0, 250.0],
            check: Settings::default(),
            clearance: None,
        }
    }
}

fn toast(cx: &mut App, words: &str) {
    overlay::toast(cx, Toast::info(words.to_string()));
}

pub(super) fn install(viewport: &Entity<Viewport>, cx: &mut App) {
    cx.set_global(Prefs::default());
    let cards = [
        ("measure", "Measure", Card::Measure),
        ("properties", "Properties", Card::Properties),
        ("draft-analysis", "Overhang", Card::Overhang),
        ("interference", "Interference", Card::Interference),
        ("printability", "Printability", Card::Printability),
        ("bed-fit", "Bed Fit Check", Card::BedFit),
    ];
    for (id, label, card) in cards {
        let v = viewport.clone();
        register(cx, id, label, Group::Tools, move |_, cx| open(&v, card, cx));
    }
    let v = viewport.clone();
    register(cx, "section", "Section View", Group::Tools, move |_, cx| {
        v.update(cx, |v, cx| {
            if v.doc().is_none() {
                return;
            }
            if v.inspecting().section.is_none() {
                let centre = v.extent().map_or(glam::Vec3::ZERO, |(c, _)| c);
                v.set_section(Some(Section::along(2, centre)), cx);
            }
            v.open_card(Some(Card::Section), cx);
        })
    });
    let v = viewport.clone();
    register(cx, "isolate", "Isolate", Group::Tools, move |_, cx| {
        let view = v.read(cx);
        if view.isolated().is_some() {
            return v.update(cx, |v, cx| v.set_isolate(None, cx));
        }
        let keep = isolate::unique(view.selection().picks.iter().filter_map(|p| p.body().map(str::to_string)));
        if keep.is_empty() {
            return toast(cx, "Select a body, then Isolate");
        }
        v.update(cx, |v, cx| v.set_isolate(Some(keep), cx));
    });
}

fn open(viewport: &Entity<Viewport>, card: Card, cx: &mut App) {
    if viewport.read(cx).doc().is_none() {
        return toast(cx, "Open a document first");
    }
    if card == Card::Interference && viewport.read(cx).body_count() < 2 {
        return toast(cx, "Interference needs two bodies");
    }
    viewport.update(cx, |v, cx| {
        let again = v.inspecting().card == Some(card);
        v.open_card(if again { None } else { Some(card) }, cx);
    });
    if card == Card::Interference && viewport.read(cx).inspecting().card == Some(card) {
        cards::check_interference(viewport, cx);
    }
}

pub(super) fn button(t: &Theme, id: impl Into<SharedString>, label: impl Into<SharedString>, primary: bool) -> Stateful<Div> {
    text(t, FS_SMALL)
        .id(ElementId::Name(id.into()))
        .h(px(26.))
        .px(px(S_3))
        .flex()
        .items_center()
        .rounded(px(FLOAT_CHIP_RADIUS))
        .font_weight(W_SEMIBOLD)
        .cursor_pointer()
        .map(|d| match primary {
            true => d.bg(t.accent).text_color(t.on_accent),
            false => d.bg(t.field_bg).border_1().border_color(t.control_edge).text_color(t.text),
        })
        .child(label.into())
}

/// One of a set of choices, lit when it is the one in use.
pub(super) fn choice(t: &Theme, id: impl Into<SharedString>, label: impl Into<SharedString>, on: bool) -> Stateful<Div> {
    text(t, FS_SMALL)
        .id(ElementId::Name(id.into()))
        .h(px(24.))
        .px(px(S_2))
        .flex()
        .items_center()
        .rounded(px(FLOAT_CHIP_RADIUS))
        .border_1()
        .cursor_pointer()
        .map(|d| match on {
            true => d.border_color(t.accent).bg(t.accent_wash).text_color(t.text),
            false => d.border_color(t.control_edge).bg(t.field_bg).text_color(t.text_dim),
        })
        .child(label.into())
}

pub(super) fn line(t: &Theme, name: impl Into<SharedString>, value: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .justify_between()
        .gap(px(S_2))
        .child(text(t, FS_SMALL).text_color(t.text_mute).child(name.into()))
        .child(text(t, FS_SMALL).min_w_0().text_right().child(value.into()))
}

pub(super) fn rows(t: &Theme, rows: &[Row]) -> Div {
    div().flex().flex_col().gap(px(S_1)).children(rows.iter().map(|(k, v)| match k.is_empty() {
        true => text(t, FS_SMALL).text_color(t.text_mute).child(v.clone()),
        false => line(t, k.clone(), v.clone()),
    }))
}

pub(super) fn swatch(rgb: u32) -> Div {
    div().flex_none().size(px(10.)).rounded(px(3.)).bg(Rgb::hex(rgb))
}

/// A number with a minus and a plus, `on` gets -1 or 1.
pub(super) fn stepper(
    t: &Theme,
    id: &str,
    name: impl Into<SharedString>,
    value: impl Into<SharedString>,
    on: impl Fn(f64, &mut App) + Clone + 'static,
) -> Div {
    let (down, up) = (on.clone(), on);
    let small = |label: &'static str, key: String| {
        text(t, FS_SMALL)
            .id(ElementId::Name(key.into()))
            .size(px(22.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .bg(t.field_bg)
            .border_1()
            .border_color(t.control_edge)
            .cursor_pointer()
            .child(label)
    };
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(S_2))
        .child(text(t, FS_SMALL).text_color(t.text_mute).child(name.into()))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(S_1))
                .child(small("-", format!("{id}:down")).on_click(move |_, _, cx| down(-1.0, cx)))
                .child(text(t, FS_SMALL).min_w(px(64.)).text_center().child(value.into()))
                .child(small("+", format!("{id}:up")).on_click(move |_, _, cx| up(1.0, cx))),
        )
}

pub(super) fn frame(t: &Theme, title: &str, id: &'static str, cx: &mut Context<Shell>) -> Stateful<Div> {
    let head = div()
        .flex()
        .items_center()
        .justify_between()
        .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).child(title.to_string()))
        .child(button(t, "inspect:close", "Close", false).on_click(cx.listener(|this, _, _, cx| {
            this.viewport.update(cx, |v, cx| v.open_card(None, cx));
        })));
    chip(t).id(id).w(px(300.)).p(px(S_3)).flex().flex_col().gap(px(S_2)).occlude().child(head)
}

#[derive(Debug, PartialEq)]
enum FootAct {
    SectionOff,
    Run(&'static str),
}

/// FundaCAD 1's rail toggles: Section View switches off when on, Isolate's own command turns it off, Measure opens its
/// card.
fn foot_act(label: &str, foot: super::rail::Foot) -> Option<FootAct> {
    match label {
        "Section View" if foot.section => Some(FootAct::SectionOff),
        "Section View" => Some(FootAct::Run("section")),
        "Isolate" => Some(FootAct::Run("isolate")),
        "Measure" => Some(FootAct::Run("measure")),
        _ => None,
    }
}

impl Shell {
    /// The open Inspect card, or the chips of a Section or Isolate left on.
    pub(super) fn rail_foot(&self, cx: &App) -> super::rail::Foot {
        let v = self.viewport.read(cx);
        super::rail::Foot { isolate: v.isolated().is_some(), section: v.inspecting().section.is_some() }
    }

    pub(super) fn rail_tool(&mut self, label: &str, window: &mut Window, cx: &mut Context<Self>) {
        match foot_act(label, self.rail_foot(cx)) {
            Some(FootAct::SectionOff) => self.viewport.update(cx, |v, cx| {
                v.set_section(None, cx);
                if v.inspecting().card == Some(Card::Section) {
                    v.open_card(None, cx);
                }
            }),
            Some(FootAct::Run(command)) => crate::commands::run(command, window, cx),
            None => {}
        }
    }

    pub(super) fn inspect_card(&self, t: &Theme, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let v = self.viewport.read(cx);
        let i = v.inspecting();
        match i.card {
            Some(card) => Some(self.card(t, card, cx)),
            None if i.section.is_some() || v.isolated().is_some() => Some(self.view_chips(t, cx)),
            None => None,
        }
    }

    fn view_chips(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let (section, isolate) = (v.inspecting().section.is_some(), v.isolated());
        let bar = |label: String| div().flex().items_center().justify_between().gap(px(S_2)).child(text(t, FS_SMALL).child(label));
        chip(t)
            .id("inspect-chips")
            .w(px(300.))
            .p(px(S_2))
            .flex()
            .flex_col()
            .gap(px(S_2))
            .occlude()
            .when(section, |d| {
                d.child(
                    bar("Section on".into()).child(
                        div()
                            .flex()
                            .gap(px(S_1))
                            .child(button(t, "section:edit", "Edit", false).on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.update(cx, |v, cx| v.open_card(Some(Card::Section), cx));
                            })))
                            .child(button(t, "section:flip", "Flip", false).on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.update(cx, |v, cx| {
                                    let s = v.inspecting().section.map(|s| Section { flip: !s.flip, ..s });
                                    v.set_section(s, cx);
                                });
                            })))
                            .child(button(t, "section:off", "Off", false).on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.update(cx, |v, cx| v.set_section(None, cx));
                            }))),
                    ),
                )
            })
            .when_some(isolate, |d, n| {
                let label = if n == 1 { "Isolated, 1 body".to_string() } else { format!("Isolated, {n} bodies") };
                d.child(bar(label).child(button(t, "isolate:off", "Off", false).on_click(cx.listener(|this, _, _, cx| {
                    this.viewport.update(cx, |v, cx| v.set_isolate(None, cx));
                }))))
            })
    }
}

#[cfg(test)]
mod tests;
