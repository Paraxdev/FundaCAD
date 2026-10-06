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

import { watch } from "vue";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import type { StressGlyphHandlers, StressGlyphModel } from "../viewport/stressGlyphs";
import { getUnit, toDisplay, displayRound } from "./units";
import { usePanelsStore, type PanelRow, type ClashRow, type ClearanceRow, type StressProbePin } from "../stores/panels";
import {
  AXES, LOAD_MARK_COLOR, SUPPORT_COLORS, SUPPORT_KINDS,
  areaCentre, autoDeformScale, buildStressRequest, defaultSpotRadius, deformSliderMax, emptyFaceSet, forceDirection,
  formatStressResult, intoDirection, newSetup, panelMessage, pinAxisSegment, pressureSites, probeLabel, probeValues,
  sameTarget, setupFromStudy, studyFromSetup, swingScale,
  type ForceDirection, type StressFaceSet, type StressLoadSetup, type StressTarget, type Tri,
} from "./stress";
import type { AxisDirection, Selector, StressStudy, StressSupportType, Vec3 } from "../types";
import { isVec3 } from "../document/stressStudy";
import * as THREE from "three";

type StressOverlay = NonNullable<Parameters<Viewport["setStressOverlay"]>[0]>;
type ProbeSurface = { indices: number[]; vonMises: number[]; displacement?: number[] };

/** What the Stress panel draws over the model (viewport/stressGlyphs.ts). */
export interface StressGlyphsApi {
  setModel(m: StressGlyphModel): void;
  setProbe(on: boolean): void;
  setProbePins(pins: Pick<StressProbePin, "tri" | "weights" | "label">[]): void;
  /** Place mode with the orb a click would put down, or null to end it. */
  setPlacing?(p: { color: number; radius: number } | null): void;
  dispose(): void;
}

export interface PanelsDeps {
  store: DocumentStore;
  viewport: Viewport;
  geometry: GeometryBackend;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  /** Makes the Stress panel's arrows and probe markers; without one (a test
   *  rig) the panel works with nothing drawn but the face tints. */
  stressGlyphs?: (handlers: StressGlyphHandlers) => StressGlyphsApi;
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
  // edited in the panel and saved with the document; this side turns
  // selections into face sets, draws the supports and loads, runs the engine
  // op with a Cancel, and draws the result, deformed and probed if asked. ---

  // Bumped on every document change, so a result for a model the user has
  // edited since is not painted over the new one. A rebuild clears the overlay
  // anyway; this covers the reply that lands after it.
  let docEpoch = 0;
  // Bumped per Run, on close and on a body change, so a reply for an earlier
  // Run is dropped.
  let runSeq = 0;
  // The build the face sets' display ids were taken on. They belong to one
  // tessellation, so on another build they are looked up again from their
  // selectors' points before anything marks or reads them.
  let facesFor: unknown = null;
  // The last result's colours and the document they were for, so "Show
  // colours" can put them back without a new Run while the model is the same,
  // with the surface the probe reads its values from.
  let colours: { overlay: StressOverlay; epoch: number; surface: ProbeSurface } | null = null;
  // The study as last written to (or read from) the document, so an edit is
  // saved once and a study the document gained some other way (a version put
  // back, an assistant's edit) is told apart from the panel's own.
  let persisted: string | null = null;
  // The arrows, axes and probe markers in the view, while the panel is open.
  let glyphs: StressGlyphsApi | null = null;
  // A load's force and direction from before a drag of its arrow, for Esc.
  const dragOrigin = new Map<number, Pick<StressLoadSetup, "direction" | "custom" | "force">>();
  // A spot's radius from before a drag of its rim, for Esc.
  let radiusOrigin: number | null = null;
  // The Animate toggle's frame loop.
  let animRaf = 0;
  // Where the gravity arrow stands, for the build it was measured on.
  let centre: { build: unknown; body: string; at: Vec3 | null } | null = null;

