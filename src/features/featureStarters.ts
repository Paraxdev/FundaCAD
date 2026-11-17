// The tool starters (Sketch, Extrude, Fillet, the booleans, Revolve, Loft and the rest) and the plane and face pickers
// they share, closing over main.ts's singletons passed in once via createFeatureStarters.
import * as THREE from "three";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { SketchMode, SketchTool } from "../sketch/sketchMode";
import { SketchPlane } from "../sketch/plane";
import {
  alongPolyline,
  axisFromEdge,
  cross3,
  dist3,
  midPlane,
  planeFromPointNormal,
  planesMeet,
  planeThroughPoints,
  unit,
} from "./planeMath";
import { BOOLEAN_LABEL, type BooleanOp } from "./booleanOps";
import type { ExtrudeTool } from "./extrudeTool";
import type { EdgeFeatureTool } from "./edgeFeatureTool";
import type { PressPullTool } from "./pressPullTool";
import type { LoftTool } from "./loftTool";
import type { MoveTool } from "./moveTool";
import type { MoveTarget } from "./moveTarget";
import { sketchFeatureTarget } from "./sketchMoveTarget";
import type { PatternKind, PatternTool } from "./patternTool";
import type { MirrorTool } from "./mirrorTool";
import { featureOwnersOfFaces, patternStart, type PatternCandidates } from "./patternSources";
import type { PlaneOffsetTool } from "./planeOffsetTool";
import type { DatumPoseTool } from "./datumPoseTool";
import { placeDatum, poseFields, ZERO_POSE, type DatumPose } from "../document/datumPose";
import { curvedFaceRow, facePlaneOfRow, pickPlaneTarget, planeSpecOf, type FacePlanePick } from "./facePlanePick";
import { bodyLabels } from "../ui/bodyLabels";
import { choose } from "../ui/choice";
import { confirmEdgeCount, edgeGate } from "./edgeCountGate";
import { pointInRegion } from "../sketch/region";
import { setPrompt } from "../ui/prompt";
import type {
  Axis3,
  AxisSpec,
  Feature,
  JointMode,
  MechanismJoint,
  PlaneDef,
  PlaneOf,
  PlaneSpec,
  PointAt,
  Selector,
  Vec3,
} from "../types";
import { asFeature } from "../types";
import { dismissToast, toast } from "../ui/toast";
import { resolveRealEntities } from "../sketch/resolve";
import { worldPointInRegion } from "../sketch/regionSelect";
import { defaultReach, gapReport, type GapReport } from "../sketch/looseEnds";
import { edgeMatchSelectorFrom, edgeSelectorFrom } from "../viewport/edgeMatch";
import type { Hit } from "../viewport/picking";
import { isDrivable, nextJointId, NO_DRIVE } from "../document/mechanism";
import { upgradeFace } from "./holeFace";
import { findSelectorAt, repickedExtent, repickedSelector, replaceSelectorAt } from "./repickReference";
import { awaitTreePick, treePickRefusal } from "../ui/treePick";
import { deferPick } from "./deferPick";
import { THIN_DEFAULTS, thinExtrudeOf } from "./thinExtrude";
import { t } from "../i18n";
import { numberedName } from "../ui/featureMeta";
import { fmtLength } from "../ui/units";

export interface FeatureStartersDeps {
  store: DocumentStore;
  viewport: Viewport;
  overlay: SketchOverlay;
  sketch: SketchMode;
  extrude: ExtrudeTool;
  edgeFeature: EdgeFeatureTool;
  pressPull: PressPullTool;
  loftTool: LoftTool;
  moveTool: MoveTool;
  patternTool: PatternTool;
  mirrorTool: MirrorTool;
  planeOffset: PlaneOffsetTool;
  datumPose: DatumPoseTool;
  canvas: HTMLCanvasElement;
  toolBusy: () => boolean;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  /** `explicit` false for a selection the app makes, see stores/selection.ts. */
  selectFeature: (id: string | null, explicit?: boolean) => void;
  noteCommitted: (id: string | null) => void;
  isSketchConsumed: (id: string) => boolean;
  getSelectedFeature: () => string | null;
  /** Whether the user picked the selected feature, see stores/selection.ts. */
  getSelectedFeatureExplicit?: () => boolean;
  setPlanePick: (v: boolean) => void;
  /** the Move gizmo's target for a selected datum plane */
  datumMoveTarget: (id: string) => MoveTarget | null;
}

/** Split and Cut ask the same question. */
function keepSides(): { value: "both" | "top" | "bottom"; label: string; hint: string }[] {
  return [
    { value: "both", label: t("tool.split.both"), hint: t("tool.split.bothHint") },
    { value: "top", label: t("tool.split.top"), hint: t("tool.split.topHint") },
    { value: "bottom", label: t("tool.split.bottom"), hint: t("tool.split.bottomHint") },
  ];
}

/** What keeps a sketch from closing, said at the end of a refusal. */
type TieWhy = { why: "gap"; gap: string } | { why: "open" | "loose"; n: number } | null;

function tieArgs(tie: TieWhy): { why: string; gap: string; n: number } {
  if (!tie) return { why: "none", gap: "", n: 0 };
  return tie.why === "gap" ? { why: "gap", gap: tie.gap, n: 0 } : { why: tie.why, gap: "", n: tie.n };
}

