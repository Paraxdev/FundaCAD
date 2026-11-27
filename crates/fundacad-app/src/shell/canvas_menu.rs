//! The viewport's right click menus for a body, a face, an edge, a plane and empty space, FundaCAD 1's
//! ui/contextMenus.ts on the shared overlay menu. Every row runs an existing command or an Items or History edit.

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use gpui::*;
use serde_json::json;

use super::items::Act;
use super::Shell;
use crate::commands::{self, register, Group};
use crate::i18n::{self, tr, Label};
use crate::items::Category;
use crate::overlay::{self, MenuItem, MenuRow};
use crate::selection::Pick;
use crate::timeline::rows::Rows;
use crate::viewport::{CanvasClick, CanvasTarget, Viewport};

const WORLD: [&str; 3] = ["XY", "XZ", "YZ"];

pub(super) fn install(viewport: &Entity<Viewport>, window: &mut Window, cx: &mut Context<Shell>) {
    cx.subscribe_in(viewport, window, |this, _, e: &CanvasClick, window, cx| this.canvas_menu(e, window, cx)).detach();
    let shell = cx.weak_entity();
    register(cx, "show-all-bodies", Label::Command("command.showAllBodies"), Group::View, move |w, cx| {
        let _ = shell.update(cx, |s, cx| s.act(Act::ShowAll(Category::Bodies), w, cx));
    });
}

/// A command's row, its key hint and greying kept, `pick` selected alone first so the command acts on it.
fn command_on(cx: &App, v: &Entity<Viewport>, id: &'static str, label: String, pick: Option<Pick>) -> MenuRow {
    let v = v.clone();
    let mut item = MenuItem::call(label, move |w, cx| {
        if let Some(p) = &pick {
            v.update(cx, |v, cx| v.set_selection(vec![p.clone()], cx));
        }
        commands::run(id, w, cx);
    });
    item.hint = commands::hint(cx, id);
    item.disabled = !commands::enabled(cx, id);
    MenuRow::Item(item)
}

fn command(cx: &App, id: &str, label: Option<String>) -> MenuRow {
    let item = MenuItem::command(cx, id);
    MenuRow::Item(match label {
        Some(l) => item.label(l),
        None => item,
    })
}

fn act(shell: &WeakEntity<Shell>, label: String, act: Act) -> MenuRow {
    let shell = shell.clone();
    MenuRow::Item(MenuItem::call(label, move |w, cx| {
        let act = act.clone();
        let _ = shell.update(cx, |s, cx| s.act(act, w, cx));
    }))
}

fn hide(category: Category, id: &str) -> Act {
    Act::Vis(vec![(category, vec![(id.to_string(), false)], HashMap::new())])
}

/// Drops separators at either end and doubled ones, left behind where a section has no rows.
pub fn tidy(rows: Vec<MenuRow>) -> Vec<MenuRow> {
    let mut out: Vec<MenuRow> = Vec::new();
    for row in rows {
        let gap = matches!(row, MenuRow::Separator);
        if gap && out.last().is_none_or(|r| matches!(r, MenuRow::Separator)) {
            continue;
        }
        out.push(row);
    }
    if matches!(out.last(), Some(MenuRow::Separator)) {
        out.pop();
    }
    out
}

impl Shell {
    fn canvas_menu(&mut self, e: &CanvasClick, window: &mut Window, cx: &mut Context<Self>) {
        let rows = match &e.target {
            CanvasTarget::Plane(id) => self.plane_menu(id, cx),
            CanvasTarget::Body(body) => self.body_menu(body, cx),
            CanvasTarget::Face(pick) => self.face_menu(pick, e.at, cx),
            CanvasTarget::Edge(pick) => self.edge_menu(pick, e.at, cx),
            CanvasTarget::Empty => self.empty_menu(cx),
        };
        overlay::open_menu(window, cx, e.at, tidy(rows));
    }

