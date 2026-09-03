// Tool-starter functions: the ~20 "start a modeling tool" entry points (Sketch,
// Extrude, Fillet, Chamfer, Split, the booleans, Revolve, Loft, Sweep, Primitive,
// Shell, Draft, Pattern, Scale, Move, Press/Pull…) plus the interactive
// plane/face pickers they share. Each closes over the same large set of
// singletons/state owned by main.ts, passed in once via createFeatureStarters.
import * as THREE from "three";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { SketchMode, SketchTool } from "../sketch/sketchMode";
import { SketchPlane } from "../sketch/plane";
import { axisFromEdge, midPlane, planeThroughPoints } from "./planeMath";
import { BOOLEAN_LABEL, type BooleanOp } from "./booleanOps";
import type { ExtrudeTool } from "./extrudeTool";
import type { EdgeFeatureTool } from "./edgeFeatureTool";
import type { PressPullTool } from "./pressPullTool";
import type { LoftTool } from "./loftTool";
import type { MoveTool } from "./moveTool";
import type { PatternKind, PatternTool } from "./patternTool";
import type { PlaneOffsetTool } from "./planeOffsetTool";
import type { TextureTool } from "./textureTool";
import { pickPlaneTarget, planeSpecOf, type FacePlanePick } from "./facePlanePick";
import { choose } from "../ui/choice";
import { pointInRegion } from "../sketch/region";
import { setPrompt } from "../ui/prompt";
import type { Axis3, AxisSpec, Feature, PlaneDef, PlaneSpec, Selector, Vec3 } from "../types";
import { findSelectorAt, replaceSelectorAt } from "./repickReference";

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
  planeOffset: PlaneOffsetTool;
  texture: TextureTool;
  canvas: HTMLCanvasElement;
  toolBusy: () => boolean;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selectFeature: (id: string | null) => void;
  noteCommitted: (id: string | null) => void;
  isSketchConsumed: (id: string) => boolean;
  getSelectedFeature: () => string | null;
  setPlanePick: (v: boolean) => void;
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
    planeOffset,
    texture,
    canvas,
    toolBusy,
    hasBody,
    setStatus,
    selectFeature,
    noteCommitted,
    getSelectedFeature,
    setPlanePick,
  } = deps;

  // Interactive Fillet / Chamfer: pick an edge (or use a Ctrl-click pre-selection),
  // then drag an arrow to scrub the radius/distance with a live sidecar preview.
  const edgeFeatureDone = (id: string | null) => { noteCommitted(id); if (id) selectFeature(id); };
  const startFillet = () => {
    if (toolBusy()) return;
    edgeFeature.start("fillet", edgeFeatureDone);
  };
  const startChamfer = () => {
    if (toolBusy()) return;
    edgeFeature.start("chamfer", edgeFeatureDone);
  };
  /** The selection handle (features/edgeNudge.ts) was pressed: arm the same
   *  tool, from the same pre-selection, but already holding the arrow — the
   *  press that summons the tool is the press that drags it.
   *
   *  It opens on FILLET, which also decides the drag's geometry: the tool reads
   *  the arrow's own direction as a fillet and the far side of the origin as a
   *  chamfer, so the more common answer is the one you get by dragging the way
   *  the arrow points. Opening on a mode the user has to choose first would put
   *  a decision back in front of the gesture, which is the thing this flow
   *  exists to stop doing — and neither answer is a dead end, since the other is
   *  one drag back through zero (or one Tab) away. */
  const grabEdgeHandle = (x: number, y: number, tangent: THREE.Vector3 | null) => {
    if (toolBusy()) return;
    edgeFeature.start("fillet", edgeFeatureDone, { tangent, grabAt: { x, y } });
  };
  // Interactive Press/Pull: pick a solid face, then drag an arrow along its normal
  // to add/cut material (planar) or offset a curved face — with a live preview.
  const pressPullDone = (id: string | null) => { noteCommitted(id); if (id) selectFeature(id); };
  const startPressPull = () => {
    if (toolBusy()) return;
    pressPull.start(pressPullDone);
  };
  /** The same hand-off as grabEdgeHandle, for the arrow offered on a selected
   *  FACE (features/faceNudge.ts). There is no treatment to choose here — a
   *  face has exactly one thing you can do to it by dragging — so unlike the
   *  edge handle this one has no default to defend. */
  const grabFaceHandle = (x: number, y: number) => {
    if (toolBusy()) return;
    pressPull.start(pressPullDone, { grabAt: { x, y } });
  };

  /** Abort an in-flight interactive plane pick, if any.
   *
   *  `planePick` is part of toolBusy(), and pickPlaneInteractive only clears it
   *  from its own canvas click or Escape. Choosing the plane in the BROWSER
   *  instead (tree.onSketchOnPlane) enters the sketch by a different route and
   *  left the flag set forever, so from then on every tool guarded by toolBusy()
   *  — extrude, fillet, shell, press/pull, measure, section — returned silently
   *  and did nothing at all, with no message, until the app was restarted. */
  function cancelPlanePick() {
    pendingPickCleanup?.();
  }

  let pendingPickCleanup: (() => void) | null = null;

  /** `face` is the pick's face reference when a body face was taken, and null
   *  for a construction quad. A datum plane keeps it so it can follow the face
   *  across a rebuild; a sketch started directly on a face has no use for it,
   *  since a sketch stores its own plane. */
  function pickPlaneInteractive(
    promptText: string,
    onPick: (spec: PlaneSpec, face: FacePlanePick | null) => void,
  ) {
    if (toolBusy()) return;
    setPlanePick(true);
    viewport.showAllPlanes(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    // Hover and click ask facePlanePick the SAME question, so the highlight is a
    // promise: a face that lights up is a face the click will take. That matters
    // now that a face can be refused — a fillet's blend implies no plane at all,
    // and the old pair (hover anything, click takes the raw triangle's plane)
    // both lit faces it had no plane for and answered, for the round ones it did
    // take, with a plane through one tessellation triangle.
    //
    // A refused face gets no highlight, which on its own reads as "the app did
    // not notice my cursor" rather than "this face has no plane" — so say which,
    // once, on the transition. Rewriting the prompt every pointermove would
    // thrash a line the user is trying to read.
    let sayingWhy = false;
    const onMove = (e: PointerEvent) => {
      const target = pickPlaneTarget(viewport, e.clientX, e.clientY);
      if (target?.kind === "face") {
        viewport.hoverFaceAt(e.clientX, e.clientY); // highlight a selectable body face
        viewport.hoverPlane(null);
      } else {
        viewport.clearHover();
        viewport.hoverPlane(target?.kind === "base" ? target.spec : null);
      }
      const why = target?.kind === "unusable";
      if (why !== sayingWhy) {
        sayingWhy = why;
        setPrompt(why ? `${promptText}, this face is neither flat nor round, so it implies no plane` : promptText);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Nothing usable under the cursor: stay in the pick rather than take a
      // guess. A body face with no plane in it deliberately does NOT fall
      // through to the construction quad behind the part.
      const target = pickPlaneTarget(viewport, e.clientX, e.clientY);
      const spec = planeSpecOf(target);
      if (!spec) return;
      const face = target?.kind === "face" ? target.face : null;
      // consume this click fully and run on the NEXT frame, so it can't bleed
      // into the sketch's own first-corner placement.
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(spec, face));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      pendingPickCleanup = null;
      setPlanePick(false);
      viewport.showAllPlanes(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    pendingPickCleanup = cleanup;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  /** Sketch. A SELECTED planar face wins outright: it is already an answer to
   *  "which plane?", so asking again — with the whole model greyed out and the
   *  base-plane quads back on screen — is a step that can only be got wrong.
   *  Click the face, press S, draw. (Curved faces and empty selections fall
   *  through to the picker, which is where base planes live anyway.)
   *
   *  The face selection is dropped on the way in. It has been CONSUMED: leaving
   *  it lit would put a stale press/pull offer behind the sketch and leave the
   *  face selected — and therefore re-consumable — when the sketch closes.
   *
   *  Dropped, but not forgotten: the face is lit for the session by its own
   *  overlay (viewport.showSketchFace), so "which face am I drawing on?" has an
   *  answer on screen without the selection being live behind it. */
  function startSketch(tool?: SketchTool) {
    if (!toolBusy()) {
      const face = viewport.selectedFaceSketchPlane();
      if (face) {
        viewport.clearSelection();
        // The anchor rides in on BOTH routes into a sketch, or a sketch started
        // from a selected face would silently be the one kind that cannot follow
        // its face.
        sketch.enter(face.plane, store, undefined, undefined, face.anchor);
        viewport.showSketchFace(face.faceId);
        if (tool) sketch.setTool(tool);
        return;
      }
    }
    pickPlaneInteractive("Select a plane or a face to sketch on · a round face gives its tangent plane", (spec, face) => {
      // Only a PLANAR face can be followed: a tangent plane on a cylinder is a
      // different plane at every point, and the pick's own point is what defines
      // it, so there is nothing for a rebuild to re-derive.
      sketch.enter(spec, store, undefined, undefined,
        face && face.kind === "planar" ? { selector: face.selector, at: face.at } : null);
      if (face) viewport.showSketchFace(face.faceId);
      if (tool) sketch.setTool(tool);
    });
  }

  // Offset Plane: pick a plane/face, then drag an arrow (or type) to set the
  // offset, with a live ghost of the resulting plane; then sketch on it.
  //
  // It used to BAKE the distance into the resulting plane's origin — the scalar
  // was discarded, the source plane identity was lost, and nothing landed in the
  // timeline, so an offset plane could never be adjusted after the fact. It now
  // creates the same parametric `datumPlane` that the Datum Plane button and the
  // right-click "Offset plane from face" already created (source plane + an
  // editable scalar offset), and enters the sketch BY ID, so changing the offset
  // in the value rows moves the sketch with it.
  function offsetPlane() {
    pickPlaneInteractive("Select a plane or face to offset from", (spec, face) => {
      const src = new SketchPlane(spec);
      planeOffset.start(src, (def) => {
        if (!def) return;
        const id = store.nextId();
        store.addFeature({
          id, type: "datumPlane", plane: spec, offset: offsetAlong(def, src), ...faceRef(face),
        } as Feature);
        sketch.enter(def, store, undefined, id);
      });
    });
  }

  // Datum Plane: pick a plane/face, position it (offset), then save a persistent
  // datum plane feature — it lands in the timeline + Planes folder and can be
  // reused as a sketch / split reference. We store the SOURCE plane + a scalar
  // offset (not a baked plane) so the offset stays editable in the value rows.
  //
  // A ROUND face is a legitimate source and gives its TANGENT plane at the point
  // you clicked (planeMath.tangentPlaneOnCylinder) — a cylinder has no plane of
  // its own, so the only two sensible answers are the tangent and something
  // built off the axis, and the tangent is the one you can immediately sketch a
  // flat on or offset away from the shaft. The offset then runs radially, which
  // is what makes "a plane 5 mm off this boss" one gesture.
  function createDatumPlane() {
    pickPlaneInteractive("Select a plane or face for the datum plane · a round face gives its tangent plane", (spec, face) => {
      const src = new SketchPlane(spec);
      planeOffset.start(src, (def) => {
        if (!def) return;
        const id = store.nextId();
        store.addFeature({
          id, type: "datumPlane", plane: spec, offset: offsetAlong(def, src), ...faceRef(face),
        } as Feature);
        selectFeature(id);
      });
    });
  }

  /** A plane spec as the resolved triple every construction below works in.
   *  `PlaneSpec` is either a named base plane or a def already; SketchPlane is
   *  the one place that knows how to turn the first into the second. */
  function asDef(spec: PlaneSpec): PlaneDef {
    const sp = new SketchPlane(spec);
    return {
      origin: [sp.origin.x, sp.origin.y, sp.origin.z],
      normal: [sp.n.x, sp.n.y, sp.n.z],
      xdir: [sp.u.x, sp.u.y, sp.u.z],
    };
  }

  // Midplane: pick two planes or faces, get the plane between them.
  //
  // It is the plane symmetry is made of, and without it "halfway between these
  // two walls" was a measurement, an offset plane at half of it, and no link
  // back to either wall afterwards. See planeMath.midPlane for what "between"
  // means when the two are not parallel.
  //
  // KNOWN LIMIT, the same one a datum built off a construction quad has: the
  // result is a RESOLVED plane, so it does not follow either face if something
  // upstream moves them. A datum keeps one face reference and this has two, so
  // following would need a shape the document does not have.
  function createMidplane() {
    pickPlaneInteractive("Select the first plane or face for the midplane", (a) => {
      // Next frame, like the pick's own commit: the first pick's click must not
      // arrive at the second pick's listeners.
      requestAnimationFrame(() => {
        pickPlaneInteractive("Select the second plane or face", (b) => {
          const def = midPlane(asDef(a), asDef(b));
          if (!def) {
            setStatus("Midplane: those two faces name no plane between them", "");
            return;
          }
          const id = store.nextId();
          store.addFeature({ id, type: "datumPlane", plane: def, name: "Midplane" } as Feature);
          selectFeature(id);
        });
      });
    });
  }

  // Plane through three points: the only way to reach a plane that no face of
  // the part lies in — through three holes, three corners of a casting, a rib
  // and two bosses. Points come from the same snap the gizmo's origin uses
  // (viewport.pointAt), so a corner and the middle of an edge are aimable
  // rather than approximate.
  function createPlaneThroughPoints() {
    pickPointsInteractive(3, "Select three points for the plane", (pts) => {
      const [a, b, c] = pts;
      const def = a && b && c ? planeThroughPoints(a, b, c) : null;
      if (!def) {
        setStatus("Plane through points: those three points lie in a line", "");
        return;
      }
      const id = store.nextId();
      store.addFeature({ id, type: "datumPlane", plane: def, name: "Plane" } as Feature);
      selectFeature(id);
    });
  }

  /** Collect `n` points on the model, snapping to what it actually has.
   *
   *  Every point taken so far is drawn, and so is the one under the cursor, so
   *  the pick is visible rather than remembered — three clicks with no feedback
   *  is a gesture nobody can recover from a mistake in. Escape drops the last
   *  point, and drops the whole pick when there is none left, which is the same
   *  stack Escape means everywhere else in the app. */
  function pickPointsInteractive(
    n: number,
    promptText: string,
    onDone: (pts: Vec3[]) => void,
  ) {
    if (toolBusy()) return;
    setPlanePick(true);
    viewport.suspendPicking = true;
    const taken: Vec3[] = [];
    const say = () => setPrompt(`${promptText} · ${taken.length} of ${n} · Esc`);
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
      taken.push([hit.p.x, hit.p.y, hit.p.z]);
      draw(null);
      if (taken.length < n) { say(); return; }
      const pts = taken.slice();
      cleanup();
      requestAnimationFrame(() => onDone(pts));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (taken.length) { taken.pop(); draw(null); say(); return; }
      cleanup();
    };
    const cleanup = () => {
      pendingPickCleanup = null;
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.setPickMarkers([], null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    pendingPickCleanup = cleanup;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  // Right-click → "Offset plane from face": same as Datum Plane but the source is
  // the right-clicked face (no separate pick step).
  function offsetPlaneFromFace(face: PlaneDef) {
    if (toolBusy()) return;
    const src = new SketchPlane(face);
    planeOffset.start(src, (def) => {
      if (!def) return;
      const id = store.nextId();
      store.addFeature({ id, type: "datumPlane", plane: face, offset: offsetAlong(def, src) } as Feature);
      selectFeature(id);
    });
  }

  /** The face reference a datum keeps, or nothing when the source was a
   *  construction quad. `at` rides along only for a round face, where the
   *  tangent plane differs at every point and the pick location is therefore
   *  part of the definition. One function because three routes create a datum
   *  and a route that forgot the selector would silently produce the old frozen
   *  behaviour, which looks identical until something upstream moves. */
  function faceRef(face: FacePlanePick | null): { face?: Selector; at?: Vec3 } {
    if (!face) return {};
    return { face: face.selector, ...(face.kind === "tangent" ? { at: face.at } : {}) };
  }

  // signed distance of an offset-tool result from its source plane, along the
  // source normal (mm) — the editable `offset` we store on the datum.
  function offsetAlong(def: PlaneDef, src: SketchPlane): number {
    return (
      (def.origin[0] - src.origin.x) * src.n.x +
      (def.origin[1] - src.origin.y) * src.n.y +
      (def.origin[2] - src.origin.z) * src.n.z
    );
  }

  // Split Body: choose which side(s) to keep, then pick + position a cutting plane.
  // Reuses the plane picker + offset gizmo so the cut lands exactly where you want.
  async function startSplit() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Split: create or import a body first", "");
      return;
    }
    // "select that plane and cut": a selected construction plane cuts ALL visible
    // bodies by id (startCutByPlane handles the keep-side prompt).
    const selId = getSelectedFeature();
    const sel = selId ? store.document.features.find((f) => f.id === selId) : null;
    if (sel?.type === "datumPlane") return void startCutByPlane(sel.id);

    const keep = await choose<"both" | "top" | "bottom">("Split Body, keep which side?", [
      { value: "both", label: "Both", hint: "two bodies" },
      { value: "top", label: "Top", hint: "+normal side" },
      { value: "bottom", label: "Bottom", hint: "−normal side" },
    ]);
    if (!keep) return;
    const bodies = store.buildState.result?.bodies ?? [];
    let body: string | undefined;
    if (bodies.length > 1) {
      const picked = await chooseBody("Which body to split?", bodies);
      if (!picked) return;
      body = picked;
    }
    pickPlaneInteractive("Select a plane or face to cut by", (spec) => {
      planeOffset.start(new SketchPlane(spec), (def) => {
        if (def) store.addFeature({ id: store.nextId(), type: "split", plane: def, keep, body, groupSides: true } as Feature);
      });
    });
  }

  // Cut ALL visible bodies by a construction plane (right-click a plane → Cut, or
  // select a plane + Split Body). Reuses the split feature with `planeId` + the list
  // of currently-visible body ids.
  async function startCutByPlane(planeId: string) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Cut: create or import a body first", "");
      return;
    }
    const keep = await choose<"both" | "top" | "bottom">("Cut, keep which side?", [
      { value: "both", label: "Both", hint: "two bodies" },
      { value: "top", label: "Top", hint: "+normal side" },
      { value: "bottom", label: "Bottom", hint: "−normal side" },
    ]);
    if (!keep) return;
    const ids = (store.buildState.result?.bodies ?? [])
      .filter((b) => store.isBodyVisible(b.id))
      .map((b) => b.id);
    store.addFeature({ id: store.nextId(), type: "split", planeId, keep, bodies: ids, groupSides: true } as Feature);
  }

  // Union / Subtract / Intersect: one starter, three commands. The operation is
  // an ARGUMENT here rather than a question, because each command already knows
  // which boolean it is — that is the whole difference from the single Combine
  // command it replaces, which opened on a dialog before it would look at the
  // selection.
  //
  // With bodies already selected it runs on them: the FIRST is the kept target
  // and the rest are tools, which is what makes the direction of a subtract
  // unambiguous without asking. With none selected it falls back to picking the
  // target (when there is more than one candidate) and a checklist of tools.
  /** Union / Subtract / Intersect.
   *
   *  Two clicks in the viewport: the body to KEEP, then the body to do it with.
   *  The order is the operation — for a subtract the first body is the one left
   *  standing and the second is the one that goes away — so it has to be asked
   *  in that order, out loud, with the prompt saying which answer it wants. It
   *  used to be a body-selection gesture followed by a modal list of names, and
   *  a list of names is the wrong place to answer "which of these two solids":
   *  the answer is in the viewport, and so is the question.
   *
   *  A selection made beforehand is still honoured, because that gesture is the
   *  only way to give ONE boolean more than one tool body: two or more selected
   *  bodies commit straight away, first kept and the rest consumed. One selected
   *  body answers the first question and the tool asks the second.
   */
  function startBoolean(op: BooleanOp) {
    if (toolBusy()) return;
    const bodies = store.buildState.result?.bodies ?? [];
    if (bodies.length < 2) {
      setStatus(`${BOOLEAN_LABEL[op]} needs two bodies`, "");
      return;
    }
    const pre = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    if (pre.length >= 2) {
      const [first, ...rest] = pre;
      if (first === undefined) return;
      commitBoolean(op, first, rest);
      return;
    }

    const verb = BOOLEAN_LABEL[op].toLowerCase();
    // Asked even when only one candidate is left. Two bodies is the ordinary
    // case, and having the second one taken automatically means a single click
    // makes a body disappear — the same gesture that, one body later, does not.
    // A step that is always there is a step you can learn.
    const withTarget = (target: string) => {
      pickBodyInteractive(
        `Click the body to ${verb} with · Esc cancels`,
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
      op === "subtract"
        ? "Click the body to keep · Esc cancels"
        : `Click the first body to ${verb} · Esc cancels`,
      [],
      withTarget,
    );
  }

  function commitBoolean(op: BooleanOp, target: string, tools: string[]) {
    viewport.setSelectedBodies([]); // consumed tools would dangle; clear the selection
    store.addFeature(
      { id: store.nextId(), type: "boolean", operation: op, target, tools } as Feature,
    );
  }

  /** Point at a body on the model. The same shape as pickRegionInteractive and
   *  pickAxisInteractive: suspend ordinary picking, light what is under the
   *  cursor, take a left click, and treat empty space as a miss rather than a
   *  cancel — so a click that lands beside the part does not throw away the
   *  half-finished operation.
   *
   *  `exclude` are bodies already spoken for by this operation. They stay
   *  clickable-looking but do not light and do not answer, because a body that
   *  vanished from the model while it was being pointed at would be a worse
   *  answer to "why did nothing happen" than one that simply does not respond. */
  function pickBodyInteractive(
    promptText: string,
    exclude: readonly string[],
    onPick: (bodyId: string) => void,
  ) {
    if (toolBusy()) return;
    const bodyUnder = (cx: number, cy: number): string | null => {
      const id = viewport.bodyIdAt(cx, cy);
      return id && !exclude.includes(id) ? id : null;
    };
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
    const cleanup = () => {
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

  /** Pick one body by name from the rebuild's body list (returns its id). Labels use
   *  the sidebar rename override (store.bodyName) so the picker matches the browser
   *  tree — otherwise a renamed "Bracket" shows as the default "Body1" here. */
  function chooseBody(title: string, bodies: { id: string; name: string }[]): Promise<string | null> {
    return choose<string>(title, bodies.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })));
  }

  // Simplify Mesh: merge near-coplanar facets of the active (imported) body into
  // fewer, larger faces. Tune the angular tolerance in the value rows (higher =
  // fewer faces, but coarsens curved regions).
  function startSimplifyMesh() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Simplify Mesh: import or create a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "simplifyMesh", tolerance: 1 } as Feature);
  }

  // Clean Up: repair boolean rot on all bodies at this point in the timeline —
  // unify glued/overlapping solids, then collapse facet debris (slivers +
  // near-coplanar staircases). Booleans on ragged imports re-manufacture debris,
  // so run it again after a heavy Press/Pull or boolean session to keep Delete
  // Face and downstream booleans reliable. Best-effort in the sidecar: a body it
  // can't confidently clean passes through unchanged.
  function startCleanUp() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Clean Up: import or create a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "cleanUp" } as Feature);
    setStatus("Clean Up added, bodies unified from here on", "");
  }

  // Scale: resize the active body about the origin (handy for fixing the units of
  // an import). Default factor 1 — set it in the value rows.
  function startScale() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Scale: create or import a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "scale", factor: 1 } as Feature);
    // Factor 1 is a visual no-op by design (the value row is where you set it),
    // which means a silent add looks exactly like the tool doing nothing. Say so,
    // the way Clean Up does.
    setStatus("Scale added — set the factor in the value rows", "");
  }

  // Move: translate / rotate the active body. Defaults to no-op — set the offsets
  // and angles in the value rows.
  function startMove() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Move: create or import a body first", "");
      return;
    }
    const bodies = store.buildState.result?.bodies ?? [];
    let ids = viewport.getSelectedBodies();
    if (!ids.length && bodies.length) {
      const lastBody = bodies[bodies.length - 1];
      if (lastBody) ids = [lastBody.id]; // none selected → active body
    }
    if (!ids.length) {
      setStatus("Move: select a body first (Select: Bodies)", "");
      return;
    }
    moveTool.start(ids, (id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  // Mirror: choose the symmetry plane (the backend honors XY/XZ/YZ; the old tool
  // was hard-coded to YZ). Mirrors the active body and unions the reflection.
  async function startMirror() {
    if (toolBusy()) return;
    const hasSolid = hasBody();
    if (!hasSolid) {
      setStatus("Mirror: create a body first", "");
      return;
    }
    const plane = await choose<"XY" | "XZ" | "YZ">("Mirror across plane", [
      { value: "XY", label: "XY" },
      { value: "XZ", label: "XZ" },
      { value: "YZ", label: "YZ" },
    ]);
    if (!plane) return;
    store.addFeature({ id: store.nextId(), type: "mirror", plane } as Feature);
  }

  // Revolve: spin the selected sketch profiles around an axis POINTED AT in the
  // viewport, into a new body, all the way round. Falls back to the only profile
  // when the sketch has just one.
  //
  // The two questions this used to ask first are both answered by defaults that
  // stay editable. The operation is New Body, which is what nearly every revolve
  // is and what the Operation row on the feature can change in one click. The
  // angle is a full turn, which the Angle row and the pitch arrow can change. A
  // modal that has to be dismissed before anything appears asks the user to
  // decide with nothing yet to look at; a default they can see and correct does
  // not.
  /** One-shot sketch-PROFILE picker: the closed areas of every visible sketch are
   *  live, the one under the cursor highlights, and a click returns it.
   *
   *  The twin of pickFaceInteractive, and it exists because Revolve and Sweep used
   *  to refuse to start without a pre-selection: "select a sketch profile to
   *  revolve first" is a dead end for anyone who reached for the tool before the
   *  profile, which — since the tool is the thing on the ribbon and the profile is
   *  a region of a sketch nobody has been told is clickable — is most people the
   *  first time. Loft never had that problem because it asks in the viewport, so
   *  ask the same way. The hit test is Loft's (features/loftTool.ts regionUnder):
   *  front-most region whose material, holes excluded, is under the cursor. */
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
        if (d < bestDist) { bestDist = d; best = wr; }
      }
      return best;
    };
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
    const cleanup = () => {
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
        setStatus("Revolve needs a closed sketch profile — draw one first", "");
        return;
      }
      // More than one profile is showing and none is selected. Ask in the
      // viewport, where the answer is, rather than refusing.
      pickRegionInteractive("Click the profile to revolve · Esc", (r) => revolveFrom([r]));
      return;
    }
    revolveFrom(picked);
  }

  function revolveFrom(picked: readonly WorldRegion[]) {
    const wr = picked[0];
    if (!wr) return;
    // Areas from OTHER sketches cannot join this one revolve — a feature names a
    // single sketch. Spinning them silently as if they had been part of it is how
    // the whole-sketch fallback used to go wrong; drop them instead.
    const areas = picked.filter((r) => r.sketchId === wr.sketchId);
    pickAxisInteractive((axis, edge) => addRevolve(wr, areas, axis, "new", edge));
  }

  /** Point at the line to spin about: one of the three arrows at the origin, or
   *  a straight edge on the model.
   *
   *  This was a list reading "X axis / Y axis / Z axis / an edge", put up in front
   *  of a viewport that was already drawing three labelled arrows — and answering
   *  "an edge" then asked the same question again, in the viewport, where it could
   *  have been asked once. The arrows ARE the drawing of this question, so they
   *  are the control. Hovering lights the one under the cursor in the colour an
   *  edge takes under the cursor, because the two are the same act.
   *
   *  Unlike pickEdgeInteractive this does not require a body. The first revolve in
   *  a document has nothing to pick an edge from, and the origin arrows are drawn
   *  whether or not anything has been built yet. */
  function pickAxisInteractive(onPick: (axis: AxisSpec, edge?: Selector) => void) {
    if (toolBusy()) return;
    const triad = viewport.scene.triad;
    // The hit lands on a shaft, a head or the arm's undrawn hit sleeve, so walk
    // up to whichever ancestor carries the tag rather than assuming a depth.
    const axisAt = (x: number, y: number): Axis3 | null => {
      const hit = viewport.rayFrom(x, y).intersectObjects(triad.arms, true)[0];
      for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
        const a = o.userData?.axis;
        if (a === "X" || a === "Y" || a === "Z") return a;
      }
      return null;
    };
    viewport.suspendPicking = true;
    viewport.emphasizeEdges(true);
    setPrompt(
      "Click an axis arrow at the origin, or a straight edge on the model, to spin around. Esc cancels.",
    );
    const onMove = (e: PointerEvent) => {
      // An arrow wins over an edge behind it. The arrows are small, deliberately
      // aimed at, and drawn in front of everything; an edge that happens to lie
      // under one is not what the cursor is on.
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
        setStatus("An axis has to be a straight edge", "");
        return;
      }
      requestAnimationFrame(() => onPick(line, hit!.selector));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
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

  /** Write the revolve. `axisEdge` present means `axis` is the resolved line kept
   *  as a cache beside the reference, not the axis of record — see the Feature
   *  type for why both are stored. */
  function addRevolve(
    wr: WorldRegion,
    areas: readonly WorldRegion[],
    axis: AxisSpec,
    operation: "new" | "join" | "cut",
    axisEdge?: Selector,
  ) {
    store.addFeature({
      id: store.nextId(), type: "revolve", sketch: wr.sketchId, axis, angle: 360, operation,
      regions: areas.map((r) => [r.interior3D.x, r.interior3D.y, r.interior3D.z]),
      ...(axisEdge ? { axisEdge } : {}),
    } as Feature);
  }

  // Loft: interactive Fusion-style tool — click profiles in order, the loft
  // previews live once two are picked (see LoftTool). Any profiles already
  // selected in the model view seed the tool.
  function startLoft() {
    if (toolBusy()) return;
    loftTool.start((id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  // Sweep: select a closed profile region, then pick a second (open) sketch as the
  // path. The profile should sit at the start of the path, roughly perpendicular.
  async function startSweep() {
    if (toolBusy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      if (!overlay.regions.length) {
        setStatus("Sweep needs a closed profile sketch — draw one first", "");
        return;
      }
      pickRegionInteractive("Click the profile to sweep · Esc", (r) => void sweepFrom(r));
      return;
    }
    await sweepFrom(wr);
  }

  async function sweepFrom(wr: WorldRegion) {
    const all = store.document.features.filter((f) => f.type === "sketch");
    const candidates = all.filter((f) => f.id !== wr.sketchId);
    if (candidates.length === 0) {
      setStatus("Sweep: add a second sketch with an open curve for the path", "");
      return;
    }
    const label = (id: string) => `Sketch ${all.findIndex((f) => f.id === id) + 1}`;
    const c0 = candidates[0];
    if (!c0) return;
    let pathId = c0.id;
    if (candidates.length > 1) {
      const picked = await choose<string>("Pick the path sketch", candidates.map((f) => ({ value: f.id, label: label(f.id) })));
      if (!picked) return;
      pathId = picked;
    }
    store.addFeature({ id: store.nextId(), type: "sweep", profile: wr.sketchId, path: pathId, operation: "new" } as Feature);
  }

  // Primitive: drop a Box / Cylinder / Sphere body at the origin (edit its size in
  // the value rows). Useful as a starting block or as a boolean tool body.
  async function startPrimitive() {
    if (toolBusy()) return;
    const shape = await choose<"box" | "cylinder" | "sphere">("Create primitive", [
      { value: "box", label: "Box", hint: "l×w×h" },
      { value: "cylinder", label: "Cylinder", hint: "r, h" },
      { value: "sphere", label: "Sphere", hint: "r" },
    ]);
    if (!shape) return;
    const id = store.nextId();
    if (shape === "box") store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 } as Feature);
    else if (shape === "cylinder") store.addFeature({ id, type: "cylinder", radius: 10, height: 20 } as Feature);
    else store.addFeature({ id, type: "sphere", radius: 10 } as Feature);
  }

  // One-shot face picker: highlight the face under the cursor, return its selector
  // on click (Esc cancels). Reused by Shell (open face) and Draft (taper face).
  function pickFaceInteractive(promptText: string, onPick: (sel: Selector) => void) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Create or import a body first", "");
      return;
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
      // Stamp the body that owns the clicked face. Without it the sidecar falls
      // back to the active (last-created) body and the face selector resolves
      // against the wrong shape — so on a multi-body model the shell/draft would
      // land on a body the user never touched (same fault as the texture bug).
      const sel: Selector = hit.bodyId ? { ...hit.selector, body: hit.bodyId } : hit.selector;
      requestAnimationFrame(() => onPick(sel));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
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
  }

  // One-shot EDGE picker, the twin of pickFaceInteractive above. Every model edge
  // lights up, the one under the cursor highlights, and a click returns its
  // selector — and its polyline, for callers that have to write down what the
  // edge WAS as well as how to find it again (revolve's axis cache).
  function pickEdgeInteractive(
    promptText: string,
    onPick: (sel: Selector, points: readonly Vec3[]) => void,
  ) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Create or import a body first", "");
      return;
    }
    viewport.suspendPicking = true;
    viewport.emphasizeEdges(true);
    setPrompt(promptText);
    const onMove = (e: PointerEvent) =>
      viewport.hoverEdge(viewport.pickEdgeAt(e.clientX, e.clientY)?.edge ?? null);
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
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
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
  }

  // Repair an ambiguous saved reference: the rebuild refused to guess between two
  // equally-close candidates, so ask which one was meant and swap that ONE
  // selector. Everything else about the feature is left alone.
  //
  // `kind` is the sidecar's own word for what went ambiguous, and it decides what
  // is picked. This used to pick a face unconditionally, so repairing a fillet
  // put a FACE selector into its `edges` field, where the resolver read the face's
  // pick point as an edge point and rounded whichever edge sat nearest it.
  //
  // Only the selector the sidecar named is touched — located by its stored point,
  // not by index (see repickReference.ts). If it can't be found the feature has
  // moved on since the failed build (already re-picked, or edited), which is not
  // an error: say so and do nothing rather than "repairing" the wrong reference.
  function repickReference(featureId: string, at: readonly number[], kind?: string) {
    const feature = store.document.features.find((f) => f.id === featureId);
    if (!feature) return;
    const site = findSelectorAt(feature, at);
    if (!site) {
      setStatus("That reference has already changed, nothing to re-pick", "");
      return;
    }
    const wantsEdge = kind === "edge";
    const pick = wantsEdge ? pickEdgeInteractive : pickFaceInteractive;
    pick(`Pick the ${wantsEdge ? "edge" : "face"} to use · Esc`, (sel) => {
      // Re-read the feature: the pick is async, and the doc may have moved under
      // us (undo, another edit). Re-locating also re-validates the site.
      const cur = store.document.features.find((f) => f.id === featureId);
      if (!cur) return;
      const site2 = findSelectorAt(cur, at);
      if (!site2) {
        setStatus("That reference has already changed, nothing to re-pick", "");
        return;
      }
      store.updateFeature(featureId, replaceSelectorAt(cur, site2, sel));
    });
  }

  // Shell: pick a face to open, hollow the body to a 2mm wall (edit thickness in
  // the value rows).
  function startShell() {
    pickFaceInteractive("Select a face to open for the shell · Esc to cancel", (faces) => {
      store.addFeature({ id: store.nextId(), type: "shell", thickness: 2, faces } as Feature);
    });
  }

  // Draft: pick a face to taper by 5° about the body's base (pull +Z; edit the
  // angle in the value rows).
  // Texture: printed surface texture (knurl/hex/waves/ribs/voronoi/noise/image
  // heightmap) over selected faces or a whole body. No pick-then-drag gesture
  // like Shell/Draft — it rides the ambient selection with a docked panel
  // (click/Ctrl-click faces, or toggle Whole Body in the panel), so it just
  // hands off to the tool directly.
  function startTexture() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Texture: create or import a body first", "");
      return;
    }
    texture.start((id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  // Pattern: repeat the selected bodies along an axis or around one, set up in
  // the viewport. It used to ask which kind in a modal and then drop a feature
  // with invented numbers into the timeline for the value rows to correct —
  // which is the whole gesture done twice, in the wrong order, with none of it
  // where the geometry is.
  //
  // Which kind is still a decision, and it is still made before the tool opens:
  // linear and circular are different gestures (pull an arrow vs sweep around
  // one), not two settings of the same one. But it is made by pressing the
  // button you meant, not by answering a dialog the button raised.
  function startPattern(kind: PatternKind) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Pattern: create or import a body first", "");
      return;
    }
    // Same rule as Move: the selection if there is one, otherwise the active
    // body — which is what the kernel patterns when the feature names no bodies.
    const built = store.buildState.result?.bodies ?? [];
    let ids = viewport.getSelectedBodies();
    if (!ids.length && built.length) {
      const last = built[built.length - 1];
      if (last) ids = [last.id];
    }
    if (!ids.length) {
      setStatus("Pattern: select a body first (Select: Bodies)", "");
      return;
    }
    patternTool.start(kind, ids, (id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  const extrudeDone = (id: string | null) => { noteCommitted(id); if (id) selectFeature(id); };

  function startExtrude() {
    if (toolBusy()) return;
    // A SELECTED FACE wins: extrude-a-face = Press/Pull it (drag out to join, in to
    // cut). This takes priority over region extrude so a visible sketch never hijacks
    // "extrude this face" (was: a shown sketch forced region-extrude, so face cut did
    // nothing).
    const sel = viewport.selectedFacesForPressPull();
    if (sel) {
      // …EXCEPT when the selected face sits ON or BEHIND a visible sketch's
      // plane (same-direction normals): faces win general picks, so a click
      // aimed at a sketch profile lying on that face selects the face instead —
      // and hijacking to Press/Pull forced users to hide the body to extrude a
      // sketch. The sketch has priority when it's on or above the face.
      const underSketch = overlay.regions.some((wr) => {
        if (wr.plane.n.dot(sel.normal) < 0.99) return false; // same-facing planes only
        return wr.plane.plane.distanceToPoint(sel.anchor) <= 0.01; // face on/behind the sketch plane
      });
      if (!underSketch) {
        pressPull.start(pressPullDone);
        return;
      }
    }
    if (overlay.regions.length === 0) {
      setStatus("Extrude needs a face or a closed sketch profile", "");
      return;
    }
    extrude.start(extrudeDone);
  }

  /** The handle offered on a selected sketch profile (features/regionNudge.ts)
   *  was pressed: arm Extrude on that pre-selection, already holding the arrow.
   *
   *  Unlike startExtrude this does NOT arbitrate between a face and a profile.
   *  That arbitration exists because the `E` key is one command aimed at
   *  whatever you had selected, and it has to guess which you meant. A press on
   *  a specific arrow standing on a specific profile is not a guess. */
  const grabRegionHandle = (x: number, y: number) => {
    if (toolBusy()) return;
    extrude.start(extrudeDone, { grabAt: { x, y } });
  };

  return {
    cancelPlanePick,
    startFillet,
    startChamfer,
    grabEdgeHandle,
    grabFaceHandle,
    startPressPull,
    startSketch,
    offsetPlane,
    createDatumPlane,
    createMidplane,
    createPlaneThroughPoints,
    offsetPlaneFromFace,
    startSplit,
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
    startShell,
    startTexture,
    startPattern,
    startExtrude,
    grabRegionHandle,
    repickReference,
  };
}

export type FeatureStarters = ReturnType<typeof createFeatureStarters>;
