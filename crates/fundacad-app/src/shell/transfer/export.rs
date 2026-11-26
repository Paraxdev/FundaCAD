//! The Export dialog and the export it sends.

use std::path::{Path, PathBuf};

use fundacad_client::transfer::export::{
    clamp_tolerance, export_dir_of, export_fields, export_file_name, export_warnings, scope_from_selection,
    written_paths, BodyScope, Colors, ExportFormat, ExportSettings, ExportStart, FlatSource, Refinement, FORMATS,
    UNITS,
};
use fundacad_client::Refused;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputState};
use serde_json::{json, Value};

use super::logic::{flat_sources, scope_choices, stamp_now, with_ext, written_summary};
use super::modal::{button, choice, note, row};
use super::{picker, prefs, Modal, Shell};
use crate::overlay::{self, Toast};
use crate::theme::{Theme, FS_SMALL};

pub(super) struct ExportDialog {
    settings: ExportSettings,
    before: ExportSettings,
    start: ExportStart,
    scope: BodyScope,
    sources: Vec<FlatSource>,
    source: usize,
    tolerance: Entity<InputState>,
    surface: Entity<InputState>,
    normal: Entity<InputState>,
    edge: Entity<InputState>,
}

fn number(v: f64) -> String {
    format!("{v}")
}

fn typed(input: &Entity<InputState>, cx: &App) -> Option<f64> {
    input.read(cx).value().trim().parse::<f64>().ok()
}

impl ExportDialog {
    fn read_inputs(&mut self, cx: &App) {
        if self.settings.show_advanced {
            if let Some(v) = typed(&self.surface, cx) {
                self.settings.set_faceting(v, |f| &mut f.surface_deviation);
            }
            if let Some(v) = typed(&self.normal, cx) {
                self.settings.set_faceting(v, |f| &mut f.normal_deviation);
            }
            if let Some(v) = typed(&self.edge, cx) {
                self.settings.set_faceting(v, |f| &mut f.max_edge_length);
            }
        }
        if let Some(v) = typed(&self.tolerance, cx) {
            self.settings.tolerance = clamp_tolerance(v);
        }
    }

    fn flat(&self) -> Option<&FlatSource> {
        self.sources.get(self.source)
    }
}

