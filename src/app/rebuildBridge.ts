import { toast } from "../ui/toast";
import { logError } from "../ui/logStore";
import { featureMeta } from "../ui/featureMeta";
import { repairableDiagFor } from "../features/repickReference";
import { contributedPaint, onContribChange } from "../plugins/contrib";
import { importedFacePaint } from "../document/faceColors";
import { faceMaterialFinishes, faceMaterialPaint, resolveFaceMaterials } from "../document/faceMaterials";
import type { Engine } from "./engine";
import { setPreviewError } from "../ui/previewError";

/** Rebuild pipeline -> viewport. The one place a build result becomes pixels. */
export function installRebuildBridge(e: Engine): void {
  // Whether the camera still owes the model a frame. Cleared by whichever path
  // performs the fit, a progressive load fits from the manifest's bbox on its
  // FIRST frame, so the camera settles before any geometry exists and never moves
  // again while chunks land.
  let pendingFit = true;

  // Colour a plugin has put on the model, asked for fresh at every point the
  // model changes.
  //
  // This used to be two functions here that read the document's palette, walked
  // each body's slot assignment and each body's per-face texture slots, and
  // returned nothing at all when a capability was switched off. All of that
  // knowledge, what a palette is, what a slot means, which capability decides
  // whether any of it counts, was in the render bridge, which is the one place
  // in the app whose job is turning a build result into pixels.
  //
  // What is left is the shape of the answer: a body id may have a colour, a
  // global face index may have a colour, and whoever knows why says so. With
  // nothing contributed both maps are empty, which is exactly what the model
  // looked like with the capability off, arrived at by there being no answer
  // rather than by a check that suppressed one.
  //
  // The document's own materials sit UNDER that: a material is what a body is
  // made of, a contribution is what a capability has decided to paint on top,
  // and the one capability that paints today is the filament palette, whose
  // slots are a deliberate choice about a real print. A material is usually
  // whatever an imported file said, so it loses.
  const paint = () => {
    const c = contributedPaint();
    const bodies = { ...e.store.materialPaint(), ...c.bodies };
    // The materials dropped on individual FACES, resolved against the model
    // that is actually on screen: an assignment naming a body that is gone, or
    // a face past the end of a body that got simpler, is dropped here rather
    // than defended against in the renderer (see document/faceMaterials.ts).
    const onFaces = resolveFaceMaterials(
      e.store.faceMaterialEntries(),
      e.store.buildState.result?.bodies,
      e.store.materialLibrary,
    );
    return {
      bodies,
      // The finish half of those face materials. Colour goes in `faces` below
      // with everything else that paints a face, because a face can only be one
      // colour; a finish has nowhere else to come from, so it travels alone.
      faceFinish: faceMaterialFinishes(onFaces),
      // A face can only be one colour, so the two sources of per-face colour are
      // ordered rather than merged: a texture inlay is something the user put
      // there in THIS document and wins over what an imported file said the
      // face was. Import colours are sparse against `bodies` (see
      // importedFacePaint), so an assembly whose parts are each one colour adds
      // nothing here at all.
      faces: {
        ...importedFacePaint(e.store.buildState.result?.bodies, bodies),
        // A material somebody dropped on this face beats what the file said it
        // was, for the same reason a texture inlay does: it was chosen here.
        ...faceMaterialPaint(onFaces),
        ...c.faces,
      },
    };
  };

  // Starting or stopping a capability has to repaint what is already on screen.
  // Both setters are no-ops when the map has not changed, so this costs nothing
  // when the change was somebody else's; without it the colours would hang about
  // until the next rebuild, which on a finished model is never.
  onContribChange(() => {
    const p = paint();
    e.viewport.setBodyPaint(p.bodies);
    e.viewport.setFacePaint(p.faces);
    e.viewport.setFaceFinish(p.faceFinish);
    e.viewport.requestRender();
  });

  // Failed-commit visibility: a feature that errors in the rebuild leaves the
  // model looking UNCHANGED (its body keeps the old mesh), so without an active
  // notification the only signal is the small status line, "nothing happened".
  // Diff each completed build's failing-feature set against the previous one and
  // toast every NEW failure; if it's the feature the user JUST committed from an
  // interactive tool, select it immediately (red chip scrolls into view).
  let prevErrorIds = new Set<string>();
  // Failed fillet/chamfer edges (midpoints per feature id), survives sidecar
  // cache-hit rebuilds that re-emit the error without its diagnostics.
  const failedEdgeMids = new Map<string, [number, number, number][]>();
  let lastCommittedId: string | null = null;
  e.noteCommitted = (id: string | null) => {
    if (id) lastCommittedId = id;
  };

  // --- progressive display -------------------------------------------------
  // The ONLY subscriber to the chunk channel. A chunked reply reaches the viewport
  // here and nowhere else: store.buildState.result keeps pointing at the PREVIOUS
  // document for the whole stream, so export, the browser tree, and every feature
  // that bakes body ids into the document are structurally unable to see a partial
  // model. The completed build below is still what makes it official.
  e.store.onBuildChunk((c) => {
    if (c.phase === "begin") {
      const hidden = c.manifest.filter((b) => !e.store.isBodyVisible(b.id)).map((b) => b.id);
      // Push the colours BEFORE the first body lands, so streamed bodies arrive
      // already wearing the one they were assigned instead of popping from grey
      // when the build commits.
      e.viewport.setBodyPaint(paint().bodies);
      e.viewport.setBodyFinish(e.store.materialFinishes());
      e.viewport.beginProgressiveModel(c.epoch, c.manifest, c.result, c.bbox, hidden, pendingFit);
      pendingFit = false;
      return;
    }
    const hidden = c.bodies.filter((b) => !e.store.isBodyVisible(b.id)).map((b) => b.id);
    e.viewport.appendProgressiveBodies(c.epoch, c.result, c.bodies, c.edgesByBody, c.triRange, hidden);
  });
  e.store.onBuildAbort(() => e.viewport.abortProgressiveModel());

  e.store.onBuild((s) => {
    // Only render COMPLETED builds. A `building` tick carries the previous result
    // (the new geometry isn't ready yet); re-rendering it would momentarily revert an
    // in-progress ghost (a committed Move/Press-Pull) to the old placement until the
    // real rebuild lands. Skipping it keeps the ghost on screen seamlessly.
    if (s.result && !s.building) {
      if (s.result.mesh.positions.length > 0) {
        // hide the faces AND wireframe of any body the user toggled off (filtered
        // in the render, no sidecar rebuild, setBodyVisibility re-emits the build).
        const hidden = (s.result.bodies ?? [])
          .filter((b) => !e.store.isBodyVisible(b.id))
          .map((b) => b.id);
        e.viewport.setModel(s.result, pendingFit, hidden);
        pendingFit = false;
        const p = paint();
        e.viewport.setBodyPaint(p.bodies); // per-body colours
        e.viewport.setFacePaint(p.faces); // + per-face inlay colours
        e.viewport.setFaceFinish(p.faceFinish); // + a material dropped on one face
        e.viewport.setBodyFinish(e.store.materialFinishes()); // + how each is finished
      } else {
        e.viewport.clearModel();
      }
      // Re-split the committed profiles against the model that just landed.
      //
      // A profile drawn across the edge of its face picks as two areas, and the
      // boundary between them comes from the model (sketch/faceFootprint.ts).
      // The overlay is otherwise rebuilt from onDocChange, which fires BEFORE the
      // build it triggered, so it split against the previous model, and on a
      // freshly opened document against no model at all. Every profile there came
      // out whole, which is the one state in which the split cannot be seen to be
      // missing: it looks exactly like a profile that does not cross anything.
      //
      // Gated on there being regions to re-split, so a document with no sketch
      // shown pays nothing; on the sketch editor being closed, which owns its own
      // profiles while it is open; and on no tool running, because a tool holds
      // the WorldRegion objects it was armed with and rebuilding them underneath
      // it would leave it dragging a profile that no longer exists.
      if (!e.sketch.active && !e.toolBusy() && e.overlay.regions.length) {
        e.overlay.update(e.store.document);
      }
      // Failed-edge red paint (fillet/chamfer edgeOpFailed diagnostics). Runs for
      // BOTH committed and preview builds (a just-toggled bad edge should turn
      // red live), unlike the toast gate below. The sidecar's prefix cache
      // re-emits errors but NOT diagnostics on cache-hit resumes, so failed mids
      // are cached per feature here and dropped only when the feature's error
      // clears from featureErrors (content-keyed caching guarantees the cached
      // mids stay valid exactly as long as the failing feature is unchanged).
      {
        const errIds = new Set(
          (s.result.featureErrors ?? []).map((x) => x.feature_id).filter(Boolean) as string[],
        );
        for (const d of s.result.diagnostics ?? []) {
          if (d.kind === "edgeOpFailed" && d.feature_id && d.failed?.length) {
            failedEdgeMids.set(d.feature_id, d.failed.map((x) => x.mid));
          }
        }
        for (const id of [...failedEdgeMids.keys()]) {
          if (!errIds.has(id)) failedEdgeMids.delete(id);
        }
        e.viewport.setErrorEdgeMids([...failedEdgeMids.values()].flat());
      }
      // toast NEW feature errors (skip preview builds, they carry a transient
      // un-committed feature whose failures resolve on commit/cancel)
      if (!e.store.hasPreview) {
        const errs = s.result.featureErrors ?? [];
        const ids = new Set(errs.map((x) => x.feature_id).filter(Boolean) as string[]);
        for (const err of errs) {
          if (!err.feature_id || prevErrorIds.has(err.feature_id)) continue;
          const f = e.store.document.features.find((x) => x.id === err.feature_id);
          const label = f ? featureMeta(f).label : err.feature_id;
          const id = err.feature_id;
          // An ambiguous saved reference is the one failure the user can actually
          // fix from here, so offer the repair instead of a bare "Show". These are
          // old files whose stored point identifies no single face, without this
          // the toast is a dead end.
          const amb = repairableDiagFor(s.result?.diagnostics, id);
          const action = amb?.at
            ? { label: "Re-pick face", onClick: () => e.starters.repickReference(id, amb.at!) }
            : { label: "Show", onClick: () => e.selectFeature(id) };
          // Logged with the FEATURE beside it, not just the sentence. A kernel
          // refusal is usually about the geometry it was handed, so the message
          // alone leaves out half the evidence, and the toast that carries the
          // message is clipped and gone in eight seconds either way.
          logError(`${label} failed: ${err.message}`, {
            source: id,
            detail: f ? JSON.stringify(f, null, 2) : undefined,
          });
          toast(`${label} failed: ${err.message}`, { kind: "error", action });
          if (id === lastCommittedId) e.selectFeature(id);
        }
        prevErrorIds = ids;
        lastCommittedId = null;
      }
    }
    e.syncDatumPlanes();
    // The one writer of the preview-refusal channel. It sits beside the toast
    // gate above rather than inside it: that gate SUPPRESSES a preview's
    // failures, deliberately, because a drag through a bad range would emit a
    // toast a frame. Suppressing them left the user with nothing at all, which
    // is what this carries to the box they are actually typing in.
    const refused = e.store.previewError;
    setPreviewError(refused);
    // The other half of the same statement: the box says what is wrong, and the
    // model stops presenting a shape nobody asked for as though it were the
    // answer. Kept together so the two can never disagree about whether the
    // value on screen builds.
    e.viewport.setStaleModel(refused !== null);
    if (s.errorMessage) {
      e.setStatus(`${s.errorFeatureId ?? ""}: ${s.errorMessage}`, "error");
    } else if (!s.building) {
      e.setStatus("ready", "connected");
    }
  });
}
