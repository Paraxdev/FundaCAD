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

const VALUES_IN_HISTORY = "Not draggable, edit the value under this feature in the history";

function whyNotEditable(e: Engine, id: string): string | null {
  if (e.store.isSuppressed(id)) return "Unsuppress the feature to edit it";
  if (e.store.buildState.result?.skippedFeatures?.some((s) => s.feature_id === id)) {
    return "This version of FundaCAD cannot edit this feature";
  }
  const idx = e.store.document.features.findIndex((x) => x.id === id);
  if (idx >= e.store.rollbackIndex) return "Roll the timeline forward to edit this feature";
  return null;
}

/** Keyed on the tools, not the edit preview, which an untouched edit has not begun and a dragged datum keeps. A value
 *  typed in the heads up box is entered first; if refused or the tool stays open, the status line says why. */
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

export function switchEdit(e: Engine, id: string): void {
  closeOpenEdit(e, id);
  if (e.toolOwnsScreen()) return;
  e.editFeature(id);
}

export function createSelection(
  e: Engine,
): Pick<Engine, "selectFeature" | "editFeature" | "featureForFace" | "deleteSelectedFace"> {
  // Defined here, not returned: the engine installs the rest with Object.assign, which copies a getter's value.
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
    useSelectionStore().featureId = id;
    useSelectionStore().featureExplicit = explicit;
    e.viewport.highlightDatum(id);
  };

  const featureForFace = (faceId: number): string | null => {
    for (const b of e.store.buildState.result?.bodies ?? []) {
      if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) {
        return b.faceOwners?.[faceId - b.faceStart] ?? null;
      }
    }
    return null;
  };

  // Removes the selected faces and heals the solid; false when none is selected.
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
    e.setStatus("Deleting face…", "");
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
        // The plane the last build used, not the cache: reopening at the cache would bake it in and undo the follow.
        e.sketch.enter(e.store.buildState.result?.sketchPlanes?.[id] ?? sk.plane, e.store, id);
        break;
      }
      case "fillet":
      case "chamfer":
        // false: not tool editable, and selectFeature has already opened its values in the history.
        if (!e.tools.edgeFeature.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "extrude":
        if (!e.tools.extrude.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "revolve":
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
        if (!e.tools.joint.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      case "mechanism":
        if (!e.tools.mechanism.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      default:
        // Asked last, so a plugin cannot take over a type the app already handles.
        {
          const edit = contributedFeature(f.type)?.edit;
          if (edit && !edit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        }
        break;
    }
  };

  return { selectFeature, editFeature, featureForFace, deleteSelectedFace };
}
