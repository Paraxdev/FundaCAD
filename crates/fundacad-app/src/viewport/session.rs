//! A running tool: the document it started from, the feature it previews, and the target field a click in the view
//! picks into. Its edits are not undo steps until OK records them as one.

use fundacad_client::Doc;
use gpui::*;

use super::Viewport;
use crate::selection::{Pick, PickKind};
use crate::tools;

#[derive(Clone, Debug, PartialEq)]
pub struct Arm {
    pub feature: String,
    pub field: &'static str,
    pub kind: PickKind,
    /// A field holding a list, a click adds or drops, else a click replaces.
    pub many: bool,
}

pub struct ToolRun {
    pub before: Doc,
    /// The card's heading, "Fillet".
    pub title: String,
    /// The undo step OK records, "Add Fillet 3".
    pub label: String,
    /// The feature the card shows the rows of.
    pub feature: String,
    pub arm: Option<Arm>,
    /// What was picked into the armed field, to light it.
    pub picks: Vec<Pick>,
}

impl Viewport {
    pub fn running(&self) -> Option<&ToolRun> {
        self.tool.as_ref()
    }

    pub(super) fn arm(&self) -> Option<&Arm> {
        self.tool.as_ref()?.arm.as_ref()
    }

    /// Starts a tool on `feature` after `f` edits the document, which may add it. Refused while another runs.
    pub fn begin_tool(
        &mut self,
        title: String,
        label: String,
        feature: String,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.tool.is_some() {
            return Err("finish the tool that is running first".into());
        }
        if self.push.as_ref().is_some_and(|p| !p.released) {
            return Err("a face is being pushed".into());
        }
        let session = self.session.as_mut().ok_or("no document is open")?;
        let before = session.doc.clone();
        session.edit(f)?;
        self.changes += 1;
        self.undo.close();
        self.tool = Some(ToolRun { before, title, label, feature, arm: None, picks: Vec::new() });
        self.hover = None;
        cx.notify();
        Ok(())
    }

    /// Arms a target field, or disarms with None. The feature is left out of the build while armed, so a click lands
    /// on the model it applies to.
    pub fn set_arm(&mut self, arm: Option<Arm>, cx: &mut Context<Self>) {
        let Some(tool) = &mut self.tool else { return };
        if tool.arm == arm {
            return;
        }
        let id = tool.feature.clone();
        let on = arm.is_some();
        tool.arm = arm;
        tool.picks.clear();
        self.picking.revision += 1;
        if let Some(session) = &mut self.session {
            match session.edit(move |d| tools::set_suppressed(d, &id, on)) {
                Ok(Some(_)) => self.changes += 1,
                Ok(None) => {}
                Err(e) => self.message = Some(e),
            }
        }
        cx.notify();
    }

    pub(super) fn pick_target(&mut self, arm: &Arm, pick: Pick, cx: &mut Context<Self>) {
        let Some(tool) = &mut self.tool else { return };
        let had = tool.picks.iter().position(|q| q.same(&pick));
        let (value, drop) = match had {
            Some(i) => (tools::entry(&tool.picks.remove(i)), true),
            None => {
                if !arm.many {
                    tool.picks.clear();
                }
                tool.picks.push(pick.clone());
                (tools::entry(&pick), false)
            }
        };
        self.picking.revision += 1;
        let (Some(value), Some(session)) = (value, &mut self.session) else { return };
        let (id, field, many) = (arm.feature.clone(), arm.field, arm.many);
        match session.edit(move |d| tools::set_target(d, &id, field, value.clone(), many, drop)) {
            Ok(Some(_)) => self.changes += 1,
            Ok(None) => {}
            Err(e) => self.said = Some(e),
        }
        cx.notify();
    }

    /// OK records what the tool did as one undo step, Cancel puts the document back.
    pub fn finish(&mut self, ok: bool, cx: &mut Context<Self>) {
        let Some(tool) = self.tool.take() else { return };
        self.picking.revision += 1;
        let Some(session) = &mut self.session else { return };
        let (id, before) = (tool.feature.clone(), tool.before.clone());
        let done = match ok {
            true => session.edit(move |d| tools::set_suppressed(d, &id, false)),
            false => session.edit(move |d| {
                d.clone_from(&before);
                Ok(())
            }),
        };
        if let Err(e) = done {
            self.message = Some(e);
        }
        self.changes += 1;
        if ok && session.doc != tool.before {
            self.undo.record(tool.before, None, Some(tool.label));
        }
        self.hover = None;
        self.show_built();
        cx.notify();
    }

    /// The edges of the armed pick, by scene body and edge index, to light them.
    pub(super) fn arm_edges(&self) -> Vec<(usize, usize)> {
        let Some(tool) = &self.tool else { return Vec::new() };
        let mut out = Vec::new();
        for p in &tool.picks {
            let Pick::Edge { body, edge, .. } = p else { continue };
            if let Some(bi) = self.scene.body_index(body) {
                out.push((bi, *edge as usize));
            }
        }
        out
    }

    /// The faces of the armed pick, for the tint.
    pub(super) fn arm_picks(&self) -> &[Pick] {
        self.tool.as_ref().map_or(&[], |t| t.picks.as_slice())
    }
}

