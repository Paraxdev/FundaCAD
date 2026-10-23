// Preconditions, status messages, geometry calls and unit formatting for the floating measure panels (Properties,
// Interference, Stress, Overhang); the DOM is in components/overlays/*Panel.vue.

import { watch } from "vue";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { GeometryBackend } from "../geometry/client";
import type { StressGlyphHandlers, StressGlyphModel } from "../viewport/stressGlyphs";
import { getUnit, toDisplay, displayRound } from "./units";
import {
  usePanelsStore,
  type PanelRow,
  type ClashRow,
  type ClearanceRow,
  type StressData,
  type StressProbePin,
} from "../stores/panels";
import { drawnCorner, engineHit, nearestVertex, refineLevel, refineSurface, type DrawnSurface } from "./stressSurface";
import { weakSpotLabel } from "./stressVerdict";
import { sentence } from "./stressWarnings";
import {
  AXES,
  LOAD_MARK_COLOR,
  SUPPORT_COLORS,
  SUPPORT_KINDS,
  areaCentre,
  autoDeformScale,
  buildStressRequest,
  defaultSpotRadius,
  deformSliderMax,
  emptyFaceSet,
  forceDirection,
  formatStressResult,
  intoDirection,
  newSetup,
  panelMessage,
  pinAxisSegment,
  pressureSites,
  probeLabel,
  probeValues,
  sameTarget,
  setupFromStudy,
  studyFromSetup,
  swingScale,
  SWING_PERIOD_MS,
  type ForceDirection,
  type StressFaceSet,
  type StressLoadSetup,
  type StressTarget,
  type Tri,
} from "./stress";
import type { AxisDirection, Selector, StressStudy, StressSupportType, Vec3 } from "../types";
import { isVec3 } from "../document/stressStudy";
import { bodyLabels, labelledBodies } from "./bodyLabels";
import * as THREE from "three";

type StressOverlay = NonNullable<Parameters<Viewport["setStressOverlay"]>[0]>;
type ProbeSurface = { indices: number[]; vonMises: number[]; displacement?: number[] };

