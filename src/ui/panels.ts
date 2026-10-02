// Facade for the floating "measure-panel" popups: Properties, Interference,
// Stress and the Overhang (Draft Analysis) settings. The DOM lives in
// components/overlays/*Panel.vue; what stays here is the part that is genuinely
// this layer's job, preconditions, status-line messages, the geometry call,
// and unit formatting of the numbers those produce.
//
// The app's own panels only. A capability that wants a floating panel brings its
// own component and its own state; a plugin's camera view used to be a fifth
// field on the store below and a fifth function here, which put "which device
// is being watched" in the same object as "which bodies are overlapping".

import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import { getUnit, toDisplay, displayRound } from "./units";
import { usePanelsStore, type PanelRow, type ClashRow, type ClearanceRow } from "../stores/panels";
import {
  buildStressRequest, formatStressResult, FIXED_MARK_COLOR, LOAD_MARK_COLOR, type StressFaceSet,
} from "./stress";
import type { Selector } from "../types";
import * as THREE from "three";

type StressOverlay = NonNullable<Parameters<Viewport["setStressOverlay"]>[0]>;

export interface PanelsDeps {
  store: DocumentStore;
  viewport: Viewport;
  geometry: GeometryBackend;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
}

export function createPanels(deps: PanelsDeps) {
  const { store, viewport, geometry, hasBody, setStatus } = deps;
  const panels = usePanelsStore();

  // --- Inspect: Properties readout (volume / area / center / bbox). Mass and
  // the filament estimate are computed live in the panel component itself,
  // from `raw` below, so changing material/infill needs no new geometry call. ---
  function showProperties() {
    if (!hasBody()) {
      setStatus("Properties: create or import a body first", "");
      return;
    }
    const sel = viewport.getSelectedBodies();
    const p = viewport.bodyProperties(sel.length ? sel : null);
    if (!p) return;
    const unit = getUnit();
    const f = toDisplay(1);
    const rows: PanelRow[] = [
      { k: "Volume", v: `${displayRound(p.volume * f * f * f)} ${unit}³` },
      { k: "Surface area", v: `${displayRound(p.area * f * f)} ${unit}²` },
      {
        k: "Center of mass",
        v: `${displayRound(toDisplay(p.com.x))}, ${displayRound(toDisplay(p.com.y))}, ${displayRound(toDisplay(p.com.z))}`,
      },
      {
        k: "Bounding box",
        v:
          `${displayRound(toDisplay(p.bbox.max.x - p.bbox.min.x))} × ` +
          `${displayRound(toDisplay(p.bbox.max.y - p.bbox.min.y))} × ` +
          `${displayRound(toDisplay(p.bbox.max.z - p.bbox.min.z))} ${unit}`,
      },
    ];
    panels.showProperties({
      title: sel.length === 1 ? (p.names[0] ?? "") : sel.length ? `${sel.length} bodies` : "All bodies",
      rows,
      raw: { volumeMm3: p.volume, areaMm2: p.area },
    });
    viewport.setComMarker(p.com);
  }

  /** Close Properties and drop its center-of-mass marker. The panel component
   *  calls this instead of nulling the store ref directly, so the overlay
   *  never outlives the panel that asked for it. */
  function closeProperties() {
    panels.properties = null;
    viewport.setComMarker(null);
  }

  // --- Inspect: Interference (clash) check between bodies, optionally with a
  // clearance threshold (mm) for the near-miss pass. ---
  async function showInterference(clearanceMm?: number) {
    if (!hasBody()) {
      setStatus("Interference: create or import a body first", "");
      return;
    }
    if ((store.buildState.result?.bodies?.length ?? 0) < 2) {
      setStatus("Interference: needs at least two bodies", "");
      return;
    }
    setStatus("Checking interference…", "");
    const res = await geometry.interference(store.document, clearanceMm);
    if (!res.ok) {
      setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
      return;
    }
    const pairs = res.pairs ?? [];
    const clearances = res.clearances ?? [];
    const foundAny = pairs.length || clearances.length;
    setStatus(
      foundAny
        ? `${pairs.length} interference${pairs.length === 1 ? "" : "s"}` +
          (clearanceMm ? `, ${clearances.length} close pair${clearances.length === 1 ? "" : "s"}` : "")
        : "No interferences found",
      foundAny ? "error" : "connected",
    );
    const unit = getUnit();
    const f = toDisplay(1);
    const clashes: ClashRow[] = pairs.map((p) => ({
      k: `${p.aName} ∩ ${p.bName}`,
      v: `${displayRound(p.volume * f * f * f)} ${unit}³`,
      a: p.a,
      b: p.b,
    }));
    const clearanceRows: ClearanceRow[] = clearances.map((c) => ({
      k: `${c.aName} ↔ ${c.bName}`,
      v: `${displayRound(toDisplay(c.distance))} ${unit}`,
      a: c.a,
      b: c.b,
    }));
    panels.showInterference({
      title: pairs.length
        ? `Interference, ${pairs.length} clash${pairs.length > 1 ? "es" : ""}`
        : "Interference",
      clashes,
      clearances: clearanceRows,
      ...(res.truncated ? { truncatedMessage: res.message } : {}),
    });
    viewport.setInterferenceOverlay(
      pairs,
      clearances.map((c) => ({ pointA: c.pointA, pointB: c.pointB })),
    );
  }

  /** Close Interference and drop its overlap/clearance overlay. */
  function closeInterference() {
    panels.interference = null;
    viewport.setInterferenceOverlay(null, null);
  }

  // --- Inspect: Stress, a linear static analysis of one body. The setup is
  // edited in the panel; this side turns selections into face sets, runs the
  // engine op with a Cancel, and draws the result. ---

  // Bumped on every document change, so a result for a model the user has
  // edited since is not painted over the new one. A rebuild clears the overlay
  // anyway; this covers the reply that lands after it.
  let docEpoch = 0;
  store.onDocChange(() => { docEpoch++; });
  // Bumped per Run, on close and on a body change, so a reply for an earlier
  // Run is dropped.
  let runSeq = 0;
  // The build the face sets' display ids were taken on. They belong to one
  // tessellation, so on another build they are looked up again from their
  // selectors' points before anything marks or reads them.
  let facesFor: unknown = null;
  // The last result's colours and the document they were for, so "Show
  // colours" can put them back without a new Run while the model is the same.
  let colours: { overlay: StressOverlay; epoch: number } | null = null;

  // Another document took this one's place: the setup's body id and face
  // points mean nothing in it.
  store.onOpen(() => { if (panels.stress) closeStress(); });

  /** The bodies the panel can analyse, in build order. */
  function stressBodies(): { id: string; name: string }[] {
    return (store.buildState.result?.bodies ?? []).map((b) => ({ id: b.id, name: b.name }));
  }

  function showStress() {
    if (!hasBody()) {
      setStatus("Stress: create or import a body first", "");
      return;
    }
    if (!geometry.stress) {
      setStatus("Stress: this geometry engine cannot run an analysis", "error");
      return;
    }
    const bodies = stressBodies();
    const picked = viewport.getSelectedBodies();
    const faceBody = viewport.getSelectedFaceIds().map((f) => viewport.faceIdToBodyId(f)).find((b) => b);
    const seed = picked.length === 1 ? picked[0]! : faceBody ?? (bodies.length === 1 ? bodies[0]!.id : null);
    if (!panels.stress) facesFor = store.buildState.result ?? null;
    panels.showStress(seed ?? null);
    refreshStressMarks();
    setStatus("Stress: select faces, then set them as fixed or as a load's faces", "");
  }

  /** A face set from display face ids: the selectors as given, and the faces'
   *  area-weighted outward normal for "into the face". */
  function faceSet(selectors: Selector[], faceIds: number[]): StressFaceSet {
    const normal = new THREE.Vector3();
    const n = new THREE.Vector3();
    let area = 0;
    for (const f of faceIds) {
      for (const t of viewport.faceTriangles(f)) {
        const a = t.getArea();
        t.getNormal(n);
        normal.addScaledVector(n, a);
        area += a;
      }
    }
    return { selectors, faceIds: [...faceIds], normalSum: [normal.x, normal.y, normal.z], area };
  }

  /** Bring the face sets onto the current build: each selector's point to the
   *  face nearest it on the analysed body, as the engine resolves it. A face
   *  that is gone leaves its set with its selector, so the counts are what a
   *  Run sends. Returns how many faces left. */
  function relocateStressFaces(): number {
    const s = panels.stress?.setup;
    const cur = store.buildState.result ?? null;
    if (!s || cur === facesFor) return 0;
    facesFor = cur;
    const before = s.fixed.selectors.length + s.loads.reduce((m, l) => m + l.faces.selectors.length, 0);
    if (!before) return 0;
    if (s.body && !stressBodies().some((b) => b.id === s.body)) {
      panels.setStressBody(null);
      return before;
    }
    let left = 0;
    const again = (set: StressFaceSet): StressFaceSet => {
      const selectors: Selector[] = [];
      const faceIds: number[] = [];
      for (const sel of set.selectors) {
        const f = "point" in sel ? viewport.faceIdNear(sel.point) : null;
        // Two picks that now land on one face are one face.
        if (f === null || viewport.faceIdToBodyId(f) !== s.body || faceIds.includes(f)) {
          left++;
          continue;
        }
        selectors.push(sel);
        faceIds.push(f);
      }
      return faceSet(selectors, faceIds);
    };
    panels.setStressFixed(again(s.fixed));
    for (const l of s.loads) panels.setStressLoadFaces(l.id, again(l.faces));
    return left;
  }

  /** Tint the fixed faces and every load's faces while the panel is open, and
   *  after a build first find them again on it. Not over the result's colours,
   *  which a tint would misread, nor on a body the user has hidden. Called by
   *  the rebuild bridge after every model it draws. */
  function refreshStressMarks() {
    const d = panels.stress;
    if (!d) {
      viewport.setFaceMarks(null);
      return;
    }
    // An edit makes the colours stale for good; a model drawn again without
    // one (an eye toggle) only took them off.
    if (d.colours !== "none" && !(colours && colours.epoch === docEpoch)) panels.setStressColours("none");
    else if (d.colours === "shown" && !viewport.hasStressOverlay()) panels.setStressColours("hidden");
    const left = relocateStressFaces();
    if (left) {
      setStatus(`Stress: ${left} face${left === 1 ? " is" : "s are"} no longer on the body after the change, set the faces again`, "");
    }
    const s = d.setup;
    if (d.colours === "shown" || !s.body || !store.isBodyVisible(s.body)) {
      viewport.setFaceMarks(null);
      return;
    }
    viewport.setFaceMarks([
      { faceIds: s.fixed.faceIds, color: FIXED_MARK_COLOR },
      { faceIds: s.loads.flatMap((l) => l.faces.faceIds), color: LOAD_MARK_COLOR },
    ]);
  }

  /** The selected faces as a face set, each selector stamped with its body,
   *  or why they cannot be one. */
  function selectedStressFaces(): { faces: StressFaceSet; body: string } | string {
    const sel = viewport.selectedFacesForPressPull();
    if (!sel) return "select one or more faces first";
    const bodies = new Set(sel.faceIds.map((f) => viewport.faceIdToBodyId(f)));
    const body = bodies.size === 1 ? [...bodies][0] : null;
    if (!body) return "the selected faces must all be on one body";
    const current = panels.stress?.setup.body;
    if (current && current !== body) return "the selected faces are on another body than the one analysed";
    return { faces: faceSet(sel.selectors.map((x) => ({ ...x, body })), sel.faceIds), body };
  }

  /** Set the fixed faces (`target` "fixed") or one load's faces from the
   *  current face selection, then clear it for the next pick. */
  function setStressFacesFromSelection(target: "fixed" | number) {
    const d = panels.stress;
    if (!d) return;
    // The other sets onto this build first, so all of them are on one.
    relocateStressFaces();
    const got = selectedStressFaces();
    if (typeof got === "string") {
      setStatus(`Stress: ${got}`, "");
      return;
    }
    if (!d.setup.body) panels.setStressBody(got.body);
    if (target === "fixed") panels.setStressFixed(got.faces);
    else panels.setStressLoadFaces(target, got.faces);
    viewport.clearSelection();
    refreshStressMarks();
    const n = got.faces.faceIds.length;
    setStatus(`Stress: ${n} face${n === 1 ? "" : "s"} ${target === "fixed" ? "fixed" : "loaded"}`, "");
  }

  /** Change the analysed body, which drops the face sets, the result and a
   *  Run in flight: its reply would be for the other body. */
  function setStressBody(body: string | null) {
    const d = panels.stress;
    if (!d || d.setup.body === body) return;
    if (d.running) {
      void cancelStress();
      runSeq++;
      panels.stressFinished({});
    }
    panels.setStressBody(body);
    panels.clearStressResult();
    colours = null;
    viewport.setStressOverlay(null);
    refreshStressMarks();
  }

  function addStressLoad() {
    panels.addStressLoad();
  }

  function removeStressLoad(loadId: number) {
    panels.removeStressLoad(loadId);
    refreshStressMarks();
  }

  /** Put the last result's colours on the body, or take them off so its faces
   *  can be picked again. Only while the model is the one they were for. */
  function setStressColours(on: boolean) {
    const d = panels.stress;
    if (!d || d.colours === "none") return;
    if (on && !(colours && colours.epoch === docEpoch)) {
      panels.setStressColours("none");
      return;
    }
    viewport.setStressOverlay(on ? colours!.overlay : null);
    panels.setStressColours(on ? "shown" : "hidden");
    refreshStressMarks();
  }

  async function runStress() {
    const d = panels.stress;
    if (!d || d.running) return;
    if (!geometry.stress) {
      setStatus("Stress: this geometry engine cannot run an analysis", "error");
      return;
    }
    const left = relocateStressFaces();
    if (left) {
      panels.stressFinished({ error: "some faces are no longer on the body, set the faces again" });
      setStatus(`Stress: ${left} face${left === 1 ? " is" : "s are"} no longer on the body after the change, set the faces again`, "");
      refreshStressMarks();
      return;
    }
    const req = buildStressRequest(d.setup);
    if (!req.ok) {
      panels.stressFinished({ error: req.message });
      setStatus(`Stress: ${req.message}`, "");
      return;
    }
    const seq = ++runSeq;
    const epoch = docEpoch;
    panels.stressStarted();
    panels.clearStressResult();
    colours = null;
    viewport.setStressOverlay(null);
    refreshStressMarks();
    setStatus("Analysing stress…", "");
    const res = await geometry.stress(store.builtDocument(), req.body, req.options, (id) => {
      if (seq === runSeq) panels.stressSent(id);
    });
    if (seq !== runSeq || !panels.stress) return;
    if (!res.ok) {
      panels.stressFinished(res.cancelled ? {} : { error: res.message });
      setStatus(res.cancelled ? "Stress analysis cancelled" : `Stress analysis failed: ${res.message}`, res.cancelled ? "" : "error");
      return;
    }
    const r = res.result;
    const view = formatStressResult(r, getUnit());
    panels.stressFinished({ result: view });
    const sf = r.safetyFactor;
    setStatus(
      `Stress: peak ${displayRound(r.maxVonMises.value)} MPa` +
        (sf !== null ? `, safety factor ${displayRound(sf)}` : ""),
      view.yields ? "error" : "connected",
    );
    if (epoch !== docEpoch) {
      setStatus("Stress: the model changed while it ran, run it again to see the colours", "");
      return;
    }
    if (r.surface) {
      colours = {
        overlay: {
          bodyId: r.body,
          positions: r.surface.positions,
          indices: r.surface.indices,
          values: r.surface.vonMises,
          range: view.legend,
        },
        epoch,
      };
      panels.setStressColours("hidden");
      setStressColours(true);
    }
  }

  /** Stop the Run in flight. Only by its own id: without one the client falls
   *  back to the most recent request, which may be a rebuild. */
  async function cancelStress() {
    const id = panels.stress?.running ? panels.stress.requestId : null;
    if (id) await geometry.cancel?.(id);
  }

  /** Close Stress, stopping a Run in flight, and drop its colours and marks. */
  function closeStress() {
    if (panels.stress?.running) void cancelStress();
    runSeq++;
    panels.stress = null;
    colours = null;
    facesFor = null;
    viewport.setStressOverlay(null);
    viewport.setFaceMarks(null);
  }

  function showOverhangSettings() {
    panels.overhang = true;
  }
  function closeOverhangSettings() {
    panels.overhang = false;
  }

  return {
    showProperties, closeProperties, showInterference, closeInterference,
    showOverhangSettings, closeOverhangSettings,
    showStress, closeStress, runStress, cancelStress, stressBodies, setStressBody,
    setStressFacesFromSelection, addStressLoad, removeStressLoad, setStressColours, refreshStressMarks,
  };
}

export type Panels = ReturnType<typeof createPanels>;
