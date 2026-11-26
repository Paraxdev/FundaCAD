use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::{button, choice, frame, line, rows, stepper, swatch, Prefs};
use crate::inspect::section::{self, Section};
use crate::inspect::{bedfit, clash, filament, measure, overhang, printcheck, props, spell};
use crate::selection::Pick;
use crate::shell::Shell;
use crate::theme::{Theme, FS_SMALL, S_1, S_2, W_SEMIBOLD};
use crate::ui::text;
use crate::viewport::inspecting::{Asked, Card, Shade};
use crate::viewport::Viewport;

fn selected_bodies(v: &Viewport) -> Vec<String> {
    crate::inspect::isolate::unique(v.selection().picks.iter().filter_map(|p| p.body().map(str::to_string)))
}

fn prefs(cx: &mut App, f: impl FnOnce(&mut Prefs)) {
    cx.update_global::<Prefs, _>(|p, _| f(p));
    cx.refresh_windows();
}

pub(super) fn check_interference(viewport: &Entity<Viewport>, cx: &mut App) {
    let clearance = cx.global::<Prefs>().clearance;
    let picked = selected_bodies(viewport.read(cx));
    let mut fields = serde_json::Map::new();
    if let Some(gap) = clearance {
        fields.insert("clearance".into(), gap.into());
    }
    if picked.len() >= 2 {
        fields.insert("bodies".into(), picked.into());
    }
    viewport.update(cx, |v, cx| v.ask(Card::Interference, "interference", fields, cx));
}

fn check_print(viewport: &Entity<Viewport>, cx: &mut App) {
    let fields = cx.global::<Prefs>().check.fields(&selected_bodies(viewport.read(cx)));
    viewport.update(cx, |v, cx| v.ask(Card::Printability, "printability", fields, cx));
}

/// What an engine check said so far, Busy and Failed as a line.
fn asked<'a>(v: &'a Viewport, card: Card) -> Result<Option<&'a serde_json::Map<String, serde_json::Value>>, String> {
    match v.inspecting().asked.as_ref().filter(|(c, _)| *c == card).map(|(_, a)| a) {
        None => Ok(None),
        Some(Asked::Busy) => Err("Checking...".into()),
        Some(Asked::Failed(why)) => Err(format!("The check failed, {why}")),
        Some(Asked::Done(m)) => Ok(Some(m)),
    }
}

impl Shell {
    pub(super) fn card(&self, t: &Theme, card: Card, cx: &mut Context<Self>) -> Stateful<Div> {
        match card {
            Card::Measure => self.measure_card(t, cx),
            Card::Section => self.section_card(t, cx),
            Card::Properties => self.properties_card(t, cx),
            Card::Overhang => self.overhang_card(t, cx),
            Card::Interference => self.interference_card(t, cx),
            Card::Printability => self.printability_card(t, cx),
            Card::BedFit => self.bed_card(t, cx),
        }
    }

