import { toast } from "../ui/toast";
import { featureFailureReport } from "../ui/errorReport";
import { featureMeta } from "../ui/featureMeta";
import { repairableDiagFor } from "../features/repickReference";
import { contributedPaint, contributedRelief, onContribChange } from "../plugins/contrib";
import { importedBodyColors, importedFacePaint } from "../document/faceColors";
import { faceMaterialFinishes, faceMaterialPaint, resolveFaceMaterials } from "../document/faceMaterials";
import type { Engine } from "./engine";
import { setPreviewError } from "../ui/previewError";
import { markDrawn } from "../diagnostics/rebuildTiming";

/** The one place a build result becomes pixels. */
export function installRebuildBridge(e: Engine): void {
  // A progressive load fits from the manifest's bbox on its first frame, so the camera never moves while chunks land.
  let pendingFit = true;
  // New homes the camera for a 20 mm part, so an import into an empty view is fitted too.
  let viewEmpty = true;
  e.store.onOpen(() => (viewEmpty = true));
  // A fit asked for a document whose model never landed is not the next one's; an opener asks again after the begin.
  e.store.sessions.onBegin(() => (pendingFit = false));
  const fitNow = () => pendingFit || (viewEmpty && e.store.document.features.some((f) => f.type === "import"));

  // Plugin paint wins over the document's materials, which usually just repeat what an imported file said.
  const paint = () => {
    const c = contributedPaint();
    const bodies = { ...e.store.materialPaint(), ...c.bodies };
    // Resolved against the model on screen, so stale face assignments drop here rather than in the renderer.
    const onFaces = resolveFaceMaterials(
      e.store.faceMaterialEntries(),
      e.store.buildState.result?.bodies,
      e.store.materialLibrary,
    );
    return {
      bodies,
      faceFinish: faceMaterialFinishes(onFaces),
      // Later spreads win: what the user chose in this document beats what an imported file said.
      faces: {
        ...importedFacePaint(
          e.store.buildState.result?.bodies,
          bodies,
          importedBodyColors(e.store.buildState.result?.bodies, e.store.document.features, (id) =>
            e.store.importColorSource(id),
          ),
        ),
        ...faceMaterialPaint(onFaces),
        ...c.faces,
      },
    };
  };

  // Otherwise a capability's colours would linger until the next rebuild; the setters skip unchanged maps.
  onContribChange(() => {
    const p = paint();
    e.viewport.setBodyPaint(p.bodies);
    e.viewport.setFacePaint(p.faces);
    e.viewport.setFaceFinish(p.faceFinish);
    e.viewport.setRelief(contributedRelief());
    e.viewport.requestRender();
  });

  // A failed feature leaves the model looking unchanged, so every new failure toasts, and one just committed is selected.
  let prevErrorIds = new Set<string>();
  let prevHiddenFaces = new Set<string>();
  // Survives cache hit rebuilds that re-emit the error without its diagnostics.
  const failedEdgeMids = new Map<string, [number, number, number][]>();
  let lastCommittedId: string | null = null;
  e.noteCommitted = (id: string | null) => {
    if (id) lastCommittedId = id;
  };
  // An example opens framed as a fresh window frames it, wherever the camera was in the document before.
  e.frameNextModel = () => {
    e.viewport.resetCamera(false);
    pendingFit = true;
  };

  // The only chunk subscriber; buildState.result keeps the previous document for the whole stream, so nothing else
  // can see a partial model.
  e.store.onBuildChunk((c) => {
    if (c.phase === "begin") {
      const hidden = c.manifest.filter((b) => !e.store.isBodyVisible(b.id)).map((b) => b.id);
      // Before the first body lands, so streamed bodies do not pop from grey on commit.
      e.viewport.setBodyPaint(paint().bodies);
      e.viewport.setBodyFinish(e.store.materialFinishes());
      e.viewport.setRelief(contributedRelief());
      e.viewport.beginProgressiveModel(c.epoch, c.manifest, c.result, c.bbox, hidden, fitNow());
      pendingFit = viewEmpty = false;
      return;
    }
    const hidden = c.bodies.filter((b) => !e.store.isBodyVisible(b.id)).map((b) => b.id);
    e.viewport.appendProgressiveBodies(c.epoch, c.result, c.bodies, c.edgesByBody, c.triRange, hidden);
  });
  e.store.onBuildAbort(() => e.viewport.abortProgressiveModel());

  e.store.onBuild((s) => {
    // A `building` tick carries the previous result, and drawing it would snap a committed Move ghost back.
    if (s.result && !s.building) {
      if (s.result.mesh.positions.length > 0) {
        const hidden = (s.result.bodies ?? []).filter((b) => !e.store.isBodyVisible(b.id)).map((b) => b.id);
        e.viewport.setModel(s.result, fitNow(), hidden);
        pendingFit = viewEmpty = false;
        const p = paint();
        e.viewport.setBodyPaint(p.bodies);
        e.viewport.setFacePaint(p.faces);
        e.viewport.setFaceFinish(p.faceFinish);
        e.viewport.setBodyFinish(e.store.materialFinishes());
        e.viewport.setRelief(contributedRelief());
        // setModel dropped the Stress panel's face marks with the old face ids.
        e.ui.panels.refreshStressMarks();
      } else {
        e.viewport.clearModel();
        viewEmpty = true;
        e.ui.panels.refreshStressMarks();
      }
      markDrawn();
      // Profiles split along face edges of the model (sketch/faceFootprint.ts), and onDocChange fires before the build.
      // Not while a tool runs: it holds the WorldRegion objects it was armed with.
      if (!e.sketch.active && !e.toolBusy() && e.overlay.regions.length) {
        e.overlay.update(e.store.document);
      }
      // Preview builds too, so a bad edge turns red live. Cache hits re-emit errors without diagnostics, so the mids
      // are kept per feature until its error clears.
      {
        const errIds = new Set((s.result.featureErrors ?? []).map((x) => x.feature_id).filter(Boolean) as string[]);
        for (const d of s.result.diagnostics ?? []) {
          if (d.kind === "edgeOpFailed" && d.feature_id && d.failed?.length) {
            failedEdgeMids.set(
              d.feature_id,
              d.failed.map((x) => x.mid),
            );
          }
        }
        for (const id of [...failedEdgeMids.keys()]) {
          if (!errIds.has(id)) failedEdgeMids.delete(id);
        }
        e.viewport.setErrorEdgeMids([...failedEdgeMids.values()].flat());
      }
      // Not for preview builds, whose failures resolve on commit or cancel.
      if (!e.store.hasPreview) {
        const errs = s.result.featureErrors ?? [];
        const ids = new Set(errs.map((x) => x.feature_id).filter(Boolean) as string[]);
        for (const err of errs) {
          if (!err.feature_id || prevErrorIds.has(err.feature_id)) continue;
          const f = e.store.document.features.find((x) => x.id === err.feature_id);
          const label = f ? featureMeta(f).label : err.feature_id;
          const id = err.feature_id;
          // An ambiguous saved reference is the one failure fixable from here, so offer the repair.
          const amb = repairableDiagFor(s.result?.diagnostics, id);
          const action = amb?.at
            ? {
                label: amb.kind === "edge" ? "Re-pick edge" : "Re-pick face",
                onClick: () => e.starters.repickReference(id, amb.at!, amb.kind),
              }
            : { label: "Show", onClick: () => e.selectFeature(id) };
          const detail = featureFailureReport({
            label,
            message: err.message,
            code: err.code,
            feature: f,
            detail: err.detail,
            diagnostics: (s.result?.diagnostics ?? []).filter((d) => d.feature_id === id),
          });
          toast(`${label} failed: ${err.message}`, { kind: "error", action, detail, source: id });
          if (id === lastCommittedId) e.selectFeature(id, false);
        }
        prevErrorIds = ids;
        lastCommittedId = null;
        const hidden = new Set(e.store.hiddenFaceMaterials());
        const lost = [...hidden].filter((id) => !prevHiddenFaces.has(id)).length;
        prevHiddenFaces = hidden;
        // A rolled back timeline hides later faces on purpose, so it says nothing.
        if (lost && e.store.rollbackIndex >= e.store.document.features.length) {
          toast(
            lost === 1
              ? "A face material lost its face in this rebuild, it shows again if the face comes back"
              : `${lost} face materials lost their faces in this rebuild, they show again if the faces come back`,
            { kind: "warning" },
          );
        }
      }
    }
    e.syncDatumPlanes();
    // Preview failures skip the toast, so the refusal goes to the box being typed in and the model shows stale.
    // A held refusal keeps the last value that built on screen.
    const refused = e.store.previewError;
    setPreviewError(refused);
    e.viewport.setStaleModel(refused !== null && !s.heldRefusal);
  });
}
