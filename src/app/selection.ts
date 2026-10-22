import { setPrompt } from "../ui/prompt";
import { asFeature } from "../types";
import { contributedFeature } from "../plugins/contrib";
import { useSelectionStore } from "../stores/selection";
import type { Engine } from "./engine";
import type { Feature } from "../types";
import type { DatumPose } from "../document/datumPose";
import { startDatumPoseEdit } from "../features/datumPlaneEdit";
import { cancelActiveTools } from "./toolBusy";
import { typedDimBox } from "../sketch/dimInput";

/** Said when a feature's value cannot be dragged and has to be typed. One
 *  constant because three feature types say it and they used to say three
 *  slightly different things, all of them naming a docked panel that no longer
 *  exists, the values moved under the history entry that names the operation
 *  they belong to. */
const VALUES_IN_HISTORY = "Not draggable, edit the value under this feature in the history";

/** Why a feature cannot be edited right now, or null when it can. */
function whyNotEditable(e: Engine, id: string): string | null {
  if (e.store.isSuppressed(id)) return "Unsuppress the feature to edit it";
  if (e.store.buildState.result?.skippedFeatures?.some((s) => s.feature_id === id)) {
    return "This version of FundaCAD cannot edit this feature";
  }
  const idx = e.store.document.features.findIndex((x) => x.id === id);
  if (idx >= e.store.rollbackIndex) return "Roll the timeline forward to edit this feature";
  return null;
}

/** Close the edit another feature has open, the way switching to a new one does:
 *  a sketch is committed, a feature tool is stood down. Keyed on the tools, not
 *  on the edit preview, which an untouched edit has not begun yet and a dragged
 *  datum or mechanism keeps in place. A value typed in the heads-up box and not
 *  entered is entered first; when the box refuses it, or the tool is still open
 *  after it, the edit stays and the status line says why. Nothing happens while
 *  no edit is open, the open one is `except` itself, or `except` could not be
 *  edited anyway. */
export function closeOpenEdit(e: Engine, except: string): void {
  if (whyNotEditable(e, except)) return;
  if (e.sketch.active) {
    if (e.sketch.editingSketchId !== except) e.sketch.finish(true);
    return;
  }
  if (!e.toolAtWork()) return;
  if ((e.store.editPreviewId ?? e.selectedFeature) === except) return;
  const typed = typedDimBox();
  if (typed) {
    if (!typed.confirm()) e.setStatus("Fix the value being typed or press Esc, then edit the other feature", "");
    else if (e.toolAtWork()) e.setStatus("Finish this edit, then edit the other feature", "");
    return;
  }
  cancelActiveTools(e.tools);
}

/** A double click on a feature row: close the open edit, then edit that feature. */
export function switchEdit(e: Engine, id: string): void {
  closeOpenEdit(e, id);
  if (e.toolOwnsScreen()) return;
  e.editFeature(id);
}