  store.onDocChange(() => {
    docEpoch++;
    adoptDocumentStudy();
  });

  // Another document took this one's place: the setup's body id and face
  // points mean nothing in it.
  store.onOpen(() => { if (panels.stress) closeStress(); });

  // Every edit in the panel lands in the setup, from its inputs or from here;
  // whichever it was, the document saves it and the view follows. Synchronous,
  // so a save never trails the edit that caused it.
  watch(() => panels.stress?.setup, () => {
    persist();
    scheduleGlyphs();
  }, { deep: true, flush: "sync" });

  function persist() {
    const d = panels.stress;
    if (!d) return;
    // The saved study lends a blank field its last value, so a field the user
    // is retyping never saves a default the panel does not show.
    const study = studyFromSetup(d.setup, store.stressStudy);
    const json = JSON.stringify(study);
    if (json === persisted) return;
    persisted = json;
    store.setStressStudy(study);
  }

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
    if (panels.stress) panels.showStress(seed ?? null);
    else loadStudy(store.stressStudy, seed ?? null);
    glyphs ??= deps.stressGlyphs?.(glyphHandlers) ?? null;
    // Before the marks, so a saved face that is gone has the last word.
    setStatus("Stress: press Place on a support or a load and click the body, or select faces and set them", "");
    refreshStressMarks();
  }

  /** Put a saved study in the panel, or a fresh setup seeded with `seed` for
   *  none. Its faces are found on the build by the next relocation, which also
   *  says which ones are not on the body any more. Reading it back is not an
   *  edit, so the document is not marked changed by it: a saved study with no
   *  body stays so until the user picks one. */
  function loadStudy(study: Readonly<StressStudy> | null, seed: string | null) {
    facesFor = null;
    const setup = study ? setupFromStudy(study, (sel) => ({ ...emptyFaceSet(), selectors: sel })) : newSetup(seed);
    persisted = JSON.stringify(study ?? studyFromSetup(setup));
    stopAnimation();
    colours = null;
    viewport.setStressOverlay(null);
    panels.replaceStressSetup(setup);
    glyphs?.setProbePins([]);
  }

  /** The document's study changed under an open panel (a version put back, an
   *  assistant's edit): show that one, stopping a Run made for the old one. */
  function adoptDocumentStudy() {
    const d = panels.stress;
    if (!d || JSON.stringify(store.stressStudy) === persisted) return;
    if (d.running) {
      void cancelStress();
      runSeq++;
      panels.stressFinished({});
    }
    // No seed: the panel's old body would undo an edit that cleared it.
    loadStudy(store.stressStudy, null);
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

  /** The display face a stored selector names on this build: by its point, as
   *  the engine resolves a picked face, or by a flat fingerprint's centroid.
   *  Undefined for a selector the view cannot place, which is kept for the
   *  engine and left untinted rather than reported lost. A centroid is only a
   *  guess at the face (an L-shaped face's lies off it), so a fingerprint the
   *  guess misses on `body` is one the view cannot place, not one that is gone.
   *  A selector of a shape it cannot read is one it cannot place either, never
   *  an error: this runs inside every rebuild while the panel is open. */
  function faceIdOf(sel: Selector, body: string | null): number | null | undefined {
    try {
      if ("point" in sel) return isVec3(sel.point) ? viewport.faceIdNear(sel.point) : undefined;
      if (sel.kind === "face" && sel.by === "match" && sel.fp?.surface === "plane" && isVec3(sel.fp.centroid)) {
        const f = viewport.faceIdNear(sel.fp.centroid);
        return f !== null && viewport.faceIdToBodyId(f) === body ? f : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Bring the face sets onto the current build: each selector's point to the
   *  face nearest it on the analysed body, as the engine resolves it. Nothing
   *  is dropped: the face sets are what the document saves, and a model that
   *  lacks a face now (an edit, the timeline rolled back, a failed build) may
   *  have it again on the next build. A selector not on this one is counted
   *  missing in its set, left untinted, and keeps a Run from going; the body
   *  stays the analysed one even on a build without it. Returns how many
   *  faces are missing, or 0 when the sets were already on this build. */
  function relocateStressFaces(): number {
    const s = panels.stress?.setup;
    const cur = store.buildState.result ?? null;
    if (!s || cur === facesFor) return 0;
    facesFor = cur;
    const onModel = !!s.body && stressBodies().some((b) => b.id === s.body);
    let missing = 0;
    const again = (set: StressFaceSet): StressFaceSet => {
      const faceIds: number[] = [];
      let lost = 0;
      let unshown = 0;
      for (const sel of set.selectors) {
        // With no body picked yet there is nothing to look on: the faces wait
        // for one, neither shown nor lost.
        const f = !s.body ? undefined : onModel ? faceIdOf(sel, s.body) : null;
        if (f === undefined) unshown++;
        else if (f === null || viewport.faceIdToBodyId(f) !== s.body) lost++;
        // Two picks that now land on one face are one face, as the engine
        // reads them too; both selectors stay.
        else if (!faceIds.includes(f)) faceIds.push(f);
      }
      missing += lost;
      return { ...faceSet(set.selectors, faceIds), missing: lost, unshown };
    };
    for (const x of s.supports) panels.setStressSupportFaces(x.id, again(x.faces));
    for (const l of s.loads) panels.setStressLoadFaces(l.id, again(l.faces));
    return missing;
  }

  /** The analysed body when the current model has it, null when it has none
   *  picked or the model lacks it. */
  function bodyOnModel(): string | null {
    const body = panels.stress?.setup.body ?? null;
    return body && stressBodies().some((b) => b.id === body) ? body : null;
  }

  /** Tint each support's faces in its kind's colour and every load's faces,
   *  while the panel is open, and after a build first find them again on it.
   *  Not over the result's colours, which a tint would misread, nor on a body
   *  the user has hidden. Called by the rebuild bridge after every model it
   *  draws. */
  function refreshStressMarks() {
    const d = panels.stress;
    if (!d) {
      viewport.setFaceMarks(null);
      return;
    }
    // An edit makes the colours stale for good; a model drawn again without
    // one (an eye toggle) only took them off.
    if (d.colours !== "none" && !(colours && colours.epoch === docEpoch)) dropResultDrawing();
    else if (d.colours === "shown" && !viewport.hasStressOverlay()) {
      stopAnimation();
      panels.setStressColours("hidden");
    }
    const missing = relocateStressFaces();
    if (missing && !bodyOnModel()) {
      setStatus("Stress: the body analysed is not on the current model; its setup is kept for when it is back, or pick another body", "");
    } else if (missing) {
      setStatus(`Stress: ${missing} face${missing === 1 ? " is" : "s are"} not found on the current model, set the faces again`, "");
    }
    drawGlyphs();
    const s = d.setup;
    if (d.colours === "shown" || !s.body || !store.isBodyVisible(s.body)) {
      viewport.setFaceMarks(null);
      return;
    }
    const marks: { faceIds: number[]; color: number }[] = [];
    for (const kind of SUPPORT_KINDS) {
      const of = s.supports.filter((x) => x.type === kind.value);
      if (of.length) marks.push({ faceIds: of.flatMap((x) => x.faces.faceIds), color: SUPPORT_COLORS[kind.value] });
    }
    marks.push({ faceIds: s.loads.flatMap((l) => l.faces.faceIds), color: LOAD_MARK_COLOR });
    viewport.setFaceMarks(marks);
  }

  /** The colours went stale: nothing drawn from the result stays, the
   *  deformation, its animation and the probes with it. */
  function dropResultDrawing() {
    stopAnimation();
    panels.setStressColours("none");
    panels.setStressDeform(null);
    panels.setStressProbe(false);
    if (panels.stress) panels.stress.pins = [];
    glyphs?.setProbe(false);
    glyphs?.setProbePins([]);
  }

  // --- the arrows and axes in the view ---

  let glyphsPending = false;
  /** Coalesce a burst of setup edits (a drag, a relocation) into one redraw. */
  function scheduleGlyphs() {
    if (!glyphs || glyphsPending) return;
    glyphsPending = true;
    queueMicrotask(() => {
      glyphsPending = false;
      drawGlyphs();
    });
  }

  function trianglesOf(faceIds: number[]): { tris: Tri[]; normals: Vec3[] } {
    const tris: Tri[] = [];
    const normals: Vec3[] = [];
    const n = new THREE.Vector3();
    for (const f of faceIds) {
      for (const t of viewport.faceTriangles(f)) {
        tris.push([[t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]]);
        t.getNormal(n);
        normals.push([n.x, n.y, n.z]);
      }
    }
    return { tris, normals };
  }

  /** The analysed body's centre of mass, measured once per build. */
  function bodyCentre(body: string): Vec3 | null {
    const build = store.buildState.result ?? null;
    if (!centre || centre.build !== build || centre.body !== body) {
      const c = viewport.bodyProperties([body])?.com;
      centre = { build, body, at: c ? [c.x, c.y, c.z] : null };
    }
    return centre.at;
  }

  function glyphModel(): StressGlyphModel {
    const m: StressGlyphModel = { forces: [], pressures: [], gravity: null, pins: [], spots: [] };
    const s = panels.stress?.setup;
    if (!s || !s.body || !bodyOnModel() || !store.isBodyVisible(s.body)) return m;
    for (const x of s.supports) {
      for (const [index, spot] of (x.spots ?? []).entries()) {
        if (drawable(spot.radius)) m.spots!.push({ target: { support: x.id }, index, at: spot.at, radius: spot.radius, color: SUPPORT_COLORS[x.type] });
      }
    }
    for (const l of s.loads) {
      const spots = l.spots ?? [];
      for (const [index, spot] of spots.entries()) {
        if (drawable(spot.radius)) m.spots!.push({ target: { load: l.id }, index, at: spot.at, radius: spot.radius, color: LOAD_MARK_COLOR });
      }
      if (!l.faces.faceIds.length && !spots.length) continue;
      const { tris, normals } = trianglesOf(l.faces.faceIds);
      if (l.kind === "pressure") {
        // A negative pressure pulls: its arrows leave the faces.
        const pull = Number(l.pressure) < 0;
        const sites = pressureSites(tris, normals, 12);
        for (const spot of spots) if (spot.normal) sites.push({ at: spot.at, dir: negate(spot.normal) });
        for (const p of sites) {
          m.pressures.push(pull ? { at: p.at, dir: negate(p.dir), pull } : p);
        }
        continue;
      }
      // On its faces when it has any, else on its first spot.
      const anchor = areaCentre(tris) ?? spots[0]?.at ?? null;
      const dir = forceDirection(l);
      if (!anchor || typeof dir === "string") continue;
      // The sign of the force is part of its direction: the arrow points the
      // way the load is applied, under that way's name, so a drag along it
      // writes the same load back with a positive force.
      const force = Number(l.force) || 0;
      const flip = force < 0;
      m.forces.push({
        loadId: l.id, anchor, dir: flip ? negate(dir) : dir, force: Math.abs(force),
        direction: flip ? oppositeDirection(l.direction) : l.direction, into: intoDirection(l.faces, l.spots),
      });
    }
    if (s.gravity.on) {
      const at = bodyCentre(s.body);
      if (at) m.gravity = { at, dir: AXES[s.gravity.direction] };
    }
    for (const x of s.supports) {
      if (x.type !== "pinned") continue;
      // One axis per face: two holes pinned by one support turn about two axes.
      for (const f of x.faces.faceIds) {
        const { tris, normals } = trianglesOf([f]);
        const seg = pinAxisSegment(tris.flat(), normals);
        if (seg) m.pins.push(seg);
      }
    }
    return m;
  }

  function drawGlyphs() {
    glyphs?.setModel(glyphModel());
  }

  function negate(v: Vec3): Vec3 {
    return [-v[0] + 0, -v[1] + 0, -v[2] + 0];
  }

  /** A radius the user is retyping reads as "" for a moment. */
  function drawable(radius: unknown): radius is number {
    return typeof radius === "number" && Number.isFinite(radius) && radius > 0;
  }

  /** The name of the way opposite `d`: the other end of an axis, or a custom
   *  vector for "into the face", which has no named opposite. */
  function oppositeDirection(d: ForceDirection): ForceDirection {
    const m = /^([+-])([XYZ])$/.exec(d);
    return m ? (`${m[1] === "+" ? "-" : "+"}${m[2]}` as AxisDirection) : "custom";
  }

  /** A drag of a force arrow writes straight into its load, so the panel's
   *  fields follow the hand. The first patch keeps what the load was, for Esc. */
  const glyphHandlers: StressGlyphHandlers = {
    forceDrag(loadId, patch) {
      const l = panels.stress?.setup.loads.find((x) => x.id === loadId);
      if (!l) return;
      if (!dragOrigin.has(loadId)) dragOrigin.set(loadId, { direction: l.direction, custom: [...l.custom], force: l.force });
      l.direction = patch.direction;
      if (patch.custom) l.custom = patch.custom;
      l.force = patch.force;
    },
    forceDragEnd(loadId, cancelled) {
      const was = dragOrigin.get(loadId);
      dragOrigin.delete(loadId);
      const l = panels.stress?.setup.loads.find((x) => x.id === loadId);
      if (!cancelled || !was || !l) return;
      l.direction = was.direction;
      l.custom = was.custom;
      l.force = was.force;
    },
    probeLabel(hit) {
      const v = colours ? probeValues(colours.surface, hit.tri, hit.weights) : null;
      return v ? probeLabel(v, getUnit()) : null;
    },
    pinProbe(hit) {
      const label = glyphHandlers.probeLabel(hit);
      if (!label) return;
      panels.addStressPin({ tri: hit.tri, weights: hit.weights, label });
      glyphs?.setProbePins(panels.stress?.pins ?? []);
    },
    leaveProbe() {
      setStressProbe(false);
    },
    placeSpot(hit, more) {
      const d = panels.stress;
      const target = d?.placing;
      if (!d || !target) return;
      if (!hit.body) return;
      if (d.setup.body && d.setup.body !== hit.body) {
        setStatus(
          bodyOnModel()
            ? "Stress: that is another body than the one analysed, click the analysed body"
            : "Stress: the body analysed is not on the current model, pick another body first",
          "",
        );
        return;
      }
      if (!d.setup.body) panels.setStressBody(hit.body);
      const radius = spotRadiusFor(hit.body);
      panels.addStressSpot(target, { at: hit.at.map(round4) as Vec3, radius, normal: hit.normal.map(round4) as Vec3 });
      setStatus(`Stress: ${rowName(target)}: a spot of radius ${radius} mm, drag its rim to size it`, "");
      if (!more) stopPlacing();
    },
    leavePlacing() {
      stopPlacing();
    },
    spotRadius(target, index, radius) {
      const spot = panels.stressRow(target)?.spots?.[index];
      if (!spot) return;
      radiusOrigin ??= spot.radius;
      spot.radius = radius;
    },
    spotRadiusEnd(target, index, cancelled) {
      const was = radiusOrigin;
      radiusOrigin = null;
      const spot = panels.stressRow(target)?.spots?.[index];
      if (cancelled && spot && was !== null) spot.radius = was;
    },
  };

  function round4(v: number): number {
    return Math.round(v * 1e4) / 1e4 + 0;
  }

  /** A row as the panel names it, "Support 2" or "Load 1". */
  function rowName(target: StressTarget): string {
    const s = panels.stress?.setup;
    if ("support" in target) return `Support ${(s?.supports.findIndex((x) => x.id === target.support) ?? 0) + 1}`;
    return `Load ${(s?.loads.findIndex((l) => l.id === target.load) ?? 0) + 1}`;
  }

  /** The radius a new spot gets: the last one placed in this setup, as the
   *  next is usually meant the same size, else one in proportion to the body. */
  function spotRadiusFor(body: string): number {
    const s = panels.stress?.setup;
    const placed = [...(s?.supports ?? []), ...(s?.loads ?? [])].flatMap((x) => x.spots ?? []);
    const last = placed[placed.length - 1];
    if (last && drawable(last.radius)) return last.radius;
    const box = viewport.bodyProperties([body])?.bbox;
    return defaultSpotRadius(box && !box.isEmpty() ? box.min.distanceTo(box.max) : NaN);
  }

  /** Arm one row: the next click on the body puts a spot there. Pressing the
   *  same row's Place again, or Esc, disarms it. The result's colours come off
   *  first, as the click is on the body and not on them. */
  function placeStressSpot(target: StressTarget) {
    const d = panels.stress;
    if (!d) return;
    if (sameTarget(d.placing, target)) {
      stopPlacing();
      return;
    }
    const row = panels.stressRow(target);
    if (!row) return;
    if (d.probe) setStressProbe(false);
    if (d.colours === "shown") setStressColours(false);
    const body = bodyOnModel();
    panels.setStressPlacing(target);
    const color = "support" in target ? SUPPORT_COLORS[(row as { type: StressSupportType }).type] : LOAD_MARK_COLOR;
    const radius = body ? spotRadiusFor(body) : defaultSpotRadius(NaN);
    glyphs?.setPlacing?.({ color, radius });
    setStatus(`Stress: click the body where ${rowName(target)} ${"support" in target ? "holds it" : "pushes"}, Shift click to place several, Esc to stop`, "");
  }

  function stopPlacing() {
    if (!panels.stress?.placing) return;
    panels.setStressPlacing(null);
    glyphs?.setPlacing?.(null);
  }

  function removeStressSpot(target: StressTarget, index: number) {
    panels.removeStressSpot(target, index);
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
    if (current && current !== body) {
      return bodyOnModel()
        ? "the selected faces are on another body than the one analysed"
        : "the body analysed is not on the current model, pick another body first";
    }
    return { faces: faceSet(sel.selectors.map((x) => ({ ...x, body })), sel.faceIds), body };
  }

  /** Set one support's faces or one load's faces from the current face
   *  selection, then clear it for the next pick. */
  function setStressFacesFromSelection(target: { support: number } | { load: number }) {
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
    const support = "support" in target ? d.setup.supports.find((x) => x.id === target.support) : undefined;
    if (support) panels.setStressSupportFaces(support.id, got.faces);
    else if ("load" in target) panels.setStressLoadFaces(target.load, got.faces);
    viewport.clearSelection();
    refreshStressMarks();
    const n = got.faces.faceIds.length;
    // Named as the panel's rows are, so the line says which row took them.
    const kind = support ? SUPPORT_KINDS.find((k) => k.value === support.type)?.label.toLowerCase() : undefined;
    const row = support
      ? `Support ${d.setup.supports.indexOf(support) + 1}${kind ? ` (${kind})` : ""}`
      : `Load ${d.setup.loads.findIndex((l) => "load" in target && l.id === target.load) + 1}`;
    setStatus(`Stress: ${row}: ${n} face${n === 1 ? "" : "s"}`, "");
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
    clearResult();
    refreshStressMarks();
  }

  /** Drop the result and everything drawn from it. */
  function clearResult() {
    stopAnimation();
    panels.clearStressResult();
    colours = null;
    viewport.setStressOverlay(null);
    glyphs?.setProbe(false);
    glyphs?.setProbePins([]);
  }

  function addStressSupport(type: StressSupportType = "fixed") {
    panels.addStressSupport(type);
  }

  function removeStressSupport(supportId: number) {
    if (sameTarget(panels.stress?.placing ?? null, { support: supportId })) stopPlacing();
    panels.removeStressSupport(supportId);
    refreshStressMarks();
  }

  /** A support's kind changed in the panel: retint it, and draw or drop its axis. */
  function setStressSupportType(supportId: number, type: StressSupportType) {
    const x = panels.stress?.setup.supports.find((v) => v.id === supportId);
    if (!x || x.type === type) return;
    x.type = type;
    refreshStressMarks();
  }

  function addStressLoad() {
    panels.addStressLoad();
  }

  function removeStressLoad(loadId: number) {
    if (sameTarget(panels.stress?.placing ?? null, { load: loadId })) stopPlacing();
    panels.removeStressLoad(loadId);
    refreshStressMarks();
  }

  /** The overlay as it should be drawn now, at the slider's deformation. */
  function overlayNow(): StressOverlay | null {
    if (!colours) return null;
    if (!colours.overlay.displacement) return colours.overlay;
    return { ...colours.overlay, scale: panels.stress?.deform?.scale ?? 0 };
  }

  /** Put the last result's colours on the body, or take them off so its faces
   *  can be picked again. Only while the model is the one they were for. */
  function setStressColours(on: boolean) {
    const d = panels.stress;
    if (!d || d.colours === "none") return;
    if (on && !(colours && colours.epoch === docEpoch)) {
      dropResultDrawing();
      return;
    }
    if (!on) {
      stopAnimation();
      if (d.probe) setStressProbe(false);
    }
    viewport.setStressOverlay(on ? overlayNow() : null);
    panels.setStressColours(on ? "shown" : "hidden");
    refreshStressMarks();
    if (on && d.deform?.animate) startAnimation();
  }

  /** Draw the deformed shape at `scale` times the true deflection. */
  function setStressDeformation(scale: number) {
    const def = panels.stress?.deform;
    if (!def || !Number.isFinite(scale)) return;
    def.scale = Math.max(0, scale);
    if (def.scale > def.max) def.max = def.scale;
    if (!def.animate) viewport.setStressDeformation(def.scale);
  }

  /** Swing the deformation between none and the slider's scale, or stop it
   *  there. */
  function setStressAnimate(on: boolean) {
    const def = panels.stress?.deform;
    if (!def) return;
    def.animate = on;
    if (on && panels.stress?.colours !== "shown") setStressColours(true);
    if (on) startAnimation();
    else stopAnimation();
  }

  function startAnimation() {
    if (animRaf || typeof requestAnimationFrame !== "function") return;
    const t0 = performance.now();
    const step = (now: number) => {
      animRaf = 0;
      const d = panels.stress;
      if (!d?.deform?.animate || d.colours !== "shown") {
        if (d?.deform) viewport.setStressDeformation(d.deform.scale);
        return;
      }
      viewport.setStressDeformation(swingScale(now - t0, d.deform.scale));
      animRaf = requestAnimationFrame(step);
    };
    animRaf = requestAnimationFrame(step);
  }

  /** Stop the swing and leave the shape at the slider's scale. */
  function stopAnimation() {
    if (animRaf) cancelAnimationFrame(animRaf);
    animRaf = 0;
    const def = panels.stress?.deform;
    if (def?.animate) {
      def.animate = false;
      viewport.setStressDeformation(def.scale);
    }
  }

  /** Probe mode: hover the coloured body for its values, click to pin them.
   *  Needs the colours, so turning it on puts them back. */
  function setStressProbe(on: boolean) {
    const d = panels.stress;
    if (!d) return;
    if (on && d.colours === "none") {
      setStatus("Stress: run the analysis first, then probe its result", "");
      return;
    }
    if (on) stopPlacing();
    if (on && d.colours !== "shown") {
      setStressColours(true);
      // The model changed since the Run, and putting the colours back found
      // them stale and dropped them: there is nothing to probe.
      if (panels.stress?.colours !== "shown") {
        setStatus("Stress: the model changed since the run, run the analysis again to probe it", "");
        return;
      }
    }
    panels.setStressProbe(on);
    glyphs?.setProbe(on);
    if (on) setStatus("Stress: hover the body to read it, click to pin a probe, Esc to stop", "");
  }

  function removeStressProbe(id: number) {
    panels.removeStressPin(id);
    glyphs?.setProbePins(panels.stress?.pins ?? []);
  }

  async function runStress() {
    const d = panels.stress;
    if (!d || d.running) return;
    if (!geometry.stress) {
      setStatus("Stress: this geometry engine cannot run an analysis", "error");
      return;
    }
    relocateStressFaces();
    if (d.setup.body && !bodyOnModel()) {
      const message = "the body analysed is not on the current model, pick another body or bring the model back to where it has it";
      panels.stressFinished({ error: message });
      setStatus(`Stress: ${message}`, "");
      return;
    }
    // Faces the model lacks are refused here, by the support or load they are in.
    const req = buildStressRequest(d.setup);
    if (!req.ok) {
      panels.stressFinished({ error: req.message });
      setStatus(`Stress: ${req.message}`, "");
      return;
    }
    const seq = ++runSeq;
    const epoch = docEpoch;
    stopPlacing();
    panels.stressStarted();
    clearResult();
    refreshStressMarks();
    setStatus("Analysing stress…", "");
    const res = await geometry.stress(store.builtDocument(), req.body, req.options, (id) => {
      if (seq === runSeq) panels.stressSent(id);
    });
    if (seq !== runSeq || !panels.stress) return;
    if (!res.ok) {
      const message = panelMessage(res.message);
      panels.stressFinished(res.cancelled ? {} : { error: message });
      setStatus(res.cancelled ? "Stress analysis cancelled" : `Stress analysis failed: ${message}`, res.cancelled ? "" : "error");
      return;
    }
    const r = res.result;
    const view = formatStressResult(r, getUnit(), (req.options.supports ?? []).map((x) => x.type));
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
      const disp = r.surface.displacement;
      const moves = !!disp && disp.length === r.surface.positions.length;
      colours = {
        overlay: {
          bodyId: r.body,
          positions: r.surface.positions,
          indices: r.surface.indices,
          values: r.surface.vonMises,
          range: view.legend,
          ...(moves ? { displacement: disp } : {}),
        },
        epoch,
        surface: r.surface,
      };
      if (moves) {
        const auto = autoDeformScale(r.surface.positions, disp!);
        panels.setStressDeform({ scale: auto, auto, max: deformSliderMax(auto), animate: false });
      }
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

  /** Close Stress, stopping a Run in flight, and drop its colours, marks and
   *  glyphs. The study stays in the document for the next time. */
  function closeStress() {
    if (panels.stress?.running) void cancelStress();
    stopAnimation();
    runSeq++;
    panels.stress = null;
    colours = null;
    facesFor = null;
    persisted = null;
    dragOrigin.clear();
    glyphs?.dispose();
    glyphs = null;
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
    setStressFacesFromSelection, placeStressSpot, removeStressSpot, addStressSupport, removeStressSupport,
    setStressSupportType,
    addStressLoad, removeStressLoad, setStressColours, refreshStressMarks,
    setStressDeformation, setStressAnimate, setStressProbe, removeStressProbe,
  };
}

export type Panels = ReturnType<typeof createPanels>;