    fn measure_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let probes = &self.viewport.read(cx).inspecting().probes;
        let shown = measure::rows(probes.first(), probes.get(1));
        let any = !probes.is_empty();
        frame(t, "Measure", "inspect-measure", cx).child(rows(t, &shown)).when(any, |d| {
            d.child(div().flex().justify_end().child(button(t, "measure:clear", "Clear", false).on_click(cx.listener(
                |this, _, _, cx| {
                    this.viewport.update(cx, |v, cx| {
                        v.open_card(None, cx);
                        v.open_card(Some(Card::Measure), cx);
                    })
                },
            ))))
        })
    }

    fn section_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let (centre, radius) = v.extent().unwrap_or((glam::Vec3::ZERO, 10.0));
        let s = v.inspecting().section;
        let picking = v.inspecting().section_face;
        let step = section::step(radius);
        let axis = s.map(|s| s.axis());
        let mut axes = div().flex().gap(px(S_1));
        for (i, name) in ["X", "Y", "Z"].into_iter().enumerate() {
            axes = axes.child(choice(t, format!("section:{name}"), name, axis == Some(name)).on_click(cx.listener(
                move |this, _, _, cx| this.viewport.update(cx, |v, cx| v.set_section(Some(Section::along(i, centre)), cx)),
            )));
        }
        axes = axes.child(choice(t, "section:face", "Face", picking || axis == Some("Face")).on_click(cx.listener(
            move |this, _, _, cx| this.viewport.update(cx, |v, cx| v.pick_section_face(!picking, cx)),
        )));
        let vp = self.viewport.clone();
        let offset = s.map_or("Off".into(), |s| format!("{} mm", spell(s.slide() as f64)));
        frame(t, "Section View", "inspect-section", cx)
            .child(axes)
            .when(picking, |d| d.child(text(t, FS_SMALL).text_color(t.accent).child("Click the face to cut along")))
            .child(stepper(t, "section:offset", "Offset", offset, move |dir, cx| {
                vp.update(cx, |v, cx| {
                    let s = v.inspecting().section.map(|s| Section { offset: s.offset + step * dir as f32, ..s });
                    v.set_section(s, cx);
                })
            }))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(S_2))
                    .child(button(t, "section:flip2", "Flip", false).on_click(cx.listener(|this, _, _, cx| {
                        this.viewport.update(cx, |v, cx| {
                            let s = v.inspecting().section.map(|s| Section { flip: !s.flip, ..s });
                            v.set_section(s, cx);
                        })
                    })))
                    .child(button(t, "section:off2", "Off", false).on_click(cx.listener(|this, _, _, cx| {
                        this.viewport.update(cx, |v, cx| {
                            v.set_section(None, cx);
                            v.open_card(None, cx);
                        })
                    }))),
            )
    }

    fn properties_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = self.viewport.read(cx).properties();
        let solid = p.faults.is_empty();
        let f = cx.global::<Prefs>().filament.clone();
        let mut card = frame(t, &props::title(&p.picked), "inspect-properties", cx);
        let Some(found) = p.found else {
            return card.child(text(t, FS_SMALL).text_color(t.text_mute).child("Nothing to measure"));
        };
        card = card.child(rows(t, &props::rows(&found, solid)));
        card = card.children(p.faults.into_iter().map(|f| text(t, FS_SMALL).text_color(t.text_mute).child(f)));
        if !solid {
            return card;
        }
        let mut materials = div().flex().flex_wrap().gap(px(S_1));
        for m in filament::MATERIALS.iter().map(|m| (m.id, m.label)).chain([(filament::CUSTOM, "Custom")]) {
            let id = m.0;
            materials = materials.child(choice(t, format!("material:{id}"), m.1, f.material == id).on_click(move |_, _, cx| {
                prefs(cx, |p| p.filament.material = id.to_string())
            }));
        }
        card.child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child("Print estimate"))
            .child(materials)
            .when(f.material == filament::CUSTOM, |d| {
                d.child(stepper(t, "density", "Density", format!("{} g/cm³", spell(f.custom_density)), |dir, cx| {
                    prefs(cx, |p| p.filament.custom_density = (p.filament.custom_density + 0.01 * dir).max(0.01))
                }))
            })
            .child(stepper(t, "infill", "Infill", format!("{} %", spell(f.infill_pct)), |dir, cx| {
                prefs(cx, |p| p.filament.infill_pct = (p.filament.infill_pct + 5.0 * dir).clamp(0.0, 100.0))
            }))
            .child(stepper(t, "wall", "Wall", format!("{} mm", spell(f.wall_mm)), |dir, cx| {
                prefs(cx, |p| p.filament.wall_mm = (p.filament.wall_mm + 0.4 * dir).max(0.0))
            }))
            .child(rows(t, &filament::rows(found.volume, found.area, &f)))
    }

    fn overhang_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let shade = v.inspecting().shade;
        let areas = v.overhang_areas();
        let mut ups = div().flex().flex_wrap().gap(px(S_1));
        for (i, name) in overhang::DIRECTIONS.into_iter().enumerate() {
            ups = ups.child(choice(t, format!("up:{name}"), name, shade.up == i).on_click(cx.listener(move |this, _, _, cx| {
                this.viewport.update(cx, |v, cx| v.set_shade(Shade { up: i, ..shade }, cx))
            })));
        }
        let vp = self.viewport.clone();
        let tints = [overhang::Tint::Overhang, overhang::Tint::Wall, overhang::Tint::Top];
        frame(t, "Overhang", "inspect-overhang", cx)
            .child(line(t, "Build direction", ""))
            .child(ups)
            .child(stepper(t, "threshold", "Threshold", format!("{}°", spell(shade.threshold as f64)), move |dir, cx| {
                vp.update(cx, |v, cx| {
                    let threshold = (shade.threshold + 5.0 * dir as f32).clamp(0.0, 90.0);
                    v.set_shade(Shade { threshold, ..shade }, cx)
                })
            }))
            .children(overhang::rows(areas).into_iter().zip(tints).map(|((k, val), tint)| {
                div().flex().items_center().gap(px(S_2)).child(swatch(tint.rgb())).child(line(t, k, val).flex_1())
            }))
            .child(
                text(t, FS_SMALL)
                    .text_color(t.text_mute)
                    .child("Downward faces flatter than the threshold need support, Esc to close"),
            )
    }

    fn interference_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let gap = cx.global::<Prefs>().clearance;
        let state = asked(v, Card::Interference).map(|m| m.map(clash::read));
        let lit = selected_bodies(v);
        let mut card = frame(t, "Interference", "inspect-interference", cx)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(choice(t, "clearance", "Clearance mode", gap.is_some()).on_click(|_, _, cx| {
                        prefs(cx, |p| p.clearance = if p.clearance.is_some() { None } else { Some(0.2) })
                    }))
                    .child(button(t, "interference:check", "Check", true).on_click(cx.listener(|this, _, _, cx| {
                        check_interference(&this.viewport, cx)
                    }))),
            )
            .when_some(gap, |d, g| {
                d.child(stepper(t, "gap", "Gap", format!("{} mm", spell(g)), |dir, cx| {
                    prefs(cx, |p| p.clearance = p.clearance.map(|g| ((g + 0.05 * dir) * 100.0).round().max(5.0) / 100.0))
                }))
            });
        let report = match state {
            Err(line) => return card.child(text(t, FS_SMALL).text_color(t.text_mute).child(line)),
            Ok(None) => return card,
            Ok(Some(r)) => r,
        };
        card = card.child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(clash::summary(&report)));
        for (k, c) in report.rows.iter().enumerate() {
            let on = lit.len() == 2 && lit.contains(&c.a) && lit.contains(&c.b);
            let (a, b) = (c.a.clone(), c.b.clone());
            card = card.child(
                div()
                    .id(ElementId::Name(format!("clash:{k}").into()))
                    .px(px(S_2))
                    .py(px(S_1))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(if on { t.accent } else { t.line })
                    .when(on, |d| d.bg(t.accent_wash))
                    .cursor_pointer()
                    .child(line(t, c.pair.clone(), c.detail.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let picks = match on {
                            true => Vec::new(),
                            false => vec![Pick::Body { body: a.clone() }, Pick::Body { body: b.clone() }],
                        };
                        this.viewport.update(cx, |v, cx| v.set_selection(picks, cx));
                    })),
            );
        }
        if !report.unchecked.is_empty() {
            card = card.child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child("Not checked"));
            card = card.children(report.unchecked.iter().map(|u| text(t, FS_SMALL).text_color(t.text_mute).child(u.clone())));
        }
        let footer = clash::footer(&report, gap);
        card.children(report.note.map(|n| text(t, FS_SMALL).text_color(t.text_mute).child(n)))
            .children(footer.into_iter().map(|l| text(t, FS_SMALL).text_color(t.text_mute).child(l)))
    }

    fn printability_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let s = cx.global::<Prefs>().check.clone();
        let picked = selected_bodies(v);
        let names: Vec<String> =
            v.bodies().iter().filter(|b| picked.contains(&b.id)).map(|b| b.name.clone()).collect();
        let state = asked(v, Card::Printability).map(|m| m.map(printcheck::read));
        let num = |id: &'static str, name: &'static str, value: f64, unit: &str, set: fn(&mut printcheck::Settings, f64)| {
            stepper(t, id, name, format!("{} {unit}", spell(value)), move |dir, cx| prefs(cx, |p| set(&mut p.check, dir)))
        };
        let mut card = frame(t, "Printability", "inspect-print", cx)
            .child(line(t, "Bodies", if names.is_empty() { "All".to_string() } else { names.join(", ") }))
            .child(num("nozzle", "Nozzle", s.nozzle, "mm", |c, d| c.nozzle = ((c.nozzle + 0.1 * d) * 10.0).round().max(1.0) / 10.0))
            .child(num("layer", "Layer", s.layer, "mm", |c, d| c.layer = ((c.layer + 0.05 * d) * 100.0).round().max(5.0) / 100.0))
            .child(num("overhang", "Overhang angle", s.overhang, "°", |c, d| c.overhang = (c.overhang + 5.0 * d).clamp(0.0, 90.0)))
            .child(num("mingap", "Smallest gap", s.min_gap, "mm", |c, d| c.min_gap = ((c.min_gap + 0.05 * d) * 100.0).round().max(0.0) / 100.0))
            .child(num("bridge", "Longest bridge", s.max_bridge, "mm", |c, d| c.max_bridge = (c.max_bridge + 1.0 * d).max(0.0)))
            .child(div().flex().justify_end().child(button(t, "print:check", "Check", true).on_click(cx.listener(
                |this, _, _, cx| check_print(&this.viewport, cx),
            ))));
        let report = match state {
            Err(line) => return card.child(text(t, FS_SMALL).text_color(t.text_mute).child(line)),
            Ok(None) => return card,
            Ok(Some(r)) => r,
        };
        card = card.child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(printcheck::summary(&report)));
        card = card.children(report.faults.iter().map(|f| text(t, FS_SMALL).text_color(t.text_mute).child(f.clone())));
        for (bi, (name, findings)) in report.bodies.iter().enumerate() {
            card = card.child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(name.clone()));
            for (k, f) in findings.iter().enumerate() {
                let at = (f.body.clone(), f.face);
                let leave = at.clone();
                card = card.child(
                    div()
                        .id(ElementId::Name(format!("finding:{bi}:{k}").into()))
                        .flex()
                        .gap(px(S_2))
                        .px(px(S_1))
                        .rounded(px(6.))
                        .hover(|d| d.bg(t.hover_wash))
                        .cursor_pointer()
                        .child(div().pt(px(4.)).child(swatch(f.rgb)))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .min_w_0()
                                .child(text(t, FS_SMALL).child(f.title.clone()))
                                .child(text(t, FS_SMALL).text_color(t.text_mute).child(f.place.clone())),
                        )
                        .on_hover(cx.listener(move |this, on: &bool, _, cx| {
                            this.viewport.update(cx, |v, cx| match on {
                                true => v.set_highlight(Some(at.clone()), cx),
                                false => v.clear_highlight(&leave, cx),
                            })
                        })),
                );
            }
        }
        card
    }

    fn bed_card(&self, t: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let v = self.viewport.read(cx);
        let shown = v.shown_bodies();
        let size = props::of(shown.iter().map(|b| &**b)).map(|p| p.size());
        let p = cx.global::<Prefs>();
        let (chosen, custom) = (p.bed, p.custom_bed);
        let bed = bedfit::PRESETS.iter().find(|b| b.id == chosen).map_or(custom, |b| b.size);
        let mut beds = div().flex().flex_wrap().gap(px(S_1));
        for b in bedfit::PRESETS.iter().map(|b| (b.id, bedfit::label(b.size))).chain([("custom", "Custom".to_string())]) {
            let id = b.0;
            beds = beds.child(choice(t, format!("bed:{id}"), b.1, chosen == id).on_click(move |_, _, cx| prefs(cx, |p| p.bed = id)));
        }
        let card = frame(t, "Bed Fit Check", "inspect-bed", cx).child(beds).when(chosen == "custom", |mut d| {
            for (i, name) in ["Width", "Depth", "Height"].into_iter().enumerate() {
                d = d.child(stepper(t, &format!("bed{i}"), name, format!("{} mm", spell(custom[i])), move |dir, cx| {
                    prefs(cx, |p| p.custom_bed[i] = (p.custom_bed[i] + 10.0 * dir).max(10.0))
                }));
            }
            d
        });
        match size {
            None => card.child(text(t, FS_SMALL).text_color(t.text_mute).child("Nothing to fit")),
            Some(size) => card
                .child(line(t, "Model", format!("{} mm", bedfit::label(size))))
                .child(text(t, FS_SMALL).font_weight(W_SEMIBOLD).child(bedfit::verdict(size, bed))),
        }
    }
}