export function createSelection(
  e: Engine,
): Pick<Engine, "selectFeature" | "editFeature" | "featureForFace" | "deleteSelectedFace"> {
  // `selectedFeature` has to be defined here, not returned with the rest: the
  // engine installs these with Object.assign, which COPIES a getter's current
  // value instead of the getter. It was a plain `e.selectedFeature = null` in
  // createEngine and nothing ever wrote it again, so every non-Vue reader saw a
  // permanent null, Delete on a selected feature, and Edit ▸ Delete/Suppress,
  // all silently did nothing.
  Object.defineProperty(e, "selectedFeature", {
    get: () => useSelectionStore().featureId,
    enumerable: true,
    configurable: true, // tests re-install onto the same object
  });

  Object.defineProperty(e, "selectedFeatureExplicit", {
    get: () => useSelectionStore().featureExplicit,
    enumerable: true,
    configurable: true,
  });

  const selectFeature = (id: string | null, explicit = true) => {
    // Writing the store is what opens the feature's values in the history AND
    // marks it in the browser tree, both render from it rather than being
    // pushed at.
    useSelectionStore().featureId = id;
    useSelectionStore().featureExplicit = explicit;
    e.viewport.highlightDatum(id); // brighten the matching construction plane (if any)
  };

  // The feature that created a face, from the per-face `faceOwners` the engine
  // attaches to each body in the build result. A double click edits it.
  const featureForFace = (faceId: number): string | null => {
    for (const b of e.store.buildState.result?.bodies ?? []) {
      if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) {
        return b.faceOwners?.[faceId - b.faceStart] ?? null;
      }
    }
    return null;
  };

  // Remove the currently-selected face(s) and heal the solid (defeature). Returns
  // false when no face is selected (so the caller can fall back to feature-delete).
  const deleteSelectedFace = (): boolean => {
    const fsel = e.viewport.selectedFacesForPressPull();
    if (!fsel) return false;
    e.store.addFeature({
      id: e.store.nextId(),
      type: "deleteFace",
      face: fsel.selectors.length === 1 ? fsel.selectors[0] : fsel.selectors,
      ...(fsel.bodyId ? { body: fsel.bodyId } : {}),
    } as Feature);
    e.viewport.clearSelection();
    e.setStatus("Deleting face…", ""); // real outcome (healed, or an error) comes from the rebuild
    setPrompt(null);
    return true;
  };

  const editFeature = (id: string) => {
    selectFeature(id);
    e.dropBodyGizmo(); // a body selection raises it by itself, see Engine.dropBodyGizmo
    if (e.toolBusy()) return; // never open a second interactive tool on top of one
    const f = e.store.document.features.find((x) => x.id === id);
    if (!f) return;
    const refusal = whyNotEditable(e, id);
    if (refusal) {
      e.setStatus(refusal, "");
      return;
    }
    const done = (cid: string | null) => {
      e.noteCommitted(cid);
      if (cid) selectFeature(cid);
    };
    switch (f.type) {
      case "sketch": {
        const sk = asFeature(f, "sketch")!;
        // The plane the last build actually used, not the feature's cache. For a
        // sketch that follows a face those differ the moment anything upstream
        // moves, and reopening at the cache would re-bake it into the feature on
        // the next commit and silently undo the follow. An unfollowed sketch has
        // no entry and reads its own plane, as before.
        e.sketch.enter(e.store.buildState.result?.sketchPlanes?.[id] ?? sk.plane, e.store, id);
        break;
      }
      case "fillet":
      case "chamfer":
        // false = not tool-editable (parameter value / structural selectors).
        // selectFeature above has already opened this feature's values in the
        // history, which is where such a value is changed.
        if (!e.tools.edgeFeature.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "extrude":
        if (!e.tools.extrude.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "revolve":
        // The arrow sets the PITCH, which is the one value on a revolve that
        // is a distance on the model rather than a number about it. It stands
        // down for a revolve whose profile was never recorded or whose pitch a
        // parameter drives, and those fall through to the rows as before.
        if (!e.tools.revolvePitch.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "hole":
        if (!e.tools.hole.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "datumPlane": {
        const deps = {
          store: e.store,
          tool: e.tools.datumPose,
          sourceOf: (d: Extract<Feature, { type: "datumPlane" }>) => e.datumSourceOf(d),
          previewPose: (pid: string, p: DatumPose | null) => e.previewDatumPose(pid, p),
        };
        if (!startDatumPoseEdit(deps, id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      }
      case "joint":
        // The arrow slides the joined body along the mate axis (its offset). It
        // stands down when a parameter drives the offset or the engine could not
        // place the axis this build, and those fall through to the rows.
        if (!e.tools.joint.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "mechanism":
        // The drive's arrow (a slider) or dial (a revolute) on the drive joint's
        // axis. It stands down without a drive, when an expression drives the
        // value, or when the engine could not solve the linkage this build.
        if (!e.tools.mechanism.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      default:
        // A feature type the app has no tool for may still have one: a plugin
        // that contributes a tool contributes how to REOPEN what the tool made,
        // and double-clicking its feature has to land in the same place
        // double-clicking a fillet does. Asked last, so nothing here can be
        // taken over by a plugin claiming a type the app already handles.
        //
        // The same false means the same thing it means above, a parameter
        // drives one of the values, so the rows in the history are where it is
        // changed, and the same status line says so.
        {
          const edit = contributedFeature(f.type)?.edit;
          if (edit && !edit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        }
        break; // the values under the history entry (selectFeature above) are the
      // edit surface for the rest
    }
  };

  return { selectFeature, editFeature, featureForFace, deleteSelectedFace };
}
