import { setPrompt } from "../ui/prompt";
import { useSelectionStore } from "../stores/selection";
import type { Engine } from "./engine";
import type { Feature } from "../types";

/** Said when a feature's value cannot be dragged and has to be typed. One
 *  constant because three feature types say it and they used to say three
 *  slightly different things, all of them naming a docked panel that no longer
 *  exists — the values moved under the history entry that names the operation
 *  they belong to. */
const VALUES_IN_HISTORY = "Not draggable, edit the value under this feature in the history";

export function createSelection(
  e: Engine,
): Pick<Engine, "selectFeature" | "editFeature" | "featureForFace" | "deleteSelectedFace"> {
  // `selectedFeature` has to be defined here, not returned with the rest: the
  // engine installs these with Object.assign, which COPIES a getter's current
  // value instead of the getter. It was a plain `e.selectedFeature = null` in
  // createEngine and nothing ever wrote it again, so every non-Vue reader saw a
  // permanent null — Delete on a selected feature, and Edit ▸ Delete/Suppress,
  // all silently did nothing.
  Object.defineProperty(e, "selectedFeature", {
    get: () => useSelectionStore().featureId,
    enumerable: true,
    configurable: true, // tests re-install onto the same object
  });

  const selectFeature = (id: string | null) => {
    // Writing the store is what opens the feature's values in the history AND
    // marks it in the browser tree — both render from it rather than being
    // pushed at.
    useSelectionStore().featureId = id;
    e.viewport.highlightDatum(id); // brighten the matching construction plane (if any)
  };

  // Click a model FACE → select the feature that created it, so Del deletes that
  // feature (and the timeline/params show which one owns the face). Provenance is the
  // per-face `faceOwners` the sidecar attaches to each body in the build result.
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
    if (e.toolBusy()) return; // never open a second interactive tool on top of one
    const f = e.store.document.features.find((x) => x.id === id);
    if (!f) return;
    if (e.store.isSuppressed(id)) {
      e.setStatus("Unsuppress the feature to edit it", "");
      return;
    }
    const idx = e.store.document.features.findIndex((x) => x.id === id);
    if (idx >= e.store.rollbackIndex) {
      e.setStatus("Roll the timeline forward to edit this feature", "");
      return;
    }
    const done = (cid: string | null) => {
      e.noteCommitted(cid);
      if (cid) selectFeature(cid);
    };
    switch (f.type) {
      case "sketch":
        // The plane the last build actually used, not the feature's cache. For a
        // sketch that follows a face those differ the moment anything upstream
        // moves, and reopening at the cache would re-bake it into the feature on
        // the next commit and silently undo the follow. An unfollowed sketch has
        // no entry and reads its own plane, as before.
        e.sketch.enter(e.store.buildState.result?.sketchPlanes?.[id] ?? f.plane, e.store, id);
        break;
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
      case "texture":
        if (!e.tools.texture.startEdit(id, done)) e.setStatus(VALUES_IN_HISTORY, "");
        break;
      default:
        break; // the values under the history entry (selectFeature above) are the
               // edit surface for the rest
    }
  };

  return { selectFeature, editFeature, featureForFace, deleteSelectedFace };
}