export function createFeatureStarters(deps: FeatureStartersDeps) {
  const {
    store,
    viewport,
    overlay,
    sketch,
    extrude,
    edgeFeature,
    pressPull,
    loftTool,
    moveTool,
    patternTool,
    mirrorTool,
    planeOffset,
    datumPose,
    canvas,
    toolBusy,
    hasBody,
    setStatus,
    selectFeature,
    noteCommitted,
    getSelectedFeature,
    getSelectedFeatureExplicit = () => true,
    setPlanePick,
    datumMoveTarget,
  } = deps;

  // Selecting what was just committed is the app's doing, not a pick of the
  // user's, so Pattern and Delete do not read it as one.
  const committed = (id: string | null) => {
    noteCommitted(id);
    if (id) selectFeature(id, false);
  };

  /** A big selection asks first (edgeCountGate.ts). The tool waits for the answer, so a handle grab that had to ask
   *  opens on its arrow without scrubbing: the pointer that pressed it is long gone. */
  const startEdgeFeature = (kind: "fillet" | "chamfer", opts?: Parameters<EdgeFeatureTool["start"]>[2]) => {
    if (toolBusy()) return;
    const count = edgeFeature.seedCount(kind);
    if (edgeGate(count) === "go") {
      edgeFeature.start(kind, committed, opts);
      return;
    }
    void confirmEdgeCount(kind, count).then((ok) => {
      const { grabAt: _, ...arrow } = opts ?? {};
      if (ok && !toolBusy()) edgeFeature.start(kind, committed, opts ? arrow : undefined);
    });
  };
  const startFillet = () => startEdgeFeature("fillet");
  /** Fillet on the edge the carry on just selected, closed when the step it rests on is undone. */
  const startFilletOn = (restsOn: string | null) => startEdgeFeature("fillet", restsOn ? { restsOn } : undefined);
  const startChamfer = () => startEdgeFeature("chamfer");
  const startChamferOn = (restsOn: string | null) => startEdgeFeature("chamfer", restsOn ? { restsOn } : undefined);
  /** The edge selection handle was pressed (features/edgeNudge.ts): arm the same tool already holding the arrow. It
   *  opens on fillet, the arrow's own direction, since asking first would put a decision before the gesture; a
   *  chamfer is one drag back through zero, or one Tab, away. */
  const grabEdgeHandle = (x: number, y: number, tangent: THREE.Vector3 | null, anchor?: THREE.Vector3) =>
    startEdgeFeature("fillet", { tangent, grabAt: { x, y }, ...(anchor ? { anchor } : {}) });
  const startPressPull = () => {
    if (toolBusy()) return;
    pressPull.start(committed);
  };
  const startPressPullOn = (restsOn: string | null) => {
    if (toolBusy()) return;
    pressPull.start(committed, restsOn ? { restsOn } : undefined);
  };
  /** The same hand-off for a selected face's arrow (features/faceNudge.ts); a face has one drag, so no default. */
  const grabFaceHandle = (x: number, y: number) => {
    if (toolBusy()) return;
    pressPull.start(committed, { grabAt: { x, y } });
  };

  /** `face` is the picked body face (null for a construction quad), kept by a datum plane to follow it. `datumId`
   *  lets a sketch follow its datum when the offset is edited later, as the browser's "Sketch on plane" does. */
  function pickPlaneInteractive(
    promptText: string,
    onPick: (spec: PlaneSpec, face: FacePlanePick | null, datumId: string | null) => void,
    opts: { roundFace?: boolean } = {},
  ) {
    if (toolBusy()) return;
    setPlanePick(true);
    viewport.showAllPlanes(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    // Hover and click ask facePlanePick the same question, so a lit face is one the click will take. A refused face
    // gets no highlight, so say why once on the transition rather than on every pointermove.
    let sayingWhy = false;
    const onMove = (e: PointerEvent) => {
      const target = pickPlaneTarget(viewport, e.clientX, e.clientY);
      if (target?.kind === "face") {
        viewport.hoverFaceAt(e.clientX, e.clientY); // highlight a selectable body face
        viewport.hoverPlane(null);
        viewport.hoverDatum(null);
      } else {
        viewport.clearHover();
        viewport.hoverPlane(target?.kind === "base" ? target.spec : null);
        // A datum lights up like a base plane: what is lit is what the click takes.
        viewport.hoverDatum(target?.kind === "datum" ? target.id : null);
      }
      const why = target?.kind === "unusable";
      if (why !== sayingWhy) {
        sayingWhy = why;
        setPrompt(why ? t("tool.datum.noPlane", { prompt: promptText }) : promptText);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Nothing usable: stay in the pick. A body face with no plane deliberately does not fall through to the
      // construction quad behind the part.
      const target = pickPlaneTarget(viewport, e.clientX, e.clientY);
      const spec = planeSpecOf(target);
      if (!spec) return;
      const face = target?.kind === "face" ? target.face : null;
      const datumId = target?.kind === "datum" ? target.id : null;
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      deferPick(viewport.domElement, () => onPick(spec, face, datumId));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const releaseTree = awaitTreePick(
      (pick) => {
        if (pick.kind === "face" && opts.roundFace) {
          const round = facePlaneOfRow(viewport, pick.faceId);
          if (!round) return t("tool.datum.notRound");
          if (round.kind !== "tangent") return t("tool.datum.flatNotRound");
          cleanup();
          deferPick(viewport.domElement, () => onPick(round.def, round, null));
          return true;
        }
        if (pick.kind === "face") {
          const flat = viewport.faceSketchPlane(pick.faceId);
          if (!flat) return curvedFaceRow();
          const { selector, at } = flat.anchor;
          cleanup();
          deferPick(viewport.domElement, () =>
            onPick(flat.plane, { def: flat.plane, kind: "planar", selector, faceId: flat.faceId, at }, null),
          );
          return true;
        }
        const spec = pick.kind === "basePlane" ? pick.plane : pick.kind === "datumPlane" ? pick.def : null;
        if (!spec || opts.roundFace) return treePickRefusal(pick, opts.roundFace ? "roundFace" : "planeOrFace");
        cleanup();
        deferPick(viewport.domElement, () => onPick(spec, null, pick.kind === "datumPlane" ? pick.id : null));
        return true;
      },
      () => cleanup(),
    );
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.showAllPlanes(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      viewport.hoverDatum(null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  /** A selected planar face is used outright, asking again could only go wrong. The selection is dropped so no stale
   *  press/pull offer sits behind the sketch or re-consumes the face, and viewport.showSketchFace lights it instead. */
  function startSketch(tool?: SketchTool) {
    if (!toolBusy()) {
      const face = viewport.selectedFaceSketchPlane();
      if (face) {
        viewport.clearSelection();
        // The anchor rides in on both routes, or a sketch from a selected face could not follow its face.
        sketch.enter(face.plane, store, undefined, undefined, face.anchor);
        viewport.showSketchFace(face.faceId);
        if (tool) sketch.setTool(tool);
        return;
      }
    }
    pickPlaneInteractive(t("tool.datum.sketchOn"), (spec, face, datumId) => {
      // Only a planar face can be followed, a tangent plane is defined by the pick's own point. A datum is followed
      // by id, so editing its offset moves this sketch.
      sketch.enter(
        spec,
        store,
        undefined,
        datumId ?? undefined,
        face && face.kind === "planar" ? { selector: face.selector, at: face.at } : null,
      );
      if (face) viewport.showSketchFace(face.faceId);
      if (tool) sketch.setTool(tool);
    });
  }

  // Offset Plane: pick a plane or face, drag or type the offset, then sketch on it. It saves a parametric
  // `datumPlane` (source plus editable offset) and enters the sketch by id, so editing the offset moves the sketch.
  function offsetPlane() {
    // A selected face is the reference, as in startSketch; its selector rides onto the datum, and clearing the
    // selection stops a stale press/pull offer sitting behind the plane.
    if (!toolBusy()) {
      const face = viewport.selectedFaceSketchPlane();
      if (face) {
        viewport.clearSelection();
        startOffsetFrom(face.plane, { face: face.anchor.selector });
        return;
      }
    }
    pickPlaneInteractive(t("tool.datum.offsetFrom"), (spec, face, datumId) => {
      startOffsetFrom(spec, { ...faceRef(face), ...(datumId ? { planeId: datumId } : {}) });
    });
  }

  /** Shared by the pick route and the selected face shortcut so both build the same feature. */
  function startOffsetFrom(spec: PlaneSpec, ref: DatumRef) {
    placeNewDatum(spec, ref, (id, def) => sketch.enter(def, store, undefined, id));
  }

  /** Where a new datum hangs from: a face it follows, or a parent datum. */
  type DatumRef = { face?: Selector; at?: Vec3; planeId?: string };

  /** The pose is stored relative to the reference, so the plane stays parametric. */
  function placeNewDatum(spec: PlaneSpec, ref: DatumRef, then: (id: string, def: PlaneDef) => void) {
    datumPose.start({ src: spec, pose: ZERO_POSE, ghost: true }, (pose: DatumPose | null, bySave) => {
      if (!pose) return;
      const id = store.nextId();
      store.addFeature({
        id,
        type: "datumPlane",
        plane: spec,
        offset: pose.offset,
        ...poseFields(pose),
        ...ref,
      } as Feature);
      if (!bySave) then(id, placeDatum(spec, pose));
    });
  }

  // Datum Plane: a source plane plus a scalar offset rather than a baked plane, so the offset stays editable. A round
  // face gives its tangent plane at the click (planeMath.tangentPlaneOnCylinder) and the offset then runs radially.
  function createDatumPlane() {
    pickPlaneInteractive(t("tool.datum.planeFrom"), (spec, face, datumId) => {
      placeNewDatum(spec, { ...faceRef(face), ...(datumId ? { planeId: datumId } : {}) }, (id) =>
        selectFeature(id, false),
      );
    });
  }

  /** SketchPlane is the one place that turns a named base plane into a def. */
  function asDef(spec: PlaneSpec): PlaneDef {
    const sp = new SketchPlane(spec);
    return {
      origin: [sp.origin.x, sp.origin.y, sp.origin.z],
      normal: [sp.n.x, sp.n.y, sp.n.z],
      xdir: [sp.u.x, sp.u.y, sp.u.z],
    };
  }

  // Midplane: the plane between two picks (planeMath.midPlane says what that means when they are not parallel).
  // Picks with a reference (flat face, datum, world plane) are kept so it follows either wall; a tangent plane bakes.
  function createMidplane() {
    pickPlaneInteractive(t("tool.datum.midFirst"), (a, fa, da) => {
      // Next frame, like the pick's own commit: the first pick's click must not
      // arrive at the second pick's listeners.
      requestAnimationFrame(() => {
        pickPlaneInteractive(t("tool.datum.midSecond"), (b, fb, db) => {
          const def = midPlane(asDef(a), asDef(b));
          if (!def) {
            setStatus(t("tool.datum.midNone"), "");
            return;
          }
          const ra = planeOfPick(a, fa, da);
          const rb = planeOfPick(b, fb, db);
          const id = store.nextId();
          store.addFeature({
            id,
            type: "datumPlane",
            plane: def,
            name: "Midplane",
            ...(ra && rb ? { through: { kind: "mid", a: ra, b: rb } } : {}),
          } as Feature);
          selectFeature(id, false);
        });
      });
    });
  }

  function planeOfPick(spec: PlaneSpec, face: FacePlanePick | null, datumId: string | null): PlaneOf | null {
    // Tracked rather than nearest: once the part grows, the picked point can
    // sit nearer a neighbouring face than the one it was picked on.
    if (face) return face.kind === "planar" ? { face: upgradeFace(face.selector, face.def.normal) } : null;
    if (datumId) return { plane: datumId };
    return typeof spec === "string" ? { plane: spec } : null;
  }

  // Plane through three points, for a plane no face lies in. Points use the gizmo origin's snap (viewport.pointAt);
  // edge ends and middles are kept as references, a bare surface spot leaves the plane baked.
  function createPlaneThroughPoints() {
    pickPointsInteractive(3, t("tool.datum.threePoints"), (pts, refs) => {
      const [a, b, c] = pts;
      const def = a && b && c ? planeThroughPoints(a, b, c) : null;
      if (!def) {
        setStatus(t("tool.datum.pointsInLine"), "");
        return;
      }
      const id = store.nextId();
      const points = allRefs(refs);
      store.addFeature({
        id,
        type: "datumPlane",
        plane: def,
        name: "Plane",
        ...(points ? { through: { kind: "points", points } } : {}),
      } as Feature);
      selectFeature(id, false);
    });
  }

  // Datum Point: one snapped click saved as a named reference to measure and snap to; it builds no geometry. On an
  // edge end or middle it follows that edge, on a bare surface spot the coordinate is baked.
  function createDatumPoint() {
    pickPointsInteractive(1, t("tool.datum.point"), (pts, refs) => {
      const [p] = pts;
      if (!p) return;
      const at = refs[0];
      const id = store.nextId();
      store.addFeature({ id, type: "datumPoint", point: p, name: "Point", ...(at ? { at } : {}) } as Feature);
      selectFeature(id, false);
    });
  }

  // Datum Axis: the line through two clicks, `origin` the first and `dir` the second minus the first, for a revolve,
  // circular pattern or mirror to aim at. Follows its points like the datum point.
  function createDatumAxis() {
    pickPointsInteractive(2, t("tool.datum.axisPoints"), (pts, refs) => {
      const [a, b] = pts;
      if (!a || !b) return;
      const dir: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-6) {
        setStatus(t("tool.datum.axisSamePoint"), "");
        return;
      }
      const id = store.nextId();
      const both = allRefs(refs);
      store.addFeature({
        id,
        type: "datumAxis",
        origin: a,
        dir,
        name: "Axis",
        ...(both && both[0] && both[1] ? { through: { kind: "points", a: both[0], b: both[1] } } : {}),
      } as Feature);
      selectFeature(id, false);
    });
  }

  // Datum Axis on an edge: the engine re-resolves the edge every rebuild so the axis follows the part. The baked
  // origin and dir written here are the cache the follow falls back to.
  function createDatumAxisOnEdge() {
    pickEdgeInteractive(t("tool.datum.axisEdge"), (sel, points) => {
      const line = axisFromEdge(points as Vec3[]);
      if (!line) {
        setStatus(t("tool.datum.axisNotStraight"), "");
        return;
      }
      const id = store.nextId();
      store.addFeature({
        id,
        type: "datumAxis",
        origin: line.origin,
        dir: line.dir,
        axisEdge: sel,
        name: "Axis",
      } as Feature);
      selectFeature(id, false);
    });
  }

  function allRefs(refs: (PointAt | null)[]): PointAt[] | null {
    return refs.every((r): r is PointAt => r !== null) ? refs : null;
  }

  /** A preselected edge (right-click selects it first) is taken as the pick, otherwise the edge is picked. */
  function withEdge(promptText: string, onPick: (sel: Selector, points: readonly Vec3[]) => void) {
    const pre = viewport.selectedEdgeLines();
    const only = pre.length === 1 ? pre[0] : undefined;
    const pts = only?.points.map((q) => [q[0], q[1], q[2]] as Vec3);
    const sel = only && pts ? edgeMatchSelectorFrom({ points: pts, body: only.body }) : undefined;
    if (sel && pts && !toolBusy()) onPick(sel, pts);
    else pickEdgeInteractive(promptText, onPick);
  }

  function matchEdge(points: readonly Vec3[], sel: Selector): Selector {
    const body = (sel as { body?: string }).body;
    return edgeMatchSelectorFrom({ points: points as Vec3[], body }) ?? sel;
  }

  // Plane normal to an edge, starting at its middle; `t` is the fraction along it (0 one end, 1 the other). The
  // engine re-resolves the edge every rebuild, so a longer edge keeps the plane at the same fraction.
  function createPlaneNormalToEdge() {
    withEdge(t("tool.datum.normalEdge"), (sel, points) => {
      const at = alongPolyline(points, 0.5);
      const def = at && planeFromPointNormal(at.p, at.tangent);
      if (!def) return;
      const id = store.nextId();
      store.addFeature({
        id,
        type: "datumPlane",
        plane: def,
        name: "Normal plane",
        t: 0.5,
        through: { kind: "normalToEdge", edge: matchEdge(points, sel) },
      } as Feature);
      selectFeature(id, false);
    });
  }

  // Plane through two edges: two parallel edges, or two that cross in one plane.
  function createPlaneThroughEdges() {
    pickEdgeInteractive(t("tool.datum.edgeFirst"), (sa, pa) => {
      requestAnimationFrame(() => {
        pickEdgeInteractive(t("tool.datum.edgeSecond"), (sb, pb) => {
          const a0 = pa[0];
          const a1 = pa[pa.length - 1];
          const b0 = pb[0];
          const b1 = pb[pb.length - 1];
          const def = a0 && a1 && b0 && b1 ? planeThroughPoints(a0, a1, dist3(a0, b0) > dist3(a0, b1) ? b0 : b1) : null;
          if (!def) {
            setStatus(t("tool.datum.edgesInLine"), "");
            return;
          }
          const id = store.nextId();
          store.addFeature({
            id,
            type: "datumPlane",
            plane: def,
            name: "Plane",
            through: { kind: "twoEdges", a: matchEdge(pa, sa), b: matchEdge(pb, sb) },
          } as Feature);
          selectFeature(id, false);
        });
      });
    });
  }

  // Plane at an angle: a straight edge as the hinge, then the face or plane the angle is measured from, 45 degrees
  // to start. The engine places it, this first placement is only the cache.
  function createPlaneAtAngle() {
    withEdge(t("tool.datum.angleHinge"), (sel, points) => {
      const line = axisFromEdge(points as Vec3[]);
      if (!line) {
        setStatus(t("tool.datum.angleHingeStraight"), "");
        return;
      }
      requestAnimationFrame(() => {
        pickPlaneInteractive(t("tool.datum.angleFrom"), (spec, face, datumId) => {
          const from = planeOfPick(spec, face, datumId);
          if (!from) {
            setStatus(t("tool.datum.angleFromFlat"), "");
            return;
          }
          const angle = 45;
          const hinge = matchEdge(points, sel);
          // The engine turns about the fingerprint's direction, so this cache does too.
          const u = unit((hinge as { fp?: { dir?: Vec3 } }).fp?.dir ?? line.dir);
          const n0 = asDef(spec).normal;
          if (!u) return;
          const r = (angle * Math.PI) / 180;
          const k = cross3(u, n0);
          const d = u[0] * n0[0] + u[1] * n0[1] + u[2] * n0[2];
          const n: Vec3 = [0, 1, 2].map(
            (i) => n0[i]! * Math.cos(r) + k[i]! * Math.sin(r) + u[i]! * d * (1 - Math.cos(r)),
          ) as Vec3;
          const def = planeFromPointNormal(line.origin, n);
          if (!def) return;
          const id = store.nextId();
          store.addFeature({
            id,
            type: "datumPlane",
            plane: def,
            name: "Angled plane",
            angle,
            through: { kind: "angle", edge: hinge, from },
          } as Feature);
          selectFeature(id, false);
        });
      });
    });
  }

  // Axis of a round face: the hole or shaft axis, followed when it moves.
  function createAxisFromCylinder() {
    pickPlaneInteractive(t("tool.datum.cylinder"), (_spec, face) => axisFromRoundFace(face), {
      roundFace: true,
    });
  }

  function axisFromRoundFace(face: FacePlanePick | null) {
    const cyl = face && face.kind === "tangent" ? viewport.faceCylinder(face.faceId) : null;
    if (!face || !cyl) {
      setStatus(t("tool.datum.cylinderRefused"), "");
      return;
    }
    const id = store.nextId();
    store.addFeature({
      id,
      type: "datumAxis",
      origin: cyl.point,
      dir: cyl.axis,
      name: "Axis",
      through: { kind: "cylinder", face: face.selector },
    } as Feature);
    selectFeature(id, false);
  }

  function createAxisFromPlanes() {
    pickPlaneInteractive(t("tool.datum.planesFirst"), (a, fa, da) => {
      requestAnimationFrame(() => {
        pickPlaneInteractive(t("tool.datum.planesSecond"), (b, fb, db) => {
          const ra = planeOfPick(a, fa, da);
          const rb = planeOfPick(b, fb, db);
          const line = planesMeet(asDef(a), asDef(b));
          if (!ra || !rb || !line) {
            setStatus(t("tool.datum.planesRefused"), "");
            return;
          }
          const id = store.nextId();
          store.addFeature({
            id,
            type: "datumAxis",
            origin: line.origin,
            dir: line.dir,
            name: "Axis",
            through: { kind: "planes", a: ra, b: rb },
          } as Feature);
          selectFeature(id, false);
        });
      });
    });
  }

  /** Every point taken so far and the one under the cursor are drawn. Escape drops the last point, or the whole pick
   *  when none is left. */
  function pickPointsInteractive(
    n: number,
    promptText: string,
    onDone: (pts: Vec3[], refs: (PointAt | null)[]) => void,
  ) {
    if (toolBusy()) return;
    setPlanePick(true);
    viewport.suspendPicking = true;
    const taken: Vec3[] = [];
    const refs: (PointAt | null)[] = [];
    const say = () => setPrompt(t("tool.datum.pointsTaken", { prompt: promptText, taken: taken.length, n }));
    say();
    const draw = (live: Vec3 | null) => viewport.setPickMarkers(taken, live);
    draw(null);
    const canvas = viewport.domElement;
    const onMove = (e: PointerEvent) => {
      const hit = viewport.pointAt(e.clientX, e.clientY);
      draw(hit ? [hit.p.x, hit.p.y, hit.p.z] : null);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = viewport.pointAt(e.clientX, e.clientY);
      if (!hit) return; // over nothing: stay in the pick rather than take a guess
      e.preventDefault();
      e.stopImmediatePropagation();
      const p: Vec3 = [hit.p.x, hit.p.y, hit.p.z];
      const edge = hit.edge && edgeMatchSelectorFrom(hit.edge);
      take(p, edge && hit.edge ? { edge, end: hit.edge.end, point: p } : null);
    };
    const take = (p: Vec3, ref: PointAt | null) => {
      taken.push(p);
      refs.push(ref);
      draw(null);
      if (taken.length < n) {
        say();
        return;
      }
      const pts = taken.slice();
      const got = refs.slice();
      cleanup();
      requestAnimationFrame(() => onDone(pts, got));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (taken.length) {
        taken.pop();
        refs.pop();
        draw(null);
        say();
        return;
      }
      cleanup();
    };
    const releaseTree = awaitTreePick(
      (pick) => {
        if (pick.kind !== "datumPoint") return treePickRefusal(pick, "datumPoint");
        take(pick.point, { datum: pick.id });
        return true;
      },
      () => cleanup(),
    );
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.setPickMarkers([], null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  // Right-click "Offset plane from face": Datum Plane with the right-clicked face as source, no pick step.
  function offsetPlaneFromFace(face: PlaneDef, parentId?: string) {
    if (toolBusy()) return;
    placeNewDatum(face, parentId ? { planeId: parentId } : {}, (id) => selectFeature(id, false));
  }

  /** None for a construction quad. `at` rides along only for a round face, whose tangent plane depends on the pick
   *  point. All three datum routes share this, a route that dropped the selector would silently freeze the datum. */
  function faceRef(face: FacePlanePick | null): { face?: Selector; at?: Vec3 } {
    if (!face) return {};
    return { face: face.selector, ...(face.kind === "tangent" ? { at: face.at } : {}) };
  }

  // Split Body: choose the side to keep, then pick and place the cutting plane with the plane picker and offset gizmo.
  async function startSplit() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.split.needBody"), "");
      return;
    }
    // A selected construction plane cuts all visible bodies (startCutByPlane asks for the side to keep).
    const selId = getSelectedFeature();
    const sel = selId ? store.document.features.find((f) => f.id === selId) : null;
    if (sel?.type === "datumPlane") return void startCutByPlane(sel.id);

    const keep = await choose(t("tool.split.keepSide"), keepSides());
    if (!keep) return;
    const bodies = store.buildState.result?.bodies ?? [];
    let body: string | undefined;
    if (bodies.length > 1) {
      const picked = await chooseBody(t("tool.split.whichBody"), bodies);
      if (!picked) return;
      body = picked;
    }
    pickPlaneInteractive(t("tool.split.cutBy"), (spec) => {
      planeOffset.start(new SketchPlane(spec), (def) => {
        if (def)
          store.addFeature({ id: store.nextId(), type: "split", plane: def, keep, body, groupSides: true } as Feature);
      });
    });
  }

  // Separate: each disjoint solid of the selected bodies becomes a body of its own.
  async function startSeparate() {
    if (toolBusy()) return;
    const bodies = store.buildState.result?.bodies ?? [];
    if (!bodies.length) {
      setStatus(t("tool.separate.needBody"), "");
      return;
    }
    let ids = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    if (!ids.length && bodies.length === 1 && bodies[0]) ids = [bodies[0].id];
    if (!ids.length) {
      const picked = await chooseBody(t("tool.separate.whichBody"), bodies);
      if (!picked) return;
      ids = [picked];
    }
    const before = new Map(bodies.map((b) => [b.id, b.name]));
    const sources = ids.map((id) => ({ id, name: before.get(id) ?? "" }));
    const id = store.nextId();
    store.addFeature({ id, type: "separate", bodies: ids } as Feature);
    carryLookToSeparated(id, before, sources);
  }

  // A body's look (palette slot, material, folder, visibility, rename) lives in the app, so each piece the engine
  // splits off is matched to its source by face note, name as fallback, and takes its look once the build lands.
  function carryLookToSeparated(
    featureId: string,
    before: Map<string, string>,
    sources: { id: string; name: string }[],
  ) {
    let off: (() => void) | null = null;
    const timer = setTimeout(() => off?.(), 60_000);
    const done = () => {
      clearTimeout(timer);
      off?.();
    };
    const bySize = [...sources].sort((a, b) => b.name.length - a.name.length);
    const numberAfter = (name: string, src: { name: string }) =>
      name.startsWith(`${src.name} `) && /^\d+$/.test(name.slice(src.name.length + 1))
        ? name.slice(src.name.length + 1)
        : null;
    off = store.onSessionBuild((s) => {
      if (s.building) return;
      if (s.errorFeatureId === featureId) {
        done();
        return;
      }
      const made = (s.result?.bodies ?? []).filter((b) => !before.has(b.id));
      if (!made.length) return;
      done();
      const notes = (s.result?.diagnostics ?? []).filter(
        (d) => d.feature_id === featureId && d.kind === "separateFaces",
      );
      const spans = (src: { id: string }) =>
        new Map((notes.find((d) => d.source === src.id)?.pieces ?? []).map((p) => [p.body, p]));
      const owner = (piece: { id: string; name: string }) =>
        sources.find((src) => spans(src).has(piece.id)) ??
        bySize.find((src) => numberAfter(piece.name, src) !== null) ??
        (sources.length === 1 ? sources[0] : undefined);
      for (const src of sources) {
        const run = spans(src);
        const pieces = [
          ...(run.has(src.id) ? [{ id: src.id, faces: run.get(src.id) }] : []),
          ...made
            .filter((piece) => owner(piece) === src)
            .map((piece) => {
              const shown = store.bodyName(src.id);
              const n = numberAfter(piece.name, src);
              return { id: piece.id, name: shown && n ? `${shown} ${n}` : undefined, faces: run.get(piece.id) };
            }),
        ];
        if (pieces.length) store.inheritBodyLook(src.id, pieces);
      }
    });
  }

  // Cut all visible bodies by a construction plane, through the split feature with `planeId` and the visible body ids.
  async function startCutByPlane(planeId: string) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.cut.needBody"), "");
      return;
    }
    const keep = await choose(t("tool.cut.keepSide"), keepSides());
    if (!keep) return;
    const ids = (store.buildState.result?.bodies ?? []).filter((b) => store.isBodyVisible(b.id)).map((b) => b.id);
    store.addFeature({ id: store.nextId(), type: "split", planeId, keep, bodies: ids, groupSides: true } as Feature);
  }

  // The click order is the operation: first the body kept, then the tool. Two or more preselected bodies commit at
  // once, first kept and the rest consumed, the only way to give one boolean several tools.
  function startBoolean(op: BooleanOp) {
    if (toolBusy()) return;
    const bodies = store.buildState.result?.bodies ?? [];
    if (bodies.length < 2) {
      setStatus(t("tool.boolean.needTwo", { tool: BOOLEAN_LABEL[op] }), "");
      return;
    }
    const pre = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    if (pre.length >= 2) {
      const [first, ...rest] = pre;
      if (first === undefined) return;
      commitBoolean(op, first, rest);
      return;
    }

    // Asked even with one candidate left, so the gesture is the same whatever the body count and one click never
    // removes a body.
    const withTarget = (target: string) => {
      pickBodyInteractive(
        t("tool.boolean.pickTool", { op }),
        [target], // clicking the kept body again is a miss, not a boolean with itself
        (tool) => commitBoolean(op, target, [tool]),
      );
    };

    const only = pre[0];
    if (only !== undefined) {
      withTarget(only);
      return;
    }
    pickBodyInteractive(
      op === "subtract" ? t("tool.boolean.pickKept") : t("tool.boolean.pickFirst", { op }),
      [],
      withTarget,
    );
  }

  function commitBoolean(op: BooleanOp, target: string, tools: string[]) {
    viewport.setSelectedBodies([]); // consumed tools would dangle; clear the selection
    store.addFeature({ id: store.nextId(), type: "boolean", operation: op, target, tools } as Feature);
  }

  /** Empty space is a miss rather than a cancel, so a click beside the part keeps the operation. Bodies in `exclude`
   *  are already used by this operation and neither light nor answer. */
  function pickBodyInteractive(promptText: string, exclude: readonly string[], onPick: (bodyId: string) => void) {
    if (toolBusy()) return;
    const bodyUnder = (cx: number, cy: number): string | null => {
      const id = viewport.bodyIdAt(cx, cy);
      return id && !exclude.includes(id) ? id : null;
    };
    setPlanePick(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => {
      const id = bodyUnder(e.clientX, e.clientY);
      viewport.hoverBody(id);
      canvas.style.cursor = id ? "pointer" : "default";
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const id = bodyUnder(e.clientX, e.clientY);
      if (!id) return; // a click on empty space is a miss, not a cancel
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(id));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const releaseTree = awaitTreePick(
      (pick) => {
        if (pick.kind !== "body") return treePickRefusal(pick, "oneBody");
        if (exclude.includes(pick.id)) return t("tool.boolean.alreadyUsed");
        cleanup();
        requestAnimationFrame(() => onPick(pick.id));
        return true;
      },
      () => cleanup(),
    );
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.hoverBody(null);
      canvas.style.cursor = "default";
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  function chooseBody(title: string, bodies: { id: string; name: string }[]): Promise<string | null> {
    const labels = bodyLabels(bodies, (id) => store.bodyName(id));
    return choose<string>(
      title,
      bodies.map((b) => ({ value: b.id, label: labels.get(b.id)! })),
    );
  }

  // Simplify Mesh merges near-coplanar facets of the active (imported) body; a higher angular tolerance gives fewer
  // faces but coarsens curved regions.
  function startSimplifyMesh() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.simplifyMesh.needBody"), "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "simplifyMesh", tolerance: 1 } as Feature);
  }

  // Clean Up repairs boolean rot on all bodies up to here. Booleans on ragged imports make new debris, so it is meant
  // to be run again after heavy editing; a body the engine cannot clean passes through unchanged.
  function startCleanUp() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.cleanUp.needBody"), "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "cleanUp" } as Feature);
    setStatus(t("tool.cleanUp.added"), "");
  }

  // Scale is about the origin, mostly to fix the units of an import.
  function startScale() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.scale.needBody"), "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "scale", factor: 1 } as Feature);
    // Factor 1 is a visual no-op, so say the feature was added, the way Clean Up does.
    setStatus(t("tool.scale.added"), "");
  }

  function startMove() {
    if (toolBusy()) return;
    let ids = viewport.getSelectedBodies();
    const sketches = new Set(overlay.selectedRegions().map((r) => r.sketchId));
    const picked = getSelectedFeature();
    const pickedType = picked ? store.document.features.find((f) => f.id === picked)?.type : undefined;
    if (!ids.length && !sketches.size && picked && pickedType === "sketch") {
      sketches.add(picked);
    }
    if (!ids.length && !sketches.size && picked && pickedType === "datumPlane") {
      const target = datumMoveTarget(picked);
      if (target) {
        moveTool.startTarget(target, committed);
        return;
      }
    }
    if (sketches.size) {
      const target = sketchFeatureTarget(viewport, store, overlay, [...sketches], ids);
      if (target) {
        overlay.clearRegionSelection();
        moveTool.startTarget(target, committed);
        return;
      }
    }
    if (!hasBody()) {
      setStatus(t("tool.move.needBodyOrSketch"), "");
      return;
    }
    const bodies = store.buildState.result?.bodies ?? [];
    if (!ids.length && bodies.length) {
      const lastBody = bodies[bodies.length - 1];
      if (lastBody) ids = [lastBody.id]; // none selected → active body
    }
    if (!ids.length) {
      setStatus(t("tool.move.selectBody", { control: t("tool.selectBodiesControl") }), "");
      return;
    }
    moveTool.start(ids, committed);
  }

  // Mirror writes its bodies into the feature, since the active body it would otherwise fall back to changes as the
  // timeline grows. A lone body needs no picking.
  function startMirror() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.mirror.needBody"), "");
      return;
    }
    const bodies = store.buildState.result?.bodies ?? [];
    const sel = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    const pre = sel.length ? sel : bodies.length === 1 ? [bodies[0]!.id] : [];
    mirrorTool.start(pre, committed);
  }

  /** One-shot sketch profile picker, so Revolve and Sweep ask in the viewport like Loft instead of requiring a
   *  preselection. The hit test is Loft's regionUnder (features/loftTool.ts). */
  function pickRegionInteractive(promptText: string, onPick: (wr: WorldRegion) => void) {
    if (toolBusy()) return;
    const scratch = new THREE.Vector3();
    const regionUnder = (cx: number, cy: number): WorldRegion | null => {
      const ray = viewport.rayFrom(cx, cy).ray;
      let best: WorldRegion | null = null;
      let bestDist = Infinity;
      for (const wr of overlay.regions) {
        if (!ray.intersectPlane(wr.plane.plane, scratch)) continue;
        if (!pointInRegion(wr.plane.to2D(scratch), wr.region)) continue;
        const d = ray.origin.distanceToSquared(scratch);
        if (d < bestDist) {
          bestDist = d;
          best = wr;
        }
      }
      return best;
    };
    setPlanePick(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => {
      const wr = regionUnder(e.clientX, e.clientY);
      overlay.setHoverRegion(wr);
      canvas.style.cursor = wr ? "pointer" : "default";
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const wr = regionUnder(e.clientX, e.clientY);
      if (!wr) return; // a click on empty space is a miss, not a cancel
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(wr));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    // A sketch row names a profile only when that sketch shows exactly one.
    const releaseTree = awaitTreePick(
      (pick) => {
        if (pick.kind !== "sketch") return treePickRefusal(pick, "sketchProfile");
        const mine = overlay.regions.filter((r) => r.sketchId === pick.id);
        const only = mine.length === 1 ? mine[0] : undefined;
        if (!only) {
          return mine.length
            ? t("tool.profile.many", { n: mine.length })
            : t("tool.profile.none", tieArgs(offerTie(pick.id)));
        }
        cleanup();
        requestAnimationFrame(() => onPick(only));
        return true;
      },
      () => cleanup(),
    );
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      overlay.setHoverRegion(null);
      canvas.style.cursor = "default";
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  // Revolve opens as a New Body and a full turn rather than asking first, both editable on the feature afterwards.
  function startRevolve() {
    if (toolBusy()) return;
    const selected = overlay.selectedRegions();
    const picked = selected.length
      ? selected
      : overlay.regions.length === 1 && overlay.regions[0]
        ? [overlay.regions[0]]
        : [];
    const wr = picked[0];
    if (!wr) {
      if (!overlay.regions.length) {
        setStatus(t("tool.revolve.needProfile"), "");
        return;
      }
      // Several profiles show and none is selected: ask in the viewport rather than refuse.
      pickRegionInteractive(t("tool.revolve.pickProfile"), (r) => revolveFrom([r]));
      return;
    }
    revolveFrom(picked);
  }

  function revolveFrom(picked: readonly WorldRegion[]) {
    const wr = picked[0];
    if (!wr) return;
    // A feature names a single sketch, so areas from other sketches are dropped rather than spun with it.
    const areas = picked.filter((r) => r.sketchId === wr.sketchId);
    pickAxisInteractive((axis, edge) => addRevolve(wr, areas, axis, "new", edge));
  }

  /** One of the origin arrows or a straight model edge. Unlike pickEdgeInteractive it needs no body, the first
   *  revolve in a document has no edge to pick. */
  function pickAxisInteractive(onPick: (axis: AxisSpec, edge?: Selector) => void) {
    if (toolBusy()) return;
    // A selected datum axis already answers which line, as a selected datum plane does for Split. Its baked origin
    // and dir are an AxisLine as is.
    const selId = getSelectedFeature();
    const selAxis = selId
      ? store.document.features.find(
          (f): f is Extract<Feature, { type: "datumAxis" }> => f.id === selId && f.type === "datumAxis",
        )
      : undefined;
    if (selAxis) {
      setStatus(t("tool.revolve.about", { name: numberedName(selAxis, store.document.features) }), "");
      requestAnimationFrame(() => onPick({ origin: selAxis.origin, dir: selAxis.dir }));
      return;
    }
    const triad = viewport.scene.triad;
    // The hit may be a shaft, a head or the undrawn hit sleeve, so walk up to the ancestor carrying the tag.
    const axisAt = (x: number, y: number): Axis3 | null =>
      viewport.probe(x, y, (rc): Axis3 | null => {
        const hit = rc.intersectObjects(triad.arms, true)[0];
        for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
          const a = o.userData?.axis;
          if (a === "X" || a === "Y" || a === "Z") return a;
        }
        return null;
      });
    setPlanePick(true);
    viewport.suspendPicking = true;
    viewport.emphasizeEdges(true);
    setPrompt(t("tool.revolve.pickAxis"));
    const onMove = (e: PointerEvent) => {
      // An arrow wins over an edge behind it: arrows are small, drawn in front and deliberately aimed at.
      const axis = axisAt(e.clientX, e.clientY);
      triad.highlight(axis);
      viewport.hoverEdge(axis ? null : (viewport.pickEdgeAt(e.clientX, e.clientY)?.edge ?? null));
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const axis = axisAt(e.clientX, e.clientY);
      const hit = axis ? null : viewport.pickEdgeAt(e.clientX, e.clientY);
      if (!axis && !hit) return; // a click on empty space is a miss, not a cancel
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      if (axis) {
        requestAnimationFrame(() => onPick(axis));
        return;
      }
      const pts = hit!.edge.points.map((q) => [q[0], q[1], q[2]] as Vec3);
      const line = axisFromEdge(pts);
      if (!line) {
        setStatus(t("tool.revolve.axisStraight"), "");
        return;
      }
      requestAnimationFrame(() => onPick(line, hit!.selector));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const releaseTree = awaitTreePick(
      (pick) => {
        if (pick.kind === "edge") {
          const pts = pick.edge.points.map((q) => [q[0], q[1], q[2]] as Vec3);
          const line = axisFromEdge(pts);
          if (!line) return t("tool.revolve.axisLine");
          const sel = edgeSelectorFrom({ points: pts, body: pick.edge.body });
          cleanup();
          requestAnimationFrame(() => onPick(line, sel));
          return true;
        }
        if (pick.kind !== "datumAxis") return treePickRefusal(pick, "axisOrStraightEdge");
        cleanup();
        requestAnimationFrame(() => onPick({ origin: pick.origin, dir: pick.dir }));
        return true;
      },
      () => cleanup(),
    );
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.emphasizeEdges(false);
      viewport.hoverEdge(null);
      triad.highlight(null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  /** With `axisEdge`, `axis` is only the resolved line cached beside the reference, see the Feature type. */
  function addRevolve(
    wr: WorldRegion,
    areas: readonly WorldRegion[],
    axis: AxisSpec,
    operation: "new" | "join" | "cut",
    axisEdge?: Selector,
  ) {
    store.addFeature({
      id: store.nextId(),
      type: "revolve",
      sketch: wr.sketchId,
      axis,
      angle: 360,
      operation,
      regions: areas.map((r) => [r.interior3D.x, r.interior3D.y, r.interior3D.z]),
      ...(axisEdge ? { axisEdge } : {}),
    } as Feature);
  }

  // Loft: profiles already selected in the model view seed the tool.
  function startLoft() {
    if (toolBusy()) return;
    loftTool.start(committed);
  }

  // Sweep: the profile should sit at the start of the open path sketch, roughly perpendicular to it.
  async function startSweep() {
    if (toolBusy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      if (!overlay.regions.length) {
        setStatus(t("tool.sweep.needProfile"), "");
        return;
      }
      pickRegionInteractive(t("tool.sweep.pickProfile"), (r) => void sweepFrom(r));
      return;
    }
    await sweepFrom(wr);
  }

  async function sweepFrom(wr: WorldRegion) {
    const all = store.document.features.filter((f) => f.type === "sketch");
    const candidates = all.filter((f) => f.id !== wr.sketchId);
    if (candidates.length === 0) {
      setStatus(t("tool.sweep.needPath"), "");
      return;
    }
    const c0 = candidates[0];
    if (!c0) return;
    let pathId = c0.id;
    if (candidates.length > 1) {
      const picked = await choose<string>(
        t("tool.sweep.pickPath"),
        candidates.map((f) => ({ value: f.id, label: numberedName(f, store.document.features) })),
      );
      if (!picked) return;
      pathId = picked;
    }
    store.addFeature({
      id: store.nextId(),
      type: "sweep",
      profile: wr.sketchId,
      path: pathId,
      operation: "new",
    } as Feature);
  }

  async function startPrimitive() {
    if (toolBusy()) return;
    const shape = await choose<"box" | "cylinder" | "cone" | "sphere" | "torus">(t("tool.primitive.title"), [
      { value: "box", label: t("feature.box"), hint: t("tool.primitive.boxHint") },
      { value: "cylinder", label: t("feature.cylinder"), hint: t("tool.primitive.cylinderHint") },
      { value: "cone", label: t("feature.cone"), hint: t("tool.primitive.coneHint") },
      { value: "sphere", label: t("feature.sphere"), hint: t("tool.primitive.sphereHint") },
      { value: "torus", label: t("feature.torus"), hint: t("tool.primitive.torusHint") },
    ]);
    if (!shape) return;
    const id = store.nextId();
    if (shape === "box") store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 } as Feature);
    else if (shape === "cylinder") store.addFeature({ id, type: "cylinder", radius: 10, height: 20 } as Feature);
    else if (shape === "cone")
      store.addFeature({ id, type: "cone", bottomRadius: 10, topRadius: 0, height: 20 } as Feature);
    else if (shape === "torus") store.addFeature({ id, type: "torus", majorRadius: 15, minorRadius: 5 } as Feature);
    else store.addFeature({ id, type: "sphere", radius: 10 } as Feature);
  }

  // Also used by Shell and Draft. False when it could not open.
  function pickFaceInteractive(
    promptText: string,
    onPick: (sel: Selector, normal: Vec3 | null) => void,
    onCancel?: () => void,
  ): boolean {
    if (toolBusy()) return false;
    if (!hasBody()) {
      setStatus(t("tool.needBody"), "");
      return false;
    }
    setPlanePick(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => void viewport.hoverFaceAt(e.clientX, e.clientY);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      // Stamp the owning body, or the engine resolves the selector against the active body and on a multi body model
      // the shell or draft lands on a body the user never touched.
      const sel: Selector = hit.bodyId ? { ...hit.selector, body: hit.bodyId } : hit.selector;
      const n = viewport.planarFace(hit.faceId)?.normal;
      const normal: Vec3 | null = n ? [n.x, n.y, n.z] : null;
      requestAnimationFrame(() => onPick(sel, normal));
    };
    const cancel = () => {
      cleanup();
      onCancel?.();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const releaseTree = awaitTreePick((pick) => {
      if (pick.kind !== "face") return treePickRefusal(pick, "face");
      cleanup();
      const n = viewport.planarFace(pick.faceId)?.normal;
      const normal: Vec3 | null = n ? [n.x, n.y, n.z] : null;
      const sel = viewport.faceSelectorOf(pick.faceId);
      requestAnimationFrame(() => onPick(sel, normal));
      return true;
    }, cancel);
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    return true;
  }

  // The edge twin of pickFaceInteractive; it also returns the polyline for callers that cache the edge (revolve axis).
  function pickEdgeInteractive(
    promptText: string,
    onPick: (sel: Selector, points: readonly Vec3[]) => void,
    onCancel?: () => void,
  ): boolean {
    if (toolBusy()) return false;
    if (!hasBody()) {
      setStatus(t("tool.needBody"), "");
      return false;
    }
    setPlanePick(true);
    viewport.suspendPicking = true;
    viewport.emphasizeEdges(true);
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => viewport.hoverEdge(viewport.pickEdgeAt(e.clientX, e.clientY)?.edge ?? null);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = viewport.pickEdgeAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      const pts = hit.edge.points.map((q) => [q[0], q[1], q[2]] as Vec3);
      requestAnimationFrame(() => onPick(hit.selector, pts));
    };
    const cancel = () => {
      cleanup();
      onCancel?.();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const releaseTree = awaitTreePick((pick) => {
      if (pick.kind !== "edge") return treePickRefusal(pick, "edge");
      const pts = pick.edge.points.map((q) => [q[0], q[1], q[2]] as Vec3);
      const sel = edgeSelectorFrom({ points: pts, body: pick.edge.body });
      if (!sel) return treePickRefusal(pick, "edge");
      cleanup();
      requestAnimationFrame(() => onPick(sel, pts));
      return true;
    }, cancel);
    const cleanup = () => {
      releaseTree();
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.emphasizeEdges(false);
      viewport.hoverEdge(null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    return true;
  }

  // Swap the one ambiguous selector the engine named, located by its stored point (repickReference.ts); `kind` says
  // whether a face or an edge is picked. If it is gone the feature changed since the failed build, so do nothing.
  function repickReference(featureId: string, at: readonly number[], kind?: string) {
    const feature = store.document.features.find((f) => f.id === featureId);
    if (!feature) return;
    const site = findSelectorAt(feature, at);
    if (!site) {
      setStatus(t("tool.repick.changed"), "");
      return;
    }
    if (toolBusy()) return;
    const wantsEdge = kind === "edge";
    let ended = false;
    let waiting: (() => void) | null = null;
    const onWaitEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    const stopWaiting = () => {
      if (!waiting) return;
      waiting();
      waiting = null;
      window.removeEventListener("keydown", onWaitEsc, true);
      setPlanePick(false);
      setPrompt(null);
    };
    function end() {
      if (ended) return;
      ended = true;
      stopWaiting();
      if (store.editPreviewId === featureId) store.endEditPreview();
    }
    const apply = (sel: Selector, normal: Vec3 | null, edgePoints?: readonly Vec3[]) => {
      // The pick is async and the doc may have moved under us (undo, another edit), so re-read and re-locate.
      const cur = store.document.features.find((f) => f.id === featureId);
      const site2 = cur ? findSelectorAt(cur, at) : null;
      if (!cur || !site2) {
        if (cur) setStatus(t("tool.repick.changed"), "");
        end();
        return;
      }
      const next = repickedSelector(cur, site2, sel, normal, edgePoints);
      store.updateFeature(featureId, replaceSelectorAt(cur, site2, next));
      end();
      if (next !== sel) settleRepickedExtent(featureId, next);
    };
    const pick = () => {
      const opened = wantsEdge
        ? pickEdgeInteractive(t("tool.repick.edge"), (sel, pts) => apply(sel, null, pts), end)
        : pickFaceInteractive(t("tool.repick.face"), apply, end);
      if (!opened) end();
    };
    // The selector resolves where the feature sits in history, so pick on the model rolled back to it; the finished
    // model carries every later move and boolean.
    const shown = store.buildState.result;
    let started = false;
    waiting = store.onSessionBuild((s) => {
      if (s.building) {
        started = true;
        return;
      }
      // previewBuilt is null for a build sent before the rollback was asked for.
      if (!started || !s.previewBuilt || !waiting) return;
      stopWaiting();
      if (store.editPreviewId !== featureId) {
        ended = true;
        return;
      }
      // A refused build keeps the last mesh, which is still the finished model.
      if (!s.result || s.result === shown) {
        setStatus(t("tool.repick.rollbackFailed"), "error");
        end();
        return;
      }
      pick();
    });
    setPlanePick(true);
    setPrompt(t("tool.repick.rollingBack"));
    window.addEventListener("keydown", onWaitEsc, true);
    store.beginEditPreview(featureId);
  }

  // Only the engine measures a tracked face's extent, so a re-picked hole face
  // takes it from the first build of that face.
  function settleRepickedExtent(featureId: string, written: Selector) {
    let started = false;
    let done = false;
    let off: (() => void) | null = null;
    const stop = () => {
      done = true;
      off?.();
    };
    off = store.onSessionBuild((s) => {
      if (done) return;
      if (s.building) {
        started = true;
        return;
      }
      const cur = store.document.features.find((f) => f.id === featureId);
      const patch = repickedExtent(cur, written, s.result?.trackedFaces?.[featureId]);
      if (patch) {
        stop();
        store.deriveFeature(featureId, patch);
      } else if (started) {
        stop();
      }
    });
    if (done) off();
  }

  // Joint: the first picked face's body moves flush onto the second face, and both connectors are re-resolved every
  // rebuild so the joined body follows edits to either part.
  function startJoint() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.needBody"), "");
      return;
    }
    pickFaceInteractive(t("tool.joint.pickMoving"), (mateSel) => {
      const movingBody = (mateSel as { body?: string }).body;
      if (!movingBody) {
        setStatus(t("tool.joint.noBody"), "");
        return;
      }
      pickFaceInteractive(t("tool.joint.pickTo"), (toSel) => {
        const toBody = (toSel as { body?: string }).body;
        if (toBody === movingBody) {
          setStatus(t("tool.joint.sameBody"), "");
          return;
        }
        store.addFeature({
          id: store.nextId(),
          type: "joint",
          moving: movingBody,
          mate: { body: movingBody, face: mateSel },
          to: { body: toBody, face: toSel },
          mode: "rigid",
        } as Feature);
      });
    });
  }

  /** A face (round face axis, flat face normal) or an edge (circle axis, straight edge) for a mechanism joint. A body
   *  in `exclude` does not answer, a joint's two sides are on different bodies. Null on Esc. */
  function pickAxisConnectorInteractive(
    promptText: string,
    exclude: string | null,
  ): Promise<{ body: string; sel: Selector } | null> {
    return new Promise((resolve) => {
      const connectorAt = (x: number, y: number): { body: string; sel: Selector; hit: Hit } | null => {
        const hit = viewport.pickEntity(x, y);
        if (!hit) return null;
        if (hit.kind === "edge") {
          const body = hit.edge.body;
          return body && body !== exclude ? { body, sel: hit.selector, hit } : null;
        }
        const face = viewport.pickFaceForPressPull(x, y);
        const body = face?.bodyId;
        if (!face || !body || body === exclude) return null;
        return { body, sel: { ...face.selector, body }, hit };
      };
      setPlanePick(true);
      viewport.suspendPicking = true;
      viewport.emphasizeEdges(true);
      setPrompt(promptText);
      const onMove = (e: PointerEvent) => viewport.hoverEntity(connectorAt(e.clientX, e.clientY)?.hit ?? null);
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const got = connectorAt(e.clientX, e.clientY);
        if (!got) return; // a click on empty space or the other side's body is a miss, not a cancel
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanup();
        requestAnimationFrame(() => resolve({ body: got.body, sel: got.sel }));
      };
      const onEsc = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        cleanup();
        resolve(null);
      };
      const releaseTree = awaitTreePick(
        (pick) => {
          let body: string | undefined;
          let sel: Selector | undefined;
          if (pick.kind === "face") {
            body = viewport.faceIdToBodyId(pick.faceId) ?? undefined;
            sel = viewport.faceSelectorOf(pick.faceId);
          } else if (pick.kind === "edge") {
            body = pick.edge.body;
            sel = edgeSelectorFrom({ points: pick.edge.points.map((q) => [q[0], q[1], q[2]] as Vec3), body });
          } else return treePickRefusal(pick, "faceOrEdge");
          if (!body || !sel) return t("tool.mechanism.noPart", { kind: pick.kind });
          if (body === exclude) return t("tool.mechanism.samePart");
          cleanup();
          requestAnimationFrame(() => resolve({ body, sel: { ...sel, body } as Selector }));
          return true;
        },
        () => {
          cleanup();
          resolve(null);
        },
      );
      const cleanup = () => {
        releaseTree();
        setPlanePick(false);
        viewport.suspendPicking = false;
        viewport.emphasizeEdges(false);
        viewport.hoverEntity(null);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("keydown", onEsc, true);
        setPrompt(null);
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerdown", onDown, true);
      window.addEventListener("keydown", onEsc, true);
    });
  }

  // Mechanism: the engine moves every other body until all joints are met. Esc at any step cancels the whole
  // mechanism, nothing is written until the drive is chosen.
  async function startMechanism() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.needBody"), "");
      return;
    }
    const ground = await new Promise<string>((resolve) =>
      pickBodyInteractive(t("tool.mechanism.pickGround"), [], resolve),
    );
    const joints: MechanismJoint[] = [];
    for (;;) {
      const kinds: { value: JointMode | "done"; label: string }[] = [
        { value: "revolute", label: t("tool.mechanism.revolute") },
        { value: "slider", label: t("tool.mechanism.slider") },
        { value: "rigid", label: t("tool.mechanism.rigid") },
      ];
      if (joints.length) kinds.push({ value: "done", label: t("common.done") });
      const title = joints.length ? t("tool.mechanism.soFar", { n: joints.length }) : t("tool.mechanism.firstKind");
      const mode = await choose<JointMode | "done">(title, kinds);
      if (mode === null) return setStatus(t("tool.mechanism.cancelled"), "");
      if (mode === "done") break;
      const id = nextJointId(joints, mode);
      const a = await pickAxisConnectorInteractive(t("tool.mechanism.pickMoves", { id }), null);
      if (!a) return setStatus(t("tool.mechanism.cancelled"), "");
      const b = await pickAxisConnectorInteractive(t("tool.mechanism.pickJoins", { id }), a.body);
      if (!b) return setStatus(t("tool.mechanism.cancelled"), "");
      joints.push({ id, mode, a: { body: a.body, axis: a.sel }, b: { body: b.body, axis: b.sel } });
    }
    const drivable = joints.filter((j) => isDrivable(j.mode));
    let drive: string | null = NO_DRIVE;
    if (drivable.length) {
      drive = await choose<string>(t("tool.mechanism.whichDrive"), [
        ...drivable.map((j) => ({
          value: j.id,
          label: t("field.option.driveJoint", { joint: j.id, mode: j.mode ?? "" }),
        })),
        { value: NO_DRIVE, label: t("tool.mechanism.noDrive") },
      ]);
      if (drive === null) return setStatus(t("tool.mechanism.cancelled"), "");
    }
    const id = store.nextId();
    store.addFeature({
      id,
      type: "mechanism",
      ground,
      joints,
      ...(drive ? { drive } : {}),
    } as Feature);
    committed(id);
  }

  /** The features Pattern targets: owners of selected faces, else the feature selected in the timeline. A selected
   *  body wins, the history highlight is stale once a body is picked. */
  function patternFeatureCandidates(): PatternCandidates {
    if (viewport.getSelectedBodies().length) return { ids: [], picked: false, explicit: true };
    const faceIds = viewport.getSelectedFaceIds();
    if (faceIds.length) {
      const owners = featureOwnersOfFaces(store.buildState.result?.bodies, faceIds);
      if (owners.length) return { ids: owners, picked: true, explicit: true };
    }
    const selected = getSelectedFeature();
    return { ids: selected ? [selected] : [], picked: false, explicit: getSelectedFeatureExplicit() };
  }

  // Linear or circular comes from the button pressed: they are different gestures, not settings of one.
  function startPattern(kind: PatternKind) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus(t("tool.pattern.needBody"), "");
      return;
    }
    const built = store.buildState.result?.bodies ?? [];
    const start = patternStart(store.document.features, patternFeatureCandidates(), built);
    if (start.mode === "features") {
      patternTool.start(kind, [], committed, start.ids);
      return;
    }
    // A feature the user pointed at that cannot be patterned is said, not
    // swapped for a whole body pattern they did not ask for (patternStart).
    if (start.mode === "refuse") {
      setStatus(start.reason, "");
      return;
    }
    // Same rule as Move: the selection if there is one, otherwise the active
    // body, which is what the kernel patterns when the feature names no bodies.
    let ids = viewport.getSelectedBodies();
    if (!ids.length && start.body) ids = [start.body];
    if (!ids.length && built.length) {
      const last = built[built.length - 1];
      if (last) ids = [last.id];
    }
    if (!ids.length) {
      setStatus(t("tool.pattern.selectBody", { control: t("tool.selectBodiesControl") }), "");
      return;
    }
    patternTool.start(kind, ids, committed);
  }

  /** `restsOn` is the step a carry on just wrote, whose undo closes the tool this opens. */
  function startExtrude(restsOn: string | null = null) {
    if (toolBusy()) return;
    const rests = restsOn ? { restsOn } : undefined;
    // A selected face is preferred and Press/Pulled, so a visible sketch never hijacks extruding a face.
    const sel = viewport.selectedFacesForPressPull();
    if (sel) {
      // Except when the face lies on or behind a visible sketch's plane: a click on a profile there selects the
      // face, so the sketch wins.
      const underSketch = overlay.regions.some((wr) => {
        if (wr.plane.n.dot(sel.normal) < 0.99) return false; // same-facing planes only
        return wr.plane.plane.distanceToPoint(sel.anchor) <= 0.01; // face on/behind the sketch plane
      });
      if (!underSketch) {
        pressPull.start(committed, rests);
        return;
      }
    }
    const chosen = hiddenChosenSketch();
    if (chosen) {
      if (extrude.start(committed, { sketch: chosen })) return;
      const gap = gapOf(chosen);
      // A gap a few mm wide is a profile drawn short, so it is named and offered a fix; Extrude
      // pressed again on it, as the toast says, is the person picking the wall.
      if (gap?.kind === "gap" && !(gapAsked?.sketch === chosen && Date.now() < gapAsked.until)) {
        setStatus(t("tool.extrude.gapEnds", { gap: gapLength(gap.gapMm), n: gap.open }), "");
        const message = t("tool.extrude.gapToast", { gap: gapLength(gap.gapMm) });
        gapAsked = {
          sketch: chosen,
          until: Date.now() + GAP_ASK_MS,
          toast: toastTie(chosen, message, t("sketch.mode.closeGap"), gap.reach, GAP_ASK_MS),
        };
        return;
      }
      // Gaps that Tie Loose Ends can close mean a profile was meant, so the tie is offered instead of a wall.
      if (gap?.kind === "tieable") {
        setStatus(t("tool.extrude.noProfile", tieArgs(offerTie(chosen))), "");
        return;
      }
      // An open sketch, lines and arcs with no closed area, extrudes as a wall along them.
      const wall = thinExtrudeOf(store.document.features, chosen, "");
      if (!wall) {
        setStatus(t("tool.extrude.noCurve", tieArgs(offerTie(chosen))), "");
        return;
      }
      if (gapAsked?.toast != null) dismissToast(gapAsked.toast);
      gapAsked = null;
      const thin = { ...wall, id: store.nextId() } as Feature;
      store.addFeature(thin);
      committed(thin.id);
      setStatus(t("tool.extrude.thinAdded", { thickness: fmtLength(THIN_DEFAULTS.thickness) }), "");
      return;
    }
    if (overlay.regions.length === 0) {
      setStatus(t("tool.extrude.needProfile"), "");
      return;
    }
    extrude.start(committed, rests);
  }

  /** Extrude on the profile a carry on picked, found again by its point once the step it rests on is built. A sketch
   *  that step consumed is shown for it, as a reopened extrude shows its own. False when no area lies there. */
  function startExtrudeOn(restsOn: string | null, at: { point: Vec3; sketch: string }): boolean {
    if (toolBusy()) return false;
    const rests = restsOn ? { restsOn } : {};
    const p = new THREE.Vector3(...at.point);
    const wr = overlay.regions.find((r) => r.sketchId === at.sketch && worldPointInRegion(p, r.plane, r.region));
    if (!wr) return extrude.start(committed, { ...rests, sketch: at.sketch, at: [at.point] });
    overlay.clearRegionSelection();
    overlay.toggleRegionSelection(wr, false);
    return extrude.start(committed, rests);
  }

  /** The sketch Extrude last named a gap in: pressing it again there while the toast shows makes the wall. */
  let gapAsked: { sketch: string; until: number; toast: number | null } | null = null;
  const GAP_ASK_MS = 9000;

  function gapOf(sketchId: string): GapReport | null {
    const sk = asFeature(
      store.document.features.find((f) => f.id === sketchId),
      "sketch",
    );
    if (!sk?.entities) return null;
    const ents = resolveRealEntities(sk, store.document.parameters);
    return gapReport(ents, sk.constraints ?? [], defaultReach(ents));
  }

  const gapLength = (mm: number) => fmtLength(Number(mm.toPrecision(2)));

  function toastTie(sketchId: string, message: string, label: string, reach?: number, timeout?: number): number | null {
    const sk = asFeature(
      store.document.features.find((f) => f.id === sketchId),
      "sketch",
    );
    return toast(message, {
      ...(timeout ? { timeout } : {}),
      action: {
        label,
        onClick: () => {
          if (sketch.active || !sk) return;
          sketch.enter(store.buildState.result?.sketchPlanes?.[sketchId] ?? sk.plane, store, sketchId);
          void sketch.tieLooseEnds(reach);
        },
      },
    });
  }

  /** Why a sketch shows no profile, when loose ends are why, with a toast that ties them. */
  function offerTie(sketchId: string): TieWhy {
    const gap = gapOf(sketchId);
    if (!gap) return null;
    const n = gap.tieable;
    if (gap.kind === "gap") {
      const length = gapLength(gap.gapMm);
      toastTie(sketchId, t("tool.looseEnds.gap", { gap: length }), t("sketch.mode.closeGap"), gap.reach);
      return { why: "gap", gap: length };
    }
    if (!n) return gap.open ? { why: "open", n: gap.open } : null;
    toastTie(sketchId, t("tool.looseEnds.keepOpen", { n }), t("tool.tieLooseEnds"));
    return { why: "loose", n };
  }

  /** A sketch picked in the tree that shows no areas, usually one an earlier extrude hid. An area picked in the
   *  viewport wins over it. */
  function hiddenChosenSketch(): string | null {
    const id = getSelectedFeature();
    if (!id || !getSelectedFeatureExplicit()) return null;
    if (overlay.selectedRegions().length) return null;
    const f = store.document.features.find((x) => x.id === id);
    if (f?.type !== "sketch") return null;
    return overlay.regions.some((wr) => wr.sketchId === id) ? null : id;
  }

  /** The handle on a selected profile (features/regionNudge.ts) arms Extrude holding the arrow. Unlike startExtrude
   *  it does not choose between face and profile, a press on a profile's arrow is not a guess. */
  const grabRegionHandle = (x: number, y: number) => {
    if (toolBusy()) return;
    extrude.start(committed, { grabAt: { x, y } });
  };

  /** The handle on a just committed extrude reopens that feature, so a second pull edits it instead of adding one. */
  const grabExtrudeEdit = (id: string, x: number, y: number) => {
    if (toolBusy()) return;
    extrude.startEdit(id, committed, { grabAt: { x, y } });
  };

  return {
    pickPlane: pickPlaneInteractive,
    startFillet,
    startFilletOn,
    startChamfer,
    startChamferOn,
    grabEdgeHandle,
    grabFaceHandle,
    startPressPull,
    startPressPullOn,
    startSketch,
    offsetPlane,
    createDatumPlane,
    createMidplane,
    createPlaneThroughPoints,
    createDatumPoint,
    createDatumAxis,
    createDatumAxisOnEdge,
    createPlaneNormalToEdge,
    createPlaneThroughEdges,
    createPlaneAtAngle,
    createAxisFromCylinder,
    axisFromRoundFace,
    createAxisFromPlanes,
    offsetPlaneFromFace,
    startSplit,
    startSeparate,
    startCutByPlane,
    startBoolean,
    startSimplifyMesh,
    startCleanUp,
    startScale,
    startMove,
    startMirror,
    startRevolve,
    startLoft,
    startSweep,
    startPrimitive,
    startJoint,
    startMechanism,
    startPattern,
    startExtrude,
    startExtrudeOn,
    grabRegionHandle,
    grabExtrudeEdit,
    repickReference,
  };
}

export type FeatureStarters = ReturnType<typeof createFeatureStarters>;
