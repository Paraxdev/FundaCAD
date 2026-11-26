//! Import, Insert FundaCAD document, and the linked files check.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use fundacad_client::transfer::files::{base_name, import_format, DOC_EXTS, IMPORT_EXTS};
use fundacad_client::transfer::import::{
    asks_for_unit, feature_ids, free_ids, import_features, import_fields, unit_choices,
};
use fundacad_client::transfer::insert::{
    bake, insert_feature, refresh_link, same_path, stale_links, stat_file, unlink, InsertError, InsertMode, LinkStat,
    Source, StaleLinks,
};
use fundacad_client::{Client, Refused};
use gpui::*;
use serde_json::{Map, Value};

use super::logic::{append_features, insert_error_text, link_path, refreshable, stale_count, stale_summary};
use super::modal::{button, choice, note, row};
use super::{picker, prefs, Kind, Modal, Shell, Stop};
use crate::theme::Theme;

type Baked = (String, LinkStat, Map<String, Value>);

fn stopped() -> InsertError {
    InsertError::Build(Refused { message: "cancelled".into(), cancelled: true })
}

/// Reads a source document and bakes its geometry, on a background thread.
fn read_and_bake(client: &Client, path: &str, blob_dir: &Path, stop: &Stop) -> Result<Baked, InsertError> {
    static N: AtomicU64 = AtomicU64::new(0);
    if stop.is_set() {
        return Err(stopped());
    }
    let stat = stat_file(path);
    let text = fundacad_format::read_document(Path::new(path), blob_dir).map_err(InsertError::Read)?;
    if stop.is_set() {
        return Err(stopped());
    }
    let n = N.fetch_add(1, Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!("fundacad-insert-{}-{n}.step", std::process::id()));
    let temp = temp.to_string_lossy().into_owned();
    let baked = bake(client, &Source { path, text: &text, stat }, &temp, || stop.is_set());
    let _ = std::fs::remove_file(&temp);
    baked.map(|b| (text, stat, b))
}

