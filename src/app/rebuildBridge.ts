import { toast } from "../ui/toast";
import { logError } from "../ui/logStore";
import { featureMeta } from "../ui/featureMeta";
import { ambiguousDiagFor } from "../features/repickReference";
import { multiColorEnabled, onFeatureFlagsChange } from "../ui/featureFlags";
import type { Engine } from "./engine";

/** Rebuild pipeline -> viewport. The one place a build result becomes pixels. */
export function installRebuildBridge(e: Engine): void {
  // Whether the camera still owes the model a frame. Cleared by whichever path
  // performs the fit — a progressive load fits from the manifest's bbox on its
  // FIRST frame, so the camera settles before any geometry exists and never moves
  // again while chunks land.
  let pendingFit = true;

  // Resolve each body's assigned palette slot to a hex color for the viewport.
  //
  // Empty when multi-material is off, which is the whole of what "off" means
  // here: the assignments stay in the document, they are still saved and still
  // exported, and the bodies simply render in the material they would have had
  // if nobody had ever assigned one.
  function computeBodyPaint(bodies = e.store.buildState.result?.bodies): Record<string, string> {
    if (!multiColorEnabled()) return {};
    const pal = e.store.colorPalette;
    const out: Record<string, string> = {};
    for (const b of bodies ?? []) {
      const slot = e.store.bodyColorSlot(b.id);
      if (slot != null && pal[slot]) out[b.id] = pal[slot].color;
    }
    return out;
  }

  // two-tone texture inlays: per-face palette overrides (global face id → hex),
  // from the sidecar's textureColorSlots (dense per-body face array, sparse key).
  function computeTexturePaint(): Record<number, string> {
    if (!multiColorEnabled()) return {};
    const pal = e.store.colorPalette;
    const out: Record<number, string> = {};
    for (const b of e.store.buildState.result?.bodies ?? []) {
      const slots = b.textureColorSlots;
      if (!slots) continue;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s != null && pal[s]) out[b.faceStart + i] = pal[s]!.color;
      }
    }
    return out;
  }

  // Toggling multi-material has to repaint what is already on screen. Both
  // setters are no-ops when the map has not changed, so this costs nothing on
  // any other flag; without it the colours would hang about until the next
  // rebuild, which on a finished model is never.
  onFeatureFlagsChange(() => {
    e.viewport.setBodyPaint(computeBodyPaint());
    e.viewport.setTexturePaint(computeTexturePaint());
    e.viewport.requestRender();
  });

  // Failed-commit visibility: a feature that errors in the rebuild leaves the
  // model looking UNCHANGED (its body keeps the old mesh), so without an active
  // notification the only signal is the small status line — "nothing happened".
  // Diff each completed build's failing-feature set against the previous one and
  // toast every NEW failure; if it's the feature the user JUST committed from an
  // interactive tool, select it immediately (red chip scrolls into view).
  let prevErrorIds = new Set<string>();
  // Failed fillet/chamfer edges (midpoints per feature id) — survives sidecar
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
      // Push the palette BEFORE the first body lands, from the manifest — so
      // streamed bodies arrive already wearing their assigned colour instead of
      // popping from grey when the build commits.
      e.viewport.setBodyPaint(computeBodyPaint(c.manifest));
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
        // in the render, no sidecar rebuild — setBodyVisibility re-emits the build).
        const hidden = (s.result.bodies ?? [])
          .filter((b) => !e.store.isBodyVisible(b.id))
          .map((b) => b.id);
        e.viewport.setModel(s.result, pendingFit, hidden);
        pendingFit = false;
        e.viewport.setBodyPaint(computeBodyPaint()); // apply assigned per-body colors
        e.viewport.setTexturePaint(computeTexturePaint()); // + per-face inlay colors
      } else {
        e.viewport.clearModel();
      }
      // Re-split the committed profiles against the model that just landed.
      //
      // A profile drawn across the edge of its face picks as two areas, and the
      // boundary between them comes from the model (sketch/faceFootprint.ts).
      // The overlay is otherwise rebuilt from onDocChange, which fires BEFORE the
      // build it triggered — so it split against the previous model, and on a
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
      // toast NEW feature errors (skip preview builds — they carry a transient
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
          // old files whose stored point identifies no single face — without this
          // the toast is a dead end.
          const amb = ambiguousDiagFor(s.result?.diagnostics, id);
          const action = amb?.at
            ? { label: "Re-pick face", onClick: () => e.starters.repickReference(id, amb.at!) }
            : { label: "Show", onClick: () => e.selectFeature(id) };
          // Logged with the FEATURE beside it, not just the sentence. A kernel
          // refusal is usually about the geometry it was handed, so the message
          // alone leaves out half the evidence — and the toast that carries the
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
    if (s.errorMessage) {
      e.setStatus(`${s.errorFeatureId ?? ""}: ${s.errorMessage}`, "error");
    } else if (!s.building) {
      e.setStatus("ready", "connected");
    }
  });
}