/** What the Stress panel draws over the model (viewport/stressGlyphs.ts). */
export interface StressGlyphsApi {
  setModel(m: StressGlyphModel): void;
  setProbe(on: boolean): void;
  setProbePins(pins: Pick<StressProbePin, "tri" | "weights" | "label">[]): void;
  /** The result's weakest spot as a pin; optional so a test rig can leave it out. */
  setWeakSpot?(p: Pick<StressProbePin, "tri" | "weights" | "label"> | null): void;
  /** Place mode with the orb a click would put down, a null radius for none, or null to end it. */
  setPlacing?(p: { color: number; radius: number | null } | null): void;
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

const INTERFERENCE_MARKS = "interference";
// Violet, apart from the amber hover, the orange selection and the red clash volume drawn inside the pair.
const INTERFERENCE_TINT = 0xa98bff;

export function createPanels(deps: PanelsDeps) {
  const { store, viewport, geometry, hasBody, setStatus } = deps;
  const panels = usePanelsStore();

  // Mass and filament are computed live in the panel from `raw`, so a material change needs no geometry call.
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
    // The mesh of a body that is not a sound solid has no inside, so a volume
    // summed off it and the centre of mass weighted by it are wrong.
    const built = store.buildState.result?.bodies ?? [];
    const names = bodyLabels(built, (id) => store.bodyName(id));
    const faults = built
      .filter((b) => b.fault !== undefined && p.ids.includes(b.id))
      .map((b) => `${names.get(b.id)} ${b.fault}`);
    const solid = faults.length === 0;
    const rows: PanelRow[] = [
      ...(solid ? [{ k: "Volume", v: `${displayRound(p.volume * f * f * f)} ${unit}³` }] : []),
      { k: "Surface area", v: `${displayRound(p.area * f * f)} ${unit}²` },
      ...(solid
        ? [
            {
              k: "Center of mass",
              v: `${displayRound(toDisplay(p.com.x))}, ${displayRound(toDisplay(p.com.y))}, ${displayRound(toDisplay(p.com.z))}`,
            },
          ]
        : []),
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
      raw: solid ? { volumeMm3: p.volume, areaMm2: p.area } : null,
      faults,
    });
    viewport.setComMarker(solid ? p.com : null);
  }

  /** So the center-of-mass overlay never outlives the panel that asked for it. */
  function closeProperties() {
    panels.properties = null;
    viewport.setComMarker(null);
  }

  // The optional clearance (mm) adds a near-miss pass.
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
    tinted = null;
    viewport.setFaceMarks(null, INTERFERENCE_MARKS);
    const res = await geometry.interference(store.document, clearanceMm);
    if (!res.ok) {
      setStatus(`Interference check failed: ${res.message ?? "error"}`, "error");
      return;
    }
    const pairs = res.pairs ?? [];
    const clearances = res.clearances ?? [];
    const labels = bodyLabels(store.buildState.result?.bodies ?? [], (id) => store.bodyName(id));
    const label = (id: string, raw: string) => labels.get(id) ?? raw;
    const unchecked = (res.unchecked ?? []).map((u) => `${label(u.id, u.name)} ${u.reason}`);
    const foundAny = pairs.length || clearances.length;
    const notJudged = unchecked.length
      ? `, ${unchecked.length} ${unchecked.length === 1 ? "body" : "bodies"} could not be checked`
      : "";
    setStatus(
      (foundAny
        ? `${pairs.length} interference${pairs.length === 1 ? "" : "s"}` +
          (clearanceMm ? `, ${clearances.length} close pair${clearances.length === 1 ? "" : "s"}` : "")
        : "No interferences found") + notJudged,
      foundAny || unchecked.length ? "error" : "connected",
    );
    const unit = getUnit();
    const f = toDisplay(1);
    const clashes: ClashRow[] = pairs.map((p) => ({
      k: `${label(p.a, p.aName)} ∩ ${label(p.b, p.bName)}`,
      v: `${displayRound(p.volume * f * f * f)} ${unit}³`,
      a: p.a,
      b: p.b,
    }));
    const clearanceRows: ClearanceRow[] = clearances.map((c) => ({
      k: `${label(c.a, c.aName)} ↔ ${label(c.b, c.bName)}`,
      v: `${displayRound(toDisplay(c.distance))} ${unit}`,
      a: c.a,
      b: c.b,
    }));
    panels.showInterference({
      title: pairs.length ? `Interference, ${pairs.length} clash${pairs.length > 1 ? "es" : ""}` : "Interference",
      clashes,
      clearances: clearanceRows,
      unchecked,
      ...(res.truncated ? { truncatedMessage: res.message } : {}),
    });
    viewport.setInterferenceOverlay(
      pairs,
      clearances.map((c) => ({ pointA: c.pointA, pointB: c.pointB })),
    );
  }

  function closeInterference() {
    panels.interference = null;
    viewport.setInterferenceOverlay(null, null);
    tinted = null;
    viewport.setFaceMarks(null, INTERFERENCE_MARKS);
  }

  let tinted: { build: unknown; key: string } | null = null;

  // A tint rather than a selection, which would bring up the Move gizmo and the selection toolbar over the pair.
  // A second click on the same pair clears it.
  function highlightInterference(a: string, b: string) {
    const built = store.buildState.result;
    const key = `${a} ${b}`;
    const again = tinted?.build === built && tinted.key === key;
    const faces = again
      ? []
      : (built?.bodies ?? [])
          .filter((x) => x.id === a || x.id === b)
          .flatMap((x) => Array.from({ length: x.faceCount }, (_, i) => x.faceStart + i));
    tinted = faces.length ? { build: built, key } : null;
    viewport.setFaceMarks(faces.length ? [{ faceIds: faces, color: INTERFERENCE_TINT }] : null, INTERFERENCE_MARKS);
  }

  // Stress: a linear static analysis of one body, its setup edited in the panel and saved with the document.

  // Bumped on every document change, so a reply landing after a rebuild is not painted over an edited model.
  let docEpoch = 0;
  // Bumped per Run, on close and on a body change, so a reply for an earlier Run is dropped.
  let runSeq = 0;
  // The build the face sets' display ids came from; on another build they are found again from their selector points.
  let facesFor: unknown = null;
  // The last result's colours, its document and probe surface, so "Show colours" restores them without a new Run.
  type Colours = { overlay: StressOverlay; epoch: number; surface: ProbeSurface; drawn: DrawnSurface };
  let colours: Colours | null = null;
  // The drawn corner nearest the engine's peak stress, pinned in the view while the colours show.
  type WeakSpot = Pick<StressProbePin, "tri" | "weights" | "label">;
  let weakSpot: WeakSpot | null = null;
  // The study as last written to (or read from) the document, so an edit is
  // saved once and a study the document gained some other way (a version put
  // back, an assistant's edit) is told apart from the panel's own.
  let persisted: string | null = null;
  // The last result outlives a Close and an edit, not a replacing load. `same` when the setup at the close was the
  // one it ran with, `study` that setup as saved, to tell an edit made while closed.
  let kept: {
    data: Pick<StressData, "result" | "deform" | "pins" | "colours" | "ranSetup">;
    colours: Colours | null;
    weakSpot: WeakSpot | null;
    body: string | null;
    same: boolean;
    study: string;
    load: number;
  } | null = null;
  // The arrows, axes and probe markers in the view, while the panel is open.
  let glyphs: StressGlyphsApi | null = null;
  // A load's force and direction from before a drag of its arrow, for Esc.
  const dragOrigin = new Map<number, Pick<StressLoadSetup, "direction" | "custom" | "force">>();
  // A spot's radius from before a drag of its rim, for Esc.
  let radiusOrigin: number | null = null;
  // The deformation's frame loop, and where its swing is in ms of a period. Play continues from the phase a pause held;
  // REST_PHASE is the full pose, the still shape's, so Play from still never jumps.
  let animRaf = 0;
  const REST_PHASE = SWING_PERIOD_MS / 2;
  let animPhase = REST_PHASE;
  let animFrom = REST_PHASE;
  let animT0 = 0;
  // Where the gravity arrow stands, for the build it was measured on.
  let centre: { build: unknown; body: string; at: Vec3 | null } | null = null;

  store.onDocChange(() => {
    docEpoch++;
    adoptDocumentStudy();
  });

  // Another document took this one's place: the setup's body id and face
  // points mean nothing in it.
  store.onOpen(() => {
    if (panels.stress) closeStress();
    kept = null;
  });

  // Every panel edit lands in the setup and the document saves it synchronously, so a save never trails its edit.
  watch(
    () => panels.stress?.setup,
    () => {
      persist();
      scheduleGlyphs();
    },
    { deep: true, flush: "sync" },
  );

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
    return labelledBodies(store);
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
    const faceBody = viewport
      .getSelectedFaceIds()
      .map((f) => viewport.faceIdToBodyId(f))
      .find((b) => b);
    const seed = picked.length === 1 ? picked[0]! : (faceBody ?? (bodies.length === 1 ? bodies[0]!.id : null));
    if (panels.stress) panels.showStress(seed ?? null);
    else loadStudy(store.stressStudy, seed ?? null);
    glyphs ??= deps.stressGlyphs?.(glyphHandlers) ?? null;
    refreshStressMarks();
    restoreKept();
  }

  function restoreKept() {
    const k = kept;
    kept = null;
    const d = panels.stress;
    if (!k?.data.result || !d || d.result || d.setup.body !== k.body || k.load !== store.loadCount) return;
    panels.stressFinished({ result: k.data.result });
    const study = JSON.stringify(store.stressStudy);
    d.ranSetup = k.same && study === k.study ? JSON.stringify(d.setup) : k.data.ranSetup;
    if (!k.colours || k.colours.epoch !== docEpoch || k.data.colours === "none") return;
    colours = k.colours;
    weakSpot = k.weakSpot;
    if (k.data.deform) panels.setStressDeform({ ...k.data.deform, animate: false });
    d.pins = k.data.pins;
    glyphs?.setProbePins(d.pins);
    panels.setStressColours("hidden");
    if (k.data.colours === "shown") setStressColours(true);
    else refreshStressMarks();
  }

  /** Faces are found on the build by the next relocation. Reading it back is not an edit, so the document stays
   *  unchanged, and a saved study with no body stays so until the user picks one. */
  function loadStudy(study: Readonly<StressStudy> | null, seed: string | null) {
    facesFor = null;
    const setup = study ? setupFromStudy(study, (sel) => ({ ...emptyFaceSet(), selectors: sel })) : newSetup(seed);
    persisted = JSON.stringify(study ?? studyFromSetup(setup));
    stopAnimation();
    colours = null;
    viewport.setStressOverlay(null);
    panels.replaceStressSetup(setup);
    glyphs?.setProbePins([]);
    weakSpot = null;
    showWeakSpot();
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

  /** By its point, as the engine resolves a picked face, or by a flat fingerprint's centroid. Undefined when the view
   *  cannot place it (a centroid can miss an L-shaped face); never an error, since it runs on every rebuild. */
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

  /** Moves each selector to the nearest face on the analysed body. Nothing is dropped, a missing face may return next
   *  build; it counts as missing, stays untinted and blocks a Run. Returns the missing count, 0 if already current. */
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

  /** Tints support and load faces after finding them on the new build, but not over the result's colours or on a hidden
   *  body. Called by the rebuild bridge after every model it draws. */
  function refreshStressMarks() {
    const d = panels.stress;
    if (!d) {
      viewport.setFaceMarks(null);
      return;
    }
    // An edit makes the colours stale for good; a model drawn again without
    // one (an eye toggle) only took them off.
    if (d.colours !== "none" && !(colours && colours.epoch === docEpoch)) dropResultDrawing();
    else if (d.colours !== "none" && !viewport.hasStressOverlay()) {
      stopAnimation();
      panels.setStressColours("hidden");
      drawOverlay();
      showWeakSpot();
    }
    const missing = relocateStressFaces();
    if (missing && !bodyOnModel()) {
      setStatus(
        "Stress: the body analysed is not on the current model; its setup is kept for when it is back, or pick another body",
        "",
      );
    } else if (missing) {
      setStatus(
        `Stress: ${missing} face${missing === 1 ? " is" : "s are"} not found on the current model, set the faces again`,
        "",
      );
    }
    drawGlyphs();
    const s = d.setup;
    if (d.colours === "shown" || shapeDrawn() || !s.body || !store.isBodyVisible(s.body)) {
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
    weakSpot = null;
    showWeakSpot();
  }

  /** The weakest spot's pin, shown while the result is, colours or not. */
  function showWeakSpot() {
    const c = panels.stress?.colours;
    glyphs?.setWeakSpot?.(c === "shown" || c === "hidden" ? weakSpot : null);
  }

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
        tris.push([
          [t.a.x, t.a.y, t.a.z],
          [t.b.x, t.b.y, t.b.z],
          [t.c.x, t.c.y, t.c.z],
        ]);
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
        if (drawable(spot.radius))
          m.spots!.push({
            target: { support: x.id },
            index,
            at: spot.at,
            radius: spot.radius,
            color: SUPPORT_COLORS[x.type],
          });
      }
    }
    for (const l of s.loads) {
      const spots = l.spots ?? [];
      for (const [index, spot] of spots.entries()) {
        if (drawable(spot.radius))
          m.spots!.push({ target: { load: l.id }, index, at: spot.at, radius: spot.radius, color: LOAD_MARK_COLOR });
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
      // The force sign is part of the direction, so dragging along the arrow writes a positive force back.
      const force = Number(l.force) || 0;
      const flip = force < 0;
      m.forces.push({
        loadId: l.id,
        anchor,
        dir: flip ? negate(dir) : dir,
        force: Math.abs(force),
        direction: flip ? oppositeDirection(l.direction) : l.direction,
        into: intoDirection(l.faces, l.spots),
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
      if (!dragOrigin.has(loadId))
        dragOrigin.set(loadId, { direction: l.direction, custom: [...l.custom], force: l.force });
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
      const at = colours ? engineHit(colours.drawn, hit.tri, hit.weights) : null;
      const v = colours && at ? probeValues(colours.surface, at.tri, at.weights) : null;
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
      if (d.placeAs === "face") addStressFace(target, hit.body, hit.faceId, hit.at);
      else {
        const radius = spotRadiusFor(hit.body);
        panels.addStressSpot(target, {
          at: hit.at.map(round4) as Vec3,
          radius,
          normal: hit.normal.map(round4) as Vec3,
        });
      }
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

  /** The next click on the body adds the face clicked, whole, or with `as` "spot" puts a spot there; the same button
   *  again or Esc disarms. The result's colours come off first, as the click is on the body. */
  function placeStressSpot(target: StressTarget, as: "face" | "spot" = "face") {
    const d = panels.stress;
    if (!d) return;
    if (sameTarget(d.placing, target) && d.placeAs === as) {
      stopPlacing();
      return;
    }
    const row = panels.stressRow(target);
    if (!row) return;
    if (d.probe) setStressProbe(false);
    if (d.colours === "shown") setStressColours(false);
    if (d.deform?.shown) setStressShape(false);
    const body = bodyOnModel();
    panels.setStressPlacing(target, as);
    const color = "support" in target ? SUPPORT_COLORS[(row as { type: StressSupportType }).type] : LOAD_MARK_COLOR;
    const radius = as === "face" ? null : body ? spotRadiusFor(body) : defaultSpotRadius(NaN);
    glyphs?.setPlacing?.({ color, radius });
  }

  /** Adds the clicked face to the row's faces, by the point clicked, which the engine resolves to that face as it
   *  does a picked one. A face the row already holds is left as it is. */
  function addStressFace(target: StressTarget, body: string, faceId: number, at: Vec3) {
    relocateStressFaces();
    const row = panels.stressRow(target);
    if (!row || row.faces.faceIds.includes(faceId)) return;
    const was = row.faces;
    const faces: StressFaceSet = {
      ...faceSet(
        [...was.selectors, { kind: "face", by: "nearest", point: at.map(round4) as Vec3, body }],
        [...was.faceIds, faceId],
      ),
      ...(was.missing ? { missing: was.missing } : {}),
      ...(was.unshown !== undefined ? { unshown: was.unshown } : {}),
    };
    if ("support" in target) panels.setStressSupportFaces(target.support, faces);
    else panels.setStressLoadFaces(target.load, faces);
    refreshStressMarks();
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
    return {
      faces: faceSet(
        sel.selectors.map((x) => ({ ...x, body })),
        sel.faceIds,
      ),
      body,
    };
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
    weakSpot = null;
    showWeakSpot();
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

  /** The overlay as it should be drawn now: coloured or plain, and deformed at the slider's pose while the shape is
   *  shown. Plain and still, it leaves the body itself on show. */
  function overlayNow(): StressOverlay | null {
    const d = panels.stress;
    if (!colours || !d || d.colours === "none") return null;
    const { displacement, ...still } = colours.overlay;
    const o = { ...still, colours: d.colours === "shown" };
    return displacement && d.deform?.shown ? { ...o, displacement, scale: poseScale() } : o;
  }

  function drawOverlay() {
    const o = overlayNow();
    viewport.setStressOverlay(o && store.isBodyVisible(o.bodyId) ? o : null);
  }

  /** The deformed shape stands in for the body, so its faces cannot be picked or tinted. */
  function shapeDrawn(): boolean {
    return !!colours?.overlay.displacement && !!panels.stress?.deform?.shown;
  }

  /** Put the last result's colours on the body, or take them off. The deformed shape keeps its own switch. Only
   *  while the model is the one they were for. */
  function setStressColours(on: boolean) {
    const d = panels.stress;
    if (!d || d.colours === "none") return;
    if (on && !(colours && colours.epoch === docEpoch)) {
      dropResultDrawing();
      return;
    }
    if (!on && d.probe) setStressProbe(false);
    panels.setStressColours(on ? "shown" : "hidden");
    drawOverlay();
    refreshStressMarks();
    showWeakSpot();
  }

  /** Draw the deformed shape, or the body as built so its faces can be picked again with the colours off. */
  function setStressShape(on: boolean) {
    const d = panels.stress;
    if (!d?.deform || d.colours === "none" || d.deform.shown === on) return;
    if (on && !(colours && colours.epoch === docEpoch)) {
      dropResultDrawing();
      return;
    }
    if (!on) pauseAnimation();
    d.deform.shown = on;
    drawOverlay();
    refreshStressMarks();
  }

  /** Draw the deformed shape at `scale` times the true deflection. */
  function setStressDeformation(scale: number) {
    const def = panels.stress?.deform;
    if (!def || !Number.isFinite(scale)) return;
    def.scale = Math.max(0, scale);
    if (def.scale > def.max) def.max = def.scale;
    if (!def.animate) {
      animPhase = REST_PHASE;
      viewport.setStressDeformation(def.scale);
    }
  }

  /** Play the deformation's swing from the pose on screen, or pause it there. */
  function setStressAnimate(on: boolean) {
    const def = panels.stress?.deform;
    if (!def) return;
    if (!on) {
      pauseAnimation();
      return;
    }
    if (!def.shown) setStressShape(true);
    if (!def.shown) return;
    def.animate = true;
    startAnimation();
  }

  /** The deformation scale drawn now: the slider's, or the pose a pause holds. */
  function poseScale(): number {
    const scale = panels.stress?.deform?.scale ?? 0;
    return animPhase === REST_PHASE ? scale : swingScale(animPhase, scale);
  }

  function startAnimation() {
    if (animRaf || typeof requestAnimationFrame !== "function") return;
    animT0 = performance.now();
    animFrom = animPhase;
    const step = (now: number) => {
      animRaf = 0;
      const d = panels.stress;
      if (!d?.deform?.animate || !d.deform.shown || d.colours === "none") return;
      animPhase = animFrom + (now - animT0);
      viewport.setStressDeformation(swingScale(animPhase, d.deform.scale));
      animRaf = requestAnimationFrame(step);
    };
    animRaf = requestAnimationFrame(step);
  }

  /** Hold the swing where it is now. */
  function pauseAnimation() {
    if (animRaf) {
      cancelAnimationFrame(animRaf);
      animRaf = 0;
      animPhase = animFrom + (performance.now() - animT0);
    }
    const def = panels.stress?.deform;
    if (def?.animate) {
      def.animate = false;
      viewport.setStressDeformation(poseScale());
    }
  }

  /** End the swing for good and leave the shape at the slider's scale. */
  function stopAnimation() {
    if (animRaf) cancelAnimationFrame(animRaf);
    animRaf = 0;
    const held = animPhase !== REST_PHASE;
    animPhase = REST_PHASE;
    const def = panels.stress?.deform;
    if (def && (def.animate || held)) {
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
      panels.stressFinished({
        error:
          "The body analysed is not on the current model. Pick another body, or bring the model back to where it has it.",
      });
      return;
    }
    // Faces the model lacks are refused here, by the support or load they are in.
    const req = buildStressRequest(d.setup);
    if (!req.ok) {
      panels.stressFinished({ error: sentence(req.message) });
      return;
    }
    const seq = ++runSeq;
    const epoch = docEpoch;
    stopPlacing();
    panels.stressStarted();
    clearResult();
    refreshStressMarks();
    const res = await geometry.stress(store.builtDocument(), req.body, req.options, (id) => {
      if (seq === runSeq) panels.stressSent(id);
    });
    if (seq !== runSeq || !panels.stress) return;
    if (!res.ok) {
      const message = panelMessage(res.message);
      panels.stressFinished(res.cancelled ? {} : { error: sentence(message) });
      setStatus(
        res.cancelled ? "Stress analysis cancelled" : `Stress analysis failed: ${message}`,
        res.cancelled ? "" : "error",
      );
      return;
    }
    const r = res.result;
    const view = formatStressResult(
      r,
      getUnit(),
      (req.options.supports ?? []).map((x) => x.type),
    );
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
      // Drawn finer than the engine's mesh so the part bends smoothly; the numbers stay the engine's.
      const drawn = refineSurface(r.surface, refineLevel(r.surface.indices.length / 3));
      colours = {
        overlay: {
          bodyId: r.body,
          positions: drawn.positions,
          indices: drawn.indices,
          values: drawn.values,
          range: view.legend,
          ...(moves && drawn.displacement ? { displacement: drawn.displacement } : {}),
        },
        epoch,
        surface: r.surface,
        drawn,
      };
      const peak = nearestVertex(r.surface.positions, r.maxVonMises.at);
      const corner = peak < 0 ? null : drawnCorner(drawn, peak);
      weakSpot = corner && { ...corner, label: weakSpotLabel(r.safetyFactor) };
      if (moves) {
        const auto = autoDeformScale(r.surface.positions, disp!);
        panels.setStressDeform({ scale: auto, auto, max: deformSliderMax(auto), animate: false, shown: true });
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
    const d = panels.stress;
    if (d?.running) void cancelStress();
    stopAnimation();
    kept =
      d?.result && !d.running
        ? {
            data: { result: d.result, deform: d.deform, pins: d.pins, colours: d.colours, ranSetup: d.ranSetup },
            colours,
            weakSpot,
            body: d.setup.body,
            same: d.ranSetup === JSON.stringify(d.setup),
            study: JSON.stringify(store.stressStudy),
            load: store.loadCount,
          }
        : null;
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
    showProperties,
    closeProperties,
    showInterference,
    closeInterference,
    highlightInterference,
    showOverhangSettings,
    closeOverhangSettings,
    showStress,
    closeStress,
    runStress,
    cancelStress,
    stressBodies,
    setStressBody,
    setStressFacesFromSelection,
    placeStressSpot,
    removeStressSpot,
    addStressSupport,
    removeStressSupport,
    setStressSupportType,
    addStressLoad,
    removeStressLoad,
    setStressColours,
    setStressShape,
    refreshStressMarks,
    setStressDeformation,
    setStressAnimate,
    pauseStressAnimation: pauseAnimation,
    setStressProbe,
    removeStressProbe,
  };
}

export type Panels = ReturnType<typeof createPanels>;