    fn plane_menu(&mut self, id: &str, cx: &mut Context<Self>) -> Vec<MenuRow> {
        let v = self.viewport.clone();
        let pick = Pick::Plane { id: id.to_string() };
        v.update(cx, |v, cx| v.set_selection(vec![pick.clone()], cx));
        let world = WORLD.contains(&id);
        let shell = cx.weak_entity();
        let mut rows = vec![command_on(cx, &v, "split", i18n::t("items.plane.cutAll"), Some(pick.clone()))];
        if world {
            let (v2, plane) = (v.clone(), id.to_string());
            rows.push(MenuRow::Item(MenuItem::call(i18n::t("ctx.plane.sketch"), move |_, cx| {
                v2.update(cx, |v, cx| v.new_sketch(json!(plane.clone()), cx));
            })));
        }
        rows.push(command_on(cx, &v, "offset-plane", i18n::t("ctx.plane.offset"), Some(pick)));
        rows.push(MenuRow::Separator);
        rows.push(act(&shell, i18n::t("ctx.plane.hide"), hide(Category::Planes, id)));
        if !world {
            let id = id.to_string();
            rows.push(MenuRow::Item(MenuItem::call(i18n::t("ctx.plane.delete"), move |_, cx| {
                let _ = shell.update(cx, |s, cx| s.delete_rows(vec![id.clone()], cx));
            })));
        }
        rows
    }

    fn edge_menu(&mut self, pick: &Pick, at: Point<Pixels>, cx: &mut Context<Self>) -> Vec<MenuRow> {
        let v = self.viewport.clone();
        let p = || Some(pick.clone());
        vec![
            command_on(cx, &v, "fillet", i18n::t("tool.fillet"), p()),
            command_on(cx, &v, "chamfer", i18n::t("tool.chamfer"), p()),
            command_on(cx, &v, "plane-normal-edge", i18n::t("ctx.edge.planeNormal"), p()),
            command_on(cx, &v, "plane-angle", i18n::t("ctx.edge.planeAngle"), p()),
            MenuRow::Separator,
            self.measure_row(at, true, cx),
        ]
    }

    fn face_menu(&mut self, pick: &Pick, at: Point<Pixels>, cx: &mut Context<Self>) -> Vec<MenuRow> {
        let v = self.viewport.clone();
        let flat = v.read(cx).flat_face(pick);
        let p = || Some(pick.clone());
        let sketch = {
            let (v, pick) = (v.clone(), pick.clone());
            let mut item = MenuItem::call(i18n::t("ctx.face.sketch"), move |_, cx| {
                v.update(cx, |v, cx| {
                    v.set_selection(vec![pick.clone()], cx);
                    v.sketch_on_selection(cx);
                })
            });
            item.hint = commands::hint(cx, "sketch");
            MenuRow::Item(item.disabled(!flat))
        };
        let mut rows = vec![
            command_on(cx, &v, "presspull", i18n::t("ctx.face.pressPull"), p()),
            sketch,
            self.measure_row(at, false, cx),
            MenuRow::Separator,
        ];
        let offset = command_on(cx, &v, "offset-plane", i18n::t("ctx.face.offsetPlane"), p());
        rows.push(match offset {
            MenuRow::Item(i) => MenuRow::Item(i.disabled(!flat)),
            other => other,
        });
        if !flat {
            rows.push(command_on(cx, &v, "axis-cylinder", i18n::t("ctx.face.axis"), p()));
        }
        rows.push(MenuRow::Separator);
        let Pick::Face { body, face, .. } = pick else { return rows };
        let owner = v.read(cx).bodies().iter().find(|b| b.id == *body).and_then(|b| b.face_owners.get(*face as usize).cloned().flatten());
        if let Some(owner) = owner.filter(|o| self.source.as_ref().is_some_and(|d| crate::tools::feature(d, o).is_some())) {
            let doc = self.source.clone().unwrap_or_default();
            let name = crate::timeline::labels::name_of(&doc, &owner);
            let shell = cx.weak_entity();
            rows.push(MenuRow::Item(MenuItem::call(tr!("ctx.face.edit", feature = name), move |_, cx| {
                let _ = shell.update(cx, |s, cx| s.open_feature(&owner, cx));
            })));
        }
        let shell = cx.weak_entity();
        rows.push(act(&shell, i18n::t("ctx.hideBody"), hide(Category::Bodies, body)));
        rows.push(act(&shell, i18n::t("ctx.isolateBody"), Act::ShowOnly(Category::Bodies, vec![body.clone()])));
        rows
    }

