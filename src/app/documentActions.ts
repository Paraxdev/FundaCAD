import { openDocument, openDocumentAtPath, type OpenOutcome } from "../io/files";
import { choose } from "../ui/choice";
import type { Engine } from "./engine";
import { TEMPLATES, templateText } from "../templates";
import { copyName } from "../ui/homeVersions";

/** An open sketch's edits reach the store only when the sketch is finished, so
 *  `store.dirty` alone misses them. */
export function hasUnsavedWork(e: Pick<Engine, "store" | "sketch">): boolean {
  return e.store.dirty || e.sketch.hasUncommittedEdits;
}

/** Whether the user lets unsaved work go, asked only when there is some. */
export async function mayDiscard(e: Pick<Engine, "store" | "sketch">, question: string): Promise<boolean> {
  if (!hasUnsavedWork(e)) return true;
  const pick = await choose(question, [
    { value: "discard", label: "Discard", hint: "lose the unsaved changes" },
    { value: "cancel", label: "Cancel" },
  ]);
  return pick === "discard";
}

export async function openPathGuarded(
  e: Pick<Engine, "store" | "sketch" | "geometry">,
  path: string,
): Promise<OpenOutcome | "cancelled"> {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (!(await mayDiscard(e, `Discard unsaved changes and open ${name}?`))) return "cancelled";
  return openDocumentAtPath(e.store, path, e.geometry);
}

/** Save then asks where to keep it, so the template itself is never written. */
export async function newFromTemplate(e: Pick<Engine, "store" | "sketch">, id: string): Promise<void> {
  const info = TEMPLATES.find((t) => t.id === id);
  if (!info) return;
  if (!(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return;
  e.store.load(await templateText(id));
  e.store.markOpenedWithoutPath(info.name);
}

type VersionEngine = Pick<Engine, "store" | "sketch" | "geometry" | "toolAtWork" | "setStatus">;

/** A version or branch loads in place, which ends no sketch or tool the way an
 *  open does, so one still at work on the open document holds it back. */
function heldBack(e: VersionEngine, path: string): boolean {
  if (e.store.filePath !== path || !e.toolAtWork()) return false;
  e.setStatus("Finish the sketch or tool first, then try again", "");
  return true;
}

/** The document at `path` on screen: the open one as it is, unsaved versions and
 *  all, or opened from disk after the usual question. */
async function reach(e: VersionEngine, path: string): Promise<boolean> {
  if (e.store.filePath === path) return true;
  return (await openPathGuarded(e, path)) === "ok";
}

/** Brings a version back as one undo step, the file is unchanged until Save. A copy
 *  also drops the path, so Save asks where and the original stays as it is. */
export async function openAtVersion(e: VersionEngine, path: string, id: string, copy: boolean): Promise<boolean> {
  if (heldBack(e, path)) return false;
  if (copy && e.store.filePath === path && !(await mayDiscard(e, "Discard unsaved changes and open a copy?"))) {
    return false;
  }
  if (!(await reach(e, path))) return false;
  const v = e.store.versionRepo?.versions.find((x) => x.id === id);
  if (!v) return false;
  e.store.restoreVersion(id);
  if (copy) e.store.markOpenedWithoutPath(copyName(path, v.message));
  return true;
}

/** Opening on the branch the file is already on keeps its saved state, which may be newer than the branch's last version. */
export async function openOnBranch(e: VersionEngine, path: string, name: string): Promise<boolean> {
  if (heldBack(e, path)) return false;
  if (!(await reach(e, path))) return false;
  const repo = e.store.versionRepo;
  if (!repo?.branches[name]) return false;
  if (repo.current !== name) e.store.switchVersionBranch(name);
  return true;
}

export function createDocumentActions(
  e: Engine,
): Pick<Engine, "newDocument" | "openDoc" | "doUndo" | "doRedo"> {
  return {
    async newDocument() {
      if (!(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return;
      e.store.newDocument();
      e.viewport.resetCamera(false);
    },

    async openDoc() {
      await openDocument(e.store, e.geometry, () => mayDiscard(e, "Discard unsaved changes and open another document?"));
    },

    // Undo/redo routing: while a sketch is OPEN its geometry lives in SketchMode and
    // is not in the document yet, so store.undo() can only reach the whole sketch,
    // which is why Ctrl+Z used to vaporise it. Hand the request to the sketch, which
    // swallows it whenever it is active (an empty sketch history says so rather than
    // falling through and eating the sketch).
    // The Move gizmo is put away first, and with it a re-open still waiting for
    // a drag's rebuild: left armed, that re-open landed on the undone model and
    // took focus into its field (FI-2).
    doUndo() { e.tools.move.cancel(); if (!e.sketch.undoEdit()) e.store.undo(); },
    doRedo() { e.tools.move.cancel(); if (!e.sketch.redoEdit()) e.store.redo(); },
  };
}
