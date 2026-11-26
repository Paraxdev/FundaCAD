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
use super::{picker, prefs, Shell, Stop};
use crate::overlay::{self, Choice, Toast};

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
        let pick = picker::pick_open_paths(&IMPORT_EXTS, true);
        cx.spawn_in(window, async move |this, cx| {
            let paths = pick.await;
            if paths.is_empty() {
                return;
            }
            let asking: Vec<&str> =
                paths.iter().filter(|p| asks_for_unit(import_format(p))).map(|p| base_name(p)).collect();
            let unit = if asking.is_empty() {
                None
            } else {
                let units = unit_choices(prefs().import_unit);
                let question = format!("Which unit is {} in? The file does not say reliably.", asking.join(", "));
                let choices = units
                    .iter()
                    .enumerate()
                    .map(|(i, u)| if i == 0 { Choice::primary(*u) } else { Choice::plain(*u) })
                    .chain([Choice::plain("Cancel")])
                    .collect();
                let Ok(asked) = cx.update(|window, cx| overlay::confirm(window, cx, question, choices)) else {
                    return;
                };
                let Some(&unit) = asked.recv().await.ok().flatten().and_then(|i| units.get(i)) else { return };
                prefs().import_unit = unit;
                Some(unit)
            };
            let _ = this.update_in(cx, |s, window, cx| s.run_import(paths, unit, window, cx));
        })
        .detach();
    }

    fn run_import(
        &mut self,
        paths: Vec<String>,
        unit: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
                    overlay::toast(cx, Toast::info(format!("Imported {added} file(s).")));
                }
                if stop.is_set() {
                    overlay::toast(cx, Toast::info("Import cancelled."));
                }
                for f in failed {
                    overlay::toast(cx, Toast::error(format!("The import failed, {f}")));
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
        let pick = picker::pick_open_paths(&DOC_EXTS, false);
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = pick.await.into_iter().next() else { return };
            if link.path.as_deref().is_some_and(|own| same_path(&path, &own.to_string_lossy())) {
                let _ =
                    cx.update(|_, cx| overlay::toast(cx, Toast::error("A document cannot be inserted into itself.")));
                return;
            }
            let question =
                format!("How should {} come in? It becomes one body built from its own history.", base_name(&path));
            let choices = vec![
                Choice::primary("Append").hint("Copies it once"),
                Choice::plain("Link").hint("Refreshes when the file changes"),
                Choice::plain("Cancel"),
            ];
            let Ok(asked) = cx.update(|window, cx| overlay::confirm(window, cx, question, choices)) else { return };
            let mode = match asked.recv().await.ok().flatten() {
                Some(0) => InsertMode::Append,
                Some(1) => InsertMode::Link,
                _ => return,
            };
            let _ = this.update_in(cx, |s, window, cx| s.run_insert(path, mode, window, cx));
        })
        .detach();
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
                    Ok(_) => overlay::toast(cx, Toast::info(format!("Inserted {}.", base_name(&path)))),
                    Err(Some(why)) => overlay::toast(cx, Toast::error(why)),
                    Err(None) => overlay::toast(cx, Toast::info("Insert cancelled.")),
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
        if stale_count(&stale) == 0 {
            if !quiet {
                overlay::toast(cx, Toast::info(stale_summary(&stale)));
            }
            return;
        }
        let refresh = refreshable(&stale);
        let mut choices = Vec::new();
        if !refresh.is_empty() {
            choices.push(Choice::primary("Refresh").hint("Reads the changed files again"));
        }
        choices.push(Choice::danger("Unlink").hint("Keeps the bodies, forgets the files"));
        choices.push(Choice::plain("Later"));
        let unlink_at = choices.len() - 2;
        let asked = overlay::confirm(window, cx, stale_summary(&stale), choices);
        cx.spawn_in(window, async move |this, cx| {
            let pick = asked.recv().await.ok().flatten();
            let _ = this.update_in(cx, |s, window, cx| match pick {
                Some(i) if i == unlink_at => s.unlink_links(stale, cx),
                Some(0) if !refresh.is_empty() => s.refresh_links(refresh, window, cx),
                _ => {}
            });
        })
        .detach();
    }

    fn unlink_links(&mut self, stale: StaleLinks, cx: &mut Context<Self>) {
        let ids: Vec<String> = stale.changed.into_iter().chain(stale.missing).chain(stale.unknown).collect();
        let edited = self.viewport.update(cx, |v, cx| {
            v.edit(
                move |d| {
                    ids.iter().for_each(|id| unlink(d, id));
                    Ok(())
                },
                cx,
            )
        });
        if let Err(e) = edited {
            overlay::toast(cx, Toast::error(e));
        }
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
                    overlay::toast(cx, Toast::info("Refresh cancelled."));
                }
                if done > 0 {
                    overlay::toast(
                        cx,
                        Toast::info(format!("Refreshed {done} linked bod{}.", if done == 1 { "y" } else { "ies" })),
                    );
                }
                for f in failed {
                    overlay::toast(cx, Toast::error(f));
                }
            });
        })
        .detach();
    }
}