    fn body_menu(&mut self, body: &str, cx: &mut Context<Self>) -> Vec<MenuRow> {
        let v = self.viewport.clone();
        let pick = Pick::Body { body: body.to_string() };
        if !v.read(cx).selection().has(&pick) {
            v.update(cx, |v, cx| v.set_selection(vec![pick], cx));
        }
        let shell = cx.weak_entity();
        let mut rows = vec![
            command_on(cx, &v, "move", i18n::t("tool.move"), None),
            command_on(cx, &v, "fillet", i18n::t("ctx.body.fillet"), None),
            command_on(cx, &v, "chamfer", i18n::t("ctx.body.chamfer"), None),
        ];
        for op in ["union", "subtract", "intersect"] {
            let id = match op {
                "union" => "boolean-union",
                "subtract" => "boolean-subtract",
                _ => "boolean-intersect",
            };
            rows.push(command_on(cx, &v, id, tr!("ctx.body.boolean", op = op), None));
        }
        rows.push(command_on(cx, &v, "separate", i18n::t("tool.separate"), None));
        rows.push(command_on(cx, &v, "properties", i18n::t("tool.properties"), None));
        rows.push(MenuRow::Separator);
        rows.push(act(&shell, i18n::t("ctx.hideBody"), hide(Category::Bodies, body)));
        rows.push(act(&shell, i18n::t("ctx.isolateBody"), Act::ShowOnly(Category::Bodies, vec![body.to_string()])));
        rows.push(command(cx, "show-all-bodies", None));
        rows.push(MenuRow::Separator);
        let id = body.to_string();
        let renamer = shell.clone();
        rows.push(MenuRow::Item(MenuItem::call(i18n::t("ctx.body.rename"), move |w, cx| {
            let id = id.clone();
            let _ = renamer.update(cx, |s, cx| {
                s.items_tab = 0;
                s.reveal_body(&id, cx);
                s.act(Act::Rename(format!("b:{id}")), w, cx)
            });
        })));
        if let Some(doc) = self.source.clone() {
            let owners: Vec<String> = {
                let mut owners: Vec<String> = Vec::new();
                for b in v.read(cx).bodies().iter().filter(|b| b.id == body) {
                    for o in b.face_owners.iter().flatten() {
                        if !owners.contains(o) {
                            owners.push(o.clone());
                        }
                    }
                }
                owners
            };
            for row in crate::plugins::body_menu(cx, &doc, &owners) {
                let run = row.run.clone();
                rows.push(MenuRow::Item(MenuItem::call(row.label, move |w, cx| run(w, cx))));
            }
        }
        rows
    }

    fn empty_menu(&mut self, cx: &mut Context<Self>) -> Vec<MenuRow> {
        let look = ["iso", "top", "front", "right"].into_iter().map(|id| command(cx, id, None)).collect();
        vec![
            command(cx, "fit", Some(i18n::t("ctx.fit"))),
            MenuRow::Submenu { label: i18n::t("ctx.look").into(), rows: look },
            command(cx, "show-all-bodies", None),
            MenuRow::Separator,
            command(cx, "undo", None),
            command(cx, "redo", None),
        ]
    }

    fn measure_row(&self, at: Point<Pixels>, edge: bool, cx: &App) -> MenuRow {
        let v = self.viewport.clone();
        let mut item = MenuItem::call(i18n::t("ctx.measureFrom"), move |_, cx| {
            v.update(cx, |v, cx| v.measure_from(at, edge, cx));
        });
        item.hint = commands::hint(cx, "measure");
        MenuRow::Item(item)
    }

    /// Picks the feature's History step alone and scrolls to it, which shows its values for editing.
    fn open_feature(&mut self, id: &str, cx: &mut Context<Self>) {
        self.timeline.rows = Rows { keys: vec![id.to_string()], anchor: Some(id.to_string()) };
        self.timeline.reveal.set(Some(id.to_string()));
        cx.notify();
    }
}