impl Shell {
    pub(super) fn open_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer_link(cx).is_none() {
            return;
        }
        let sources = self.viewport.read(cx).doc().map(flat_sources).unwrap_or_default();
        let settings = prefs().export.clone();
        // The app has no body selection yet, so Export starts from the whole document.
        let start = scope_from_selection(&[], &[], &[], &self.doc.name);
        let input = |v: f64, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).default_value(number(v)))
        };
        let f = settings.faceting;
        let dialog = ExportDialog {
            tolerance: input(settings.tolerance, window, cx),
            surface: input(f.surface_deviation, window, cx),
            normal: input(f.normal_deviation, window, cx),
            edge: input(f.max_edge_length, window, cx),
            before: settings.clone(),
            settings,
            scope: start.scope.clone(),
            start,
            sources,
            source: 0,
        };
        self.open_modal(Modal::Export(Box::new(dialog)), window, cx);
    }

    fn edit_export(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut ExportDialog)) {
        if let Some(Modal::Export(d)) = &mut self.transfer.modal {
            f(d);
            cx.notify();
        }
    }

    fn pick_refinement(&mut self, r: Refinement, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Modal::Export(d)) = &mut self.transfer.modal else { return };
        d.read_inputs(cx);
        d.settings.pick_refinement(r);
        let f = d.settings.faceting;
        for (input, v) in
            [(&d.surface, f.surface_deviation), (&d.normal, f.normal_deviation), (&d.edge, f.max_edge_length)]
        {
            input.update(cx, |i, cx| i.set_value(number(v), window, cx));
        }
        cx.notify();
    }

    pub(super) fn export_view(&self, d: &ExportDialog, t: &Theme, cx: &mut Context<Self>) -> (AnyElement, AnyElement) {
        let s = &d.settings;
        let has_sources = !d.sources.is_empty();
        let formats =
            FORMATS.iter().map(|info| {
                let format = info.format;
                let enabled = has_sources || !format.is_flat();
                choice(t, ("export-format", format as usize), info.value.to_uppercase(), s.format == format, enabled)
                    .when(enabled, |c| {
                        c.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.edit_export(cx, |d| d.settings.format = format)
                        }))
                    })
            });
        let mut body = div().flex().flex_col().gap(px(8.)).child(row(
            t,
            "Format",
            div().flex().flex_wrap().gap(px(4.)).children(formats),
        ));
        if !has_sources {
            body = body.child(note(t, "DXF and SVG draw a sketch, this document has none."));
        }
        if s.format.is_flat() {
            let sources = d.sources.iter().enumerate().map(|(i, src)| {
                choice(t, ("export-source", i), src.label().to_owned(), d.source == i, true)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.edit_export(cx, |d| d.source = i)))
            });
            body = body.child(row(t, "Sketch", div().flex().flex_wrap().gap(px(4.)).children(sources))).child(row(
                t,
                "Tolerance",
                field(t, &d.tolerance, "mm"),
            ));
        } else {
            let scopes =
                scope_choices(!d.start.selected.is_empty()).into_iter().enumerate().map(|(i, (scope, label))| {
                    let on = d.scope == scope;
                    choice(t, ("export-scope", i), label, on, true).on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            let scope = scope.clone();
                            this.edit_export(cx, |d| d.scope = scope)
                        },
                    ))
                });
            body = body.child(row(t, "Bodies", div().flex().flex_wrap().gap(px(4.)).children(scopes)));
        }
        if s.format.takes_unit() {
            let units = UNITS.iter().map(|u| {
                let u: &'static str = u;
                choice(t, SharedString::from(format!("export-unit-{u}")), u, s.unit == u, true).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.edit_export(cx, |d| d.settings.unit = u)),
                )
            });
            body = body.child(row(t, "Unit", div().flex().gap(px(4.)).children(units)));
        }
        if s.format == ExportFormat::Stl {
            let enc = [(true, "Binary"), (false, "ASCII")].map(|(binary, label)| {
                choice(t, ("export-binary", usize::from(binary)), label, s.binary == binary, true).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.edit_export(cx, |d| d.settings.binary = binary)
                    }),
                )
            });
            body = body.child(row(t, "Encoding", div().flex().gap(px(4.)).children(enc)));
        }
        if s.format.is_mesh() {
            let presets = [Refinement::Low, Refinement::Medium, Refinement::High, Refinement::Custom].map(|r| {
                let label = match r {
                    Refinement::Low => "Low",
                    Refinement::Medium => "Medium",
                    Refinement::High => "High",
                    Refinement::Custom => "Custom",
                };
                choice(t, ("export-refine", r as usize), label, s.refinement == r, true)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.pick_refinement(r, window, cx)))
            });
            let advanced = choice(t, "export-advanced", "Advanced", s.show_advanced, true).on_click(cx.listener(
                |this, _: &ClickEvent, _, cx| {
                    if let Some(Modal::Export(d)) = &mut this.transfer.modal {
                        d.read_inputs(cx);
                        d.settings.show_advanced = !d.settings.show_advanced;
                        cx.notify();
                    }
                },
            ));
            body = body.child(row(t, "Refinement", div().flex().gap(px(4.)).children(presets).child(advanced)));
            if s.show_advanced {
                body = body
                    .child(row(t, "Deviation", field(t, &d.surface, "mm")))
                    .child(row(t, "Angle", field(t, &d.normal, "deg")))
                    .child(row(t, "Max edge", field(t, &d.edge, "mm, 0 is none")));
            }
        }
        let ready = !s.format.is_flat() || d.flat().is_some();
        let ok = button(t, "export-run", "Export...", true, ready)
            .when(ready, |b| b.on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.run_export(window, cx))));
        (body.into_any_element(), ok.into_any_element())
    }

    fn run_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Modal::Export(d)) = &mut self.transfer.modal else { return };
        d.read_inputs(cx);
        let (settings, before, scope, start) = (d.settings.clone(), d.before.clone(), d.scope.clone(), d.start.clone());
        let flat = d.flat().cloned().filter(|_| settings.format.is_flat());
        let path = self.bench.files.read(cx).path().map(Path::to_path_buf);
        let Some(link) = self.viewport.read(cx).session_link(path.as_deref()) else { return };
        let colors: Option<(Value, Value)> = (settings.format == ExportFormat::Glb)
            .then(|| self.viewport.read(cx).doc())
            .flatten()
            .and_then(|doc| Some((doc.get("palette")?.clone(), doc.get("bodyColors").cloned().unwrap_or(json!({})))));
        let base = flat.as_ref().map_or(start.base.as_str(), FlatSource::label);
        let name = export_file_name(base, settings.format.ext(), stamp_now());
        let dir = prefs()
            .export_dir
            .clone()
            .map(PathBuf::from)
            .or_else(|| link.path.as_deref().and_then(Path::parent).map(Path::to_path_buf))
            .unwrap_or_else(std::env::temp_dir);
        let pick = picker::pick_save_path(&dir, &name);
        self.transfer.modal = None;
        window.focus(&self.focus, cx);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = pick.await else { return };
            let path = with_ext(&path.to_string_lossy(), settings.format);
            let colors = colors.as_ref().map(|(palette, body_colors)| Colors { palette, body_colors });
            let fields = export_fields(&settings, &scope, &start, flat.as_ref(), &path, colors);
            let client = link.client.clone();
            let Ok((token, stop)) = this.update_in(cx, |s, w, cx| s.set_busy("Exporting", link.client.clone(), w, cx))
            else {
                return;
            };
            let task = stop.clone();
            let answer = cx
                .background_spawn(async move {
                    if task.is_set() {
                        return Err(Refused { message: "cancelled".into(), cancelled: true });
                    }
                    client.export(fields)
                })
                .await;
            let _ = this.update_in(cx, |s, w, cx| {
                s.end_busy(token, w, cx);
                match answer {
                    Ok(result) => {
                        let mut p = prefs();
                        p.export = settings.remembered(&before);
                        p.export_dir = export_dir_of(&path).map(str::to_owned);
                        drop(p);
                        overlay::toast(cx, Toast::info(written_summary(&written_paths(&result))));
                        let warnings = export_warnings(&result);
                        if let Some((_, first)) = warnings.first() {
                            let n = warnings.len();
                            let text =
                                format!("{n} feature(s) failed, their bodies are missing from the file: {first}");
                            overlay::toast(cx, Toast::error(text));
                        }
                    }
                    Err(r) if r.cancelled => overlay::toast(cx, Toast::info("Export cancelled.")),
                    Err(r) => overlay::toast(cx, Toast::error(format!("The export failed: {}", r.message))),
                }
            });
        })
        .detach();
    }
}

fn field(t: &Theme, input: &Entity<InputState>, unit: &'static str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(div().w(px(110.)).child(Input::new(input).text_size(px(FS_SMALL))))
        .child(note(t, unit))
}
