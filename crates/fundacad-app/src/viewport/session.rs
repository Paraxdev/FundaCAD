//! The viewport's side of a running tool, tools::run's edits applied to the open document and its targets lit.

use gpui::*;

use super::resolve::resolve;
use super::Viewport;
use crate::i18n;
use crate::selection::Pick;
use crate::tools::{self, Target};

pub use crate::tools::run::Run as ToolRun;

impl Viewport {
    pub fn running(&self) -> Option<&ToolRun> {
        self.tool.as_ref()
    }

    /// The bodies the latest build made, hidden ones included.
    pub fn body_count(&self) -> usize {
        self.built.len()
    }

    pub(super) fn arm(&self) -> Option<Target> {
        self.tool.as_ref()?.arm
    }

    /// Starts a tool on `feature` after `f` edits the document, which may add it. Refused while another runs.
    pub fn begin_tool(
        &mut self,
        title: String,
        label: String,
        feature: String,
        need: Vec<Target>,
        f: impl Fn(&mut tools::Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.tool.is_some() {
            return Err(i18n::t("ctx.busy"));
        }
        if self.push.is_some() {
            return Err(i18n::t("viewport.pushing"));
        }
        let session = self.session.as_mut().ok_or_else(|| i18n::t("files.openDocumentFirst"))?;
        let before = session.doc.clone();
        session.edit(f)?;
        self.changes += 1;
        self.undo.close();
        self.tool = Some(ToolRun::new(before, title, label, feature, need));
        self.hover = None;
        cx.notify();
        Ok(())
    }

    /// Runs `f` on the tool and a copy of the document, and sends the copy on when it changed.
    fn run_edit<R>(&mut self, f: impl FnOnce(&mut ToolRun, &mut tools::Doc) -> R, cx: &mut Context<Self>) -> Option<R> {
        let (tool, session) = (self.tool.as_mut()?, self.session.as_mut()?);
        let mut doc = session.doc.clone();
        let out = f(tool, &mut doc);
        if doc != session.doc {
            match session.edit(move |d| {
                d.clone_from(&doc);
                Ok(())
            }) {
                Ok(Some(_)) => self.changes += 1,
                Ok(None) => {}
                Err(e) => self.message = Some(e),
            }
        }
        self.picking.revision += 1;
        cx.notify();
        Some(out)
    }

    pub fn set_arm(&mut self, arm: Option<Target>, cx: &mut Context<Self>) {
        self.run_edit(|r, d| r.set_arm(d, arm), cx);
    }

    pub(super) fn pick_target(&mut self, pick: Pick, cx: &mut Context<Self>) {
        let (Some(tool), Some(value)) = (self.tool.as_ref(), tools::entry(&pick)) else { return };
        let Some(arm) = tool.arm else { return };
        let had = self.doc().and_then(|d| {
            let held = tools::entries(d, &tool.feature, arm.field);
            held.into_iter().find(|e| resolve(&self.scene, self.picking.lines(), e).is_some_and(|p| p.same(&pick)))
        });
        if let Some(Err(why)) = self.run_edit(|r, d| r.pick(d, value, had), cx) {
            self.say(why, cx);
        }
    }

    pub fn clear_target(&mut self, cx: &mut Context<Self>) {
        if let Some(Err(why)) = self.run_edit(|r, d| r.clear(d), cx) {
            self.say(why, cx);
        }
    }

    /// OK records what the tool did as one undo step, Cancel puts the document back. OK waits for the needed targets.
    pub fn finish(&mut self, ok: bool, cx: &mut Context<Self>) {
        match self.run_edit(|r, d| r.finish(d, ok), cx) {
            None => return,
            Some(Err(why)) => return self.say(why, cx),
            Some(Ok(Some((before, label)))) => self.undo.record(before, None, Some(label)),
            Some(Ok(None)) => {}
        }
        self.tool = None;
        self.hover = None;
        self.show_built();
        cx.notify();
    }

    /// The targets of the running feature on the current build, to light while picking: the armed field's and the
    /// needed ones already filled.
    pub(super) fn arm_picks(&self) -> Vec<Pick> {
        let (Some(tool), Some(doc)) = (self.tool.as_ref(), self.doc()) else { return Vec::new() };
        let Some(arm) = tool.arm else { return Vec::new() };
        let mut fields: Vec<&str> = tool.need.iter().map(|t| t.field).collect();
        if !fields.contains(&arm.field) {
            fields.push(arm.field);
        }
        fields
            .into_iter()
            .flat_map(|f| tools::entries(doc, &tool.feature, f))
            .filter_map(|e| resolve(&self.scene, self.picking.lines(), &e))
            .collect()
    }

    /// The edges of the armed pick, by scene body and edge index.
    pub(super) fn arm_edges(&self) -> Vec<(usize, usize)> {
        self.arm_picks()
            .iter()
            .filter_map(|p| match p {
                Pick::Edge { body, edge, .. } => Some((self.scene.body_index(body)?, *edge as usize)),
                _ => None,
            })
            .collect()
    }
}