impl Shell {
    pub(super) fn start_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer_link(cx).is_none() {
            return;
        }
        let pick = picker::pick_open_paths(cx, &IMPORT_EXTS, true);
        cx.spawn_in(window, async move |this, cx| {
            let paths = pick.await;
            if paths.is_empty() {
                return;
            }
            let _ = this.update_in(cx, |s, window, cx| {
                if paths.iter().any(|p| asks_for_unit(import_format(p))) {
                    let unit = unit_choices(prefs().import_unit)[0];
                    s.open_modal(Modal::ImportUnit { paths, unit }, window, cx);
                } else {
                    s.run_import(paths, None, window, cx);
                }
            });
        })
        .detach();
    }

    pub(super) fn import_unit_view(
        &self,
        paths: &[String],
        unit: &'static str,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, AnyElement) {
        let asking: Vec<&str> =
            paths.iter().filter(|p| asks_for_unit(import_format(p))).map(|p| base_name(p)).collect();
        let units = unit_choices(prefs().import_unit).into_iter().map(|u| {
            choice(t, SharedString::from(format!("import-unit-{u}")), u, u == unit, true).on_click(cx.listener(
                move |this, _: &ClickEvent, _, cx| {
                    if let Some(Modal::ImportUnit { unit, .. }) = &mut this.transfer.modal {
                        *unit = u;
                        cx.notify();
                    }
                },
            ))
        });
        let body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(note(t, format!("{} may be in any unit, the file does not say reliably.", asking.join(", "))))
            .child(row(t, "Unit", div().flex().gap(px(4.)).children(units)));
        let ok =
            button(t, "unit-ok", "Import", true, true).on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                if let Some(Modal::ImportUnit { paths, unit }) = this.transfer.modal.take() {
                    prefs().import_unit = unit;
                    this.run_import(paths, Some(unit), window, cx);
                }
            }));
        (body.into_any_element(), ok.into_any_element())
    }

    fn run_import(
        &mut self,
        paths: Vec<String>,
        unit: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.transfer.modal = None;
        let Some(link) = self.transfer_link(cx) else { return };
        let label = match paths.as_slice() {
            [one] => format!("Importing {}", base_name(one)),
            many => format!("Importing {} files", many.len()),
        };
        let (token, stop) = self.set_busy(label, link.client.clone(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let (mut added, mut failed) = (0, Vec::new());
            for path in paths {
                if stop.is_set() {
                    break;
                }
                let format = import_format(&path);
                let fields = import_fields(&path, format, unit);
                let client = link.client.clone();
                let answer = cx.background_spawn(async move { client.request("import", fields) }).await;
                let reply = match answer {
                    Ok(_) if stop.is_set() => break,
                    Ok(reply) => reply,
                    Err(r) if r.cancelled => break,
                    Err(r) => {
                        failed.push(format!("{}: {}", base_name(&path), r.message));
                        continue;
                    }
                };
                match this.update(cx, |s, cx| s.add_imported(&reply, format, &path, cx)) {
                    Ok(Ok(_)) => added += 1,
                    Ok(Err(e)) => failed.push(format!("{}: {e}", base_name(&path))),
                    Err(_) => return,
                }
            }
            let _ = this.update_in(cx, |s, w, cx| {
                s.end_busy(token, w, cx);
                if added > 0 {
                    s.toast(Kind::Info, format!("Imported {added} file(s)."), cx);
                }
                if stop.is_set() {
                    s.toast(Kind::Info, "Import cancelled.", cx);
                }
                for f in failed {
                    s.toast(Kind::Error, format!("The import failed, {f}"), cx);
                }
            });
        })
        .detach();
    }

    fn add_imported(
        &mut self,
        reply: &Map<String, Value>,
        format: &str,
        path: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let features = {
            let doc = self.viewport.read(cx).doc().ok_or("no document is open")?;
            import_features(reply, format, path, &feature_ids(doc))
        };
        if features.is_empty() {
            return Err("the file has no geometry".into());
        }
        self.viewport.update(cx, |v, cx| v.edit(move |d| append_features(d, &features), cx)).map(|_| ())
    }

    pub(super) fn start_insert(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(link) = self.transfer_link(cx) else { return };
        let pick = picker::pick_open_paths(cx, &DOC_EXTS, false);
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = pick.await.into_iter().next() else { return };
            let _ = this.update_in(cx, |s, window, cx| {
                if same_path(&path, &link.path.to_string_lossy()) {
                    s.toast(Kind::Error, "A document cannot be inserted into itself.", cx);
                } else {
                    s.open_modal(Modal::InsertMode { path }, window, cx);
                }
            });
        })
        .detach();
    }

    pub(super) fn insert_view(&self, path: &str, t: &Theme, cx: &mut Context<Self>) -> (AnyElement, Vec<AnyElement>) {
        let body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(note(t, format!("{} comes in as one body built from its own history.", base_name(path))))
            .child(note(
                t,
                "Append copies it once. Link also keeps the file, so the body can refresh when it changes.",
            ));
        let mode = |id: &'static str, label: &'static str, primary: bool, mode: InsertMode| {
            button(t, id, label, primary, true)
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    if let Some(Modal::InsertMode { path }) = this.transfer.modal.take() {
                        this.run_insert(path, mode, window, cx);
                    }
                }))
                .into_any_element()
        };
        let buttons = vec![
            mode("insert-link", "Link", false, InsertMode::Link),
            mode("insert-append", "Append", true, InsertMode::Append),
        ];
        (body.into_any_element(), buttons)
    }

    fn run_insert(&mut self, path: String, mode: InsertMode, window: &mut Window, cx: &mut Context<Self>) {
        let Some(link) = self.transfer_link(cx) else { return };
        let (token, stop) = self.set_busy(format!("Inserting {}", base_name(&path)), link.client.clone(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let (client, blob_dir, read, task) =
                (link.client.clone(), link.blob_dir.clone(), path.clone(), stop.clone());
            let baked = cx.background_spawn(async move { read_and_bake(&client, &read, &blob_dir, &task) }).await;
            let _ = this.update_in(cx, |s, w, cx| {
                s.end_busy(token, w, cx);
                let baked = baked.and_then(|b| if stop.is_set() { Err(stopped()) } else { Ok(b) });
                let added = baked.map_err(|e| insert_error_text(&e)).and_then(|(text, stat, baked)| {
                    let feature = {
                        let doc = s.viewport.read(cx).doc().ok_or(Some("no document is open".to_owned()))?;
                        let id = free_ids(feature_ids(doc), 1).remove(0);
                        insert_feature(&id, &Source { path: &path, text: &text, stat }, mode, &baked)
                    };
                    s.viewport
                        .update(cx, |v, cx| v.edit(move |d| append_features(d, std::slice::from_ref(&feature)), cx))
                        .map_err(Some)
                });
                match added {
                    Ok(_) => s.toast(Kind::Info, format!("Inserted {}.", base_name(&path)), cx),
                    Err(Some(why)) => s.toast(Kind::Error, why, cx),
                    Err(None) => s.toast(Kind::Info, "Insert cancelled.", cx),
                }
            });
        })
        .detach();
    }

    /// Linked bodies whose file changed. `quiet` says nothing when all are current, for the check on open.
    pub(in crate::shell) fn check_links(&mut self, quiet: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer.modal.is_some() {
            return;
        }
        let Some(doc) = self.viewport.read(cx).doc() else { return };
        let stale = stale_links(doc, stat_file);
        if stale_count(&stale) > 0 {
            self.open_modal(Modal::Links(stale), window, cx);
        } else if !quiet {
            self.toast(Kind::Info, stale_summary(&stale), cx);
        }
    }

    pub(super) fn links_view(
        &self,
        stale: &StaleLinks,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<AnyElement>) {
        let body = div().flex().flex_col().gap(px(8.)).child(note(t, stale_summary(stale))).child(note(
            t,
            "Refresh reads the changed files again. Unlink keeps the bodies as they are and forgets the files.",
        ));
        let can_refresh = !refreshable(stale).is_empty();
        let unlink_all = button(t, "links-unlink", "Unlink", false, true).on_click(cx.listener(
            |this, _: &ClickEvent, window, cx| {
                if let Some(Modal::Links(stale)) = this.transfer.modal.take() {
                    let ids: Vec<String> =
                        stale.changed.into_iter().chain(stale.missing).chain(stale.unknown).collect();
                    let edited = this.viewport.update(cx, |v, cx| {
                        v.edit(
                            move |d| {
                                ids.iter().for_each(|id| unlink(d, id));
                                Ok(())
                            },
                            cx,
                        )
                    });
                    if let Err(e) = edited {
                        this.toast(Kind::Error, e, cx);
                    }
                    window.focus(&this.focus, cx);
                    cx.notify();
                }
            },
        ));
        let refresh = button(t, "links-refresh", "Refresh", true, can_refresh);
        let refresh = if can_refresh {
            refresh.on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                if let Some(Modal::Links(stale)) = this.transfer.modal.take() {
                    this.refresh_links(refreshable(&stale), window, cx);
                }
            }))
        } else {
            refresh
        };
        (body.into_any_element(), vec![unlink_all.into_any_element(), refresh.into_any_element()])
    }

    fn refresh_links(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(link) = self.transfer_link(cx) else { return };
        let Some(doc) = self.viewport.read(cx).doc() else { return };
        let targets: Vec<(String, String)> =
            ids.into_iter().filter_map(|id| Some((link_path(doc, &id)?, id))).collect();
        let (token, stop) = self.set_busy("Refreshing linked files", link.client.clone(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let (mut done, mut failed) = (0, Vec::new());
            for (path, id) in targets {
                let (client, blob_dir, read, task) =
                    (link.client.clone(), link.blob_dir.clone(), path.clone(), stop.clone());
                let baked = cx.background_spawn(async move { read_and_bake(&client, &read, &blob_dir, &task) }).await;
                let (text, stat, baked) = match baked {
                    Ok(_) if stop.is_set() => break,
                    Ok(b) => b,
                    Err(e) if e.cancelled() => break,
                    Err(e) => {
                        failed.push(insert_error_text(&e).unwrap_or_default());
                        continue;
                    }
                };
                let edit = move |d: &mut fundacad_client::Doc| {
                    let source = Source { path: &path, text: &text, stat };
                    refresh_link(d, &id, &source, &baked).map_err(|e| insert_error_text(&e).unwrap_or_default())
                };
                match this.update(cx, |s, cx| s.viewport.update(cx, |v, cx| v.edit(edit, cx))) {
                    Ok(Ok(_)) => done += 1,
                    Ok(Err(e)) => failed.push(e),
                    Err(_) => return,
                }
            }
            let _ = this.update_in(cx, |s, w, cx| {
                s.end_busy(token, w, cx);
                if stop.is_set() {
                    s.toast(Kind::Info, "Refresh cancelled.", cx);
                }
                if done > 0 {
                    s.toast(
                        Kind::Info,
                        format!("Refreshed {done} linked bod{}.", if done == 1 { "y" } else { "ies" }),
                        cx,
                    );
                }
                for f in failed {
                    s.toast(Kind::Error, f, cx);
                }
            });
        })
        .detach();
    }
}
