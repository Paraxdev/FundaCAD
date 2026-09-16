// Viewport orchestrator: owns the scene, camera rig, render loop, ViewCube,
// the current model view, picking + highlighting. Exposes a small API the rest
// of the app uses: setModel(), fit(), pick callbacks, projection/view toggles.

import * as THREE from "three";
import { createScene, type SceneBundle } from "./scene";
import {
  createCameraRig,
  type CameraRig,
  type StandardView,
  type ProjectionMode,
} from "./cameras";
import {
  buildBodyMesh,
  isRenderLowPower,
  buildEdgeLines,
  buildSectionGhosts,
  bodyMaterials,
  bodyOfFace,
  disposeBody,
  disposeModel,
  faceIdOfHit,
  edgeObjects,
  groupEdgesByBody,
  partitionMesh,
  resetBodyAppearance,
  setEdgeResolution,
  visibleBodyMeshes,
  BASE_COLOR,
  type BodyMesh,
  type ModelView,
  type EdgeRef,
} from "./render";
import { SectionCaps } from "./sectionCaps";
// The one derivation of "which plane is that face"; pure, so nothing cycles back.
import { pickFacePlaneAt } from "../features/facePlanePick";
import { FpsMeter } from "./fpsMeter";
import { StutterWatch } from "./stutterWatch";
import { sceneStats } from "../diagnostics/sceneStats";
import { makeZebraMaterial, buildCurvatureCombs } from "./overlays";
import { Picker, occludedEdge, type EdgeCandidate, type Hit, type EdgeHit, type PickMods } from "./picking";
import { bandIndex, expandToBand, type BandIndex } from "./faceBands";
import { flushRaycastIndex } from "./raycastIndex";
import { GhostLayer } from "./ghosts";
import { hideFlushSeams } from "./flushSeams";
import { EdgeEmphasis } from "./edgeEmphasis";
import { ViewCube, FACE_VIEWS } from "./viewCube";
import { setPrompt } from "../ui/prompt";
import type { DocumentStore } from "../document/store";
import type { BodyFinish } from "../document/materials";
import { BodyFinishLayer, sameFinishMap, sameStringMap } from "./bodyFinish";
import { onRenderPrefsChange, renderPrefs } from "../ui/renderPrefs";
import { invalidateThemeColors } from "./themeColors";
import { onThemeChange } from "../ui/theme";
import type { ViewCubeSide } from "../types";

/** A selection captured before a rebuild replaces the Highlighter (selectionMemo.ts). */
interface SelectionMemo {
  edges: { ref: EdgeRef; mid: [number, number, number] | null }[];
  faces: { id: number; body: BodyMesh | null; point: [number, number, number] | null }[];
  bodies: string[];
}

const EDGE_IDLE = new THREE.Color(0x1b1f24); // normal dark edge
const EDGE_WIRE = new THREE.Color(0xc4ced9); // with no faces behind them the dark idle edges vanish into the ground
const EDGE_PICKABLE = new THREE.Color(0xd98a4a); // muted ember "selectable" edge (fillet/chamfer mode)

/** How much of the model is left standing while a sketch is open on it, and how
 *  much of its edges. Both were far lower; see setModelDimmed. */
const SKETCH_DIM_OPACITY = 0.55;
const SKETCH_DIM_EDGE_OPACITY = 0.5;


import { Highlighter, EDGE_HOVER_COLOR } from "./highlight";
import { ProgressiveModel } from "./progressive";
import { nearestEdgeByMid, midMatchTol, edgeSelectorFrom, polylineMid } from "./edgeMatch";
import { mergeScope, pickScope, type ScopeDecision, type ScopeView } from "./pickScope";
import { clickTakes, type SelectPolicy } from "./clickIntent";
import { getHoverDwellMs } from "../ui/interactionPrefs";
import { edgesOnFace, faceEdgeTol, faceSurface, type Tri } from "./faceEdges";
import { remapSelection, remapStreamedSelection, shouldAnnounce } from "./selectionMemo";
import { cylinderFromFace, radialAt, solidInsideCylinder } from "../features/planeMath";
import type { RoundFace } from "../features/radialDrag";
import type { Plane3, PlaneDef, RebuildResult, Selector, Vec3 } from "../types";
import { dragStep } from "./dragStep";
import { groundAnchor } from "./zoomAnchor";
import { faceSketchPlane } from "../sketch/sketchView";
import { viewSideNormal } from "./viewFlight";
import { themeColor } from "./themeColors";
import { AreaBox } from "./areaBox";
import { buildFaceMarker, disposeFaceMarker } from "./sketchFaceMarker";
import { auditIsClean, auditLine, auditScene } from "../diagnostics/sceneAudit";
import { pipe, pipeFault } from "../diagnostics/pipelineLog";
import {
  pickPoint,
  polylineMidpoint3,
  POINT_SNAP_PX,
  type ModelPointKind,
  type PointCandidate,
} from "./pointSnap";
import {
  dragBox,
  isAreaDrag,
  areaSelectionMode,
  nextAreaFilter,
  type AreaFilter,
  type AreaMode,
  type ScreenRect,
} from "./areaSelect";
import { collectInBox, projectForArea, type AreaProjection } from "./areaProjection";

/** One box drag. The box previews by selecting every frame, so each frame starts
 *  from the selection as it was when the drag began. */
export interface AreaDrag {
  x: number;
  y: number;
  additive: boolean;
  faces: readonly number[];
  edges: readonly EdgeRef[];
  bodies: readonly string[];
}

/** (0,0,0), kept once. Read every frame to size the origin arrows, and a fresh
 *  Vector3 per frame for a constant is litter in the hot path. Never written. */
const WORLD_ORIGIN = new THREE.Vector3(0, 0, 0);

export class Viewport {
  readonly scene: SceneBundle;
  readonly rig: CameraRig;
  private cube: ViewCube;
  private picker = new Picker();
  private highlighter: Highlighter | null = null;
  private model: ModelView | null = null;
  /** The frontend-only previews a drag paints (press/pull, move, pattern). Split
   *  out to ghosts.ts, which reaches back through a GhostHost of live accessors
   *  rather than holding a copy of anything. */
  private ghosts: GhostLayer = new GhostLayer({
    model: () => this.model,
    addToScene: (o) => this.addToScene(o),
    removeFromScene: (o) => this.removeFromScene(o),
    requestRender: () => this.requestRender(),
    faceNormalWorld: (id) => this.faceNormalWorld(id),
  });
  /** Which faces of the current model are pieces of one surface, keyed by every
   *  member (faceBands). Rebuilt with the model, since face ids belong to one
   *  tessellation and mean nothing across two. */
  private faceBands: BandIndex = new Map();
  /** The selection carried across a chunked reply: every installment gets a fresh
   *  Highlighter, so it is held from the first installment to the commit. */
  private streamMemo: SelectionMemo | null = null;

  /** The RebuildResult behind the current scene, held by IDENTITY so setModel
   *  can recognise a re-emit of the same reply (an eye toggle) and skip
   *  everything but the visibility flags. Never read for its contents. */
  private lastResult: RebuildResult | null = null;
  /** A chunked reply is being drawn, so picking is off: a pick would force-build
   *  every queued BVH synchronously. Separate from a tool's suspendPicking. */
  private streaming = false;
  private progressive: ProgressiveModel;
  // Z the ground grid sits at: the model's lowest point (so the grid is always a
  // floor under the model), or 0 (world XY) when the document is empty.
  private targetGridZ = 0;
  private clock = new THREE.Clock();
  private resolution = new THREE.Vector2();
  /** A wide line over one edge, for when a hover tint on a 1.6px line is not enough. */
  private emphasis: EdgeEmphasis | null = null;
  // persistent construction/datum planes (translucent quads, click to select)
  private datumGroup = new THREE.Group();
  private datumQuads: THREE.Mesh[] = [];
  /** A tool is asking for a plane: the construction quads draw over the model
   *  and take the click before it. */
  private planesOnTop = false;
  // Datum points and axes, apart from datumQuads so a plane pick never resolves to one.
  private datumMarkers: THREE.Mesh[] = [];
  private hoveredDatum: string | null = null;
  private selectedDatum: string | null = null;
  private dragMoved = false;
  private downPos = { x: 0, y: 0 };
  // "redefine cube side from a model face" pick mode (null = not active)
  private setOverrideSide: ViewCubeSide | null = null;

  onHit: ((hit: Hit | null, shiftKey: boolean) => void) | null = null;
  onSelectionChange: (() => void) | null = null; // fired when edge/face selection changes
  /** An area box is being dragged (with which verdict), or has just ended
   *  (null). For the prompt, which is the only thing that can say what the
   *  direction of the drag has decided. */
  onAreaDrag: ((mode: AreaMode | null) => void) | null = null;
  onPickDatum: ((id: string) => void) | null = null; // fired when a datum plane quad is clicked
  /** A double-click on the model; the app opens the edit of the feature that made the face. */
  onDoubleClick: ((x: number, y: number) => void) | null = null;
  // A right-click without movement (a right-drag orbits). When shouldOpenContextMenu
  // says no, the event is left alone entirely.
  onContextClick: ((x: number, y: number) => void) | null = null;
  shouldOpenContextMenu: (() => boolean) | null = null;
  // SOLID-mode selection of a visible sketch's profile areas (set by the app).
  // regionPickAt: click-select the region under the cursor (true if one was hit,
  // so face/body picking is skipped). regionHoverAt: hover-highlight it.
  regionPickAt: ((clientX: number, clientY: number, additive: boolean) => boolean) | null = null;
  regionHoverAt: ((clientX: number, clientY: number) => boolean) | null = null;
  onBodySelectionChange: (() => void) | null = null; // fired when the body selection changes
  // An edge click that hit two coincident edges of touching bodies (edgeTies.ts).
  // Returning true means the app took the click and asked which one.
  onAmbiguousEdge:
    | ((cands: EdgeCandidate[], at: { x: number; y: number }, mods: PickMods) => boolean)
    | null = null;
  // "faces" = the selection holds faces/edges; "bodies" = whole bodies (to move).
  private selectionMode: "faces" | "bodies" = "faces";
  /** What a click picks: always faces, always bodies, or "auto", a body first
   *  and then the faces of a body already chosen. */
  private selectPolicy: SelectPolicy = "auto";
  suspendPicking = false;

  /** Picking is off while a chunked reply is being drawn OR while a tool has
   *  suspended it. Two independent reasons, deliberately not one flag. */
  private get pickSuppressed(): boolean {
    return this.suspendPicking || this.streaming;
  }
  // Until the user moves the camera the model stays framed on resize: under remote
  // desktops and fractional scaling the canvas settles a frame after the first fit.
  private userMovedCamera = false;
  // Render on demand: the camera moved, requestRender() was called, or a few
  // linger frames remain for effects that settle a frame late.
  private needsRender = true;
  private lingerFrames = 3;

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = createScene(canvas);
    this.progressive = new ProgressiveModel(this.scene.modelGroup, disposeBody);
    this.scene.scene.add(this.datumGroup);
    const rect = canvas.getBoundingClientRect();
    this.rig = createCameraRig(canvas, rect.width / rect.height);

    this.cube = new ViewCube(canvas, this.scene.renderer, {
      applySide: (side) => this.applyCubeSide(side),
      applyDir: (dir, up) => { this.rig.setViewDir(dir, up); this.requestRender(); },
      getOverrides: () => this.store?.viewOverrides ?? {},
      beginSetOverride: (side) => this.beginSetOverride(side),
      resetOverride: (side) => {
        this.store?.setViewOverride(side, null);
        this.cube.refreshOverrideMarks();
        this.requestRender();
      },
    });

    this.resize();
    window.addEventListener("resize", () => this.resize());
    // The canvas often settles after construction, which a window resize alone misses.
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    // once the user drives the camera (orbit/pan/zoom), stop auto-framing.
    this.rig.controls.addEventListener("controlstart", () => {
      this.userMovedCamera = true;
      this.requestRender();
    });
    this.installPointer();
    // Re-applied on theme changes too: the default ground is a theme token.
    this.scene.applyRenderPrefs();
    onRenderPrefsChange(() => {
      const wasLow = isRenderLowPower();
      this.scene.applyRenderPrefs(); // re-applies the power tier (performance mode)
      this.rig.setFov(renderPrefs().fov);
      // Only when the tier actually flipped: the finishes decide glass vs alpha
      // and how many emitter lights to draw off it, and re-running them on every
      // brightness nudge would walk every body's materials for nothing.
      if (isRenderLowPower() !== wasLow) {
        this.applyBodyFinish();
        this.stutter.reset();
        this.setStuttering(false);
      }
      this.requestRender();
    });
    onThemeChange(() => {
      // Explicit, so the result does not depend on which subscriber ran first.
      invalidateThemeColors();
      this.scene.grid.applyTheme();
      this.scene.applyRenderPrefs();
      this.requestRender();
    });
    this.loop();
  }

  /** Call after changing what is on screen without moving the camera. */
  requestRender() {
    this.needsRender = true;
    this.lingerFrames = 3;
  }

  // Wired after construction: the store needs the geometry backend, which needs the canvas.
  private storeRef: DocumentStore | undefined;
  private get store(): DocumentStore | undefined {
    return this.storeRef;
  }
  /** Hand the FPS readout its element once the Vue shell has rendered it. */
  attachFpsHost(host: HTMLElement) {
    this.fps.setHost(host);
  }

  attachStore(s: DocumentStore) {
    if (this.storeRef) return;
    this.storeRef = s;
    // refresh the cube's redefined-side markers whenever the document changes
    // (open file, undo/redo, override set/reset).
    s.onDocChange(() => this.cube.refreshOverrideMarks());
  }

  private installPointer() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragMoved = false;
      this.downPos = { x: e.clientX, y: e.clientY };
      // A left drag draws a selection box; shift adds, as it does for a click.
      this.areaDown = (this.canAreaSelect?.() ?? true)
        ? {
            x: e.clientX,
            y: e.clientY,
            additive: e.shiftKey,
            faces: this.highlighter?.getSelectedFaces() ?? [],
            edges: this.highlighter?.getSelectedEdges() ?? [],
            bodies: this.highlighter?.getSelectedBodies() ?? [],
          }
        : null;
    });
    // Right-drag orbits about what is under the cursor now, not wherever a pan left
    // the target. Released on the window, since a drag can end off the canvas.
    c.addEventListener("pointerdown", (e) => {
      if (e.button === 2) this.rig.setOrbitPivot(this.orbitPivotAt(e.clientX, e.clientY));
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 2) this.rig.setOrbitPivot(null);
    });
    c.addEventListener("pointermove", (e) => {
      if (
        Math.abs(e.clientX - this.downPos.x) > 3 ||
        Math.abs(e.clientY - this.downPos.y) > 3
      ) {
        this.dragMoved = true;
      }
      const down = this.areaDown;
      if (down && (e.buttons & 1) && isAreaDrag(down.x, down.y, e.clientX, e.clientY)) {
        // The moment a press becomes a BOX, once per drag. A press is still a
        // click until it has travelled, so anything that reacts to a box has to
        // wait until here rather than firing on every pointerdown.
        if (!this.areaBox.visible) this.onAreaBegin?.();
        this.areaAt = { x: e.clientX, y: e.clientY };
        this.showAreaBox();
      }
      // Unconditional: the ViewCube hover-highlights off this same pointermove.
      this.requestRender();
      this.queueHover(e);
    });
    c.addEventListener("pointerleave", () => {
      if (!this.pickSuppressed) this.clearIntentHover();
    });
    c.addEventListener("pointerup", (e) => {
      // The drag suppressed hover (see queueHover); re-establish it for wherever
      // the cursor actually ended up, so the face under it lights straight away
      // instead of waiting for the next mouse twitch.
      if (e.buttons === 0) this.queueHover(e);
      const down = this.areaDown;
      this.areaDown = null;
      this.areaAt = null;
      if (this.areaBox.visible) {
        this.areaBox.hide();
        this.onAreaDrag?.(null);
        if (down && e.button === 0) {
          const { rect, mode } = dragBox(down.x, down.y, e.clientX, e.clientY);
          // The same call the preview has been making all along, and this time
          // it announces. That is the whole of the difference between the two:
          // there is no second code path for the box to disagree with.
          this.selectInBox(rect, mode, down, true);
        }
        this.dropAreaProjection();
        return; // a box is not also a click
      }
      if (e.button !== 0 || this.dragMoved) return;
      // 1) a click landing on the ViewCube corner orients the view (and never
      //    falls through to model picking).
      if (this.cube.handleLeftClick(e.clientX, e.clientY)) return;
      // 2) if we're redefining a cube side, the next model click captures a face.
      if (this.setOverrideSide) {
        this.captureOverrideFace(e);
        return;
      }
      this.handleClick(e);
    });
    // WebKit fires `contextmenu` while the button is still down, so the menu
    // waits for a release without movement.
    let rightDown: { x: number; y: number } | null = null;
    let rightDrag = false; // did this right-press move far enough to be a pan?
    let menuPending = false; // contextmenu seen mid-press → deliver on release
    c.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 2) return;
        rightDown = { x: e.clientX, y: e.clientY };
        rightDrag = false;
        menuPending = false;
      },
      true,
    );
    c.addEventListener(
      "pointermove",
      (e) => {
        if (rightDown && !rightDrag && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > 5) rightDrag = true;
      },
      true,
    );
    c.addEventListener(
      "pointerup",
      (e) => {
        if (e.button !== 2 || !rightDown) return;
        const at = rightDown;
        rightDown = null;
        if (menuPending && !rightDrag) this.onContextClick?.(at.x, at.y);
        menuPending = false;
      },
      true,
    );
    c.addEventListener("contextmenu", (e) => {
      if (!this.onContextClick) return;
      if (!(this.shouldOpenContextMenu?.() ?? true)) return; // a tool/sketch owns the gesture
      if (this.cubeHitsRegion(e.clientX, e.clientY)) return; // ViewCube owns its corner
      e.preventDefault();
      if (e.buttons & 2) menuPending = true; // fired on press → wait for the release
      else if (!rightDrag) this.onContextClick(e.clientX, e.clientY); // fired on release
    });
    // Explicit wheel zoom for BOTH projections (camera-controls' built-in wheel
    // DOLLY didn't zoom in perspective under WebKitGTK). deltaMode-normalized so
    // line/page-mode wheels (some webviews) still produce a sensible step.
    c.addEventListener("wheel", (e) => this.wheelZoom(e), { passive: false });
    c.addEventListener("dblclick", (e) => {
      if (this.cubeHitsRegion(e.clientX, e.clientY)) return;
      this.onDoubleClick?.(e.clientX, e.clientY);
    });
  }

  /** One wheel notch, wherever it was caught. */
  private wheelZoom(e: WheelEvent) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines/pages -> px
    const dy = Math.max(-240, Math.min(240, e.deltaY * unit));
    this.userMovedCamera = true;
    // zoom toward what's under the cursor (MCAD-style), not the orbit centre
    this.rig.zoomBy(Math.pow(1.0016, dy), this.cursorWorldPoint(e.clientX, e.clientY));
    this.requestRender();
  }

  /** A wheel notch an overlay swallowed (a dimension badge takes pointer events),
   *  handed back so the view still zooms under it. */
  forwardWheel(e: WheelEvent) {
    this.wheelZoom(e);
  }

  /** The model surface under the cursor, else the model's centre. Not the orbit
   *  target, which pans and zooms push well off the model. */
  private orbitPivotAt(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.model || this.model.box.isEmpty()) return null;
    const hit = this.rayFrom(clientX, clientY)
      .intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return hit ? hit.point.clone() : this.model.box.getCenter(new THREE.Vector3());
  }

  /** Zoom anchor: the model under the cursor, else the ground plane, else a point
   *  at the target distance. Without the ground case, zooming over empty space
   *  walked the camera through the grid. */
  private cursorWorldPoint(clientX: number, clientY: number): THREE.Vector3 {
    const rc = this.rayFrom(clientX, clientY);
    if (this.model) {
      const hit = rc.intersectObjects(visibleBodyMeshes(this.model), false)[0];
      if (hit) return hit.point.clone();
    }
    const cam = this.rig.controls.getPosition(new THREE.Vector3());
    const target = this.rig.controls.getTarget(new THREE.Vector3());
    const dist = cam.distanceTo(target);
    // Only while the ground grid is drawn; a sketch's lattice may be vertical.
    if (this.scene.grid.group.visible) {
      const ground = groundAnchor(rc.ray.origin, rc.ray.direction, this.targetGridZ, dist);
      if (ground) return ground.clone();
    }
    return rc.ray.origin.clone().add(rc.ray.direction.clone().multiplyScalar(dist));
  }

  // Hover picks once per animation frame with the newest pointer position.
  private hoverPending: { clientX: number; clientY: number; force: boolean } | null = null;
  private hoverRaf = 0;
  /** The body the cursor arrived on and when. Under the auto policy a body lights
   *  whole on arrival and its face or edge takes over once the cursor has stayed
   *  on it for the hover delay preference, and a click takes whichever is lit. */
  private intent: { bodyId: string; since: number } | null = null;
  private intentTimer = 0;
  private lastHover: { clientX: number; clientY: number; force: boolean } | null = null;

  private queueHover(e: PointerEvent) {
    // No hover while a button is held: repainting a face under an orbit cost 6.5x the draw.
    if (e.buttons !== 0) {
      // clear once so a stale highlight doesn't ride along through the orbit;
      // hoverFace(null) early-returns after the first call, so this is free.
      this.highlighter?.clearHover();
      if (!this.pickSuppressed) this.highlighter?.hoverBody(null);
      return;
    }
    // Judged now, not in the deferred pass, or a tool releasing picking in between
    // leaves a stray hover painted.
    if (this.pickSuppressed) return;
    this.scheduleHover(e.clientX, e.clientY, false);
  }

  private scheduleHover(clientX: number, clientY: number, force: boolean) {
    this.hoverPending = { clientX, clientY, force };
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const ev = this.hoverPending;
      this.hoverPending = null;
      if (ev) this.handleHover(ev, ev.force);
    });
  }

  /** Hover for a tool that holds the pointer but not this spot, the move gizmo
   *  away from its handles. Null clears whatever is lit. */
  hoverThrough(clientX: number | null, clientY = 0) {
    if (clientX === null) {
      this.clearIntentHover();
      return;
    }
    this.scheduleHover(clientX, clientY, true);
  }

  private clearIntentHover() {
    this.hoverPending = null;
    this.intent = null;
    clearTimeout(this.intentTimer);
    this.highlighter?.clearHover();
    this.highlighter?.hoverBody(null);
    this.requestRender();
  }

  private noteIntent(bodyId: string | null) {
    if (bodyId === null) {
      this.intent = null;
      clearTimeout(this.intentTimer);
      return;
    }
    if (this.intent?.bodyId === bodyId) return;
    this.intent = { bodyId, since: performance.now() };
    clearTimeout(this.intentTimer);
    this.intentTimer = window.setTimeout(() => {
      const at = this.lastHover;
      if (at && this.intent?.bodyId === bodyId) this.scheduleHover(at.clientX, at.clientY, at.force);
    }, getHoverDwellMs() + 20);
  }

  private dwelt(bodyId: string): boolean {
    return this.intent?.bodyId === bodyId && performance.now() - this.intent.since >= getHoverDwellMs();
  }

  /** Under the auto policy, whether a hit takes its body whole: a face hit on a
   *  body the cursor has not stayed on, which is not the one already chosen. */
  private hitTakesBody(hit: Hit | null, additive: boolean): string | null {
    const bodyId = this.bodyOfHit(hit);
    if (!bodyId || hit?.kind !== "face" || this.dwelt(bodyId)) return null;
    return this.takesBody(bodyId, additive) ? bodyId : null;
  }

  private handleHover(e: { clientX: number; clientY: number }, force = false) {
    // while redefining a cube side, hover-highlight the model face under the
    // cursor (so the user sees which face they'll capture).
    if (this.setOverrideSide) {
      this.hoverFaceAt(e.clientX, e.clientY);
      return;
    }
    if (this.pickSuppressed && !force) return;
    const auto = this.selectPolicy === "auto";
    if (this.selectionMode === "bodies" && !auto) return; // no face hover while picking bodies
    // No model is not no targets: a sketch with nothing extruded still has pickable areas.
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.model
      ? this.picker.pick(e.clientX, e.clientY, rect, this.rig.active, this.model)
      : null;
    this.highlighter?.clearHover();
    this.requestRender();
    if (auto && this.highlighter) {
      this.lastHover = { clientX: e.clientX, clientY: e.clientY, force };
      this.noteIntent(this.bodyOfHit(hit));
      const whole = this.hitTakesBody(hit, false);
      if (whole && !this.regionHoverAt?.(e.clientX, e.clientY)) {
        this.highlighter.hoverBody(whole);
        return;
      }
      this.highlighter.hoverBody(null);
    }
    if (hit?.kind === "edge") { this.highlighter?.hoverEdge(hit.edge); this.regionHoverAt?.(-1, -1); return; }
    // Sketch has PRIORITY over the body, except where the body hides it or the
    // profile traces the whole face (sketch/regionOverSurface.ts).
    if (this.regionHoverAt?.(e.clientX, e.clientY)) return;
    // The whole run, matching what a click on it will take. Measure and the
    // pick-one-face tools deliberately keep hovering a single face: they act on
    // one face and must not promise otherwise.
    if (hit?.kind === "face") {
      this.highlighter?.hoverFaceRun(expandToBand(hit.faceId, this.faceBands));
      return;
    }
  }

  private handleClick(e: PointerEvent) {
    if (this.pickSuppressed) return;
    this.clickAt(e.clientX, e.clientY, e.ctrlKey || e.metaKey, e.shiftKey);
  }

  /** A plain click that stood a tool down, replayed as the click it would have
   *  been with no tool up. */
  clickThrough(clientX: number, clientY: number, ctrl: boolean) {
    if (this.selectPolicy === "auto") this.clickAt(clientX, clientY, ctrl, false);
    else this.selectBodyAt(clientX, clientY, ctrl);
  }

  setSelectPolicy(p: SelectPolicy) {
    this.selectPolicy = p;
    this.highlighter?.hoverBody(null);
    if (p !== "auto") this.setSelectionMode(p);
  }

  get policy(): SelectPolicy {
    return this.selectPolicy;
  }

  private bodyOfHit(hit: Hit | null): string | null {
    if (!hit) return null;
    return hit.kind === "edge" ? (hit.edge.body ?? null) : this.faceIdToBodyId(hit.faceId);
  }

  /** Bodies that own a selected face or edge. */
  private drilledBodies(): Set<string> {
    const out = new Set<string>();
    if (!this.highlighter || this.selectionMode !== "faces") return out;
    for (const f of this.highlighter.getSelectedFaces()) {
      const id = this.faceIdToBodyId(f);
      if (id) out.add(id);
    }
    for (const edge of this.highlighter.getSelectedEdges()) if (edge.body) out.add(edge.body);
    return out;
  }

  private takesBody(bodyId: string, additive: boolean): boolean {
    return clickTakes({
      bodyId,
      additive,
      selectedBodies: this.selectionMode === "bodies" ? this.getSelectedBodies() : [],
      drilledBodies: this.drilledBodies(),
    }) === "body";
  }

  /** The body a plain click here would select whole, under the auto policy. */
  bodyClickAt(clientX: number, clientY: number): string | null {
    if (this.selectPolicy !== "auto" || !this.model) return null;
    const hit = this.picker.pick(clientX, clientY, this.canvas.getBoundingClientRect(), this.rig.active, this.model);
    return this.hitTakesBody(hit, false);
  }

  private clickAt(clientX: number, clientY: number, ctrl: boolean, shift: boolean) {
    const rect = this.canvas.getBoundingClientRect();

    // --- Bodies mode: a click selects the WHOLE body under the cursor ---
    if (this.selectPolicy !== "auto" && this.selectionMode === "bodies" && this.model && this.highlighter) {
      this.selectBodyAt(clientX, clientY, ctrl);
      return;
    }

    const hit = this.model
      ? this.picker.pick(clientX, clientY, rect, this.rig.active, this.model)
      : null;

    if (this.selectPolicy === "auto" && this.model && this.highlighter) {
      const bodyId = this.hitTakesBody(hit, ctrl || shift);
      if (bodyId) {
        if (this.regionPickAt?.(clientX, clientY, ctrl || shift)) return;
        this.setSelectionMode("bodies");
        if (ctrl || shift) this.highlighter.toggleSelectBody(bodyId);
        else this.highlighter.selectOnlyBody(bodyId);
        this.highlighter.hoverBody(null);
        this.onBodySelectionChange?.();
        this.requestRender();
        return;
      }
      this.setSelectionMode("faces");
    }
    const e = { clientX, clientY, ctrlKey: ctrl, metaKey: false, shiftKey: shift };
    // A visible sketch's area wins over the face it lies on (with the exceptions in
    // sketch/regionOverSurface.ts); an edge still wins over both.
    if (hit?.kind !== "edge" && this.regionPickAt?.(e.clientX, e.clientY, e.ctrlKey || e.metaKey || e.shiftKey)) return;
    // a click on a construction plane, datum point or datum axis (where it does
    // not overlap the body) selects it. Markers are raycast alongside the quads,
    // so the nearest reference geometry under the cursor wins by depth.
    if (!hit && (this.datumQuads.length || this.datumMarkers.length)) {
      const dh = this.rayFrom(e.clientX, e.clientY)
        .intersectObjects([...this.datumQuads, ...this.datumMarkers], false)[0];
      if (dh) {
        this.onPickDatum?.(dh.object.userData.datumId as string);
        return;
      }
    }
    if (!this.model) return;
    // Ctrl/Cmd or Shift adds; Shift on an edge also means no tangent chain (pickScope.ts).
    const mods: PickMods = { additive: e.ctrlKey || e.metaKey || e.shiftKey, exact: e.shiftKey };
    // Two edges in the same pixels is a question, not a pick. Asked BEFORE the
    // selection is touched, so declining the menu leaves everything exactly as
    // it was rather than having cleared it on the way in.
    if (hit?.kind === "edge" && this.onAmbiguousEdge && this.model) {
      const cands = this.pickableEdgeCandidates(e.clientX, e.clientY, rect);
      if (cands.length > 1 && this.onAmbiguousEdge(cands, { x: e.clientX, y: e.clientY }, mods)) {
        return;
      }
    }
    this.edgeClick = hit?.kind === "edge" && !mods.additive
      ? { edge: hit.edge, at: this.nearestOnEdge(hit.edge, e.clientX, e.clientY) }
      : null;
    this.applyPick(hit, mods);
  }

  /** The one edge last picked by a plain click, and where on it the click landed. */
  private edgeClick: { edge: EdgeRef; at: [number, number, number] | null } | null = null;

  /** Where the single selected edge was clicked, null when it was not picked by a click. */
  selectedEdgeClickPoint(): [number, number, number] | null {
    const sel = this.selectedEdgeLines();
    return sel.length === 1 && this.edgeClick && sel[0] === this.edgeClick.edge ? this.edgeClick.at : null;
  }

  private nearestOnEdge(edge: EdgeRef, clientX: number, clientY: number): [number, number, number] | null {
    const ray = this.rayFrom(clientX, clientY).ray;
    const onSeg = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let best: [number, number, number] | null = null;
    let bestD = Infinity;
    for (let i = 1; i < edge.points.length; i++) {
      const p = edge.points[i - 1]!, q = edge.points[i]!;
      a.set(p[0], p[1], p[2]);
      b.set(q[0], q[1], q[2]);
      const d = ray.distanceSqToSegment(a, b, undefined, onSeg);
      if (d < bestD) {
        bestD = d;
        best = [onSeg.x, onSeg.y, onSeg.z];
      }
    }
    return best;
  }

  /** Bodies mode's pick, callable by the move gizmo so a click elsewhere while it
   *  is up moves it in one click. Returns whether anything ended up selected. */
  selectBodyAt(clientX: number, clientY: number, additive = false): boolean {
    if (!this.model || !this.highlighter) return false;
    const bodyId = this.bodyIdAt(clientX, clientY);
    if (bodyId) {
      if (additive) this.highlighter.toggleSelectBody(bodyId);
      else this.highlighter.selectOnlyBody(bodyId);
    } else if (!additive) {
      this.highlighter.clearBodySelection();
    }
    this.onBodySelectionChange?.();
    this.requestRender();
    return this.highlighter.getSelectedBodies().length > 0;
  }

  /** Apply a pick to the selection. The ambiguous-edge menu runs this too, so a
   *  menu pick and a click can never select differently. */
  applyPick(hit: Hit | null, mods: PickMods) {
    if (this.highlighter) {
      if (!mods.additive) {
        this.highlighter.clearSelection();
        this.edgeScope = { scope: "chain", reason: "tangent" }; // a replaced selection carries nothing over
      }
      if (hit?.kind === "edge") {
        this.highlighter.toggleSelectEdge(hit.edge);
        this.noteEdgePickScope(hit.edge, mods.exact, mods.additive);
      } else if (hit?.kind === "face") {
        // A face the kernel split is picked as the whole run; Shift takes one piece.
        const want = mods.exact ? [hit.faceId] : expandToBand(hit.faceId, this.faceBands);
        for (const f of want) this.highlighter.toggleSelectFace(f);
      }
      this.requestRender();
    }
    this.onHit?.(hit, mods.exact);
    this.onSelectionChange?.();
  }

  // ---- Bodies selection mode + body helpers --------------------------------

  setSelectionMode(m: "faces" | "bodies") {
    if (this.selectionMode === m) return;
    this.selectionMode = m;
    // switching clears the other kind of selection so paint never mixes
    if (m === "bodies") {
      this.highlighter?.clearSelection();
      this.onSelectionChange?.();
    } else {
      this.highlighter?.clearBodySelection();
      this.onBodySelectionChange?.();
    }
    this.requestRender();
  }
  get selecting(): "faces" | "bodies" {
    return this.selectionMode;
  }

  // ---- area selection ------------------------------------------------------
  // Only camera-facing triangles count unless see-through is on. Known limit:
  // facing is not occlusion, so a crossing box still takes the front face of a
  // body behind another. Fixing that needs an id buffer.

  /** Set by the app to withhold the gesture while a tool owns the pointer. */
  canAreaSelect: (() => boolean) | null = null;
  /** Fires once, when a press has travelled far enough to be a box. The app
   *  uses it to stand down anything that is up only because something is
   *  selected, which a box is about to replace anyway. */
  onAreaBegin: (() => void) | null = null;
  private areaAt: { x: number; y: number } | null = null;
  private areaDown: AreaDrag | null = null;
  private areaBox = new AreaBox();
  /** What a box takes, cycled with Tab during the drag and kept afterwards. It also
   *  decides the kind of selection made (areaSelectionMode). */
  private areaFilter: AreaFilter = "all";
  private xray = false;
  /** Faces drawn as nothing, so only the edges show, hidden ones included. */
  private wireframe = false;
  private edgesEmphasized = false;
  /** Fires when see-through is switched, so the chrome can say it is on. */
  onXrayChange: ((on: boolean) => void) | null = null;
  onWireframeChange: ((on: boolean) => void) | null = null;
  /** The mesh on screen is the last one that BUILT, not what the values say. */
  private stale = false;

  get seeThrough(): boolean {
    return this.xray || this.wireframe;
  }

  get isWireframe(): boolean {
    return this.wireframe;
  }

  /** Edges only. The faces still take picks, so a face can be chosen through the
   *  lines, and a box reaches the far side as it does in x-ray. */
  setWireframe(on: boolean) {
    if (this.wireframe === on) return;
    this.wireframe = on;
    this.dropAreaProjection();
    this.applyBodyFinish();
    if (!on && !this.edgesEmphasized) this.highlighter?.setEdgeBase(EDGE_IDLE);
    this.onWireframeChange?.(on);
    this.requestRender();
  }

  get areaTakes(): AreaFilter {
    return this.areaFilter;
  }

  /** The box being dragged, with its start corner and the cursor corner kept apart. */
  get areaDragState(): {
    rect: ScreenRect;
    mode: AreaMode;
    from: { x: number; y: number };
    at: { x: number; y: number };
  } | null {
    const from = this.areaDown;
    const at = this.areaAt;
    if (!from || !at || !this.areaBox.visible) return null;
    const { rect, mode } = dragBox(from.x, from.y, at.x, at.y);
    return { rect, mode, from: { x: from.x, y: from.y }, at };
  }

  /** See-through: translucent, and a box reaches the far side. Always both together. */
  setXray(on: boolean) {
    if (this.xray === on) return;
    this.xray = on;
    // See-through changes which triangles a box may reach, so a projection
    // taken before it would answer for the wrong half of the model. Toggling it
    // mid-drag is exactly what x-ray is for, so this is not a corner case.
    this.dropAreaProjection();
    this.applyBodyFinish();
    this.onXrayChange?.(on);
    this.requestRender();
  }

  toggleXray() {
    this.setXray(!this.xray);
  }

  /** Ghost the last good mesh when a preview build was refused, so it does not pass
   *  for the result of the values shown (ui/previewError.ts says what is wrong). */
  setStaleModel(on: boolean) {
    if (this.stale === on) return;
    this.stale = on;
    this.applyBodyFinish();
    this.requestRender();
  }

  private finish = new BodyFinishLayer({
    model: () => this.model,
    scene: () => this.scene,
    faceIdToBodyId: (id) => this.faceIdToBodyId(id),
    addToScene: (o) => this.addToScene(o),
    requestRender: () => this.requestRender(),
    savedMats: () => this.savedMats,
  });

  private peek: ReadonlySet<string> = new Set();
  private peekAt: (() => Iterable<string>) | null = null;

  /** Ghost the bodies `which` names while a tool previews something inside them.
   *  It rides the finish layer like x-ray, and `which` is asked again whenever
   *  the finish is re-applied, because a preview rebuild can land mid-gesture
   *  with bodies that were still streaming when the tool last asked. Null gives
   *  every body back its own finish. Picking is untouched. */
  setPeek(which: (() => Iterable<string>) | null): ReadonlySet<string> {
    this.peekAt = which;
    const next = this.resolvePeek();
    if (next.size === this.peek.size && [...next].every((id) => this.peek.has(id))) return this.peek;
    this.applyBodyFinish();
    this.requestRender();
    return this.peek;
  }

  private resolvePeek(): ReadonlySet<string> {
    return new Set(this.model && this.peekAt ? this.peekAt() : []);
  }

  private applyBodyFinish() {
    if (!this.model) return;
    this.peek = this.resolvePeek();
    this.finish.apply({ xray: this.xray, stale: this.stale, wireframe: this.wireframe, peek: this.peek });
    if (this.wireframe && !this.edgesEmphasized) this.highlighter?.setEdgeBase(EDGE_WIRE);
    this.syncBloomable();
    this.scene.frameShadows();
  }

  /** A sketch dims the model to a backdrop, so nothing on it is worth a glow. */
  private syncBloomable() {
    this.scene.post.bloomable = this.finish.bloomable && !this.sketchDimmed;
  }

  /** The model projected once per box drag (the camera cannot move during one),
   *  dropped by anything that changes what is on screen. */
  private areaProj: AreaProjection | null = null;

  private dropAreaProjection() {
    this.areaProj = null;
  }

  private projectForArea(): AreaProjection {
    if (!this.model) return { bodies: [], edges: [] };
    return projectForArea(this.model, this.rig.active, this.canvas.getBoundingClientRect(), this.seeThrough);
  }

  /** Redraw the band at the current pointer position and re-announce what it
   *  will take. Shared by the drag and by Tab, so the two can never disagree
   *  about which box is on screen. */
  private showAreaBox() {
    const down = this.areaDown;
    const at = this.areaAt;
    if (!down || !at) return;
    const { rect, mode } = dragBox(down.x, down.y, at.x, at.y);
    this.areaBox.show(rect.x0, rect.y0, rect.x1, rect.y1, mode);
    // Painted live but announced only on release: listeners are about a finished selection.
    this.areaProj ??= this.projectForArea();
    this.selectInBox(rect, mode, down, false);
    this.onAreaDrag?.(mode);
  }

  /** Cycle what an in-flight box takes. No-op when no box is open, so Tab keeps
   *  whatever meaning it has everywhere else. */
  cycleAreaFilter(): boolean {
    if (!this.areaBox.visible) return false;
    this.areaFilter = nextAreaFilter(this.areaFilter);
    this.showAreaBox();
    return true;
  }

  // ---- aiming at a point on the model --------------------------------------

  /** A corner, edge middle, face centre or bare surface under the cursor. Only edge
   *  ends and middles are offered, never mesher samples (ranking in pointSnap.ts). */
  pointAt(clientX: number, clientY: number): { p: THREE.Vector3; kind: ModelPointKind } | null {
    if (!this.model) return null;
    const cands: PointCandidate[] = [];
    for (const e of this.model.edges) {
      if (!e.draw.object.visible) continue;
      const pts = e.points;
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first) cands.push({ p: [first[0], first[1], first[2]], kind: "vertex" });
      if (last) cands.push({ p: [last[0], last[1], last[2]], kind: "vertex" });
      const mid = polylineMidpoint3(pts);
      if (mid) cands.push({ p: mid, kind: "midpoint" });
    }
    // The face under the cursor contributes its own centre and, as the last
    // resort, the exact spot the ray struck it.
    const hit = this.pickFaceForPressPull(clientX, clientY);
    if (hit) {
      const c = this.faceCentroidWorld(hit.faceId);
      cands.push({ p: [c.x, c.y, c.z], kind: "center" });
      cands.push({ p: [hit.anchor.x, hit.anchor.y, hit.anchor.z], kind: "surface" });
    }
    const best = pickPoint(
      cands,
      (q) => {
        const s = this.projectToScreen(this.pointScratch.set(q[0], q[1], q[2]));
        return Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
      },
      { x: clientX, y: clientY },
      POINT_SNAP_PX,
    );
    return best ? { p: new THREE.Vector3(best.p[0], best.p[1], best.p[2]), kind: best.kind } : null;
  }

  private pointScratch = new THREE.Vector3();

  // Points a pick has taken, plus the live one. depthTest off: a point on a surface z-fights.
  private pickMarks: THREE.Group | null = null;
  private pickMarkMat: THREE.MeshBasicMaterial | null = null;
  private liveMarkMat: THREE.MeshBasicMaterial | null = null;

  /** `taken` are committed picks; `live` is the one the cursor is over, drawn
   *  in the hover colour. Pass an empty list and null to clear. */
  setPickMarkers(taken: readonly Vec3[], live: Vec3 | null) {
    if (this.pickMarks) {
      this.scene.scene.remove(this.pickMarks);
      for (const c of this.pickMarks.children) (c as THREE.Mesh).geometry.dispose();
      this.pickMarks = null;
    }
    if (!taken.length && !live) {
      this.pickMarkMat?.dispose();
      this.liveMarkMat?.dispose();
      this.pickMarkMat = this.liveMarkMat = null;
      this.requestRender();
      return;
    }
    this.pickMarkMat ??= new THREE.MeshBasicMaterial({
      color: themeColor("--accent", 0xff7a3c), depthTest: false, depthWrite: false,
    });
    this.liveMarkMat ??= new THREE.MeshBasicMaterial({
      color: 0x64d2ff, depthTest: false, depthWrite: false,
    });
    const group = new THREE.Group();
    group.renderOrder = 998;
    const at = new THREE.Vector3();
    const add = (p: Vec3, mat: THREE.MeshBasicMaterial, r: number) => {
      at.set(p[0], p[1], p[2]);
      const m = new THREE.Mesh(new THREE.SphereGeometry(this.pixelWorldSize(at) * r, 16, 12), mat);
      m.position.copy(at);
      m.renderOrder = 998;
      group.add(m);
    };
    for (const p of taken) add(p, this.pickMarkMat, 4.5);
    if (live) add(live, this.liveMarkMat, 5.5);
    this.pickMarks = group;
    this.scene.scene.add(group);
    this.requestRender();
  }

  /** Take what the box covers, starting from the selection at drag start. `announce`
   *  is false for preview frames, so listeners hear only the finished selection. */
  selectInBox(rect: ScreenRect, mode: AreaMode, from: AreaDrag, announce: boolean) {
    const h = this.highlighter;
    if (!h || !this.model) return;
    const got = collectInBox(this.areaProj ?? this.projectForArea(), rect, mode);
    // The FILTER decides what kind of selection this is, not the mode the
    // viewport happens to be in; "all" is the one that follows the mode.
    const kind = areaSelectionMode(this.areaFilter, this.selectionMode);
    // On release only: switching to bodies raises the move gizmo mid-drag otherwise.
    if (announce && kind !== this.selectionMode) this.setSelectionMode(kind);
    // BOTH kinds are cleared every frame, because Tab can change the filter
    // mid-drag and the highlight the previous filter painted is not this one's.
    h.clearSelection();
    h.clearBodySelection();
    if (kind === "bodies") {
      if (from.additive) for (const id of from.bodies) h.selectBody(id);
      for (const id of got.bodies) h.selectBody(id);
      if (announce) this.onBodySelectionChange?.();
    } else {
      if (from.additive) {
        for (const f of from.faces) h.selectFace(f);
        for (const e of from.edges) h.selectEdge(e);
      } else {
        this.edgeScope = { scope: "chain", reason: "tangent" };
      }
      if (this.areaFilter !== "edges") for (const f of got.faces) h.selectFace(f);
      if (this.areaFilter !== "faces") for (const e of got.edges) h.selectEdge(e);
      // A box states its extent, so a later fillet must not widen it to tangent chains.
      if (got.edges.length && this.areaFilter !== "faces") {
        this.edgeScope = { scope: "single", reason: "shift" };
      }
      if (announce) this.onSelectionChange?.();
    }
    this.requestRender();
  }

  /** which body owns a triangle's B-rep faceId (null if none). */
  faceIdToBodyId(faceId: number): string | null {
    if (!this.model) return null;
    return bodyOfFace(this.model, faceId)?.id ?? null;
  }

  /** The body under the cursor via a plain mesh raycast (no edge priority),
   *  exactly how bodies-mode click-select resolves, so the right-click body
   *  menu agrees with a left-click at the same pixel. */
  bodyIdAt(clientX: number, clientY: number): string | null {
    if (!this.model) return null;
    const fh = this.rayFrom(clientX, clientY).intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return fh ? this.faceIdToBodyId(faceIdOfHit(fh)) : null;
  }

  private psRay = new THREE.Raycaster();
  // a diagonal probe direction: never coplanar with the model's axis-aligned
  // faces, so the parity count can't graze along a face and miscount.
  private psDir = new THREE.Vector3(0.5773, 0.5772, 0.5774).normalize();
  /** True when world point `p` is INSIDE a solid body, an even/odd parity ray
   *  cast against the merged (closed, manifold) body mesh: an odd number of
   *  crossings means the point is enclosed. False when there's no model. Used by
   *  Extrude to tell whether pushing along a direction enters material (→ Cut) or
   *  leaves it (→ Join). A heuristic: the sidecar boolean guard is the authority. */
  pointInSolid(p: THREE.Vector3): boolean {
    if (!this.model) return false;
    this.psRay.set(p, this.psDir);
    this.psRay.near = 0;
    this.psRay.far = Infinity;
    return this.psRay.intersectObjects(visibleBodyMeshes(this.model), false).length % 2 === 1;
  }

  /** How far material runs behind a face point, against its outward normal, to the
   *  next surface: the wall or floor thickness at that point. Null with no model or
   *  when nothing is hit. */
  thicknessBehind(point: THREE.Vector3, normal: THREE.Vector3): number | null {
    if (!this.model) return null;
    const into = normal.clone().normalize().negate();
    const eps = 1e-3;
    this.psRay.set(point.clone().addScaledVector(into, eps), into);
    this.psRay.near = 0;
    this.psRay.far = Infinity;
    const hit = this.psRay.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return hit ? hit.distance + eps : null;
  }

  /** Visible bodies holding any of `points`: the parity count of pointInSolid
   *  kept per body, or with `bounds`, a point anywhere in the body's box. */
  bodiesHolding(points: readonly THREE.Vector3[], bounds = false): string[] {
    if (!this.model || !points.length) return [];
    const meshes = visibleBodyMeshes(this.model);
    const found = new Set<string>();
    if (bounds) {
      const box = new THREE.Box3();
      for (const mesh of meshes) {
        const owner = mesh.userData.owner as BodyMesh | undefined;
        if (!owner) continue;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (!mesh.geometry.boundingBox) continue;
        box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (points.some((p) => box.containsPoint(p))) found.add(owner.id);
      }
      return [...found];
    }
    const crossings = new Map<string, number>();
    for (const p of points) {
      crossings.clear();
      this.psRay.set(p, this.psDir);
      this.psRay.near = 0;
      this.psRay.far = Infinity;
      for (const hit of this.psRay.intersectObjects(meshes, false)) {
        const id = (hit.object.userData.owner as BodyMesh | undefined)?.id;
        if (id) crossings.set(id, (crossings.get(id) ?? 0) + 1);
      }
      for (const [id, n] of crossings) if (n % 2 === 1) found.add(id);
    }
    return [...found];
  }

  // --- face-colour analysis overlays (Inspect), re-applied after each rebuild ---
  analysis: "none" | "component" | "draft" = "none";
  // overhang config (transient view state, not persisted): build direction and
  // the support threshold in degrees from horizontal (45° = typical FDM default).
  private draftDir = new THREE.Vector3(0, 0, 1);
  private draftThreshold = 45;
  // zebra-stripe + curvature-comb overlays (display-only; re-applied on rebuild)
  private zebra = false;
  private zebraMat: THREE.ShaderMaterial | null = null;
  // per-body original material, saved while zebra is on (keyed by body id since
  // each body now owns its own mesh/material instead of one shared mesh).
  private savedMats = new Map<string, THREE.Material | THREE.Material[]>();
  private combs = false;
  private combsObj: THREE.LineSegments | null = null;

  setAnalysis(mode: "none" | "component" | "draft") {
    this.analysis = mode;
    this.applyAnalysis();
  }

  /** the current overhang build direction (as a sign+axis label) and threshold. */
  get draftConfig(): { dir: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z"; threshold: number } {
    const v = this.draftDir;
    const dir = v.x > 0.5 ? "+X" : v.x < -0.5 ? "-X" : v.y > 0.5 ? "+Y" : v.y < -0.5 ? "-Y" : v.z < -0.5 ? "-Z" : "+Z";
    return { dir, threshold: this.draftThreshold };
  }

  /** reconfigure overhang analysis (build direction + threshold°) and repaint. */
  setDraftConfig(dir: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", threshold: number) {
    const map: Record<string, [number, number, number]> = {
      "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1],
    };
    const d = map[dir];
    if (d) this.draftDir.set(...d);
    this.draftThreshold = Math.max(0, Math.min(90, threshold));
    if (this.analysis === "draft") this.applyAnalysis();
  }

  private applyAnalysis(only?: Iterable<BodyMesh>) {
    if (!this.highlighter || !this.model) return;
    if (this.analysis === "component") {
      const hue = new Map<string, THREE.Color>();
      this.model.bodies.forEach((b, i) =>
        hue.set(b.id, new THREE.Color().setHSL((i * 0.137 + 0.05) % 1, 0.45, 0.55)),
      );
      this.highlighter.setBase((fid) => hue.get(this.faceIdToBodyId(fid) ?? "") ?? BASE_COLOR, only);
    } else if (this.analysis === "draft") {
      const B = this.draftDir;
      const OVERHANG = new THREE.Color(0xe24a3b); // unsupported overhang (red)
      const TOP = new THREE.Color(0x49c46a); // up-facing
      const WALL = new THREE.Color(0x4aa3e2); // wall / steep-enough downward
      // a downward face is an overhang when its angle from straight-down (β) is
      // below the threshold; β=0 is a flat ceiling (worst), β=90° is a vertical
      // wall (fine). Equivalent to slicers' "support below <threshold>°".
      this.highlighter.setBase((fid) => {
        const c = this.faceNormalWorld(fid).dot(B); // cos(angle to build dir)
        if (c >= -0.02) return c > 0.02 ? TOP : WALL; // up-facing or vertical
        const beta = Math.acos(Math.min(1, -c)) * (180 / Math.PI); // 0..90, 0 = straight down
        return beta < this.draftThreshold ? OVERHANG : WALL;
      }, only);
    } else {
      // A face's own colour wins over its body's.
      this.highlighter.setBase((fid) => {
        const own = this.finish.facePaint[fid];
        if (own) return new THREE.Color(own);
        const bid = this.faceIdToBodyId(fid);
        const hex = bid ? this.finish.bodyPaint[bid] : undefined;
        return hex ? new THREE.Color(hex) : BASE_COLOR;
      }, only);
    }
    this.requestRender();
  }

  /** set the per-body assigned colors (body id → hex) and repaint if no analysis
   *  overlay is currently masking them. */
  setBodyPaint(map: Record<string, string>) {
    // Called on every build; an unchanged map skipped 0.39 s of colour re-upload.
    if (sameStringMap(this.finish.bodyPaint, map)) return;
    this.finish.bodyPaint = map;
    if (this.analysis === "none") this.applyAnalysis();
    // A glowing body glows in its paint colour.
    this.applyBodyFinish();
  }

  /** Read-only, for e2e/materials_e2e.cjs to check what a material did without screenshots. */
  get bodyMeshes(): readonly BodyMesh[] {
    return this.model?.bodies ?? [];
  }

  /** Colour travels separately through setBodyPaint: it is per vertex, a finish per material. */
  setBodyFinish(map: Record<string, BodyFinish>) {
    if (sameFinishMap(this.finish.bodyFinish, map)) return;
    this.finish.bodyFinish = map;
    this.applyBodyFinish();
    this.requestRender();
  }

  /** global face id → hex. Sparse: a face wearing its body's colour is absent. */
  setFacePaint(map: Record<number, string>) {
    if (sameStringMap(this.finish.facePaint, map)) return;
    this.finish.facePaint = map;
    if (this.analysis === "none") this.applyAnalysis();
    // A face material's emissive tint lives on its material, not in the vertex buffer.
    if (Object.keys(this.finish.faceFinish).length) this.applyBodyFinish();
  }

  /** global face id → finish. Sparse like setFacePaint. */
  setFaceFinish(map: Record<number, BodyFinish>) {
    if (sameFinishMap(this.finish.faceFinish, map)) return;
    this.finish.faceFinish = map;
    this.applyBodyFinish();
    this.requestRender();
  }

  // --- dropping something onto the model ------------------------------------

  /** The face or body under a material drag, highlighted as it answers. A drag sends
   *  dragover, not pointermove, so the hover path never runs. `localFace` is the
   *  index within its body (document/faceMaterials.ts). */
  dropTargetAt(
    clientX: number,
    clientY: number,
    scope: "face" | "body",
  ): { bodyId: string; faceId: number; localFace: number } | null {
    if (!this.model || !this.highlighter) return null;
    // Faces only, nearest hit only. The general pick also raycasts every body's
    // edge lines, which have no BVH and which a drop would throw away anyway.
    flushRaycastIndex();
    const ray = this.rayFrom(clientX, clientY);
    const hitOnly = ray as THREE.Raycaster & { firstHitOnly?: boolean };
    hitOnly.firstHitOnly = true;
    const fh = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    hitOnly.firstHitOnly = false;
    const faceId = fh ? faceIdOfHit(fh) : null;
    const body = faceId === null ? null : bodyOfFace(this.model, faceId);
    if (faceId === null || !body) {
      if (this.dropKey) this.clearDropTarget();
      return null;
    }
    // A still cursor keeps firing dragover, and re-highlighting the same target
    // redrew the whole scene with its shadows for the entire drag.
    const key = scope === "body" ? `b:${body.id}` : `f:${faceId}`;
    if (key !== this.dropKey) {
      this.dropKey = key;
      if (scope === "body") {
        this.highlighter.clearHover();
        this.highlighter.hoverBody(body.id);
      } else {
        this.highlighter.hoverBody(null);
        // The whole run, matching what the drop takes.
        this.highlighter.hoverFaceRun(expandToBand(faceId, this.faceBands));
      }
      this.requestRender();
    }
    return { bodyId: body.id, faceId, localFace: faceId - body.faceStart };
  }

  private dropKey = "";

  /** Every face of one body, as local indices, for a drop that dresses the whole
   *  part face by face. */
  localFacesOf(bodyId: string): number[] {
    const b = this.model?.bodies.find((x) => x.id === bodyId);
    if (!b) return [];
    return Array.from({ length: b.faceCount }, (_, i) => i);
  }

  /** The band a face belongs to, as LOCAL indices within its body: the run of
   *  faces a pick on it takes. What a drop actually writes, so that dressing a
   *  cylinder the kernel split in two dresses both halves. */
  localFaceBand(faceId: number): { bodyId: string; faces: number[] } | null {
    if (!this.model) return null;
    const body = bodyOfFace(this.model, faceId);
    if (!body) return null;
    const run = expandToBand(faceId, this.faceBands);
    const ids = (run.length ? run : [faceId]).map((f) => f - body.faceStart);
    return { bodyId: body.id, faces: ids.filter((i) => i >= 0 && i < body.faceCount) };
  }

  /** Put back whatever the drag lit up. Called when the drag leaves the canvas
   *  and after the drop, so a cancelled drag leaves nothing highlighted. */
  clearDropTarget() {
    this.dropKey = "";
    if (!this.highlighter) return;
    this.highlighter.clearHover();
    this.highlighter.hoverBody(null);
    this.requestRender();
  }

  /** Zebra-stripe continuity overlay: swaps the model material for a reflective
   *  striped shader (restored on toggle-off / re-applied after rebuild). */
  get zebraOn(): boolean {
    return this.zebra;
  }
  get combsOn(): boolean {
    return this.combs;
  }
  setZebra(on: boolean) {
    this.zebra = on;
    this.applyZebra();
  }
  private applyZebra() {
    if (!this.model) return;
    if (this.zebra) {
      if (!this.zebraMat) this.zebraMat = makeZebraMaterial();
      for (const b of this.model.bodies) {
        if (b.mesh.material !== this.zebraMat) {
          this.savedMats.set(b.id, b.mesh.material);
          b.mesh.material = this.zebraMat;
        }
      }
    } else if (this.zebraMat) {
      for (const b of this.model.bodies) {
        if (b.mesh.material === this.zebraMat) {
          const saved = this.savedMats.get(b.id);
          if (saved) b.mesh.material = saved;
        }
      }
      this.savedMats.clear();
    }
    this.requestRender();
  }

  /** Curvature-comb overlay along edges (rebuilt from the current model). */
  setCurvatureCombs(on: boolean) {
    this.combs = on;
    this.applyCombs();
  }
  private applyCombs() {
    if (this.combsObj) {
      this.scene.modelGroup.remove(this.combsObj);
      this.combsObj.geometry.dispose();
      (this.combsObj.material as THREE.Material).dispose();
      this.combsObj = null;
    }
    if (this.combs && this.model) {
      const seg = buildCurvatureCombs(this.model, this.model.box);
      if (seg) {
        this.combsObj = seg;
        this.scene.modelGroup.add(seg);
      }
    }
    this.requestRender();
  }

  getSelectedBodies(): string[] {
    return this.highlighter?.getSelectedBodies() ?? [];
  }

  /** O(selection). Per-frame callers must use this, not selectedFacesForPressPull,
   *  which walks every triangle of every selected face. */
  getSelectedFaceIds(): number[] {
    return this.highlighter?.getSelectedFaces() ?? [];
  }

  /** Light the body under the cursor while a tool is asking which body. */
  hoverBody(bodyId: string | null) {
    if (!this.highlighter) return;
    this.highlighter.hoverBody(bodyId);
    this.requestRender();
  }

  /** set the body selection from outside (e.g. the browser tree). */
  setSelectedBodies(ids: string[]) {
    if (!this.highlighter) return;
    if (this.selectPolicy === "auto" && ids.length) this.setSelectionMode("bodies");
    this.highlighter.clearBodySelection();
    for (const id of ids) this.highlighter.toggleSelectBody(id);
    this.onBodySelectionChange?.();
    this.requestRender();
  }

  /** right-click hit-test against the construction-plane quads and the datum
   *  point/axis markers. */
  pickDatumAt(clientX: number, clientY: number): string | null {
    if (!this.datumQuads.length && !this.datumMarkers.length) return null;
    const dh = this.rayFrom(clientX, clientY)
      .intersectObjects([...this.datumQuads, ...this.datumMarkers], false)[0];
    return dh ? (dh.object.userData.datumId as string) : null;
  }

  /** The nearest base or datum plane under the cursor, in one raycast over both. */
  pickConstructionAt(
    clientX: number,
    clientY: number,
  ):
    | { kind: "base"; plane: Plane3 }
    | { kind: "datum"; id: string; def: PlaneDef }
    | null {
    this.rayFrom(clientX, clientY);
    const base = (["XY", "XZ", "YZ"] as Plane3[]).map((k) => this.scene.planes[k]);
    const hit = this.sharedRaycaster.intersectObjects([...base, ...this.datumQuads], false)[0];
    if (!hit) return null;
    const id = hit.object.userData.datumId as string | undefined;
    if (id) return { kind: "datum", id, def: hit.object.userData.datumDef as PlaneDef };
    const plane = hit.object.userData.plane as Plane3 | undefined;
    return plane ? { kind: "base", plane } : null;
  }

  /** Brighten the plane under the cursor, separately from the selected one. */
  hoverDatum(id: string | null) {
    if (this.hoveredDatum === id) return;
    this.hoveredDatum = id;
    this.paintDatums();
  }

  /** centroid (world) of the given bodies' vertices, the Move gizmo anchor. */
  bodiesCentroid(ids: string[]): THREE.Vector3 {
    const out = new THREE.Vector3();
    if (!this.model) return out;
    const set = new Set(ids);
    const bodies = this.model.bodies.filter((b) => set.has(b.id));
    if (!bodies.length) return out;
    const tmp = new THREE.Vector3();
    let n = 0;
    for (const body of bodies) {
      const pos = body.mesh.geometry.getAttribute("position");
      for (let v = 0; v < pos.count; v++) {
        out.add(tmp.fromBufferAttribute(pos, v).applyMatrix4(body.mesh.matrixWorld));
        n++;
      }
    }
    if (n) out.divideScalar(n);
    return out;
  }

  /** The world bounding box of the given bodies, or null when none of them are
   *  in the current model. How big the thing being patterned IS, the natural
   *  first spacing for a repeat is one span, where the copies just touch. */
  bodiesBox(ids: readonly string[]): THREE.Box3 | null {
    if (!this.model) return null;
    const set = new Set(ids);
    const bodies = this.model.bodies.filter((b) => set.has(b.id));
    if (!bodies.length) return null;
    const box = new THREE.Box3();
    for (const b of bodies) {
      b.mesh.geometry.computeBoundingBox();
      const bb = b.mesh.geometry.boundingBox;
      if (bb) box.union(bb.clone().applyMatrix4(b.mesh.matrixWorld));
    }
    return box.isEmpty() ? null : box;
  }

  /** True if (clientX,clientY) is over the ViewCube corner, so a right-click
   *  there belongs to the cube, not the model. */
  cubeHitsRegion(clientX: number, clientY: number): boolean {
    return this.cube.hitsRegion(clientX, clientY);
  }

  /** Render the document's datum/construction planes as translucent quads that
   *  can be clicked to select (and then cut by). */
  setDatumPlanes(
    planes: {
      id: string;
      origin: [number, number, number];
      normal: [number, number, number];
      xdir: [number, number, number];
    }[],
  ) {
    for (const q of this.datumQuads) {
      this.datumGroup.remove(q);
      q.geometry.dispose();
      (q.material as THREE.Material).dispose();
    }
    this.datumQuads = [];
    const up = new THREE.Vector3(0, 0, 1);
    for (const p of planes) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb98cff, // construction-plane lilac
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), mat);
      m.position.set(p.origin[0], p.origin[1], p.origin[2]);
      m.quaternion.setFromUnitVectors(
        up,
        new THREE.Vector3(p.normal[0], p.normal[1], p.normal[2]).normalize(),
      );
      m.renderOrder = -1;
      m.userData.datumId = p.id;
      // Kept on the quad so a hit carries its plane (features/facePlanePick.ts cannot ask).
      m.userData.datumDef = { origin: p.origin, normal: p.normal, xdir: p.xdir };
      if (this.planesOnTop) this.drawPlaneOnTop(m, true);
      this.datumGroup.add(m);
      this.datumQuads.push(m);
    }
    this.highlightDatum(this.selectedDatum);
  }

  /** Datum points and axes as pickable geometry, sized against the model. */
  setDatumMarkers(
    points: { id: string; point: [number, number, number] }[],
    axes: { id: string; origin: [number, number, number]; dir: [number, number, number] }[],
  ) {
    for (const m of this.datumMarkers) {
      this.datumGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.datumMarkers = [];
    // A world size to draw at: a fraction of the model, so a datum on a 5 mm part
    // and one on a 5 m part both read. Fallback for an empty document.
    const diag = this.modelDiagonal() ?? 100;
    const r = Math.max(0.4, diag * 0.012);
    const mk = (geom: THREE.BufferGeometry, id: string) => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb98cff, transparent: true, opacity: 0.85, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.datumId = id;
      mesh.renderOrder = 3; // over the surface, so a datum on a face stays visible
      this.datumGroup.add(mesh);
      this.datumMarkers.push(mesh);
      return mesh;
    };
    for (const p of points) {
      const mesh = mk(new THREE.SphereGeometry(r, 16, 12), p.id);
      mesh.position.set(p.point[0], p.point[1], p.point[2]);
    }
    const up = new THREE.Vector3(0, 1, 0); // the cylinder's own axis
    for (const a of axes) {
      const dir = new THREE.Vector3(a.dir[0], a.dir[1], a.dir[2]);
      if (dir.lengthSq() < 1e-12) continue; // a zero direction names no line
      dir.normalize();
      const len = diag * 3 + 50; // long enough to read as "infinite" at any fit
      const mesh = mk(new THREE.CylinderGeometry(r * 0.3, r * 0.3, len, 12), a.id);
      mesh.position.set(a.origin[0], a.origin[1], a.origin[2]);
      mesh.quaternion.setFromUnitVectors(up, dir);
    }
    this.paintDatums();
  }

  /** Brighten the selected construction plane; others stay faint. */
  highlightDatum(id: string | null) {
    this.selectedDatum = id;
    this.paintDatums();
  }

  private paintDatums() {
    for (const q of this.datumQuads) {
      const id = q.userData.datumId as string;
      (q.material as THREE.MeshBasicMaterial).opacity =
        id === this.selectedDatum ? 0.32 : id === this.hoveredDatum ? 0.24 : 0.12;
    }
    // A point/axis is a solid mark, not a translucent wash like a plane, so it
    // brightens rather than fades: full on when selected or hovered, still
    // clearly visible otherwise.
    for (const m of this.datumMarkers) {
      const id = m.userData.datumId as string;
      (m.material as THREE.MeshBasicMaterial).opacity =
        id === this.selectedDatum || id === this.hoveredDatum ? 1 : 0.7;
    }
    this.requestRender();
  }

  /** The currently selected edge lines themselves, for the selection handle,
   *  which needs their polylines (midpoint + tangent) rather than the
   *  rebuild-stable selectors those polylines get turned into. */
  selectedEdgeLines(): EdgeRef[] {
    return this.highlighter?.getSelectedEdges() ?? [];
  }

  // --- edge pick scope ---------------------------------------------------------
  // Whether an edge was picked alone or as its tangent chain is decided at pick time
  // (pickScope.ts) and read when a tool arms, so it lives beside the selection.

  /** Scope of the CURRENT edge selection, with the reason it came out that way.
   *  Replaced wholesale by a plain click, folded by mergeScope on an additive
   *  one. */
  private edgeScope: ScopeDecision = { scope: "chain", reason: "tangent" };

  /** Record what a fresh edge pick means. `additive` folds into what the
   *  selection already carried (single wins); a replacing click starts over. */
  private noteEdgePickScope(edge: EdgeRef, shift: boolean, additive: boolean) {
    const decided = pickScope({ shift, view: this.edgeScopeView(edge) });
    if (!additive) {
      this.edgeScope = decided;
      return;
    }
    // Keep the REASON belonging to whichever pick won the merge, so the prompt
    // explains the set the user is looking at rather than their last click.
    const scope = mergeScope(this.edgeScope.scope, decided.scope);
    if (scope === decided.scope) this.edgeScope = decided;
  }

  /** What the current edge selection means, "chain" to expand each member
   *  across its tangent neighbours, "single" for exactly these edges. */
  selectedEdgeScope(): ScopeDecision {
    return this.edgeScope;
  }

  /** The camera's relationship to one edge, for the zoom heuristic. Public
   *  because the edge tool picks edges of its own once it is armed, and those
   *  picks have to be scoped by the same rule as the pick that armed it. */
  edgeScopeView(edge: EdgeRef): ScopeView {
    const rect = this.canvas.getBoundingClientRect();
    const viewportPx = Math.max(1, Math.min(rect.width, rect.height));
    const pts = edge.points as [number, number, number][];
    const mid = polylineMid(pts);
    return {
      edgePx: this.screenExtent(pts),
      viewportPx,
      pixelWorldSize: mid ? this.pixelWorldSize(new THREE.Vector3(mid[0], mid[1], mid[2])) : null,
      modelDiagonal: this.modelDiagonal(),
    };
  }

  /** The displayed model's diagonal, for sizing manipulators. The store's result
   *  differs during a live preview, when a handle must not change size. */
  modelDiagonal(): number | null {
    return this.model ? this.model.box.getSize(new THREE.Vector3()).length() : null;
  }

  /** A polyline's on-screen size in CSS pixels, from eight sampled points. */
  private screenExtent(points: [number, number, number][]): number | null {
    if (points.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const step = Math.max(1, Math.floor((points.length - 1) / 7));
    for (let i = 0; i < points.length; i += step) {
      const p = points[i]!;
      const s = this.projectToScreen(new THREE.Vector3(p[0], p[1], p[2]));
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    const d = Math.hypot(maxX - minX, maxY - minY);
    return Number.isFinite(d) ? d : null;
  }

  /** The edges on the selected faces, found geometrically: the reply never says
   *  which edges bound which face (faceEdges.ts). */
  edgesOfSelectedFaces(): EdgeRef[] {
    if (!this.highlighter || !this.model) return [];
    const faces = this.highlighter.getSelectedFaces();
    if (!faces.length) return [];
    const tol = faceEdgeTol(this.model.box.getSize(new THREE.Vector3()).length());
    const all = this.visibleEdgeLines();
    const out: EdgeRef[] = [];
    const seen = new Set<EdgeRef>();
    for (const fid of faces) {
      const tris = this.faceTriangles(fid).map(
        (t): Tri => [
          [t.a.x, t.a.y, t.a.z],
          [t.b.x, t.b.y, t.b.z],
          [t.c.x, t.c.y, t.c.z],
        ],
      );
      if (!tris.length) continue;
      const bodyId = this.faceIdToBodyId(fid);
      const candidates = bodyId ? all.filter((e) => !e.body || e.body === bodyId) : all;
      for (const edge of edgesOnFace(candidates, faceSurface(tris), tol)) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        out.push(edge);
      }
    }
    return out;
  }

  /** Selectors for the currently selected edges (for pre-selected fillet/chamfer). */
  selectedEdgeSelectors(): Selector[] {
    if (!this.highlighter) return [];
    return this.highlighter.getSelectedEdges().flatMap((line): Selector[] => {
      const sel = edgeSelectorFrom({ points: line.points, body: line.body });
      return sel ? [sel] : [];
    });
  }

  /** Find the rendered edge whose polyline midpoint is nearest `mid` (world
   *  units, model-scaled tolerance), the rebuild-stable way to re-locate an
   *  edge a saved selector or a sidecar diagnostic refers to. */
  edgeLineByMid(mid: [number, number, number]): EdgeRef | null {
    if (!this.model) return null;
    const edges = this.model.edges.map((e) => ({ points: e.points }));
    const i = nearestEdgeByMid(edges, mid, midMatchTol(this.model.box.getSize(this.projScratch).length()));
    return i == null ? null : (this.model.edges[i] ?? null);
  }

  /** Paint these edges as selected (used to pre-highlight a feature's saved
   *  member edges when re-opening it for editing). */
  selectEdgeLines(lines: EdgeRef[]) {
    if (!this.highlighter) return;
    const already = new Set(this.highlighter.getSelectedEdges());
    for (const l of lines) if (!already.has(l)) this.highlighter.toggleSelectEdge(l);
    this.requestRender();
  }

  /** Paint these faces as selected (used to pre-highlight a texture feature's
   *  saved member faces when re-opening it for editing). */
  selectFaces(faceIds: number[]) {
    if (!this.highlighter) return;
    const already = new Set(this.highlighter.getSelectedFaces());
    for (const f of faceIds) if (!already.has(f)) this.highlighter.toggleSelectFace(f);
    this.requestRender();
  }

  /** The face whose surface is nearest `point`, as the sidecar's by:"nearest" resolves.
   *  Never compare against faceCentroidWorld: triangle centroids move with tessellation
   *  density. `extraTol` covers a known offset such as a texture's depth. */
  faceIdNear(point: [number, number, number], extraTol = 0): number | null {
    if (!this.model) return null;
    const target = new THREE.Vector3(point[0], point[1], point[2]);
    const local = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    const tri = new THREE.Triangle();
    const closest = new THREE.Vector3();
    let best: number | null = null;
    let bestDist = Infinity;
    for (const body of this.model.bodies) {
      // compare in the body's local space: one matrix inverse per body instead
      // of three vector transforms per triangle.
      inv.copy(body.mesh.matrixWorld).invert();
      local.copy(target).applyMatrix4(inv);
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      for (const [faceId, tris] of body.faceTriangles) {
        for (const t of tris) {
          tri.a.fromBufferAttribute(pos, index.getX(t * 3));
          tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
          tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
          tri.closestPointToPoint(local, closest);
          const d = closest.distanceTo(local);
          if (d < bestDist) { bestDist = d; best = faceId; }
        }
      }
    }
    const tol = midMatchTol(this.model.box.getSize(this.projScratch).length()) + Math.abs(extraTol);
    return best != null && bestDist <= tol ? best : null;
  }


  /** Paint the edges nearest these midpoints red (fillet/chamfer failures).
   *  Replaces the previous error set; pass [] to clear. Re-apply after each
   *  rebuild (setModel rebuilds the highlighter, wiping paint by design). */
  setErrorEdgeMids(mids: [number, number, number][]) {
    if (!this.highlighter) return;
    const lines: EdgeRef[] = [];
    for (const mid of mids) {
      const l = this.edgeLineByMid(mid);
      if (l) lines.push(l);
    }
    this.highlighter.setErrorEdges(lines);
    this.requestRender();
  }

  /** A by:"nearest" selector per selected face plus the first face's normal and anchor.
   *  `round` is set for a lone cylindrical face, making the drag a resize. */
  selectedFacesForPressPull(): { selectors: Selector[]; faceIds: number[]; normal: THREE.Vector3; anchor: THREE.Vector3; bodyId: string | null; round: RoundFace | null } | null {
    if (!this.highlighter || !this.model) return null;
    const faces = this.highlighter.getSelectedFaces();
    if (faces.length === 0) return null;
    const selectors: Selector[] = faces.map((fid) => {
      const c = this.faceCentroidWorld(fid);
      return { kind: "face", by: "nearest", point: [c.x, c.y, c.z] };
    });
    const first = faces[0];
    if (first === undefined) return null;
    const anchor = this.faceCentroidWorld(first);
    return {
      selectors,
      faceIds: [...faces],
      normal: this.faceNormalWorld(first),
      anchor,
      bodyId: this.faceIdToBodyId(first),
      // Only when ONE face is selected. A multi-face press/pull shares a single
      // distance along a single normal; a diameter is a property of one face and
      // has no meaning spread across several.
      round: faces.length === 1 ? this.roundFaceAt(first, anchor) : null,
    };
  }

  /** The cylinder a face lies on, or null. Not from faceNormalWorld: a closed
   *  cylinder's facet normals average to zero. */
  roundFaceAt(faceId: number, at: THREE.Vector3): RoundFace | null {
    const tris = this.faceTriangles(faceId);
    if (tris.length < 3) return null;
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    const n = new THREE.Vector3();
    for (const t of tris) {
      points.push([t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]);
      t.getNormal(n);
      normals.push([n.x, n.y, n.z]);
    }
    const cylinder = cylinderFromFace(points, normals);
    if (!cylinder) return null;
    const solidInside = solidInsideCylinder(cylinder, points, normals);
    if (solidInside === null) return null;
    const radial = radialAt(cylinder, [at.x, at.y, at.z]);
    if (!radial) return null;
    return {
      cylinder,
      radius: cylinder.radius,
      solidInside,
      radial: new THREE.Vector3(radial[0], radial[1], radial[2]),
    };
  }

  /** The sketch plane of the selected planar face, so "click a face, press S" skips the
   *  plane picker. Null for none or a curved face. The winding already points out of
   *  the material; a body-centre test would invert the underside of an overhang. */
  selectedFaceSketchPlane(): {
    plane: PlaneDef;
    faceId: number;
    anchor: { selector: Selector; at: [number, number, number] };
  } | null {
    if (!this.highlighter || !this.model) return null;
    const faceId = this.highlighter.getSelectedFaces()[0];
    if (faceId === undefined) return null;
    const n = this.faceNormalWorld(faceId);
    const c = this.faceCentroidWorld(faceId);
    const tris = this.faceTriangles(faceId);
    if (tris.length === 0) return null;
    // Planar means "every vertex sits on the plane through the centroid". The
    // tolerance scales with the model so a 2 m import is judged as leniently as
    // a 20 mm part, the same rule selectCoplanarFaces uses.
    const tol = 1e-3 * (this.model.box.getSize(new THREE.Vector3()).length() || 1) + 1e-4;
    const d0 = n.dot(c);
    for (const t of tris) {
      for (const v of [t.a, t.b, t.c]) {
        if (Math.abs(n.dot(v) - d0) > tol) return null;
      }
    }
    return {
      plane: faceSketchPlane([n.x, n.y, n.z], [c.x, c.y, c.z]),
      faceId,
      // Lets the sketch follow the face. A triangle centroid lies on the face; a vertex
      // average does not for an L-shape or a face with a hole.
      anchor: {
        selector: {
          kind: "face", by: "nearest", point: [c.x, c.y, c.z],
          ...(this.faceIdToBodyId(faceId) ? { body: this.faceIdToBodyId(faceId)! } : {}),
        } as Selector,
        at: [c.x, c.y, c.z] as [number, number, number],
      },
    };
  }

  // --- the face a sketch is being drawn on -----------------------------------
  // Its own marker, not the selection: starting the sketch consumed the selection.
  private sketchFace: THREE.Group | null = null;

  /** Light the face this sketch sits on, or clear it with null. */
  showSketchFace(faceId: number | null) {
    if (this.sketchFace) {
      this.scene.scene.remove(this.sketchFace);
      disposeFaceMarker(this.sketchFace);
      this.sketchFace = null;
    }
    const tris = faceId == null ? [] : this.faceTriangles(faceId);
    if (tris.length) {
      this.sketchFace = buildFaceMarker(tris);
      this.scene.scene.add(this.sketchFace);
    }
    this.requestRender();
  }


  /** Start drawing a chunked reply. `bbox` is final, so the camera settles once here.
   *  setModel stays authoritative and reuses these bodies by id and etag. */
  beginProgressiveModel(
    epoch: number,
    manifest: NonNullable<RebuildResult["bodies"]>,
    result: RebuildResult,
    bbox: RebuildResult["bbox"],
    hiddenBodies: string[],
    fit: boolean,
  ) {
    // Before progressive.begin() disposes bodies the memo's anchors are read from.
    const held = new Map((this.model?.bodies ?? []).map((b) => [b.id, b] as const));
    const changing = new Set<string>();
    for (const m of manifest) {
      const p = held.get(m.id);
      if (!(p && m.etag !== undefined && p.etag === m.etag)) changing.add(m.id);
    }
    this.streamMemo = this.captureSelection(changing);

    const box = new THREE.Box3(
      new THREE.Vector3(...(bbox?.min ?? [0, 0, 0])),
      new THREE.Vector3(...(bbox?.max ?? [0, 0, 0])),
    );
    this.streaming = true;
    // Force any stray setModel during the stream down the FULL path: the
    // visibility-only fast path keys on result identity, and the in-progress
    // result is not a model anyone should shortcut against.
    this.lastResult = null;
    // Orphan edges are invisible to ProgressiveModel, so they leak unless removed here.
    if (this.model?.orphanEdges) {
      this.scene.modelGroup.remove(this.model.orphanEdges.object);
      this.model.orphanEdges.dispose();
    }
    pipe(`stream begin epoch=${epoch} manifest=${manifest.length} changing=${changing.size} `
      + `held=${held.size} hidden=${hiddenBodies.length}`);
    const view = this.progressive.begin(
      epoch, manifest, result, box, this.model, new Set(hiddenBodies),
    );
    this.adoptProgressiveView(view);
    this.targetGridZ = box.min.z;
    this.rig.setContentBox(box);
    if (fit) this.rig.fit(box, true);
    this.requestRender();
  }

  /** Add one chunk's bodies. The whole-model passes run once, at the commit. */
  appendProgressiveBodies(
    epoch: number,
    result: RebuildResult,
    metas: NonNullable<RebuildResult["bodies"]>,
    edgesByBody: Map<string, RebuildResult["edges"]>,
    triRange: { triStart: number; triEnd: number },
    hiddenBodies: string[],
  ) {
    const before = new Set(this.progressive.current?.bodies ?? []);
    const view = this.progressive.append(
      epoch, result, metas, edgesByBody, triRange, new Set(hiddenBodies), this.resolution,
    );
    if (!view) {
      // Not an error on its own: an edit during a long rebuild starts a new
      // stream and the old one's chunks land here afterwards. It IS the moment
      // a body can stop being delivered, so it is on the record.
      pipe(`stream chunk DROPPED epoch=${epoch} bodies=${metas.length} (stream moved on)`);
      return;
    }
    pipe(`stream chunk epoch=${epoch} +${metas.length} tris=${triRange.triStart}..${triRange.triEnd} `
      + `filled=${this.progressive.filled}/${this.progressive.total}`);
    this.adoptProgressiveView(view);
    // repaint ONLY what just arrived, so streamed bodies show their assigned
    // colour rather than popping from grey at the commit
    const fresh = view.bodies.filter((b) => !before.has(b));
    if (fresh.length) this.applyAnalysis(fresh);
    this.requestRender();
  }

  /** Tear down a stream that cannot finish. The caller then re-renders whatever
   *  the store still holds, which rebuilds the previous model from scratch. */
  abortProgressiveModel() {
    if (!this.streaming) return;
    pipe(`stream abort, ${this.progressive.filled}/${this.progressive.total} bodies delivered`);
    this.progressive.abort();
    this.streaming = false;
    this.streamMemo = null;
    this.model = null;
    this.highlighter = null;
    this.lastResult = null;
    this.picker.invalidate();
    this.requestRender();
  }

  /** Must be a fresh ModelView each time: caches in render.ts and Highlighter key on its identity. */
  private adoptProgressiveView(view: ModelView) {
    this.model = view;
    this.highlighter = new Highlighter(view);
    this.dropKey = "";
    this.picker.invalidate();
    // Retried every installment: the selected face's body is usually still in flight.
    if (this.streamMemo) this.restoreSelection(this.streamMemo, true);
  }

  setModel(result: RebuildResult, fit = false, hiddenBodies: string[] = []) {
    this.dropAreaProjection();
    const hidden = new Set(hiddenBodies);
    // An eye toggle re-emits the same result object: only flip visibility. The full
    // pass cost 0.63 s per toggle on a 3,071-body assembly.
    if (!fit && this.model && this.lastResult === result) {
      let anyChanged = false;
      for (const b of this.model.bodies) {
        const vis = !hidden.has(b.id);
        if (b.mesh.visible !== vis) {
          b.mesh.visible = vis;
          b.edges.setBodyVisible(vis);
          anyChanged = true;
        }
      }
      if (anyChanged) for (const d of edgeObjects(this.model)) d.flush();
      return;
    }
    // finish(), not abort(): the streamed bodies are reused below.
    const afterStream = this.streaming;
    if (this.streaming) {
      pipe(`stream finish, ${this.progressive.filled}/${this.progressive.total} bodies delivered`);
      this.progressive.finish();
      this.streaming = false;
    }
    // Face ids belong to one tessellation, so the marker is stale now.
    this.showSketchFace(null);
    this.lastResult = result;
    const bodyMeta = result.bodies ?? [];
    this.faceBands = bandIndex(bodyMeta);
    const bodyIds = new Set(bodyMeta.map((b) => b.id));
    this.finish.dropFaceMaterials((id) => !bodyIds.has(id));
    const { byBody, orphans } = groupEdgesByBody(result.edges, bodyIds);

    // bodies from the PREVIOUS model, keyed by id, consumed as we go; whatever
    // is left at the end no longer exists in this reply and gets disposed.
    const prevBodies = new Map<string, BodyMesh>(this.model?.bodies.map((b) => [b.id, b]) ?? []);

    // Settled before the build loop consumes prevBodies; an unchanged etag is reused.
    const rebuilding = new Set<string>();
    for (const meta of bodyMeta) {
      const prev = prevBodies.get(meta.id);
      if (!(prev && meta.etag !== undefined && prev.etag === meta.etag)) rebuilding.add(meta.id);
    }
    // One shared partition: O(model) instead of O(bodies x model), 2 s against 38 s.
    const partition = rebuilding.size > 1 ? partitionMesh(result, rebuilding) : undefined;

    // After `rebuilding` is known, so reused bodies need no anchor. The stream memo
    // covers a commit that lands before any installment restored the selection.
    const memo = this.captureSelection(rebuilding) ?? this.streamMemo;
    this.streamMemo = null;

    const bodies: BodyMesh[] = [];
    for (const meta of bodyMeta) {
      const prev = prevBodies.get(meta.id);
      prevBodies.delete(meta.id);
      let body: BodyMesh;
      if (prev && meta.etag !== undefined && prev.etag === meta.etag) {
        // unchanged since the last reply, keep its GPU objects untouched, just
        // reset the transient display state a rebuild used to wipe for free.
        body = prev;
        resetBodyAppearance(body);
      } else {
        body = buildBodyMesh(result, meta, byBody.get(meta.id) ?? [], this.resolution, meta.etag, partition);
        if (prev) {
          this.scene.modelGroup.remove(prev.mesh);
          this.scene.modelGroup.remove(prev.edges.object);
          disposeBody(prev);
        }
        this.scene.modelGroup.add(body.mesh);
        this.scene.modelGroup.add(body.edges.object);
      }
      body.mesh.visible = !hidden.has(meta.id);
      body.edges.setBodyVisible(body.mesh.visible);
      bodies.push(body);
    }
    pipe(`commit bodies=${bodyMeta.length} built=${rebuilding.size} `
      + `reused=${bodyMeta.length - rebuilding.size} dropped=${prevBodies.size} `
      + `orphanEdges=${orphans.length} ${afterStream ? "after a stream" : "no stream"}`);
    // any body left in prevBodies is gone from this reply, dispose it
    for (const stale of prevBodies.values()) {
      this.scene.modelGroup.remove(stale.mesh);
      this.scene.modelGroup.remove(stale.edges.object);
      disposeBody(stale);
    }

    // orphan edges (no owning body, see ModelView.orphanEdges) are rebuilt
    // fresh every call; there's no per-body cache key to reuse them by.
    if (this.model?.orphanEdges) {
      this.scene.modelGroup.remove(this.model.orphanEdges.object);
      this.model.orphanEdges.dispose();
    }
    const orphanEdges = orphans.length ? buildEdgeLines(orphans, this.resolution) : null;
    if (orphanEdges) this.scene.modelGroup.add(orphanEdges.object);

    const box = new THREE.Box3(new THREE.Vector3(...result.bbox.min), new THREE.Vector3(...result.bbox.max));
    const edges = bodies.flatMap((b) => b.edges.refs).concat(orphanEdges?.refs ?? []);
    this.model = { bodies, edges, orphanEdges, box };

    this.hideFlushSeams();
    // hideFlushSeams early-returns on an edgeless model, missing a reused body's reset.
    for (const d of edgeObjects(this.model)) d.flush();
    this.picker.invalidate(); // edge geometry just changed, drop cached targets
    this.highlighter = new Highlighter(this.model);
    this.dropKey = "";
    // Before applyAnalysis: setBase() reads the selected set.
    if (memo) this.restoreSelection(memo);
    this.targetGridZ = this.model.box.min.z; // drop the grid to the model's floor
    this.rig.setContentBox(this.model.box);
    this.applyAnalysis(); // paints the analysis overlay, or assigned body colors when "none"
    if (this.zebra) this.applyZebra();
    if (this.combs) this.applyCombs();
    // The cut survives the rebuild the same way: the bodies under it are new (or
    // have just had their clipping reset by resetBodyAppearance), and the ghost
    // meshes went with the meshes they were parented to.
    if (this.section) this.applySection();
    // A rebuild hands back materials wearing the default finish.
    this.applyBodyFinish();
    if (fit) this.rig.fit(this.model.box, true);
    this.auditScene("commit");
  }

  /** Log whether the scene holds exactly this model. Runs every commit because the
   *  fault it catches (a doubled body) is intermittent; it reads no geometry. */
  private auditScene(when: string) {
    const a = auditScene(this.scene.modelGroup.children, this.model, {
      orphanEdges: this.model?.orphanEdges?.object,
      combs: this.combsObj,
    });
    if (auditIsClean(a)) pipe(`${when}: ${auditLine(a)}`);
    else pipeFault(`${when}: ${auditLine(a)}`);
  }

  /** The selection in terms that survive the rebuild. Only bodies in `rebuilding`
   *  need world-space anchors; reused ones keep their objects and face ids. */
  private captureSelection(rebuilding: ReadonlySet<string>): SelectionMemo | null {
    const h = this.highlighter;
    const model = this.model;
    if (!h || !model) return null;
    const selEdges = h.getSelectedEdges();
    const selFaces = h.getSelectedFaces();
    const selBodies = h.getSelectedBodies();
    if (!selEdges.length && !selFaces.length && !selBodies.length) return null;
    return {
      // An edge's midpoint is cheap whatever happens (a polyline is a handful of
      // samples), so it is taken unconditionally rather than gated on the body.
      edges: selEdges.map((ref) => ({
        ref,
        mid: polylineMid(ref.points as [number, number, number][]) ?? null,
      })),
      faces: selFaces.map((id) => {
        const body = bodyOfFace(model, id);
        const c = body && rebuilding.has(body.id) ? this.faceCentroidWorld(id) : null;
        return { id, body: body ?? null, point: c ? ([c.x, c.y, c.z] as [number, number, number]) : null };
      }),
      bodies: selBodies,
    };
  }

  /** Restore the selection and announce it, even when nothing survived (the drag
   *  handle needs that). Mid-stream, a missing body is not yet a lost face, so the
   *  geometric fallback waits and only a real restore is announced. */
  private restoreSelection(memo: SelectionMemo, duringStream = false): void {
    const h = this.highlighter;
    if (!h || !this.model) return;
    const liveBodies = new Set<BodyMesh>(this.model.bodies);
    const liveEdges = new Set<EdgeRef>(this.model.edges);
    const liveBodyIds = new Set(this.model.bodies.map((b) => b.id));

    const edges = remapSelection(
      memo.edges,
      (m) => (liveEdges.has(m.ref) ? m.ref : null),
      (m) => (m.mid ? this.edgeLineByMid(m.mid) : null),
    );
    const faces = remapStreamedSelection(
      memo.faces,
      (m) => (m.body && liveBodies.has(m.body) ? m.id : null),
      (m) => (m.point ? this.faceIdNear(m.point) : null),
      (m) => !duringStream || (m.body !== null && liveBodyIds.has(m.body.id)),
    );
    // Bodies are the easy case and always exact: ids ARE stable across a
    // rebuild, so a body is either still here or genuinely gone.
    const bodies = memo.bodies.filter((id) => liveBodyIds.has(id));

    for (const l of edges) h.toggleSelectEdge(l);
    for (const f of faces) h.toggleSelectFace(f);
    for (const b of bodies) h.toggleSelectBody(b);

    if (shouldAnnounce(memo.edges.length + memo.faces.length, edges.length + faces.length, duringStream))
      this.onSelectionChange?.();
    if (shouldAnnounce(memo.bodies.length, bodies.length, duringStream))
      this.onBodySelectionChange?.();
  }

  /** Wall-clock cost of the last flush-seam pass, ms, surfaced in sceneStats
   *  so a slow open reports what it actually spent the time on. */
  seamMs = 0;
  /** Set when the pass was skipped for being too big (flushSeams.ts). */
  seamSkipped = false;

  private hideFlushSeams() {
    const got = hideFlushSeams(this.model);
    this.seamMs = got.ms;
    this.seamSkipped = got.skipped;
  }

  clearModel() {
    this.dropAreaProjection();
    this.faceBands = new Map();
    // A reply with no geometry ends its stream here, not in setModel; left open,
    // `streaming` would suppress picking for good.
    this.abortProgressiveModel();
    if (this.model) {
      for (const b of this.model.bodies) this.scene.modelGroup.remove(b.mesh);
      for (const d of edgeObjects(this.model)) this.scene.modelGroup.remove(d.object);
      disposeModel(this.model);
      this.model = null;
      this.highlighter = null;
    }
    this.targetGridZ = 0; // no model → grid back on the world XY plane
    this.rig.setContentBox(new THREE.Box3());
    this.savedMats.clear(); // materials died with the model
    this.finish.clear();
    this.caps.clear();
    this.syncBloomable();
    this.ghostMeshes = []; // ...as did the meshes the ghosts hung off
    if (this.combsObj) {
      this.scene.modelGroup.remove(this.combsObj);
      this.combsObj.geometry.dispose();
      (this.combsObj.material as THREE.Material).dispose();
      this.combsObj = null;
    }
    this.requestRender();
  }

  fitView() {
    if (this.model) this.rig.fit(this.model.box, true);
  }

  /** The camera a fresh window starts with. `onModel` frames what is built;
   *  without it the view goes home to the origin, which is what New wants while
   *  the old model is still on screen for the frame before the rebuild clears it. */
  resetCamera(onModel = true) {
    this.userMovedCamera = false;
    this.rig.resetView(onModel ? (this.model?.box ?? null) : null);
    this.requestRender();
  }

  showAllPlanes(on: boolean) {
    this.planesOnTop = on;
    for (const k of ["XY", "XZ", "YZ"] as Plane3[]) {
      const m = this.scene.planes[k];
      m.visible = on;
      (m.material as THREE.MeshBasicMaterial).opacity = on ? 0.18 : 0.08;
      this.drawPlaneOnTop(m, on);
    }
    for (const q of this.datumQuads) this.drawPlaneOnTop(q, on);
    this.requestRender();
  }

  private drawPlaneOnTop(quad: THREE.Object3D, on: boolean) {
    quad.traverse((o) => {
      o.renderOrder = on ? 950 : -1;
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat && !Array.isArray(mat)) {
        mat.depthTest = !on && !(o instanceof THREE.Sprite);
        mat.needsUpdate = true;
      }
    });
  }

  /** True while the construction quads are drawn over the model. */
  get constructionOnTop(): boolean {
    return this.planesOnTop;
  }

  /** Brighten the plane under the cursor during plane-pick (null = none). */
  hoverPlane(kind: Plane3 | null) {
    for (const k of ["XY", "XZ", "YZ"] as Plane3[]) {
      const m = this.scene.planes[k];
      if (!m.visible) continue;
      (m.material as THREE.MeshBasicMaterial).opacity = k === kind ? 0.36 : 0.14;
    }
    this.requestRender();
  }

  /**
   * Raycast the three plane quads and return the plane whose surface is nearest
   * the camera under the cursor, i.e. the one you're pointing at.
   * `intersectObjects` returns hits sorted nearest-first, so hits[0] is it.
   */
  pickPlane(clientX: number, clientY: number): Plane3 | null {
    this.rayFrom(clientX, clientY);
    const meshes = (["XY", "XZ", "YZ"] as Plane3[]).map((k) => this.scene.planes[k]);
    const hits = this.sharedRaycaster.intersectObjects(meshes, false);
    const hit = hits[0];
    if (!hit) return null;
    return (hit.object.userData.plane as Plane3) ?? null;
  }

  /** The plane pick of the face under the cursor. `kind` says flat or round, and
   *  `selector`/`at` let a sketch or datum follow the face across a rebuild. */
  facePlanePick(clientX: number, clientY: number) {
    return pickFacePlaneAt(this, clientX, clientY);
  }

  pickFacePlane(clientX: number, clientY: number): PlaneDef | null {
    return pickFacePlaneAt(this, clientX, clientY)?.def ?? null;
  }

  /** Edge-only pick for the fillet/chamfer edge-selection tools. */
  pickEdgeAt(clientX: number, clientY: number): EdgeHit | null {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.picker.pickEdge(clientX, clientY, rect, this.rig.active, this.model);
  }

  /** All visible edge lines of the current model, for tangent-chain expansion. */
  visibleEdgeLines(): EdgeRef[] {
    return this.model ? this.picker.visibleEdges(this.model) : [];
  }

  // --- Measure (Inspect): pick a face/edge and read its size ----------------

  /** Pick the face or edge under the cursor (face-vs-edge gated like selection). */
  pickEntity(clientX: number, clientY: number): Hit | null {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    return this.picker.pick(clientX, clientY, rect, this.rig.active, this.model);
  }

  /** World-space area (mm²) of a B-rep face = Σ its triangle areas. */
  faceArea(faceId: number): number {
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return 0;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const mw = body.mesh.matrixWorld;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let area = 0;
    for (const t of tris) {
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
      area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    }
    return area;
  }

  /** Face readout: area + world centroid + outward normal. */
  measureFace(faceId: number): { area: number; centroid: THREE.Vector3; normal: THREE.Vector3 } {
    return {
      area: this.faceArea(faceId),
      centroid: this.faceCentroidWorld(faceId),
      normal: this.faceNormalWorld(faceId),
    };
  }

  /** All world-space triangles of a B-rep face, the Measure tool's raw
   *  material for true shortest-distance computation. */
  faceTriangles(faceId: number): THREE.Triangle[] {
    const out: THREE.Triangle[] = [];
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return out;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const mw = body.mesh.matrixWorld;
    for (const t of tris) {
      const tri = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw),
        new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw),
      );
      out.push(tri);
    }
    return out;
  }

  /** Hover-highlight whatever a pick returned (Measure aiming feedback). */
  hoverEntity(hit: import("./picking").Hit | null) {
    this.highlighter?.clearHover();
    if (!hit) { this.requestRender(); return; }
    if (hit.kind === "edge") this.highlighter?.hoverEdge(hit.edge);
    else this.highlighter?.hoverFace(hit.faceId);
    this.requestRender();
  }

  /** Transient marker line between the two closest points of a measure pair
   *  (pass null to clear). Drawn on top so it reads through the model. */
  setMeasureMarker(a: THREE.Vector3 | null, b?: THREE.Vector3) {
    if (this.measureLine) {
      this.scene.scene.remove(this.measureLine);
      this.measureLine.geometry.dispose();
      (this.measureLine.material as THREE.Material).dispose();
      this.measureLine = null;
    }
    if (!a || !b) { this.requestRender(); return; }
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffc24a,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    this.measureLine = new THREE.Line(geo, mat);
    this.measureLine.renderOrder = 999;
    this.scene.scene.add(this.measureLine);
    this.requestRender();
  }
  private measureLine: THREE.Line | null = null;

  /** Highlight exactly these faces + edges (used by the Measure tool). */
  measureHighlight(
    faceIds: number[],
    lines: EdgeRef[],
  ) {
    this.highlighter?.clearSelection();
    for (const f of faceIds) this.highlighter?.toggleSelectFace(f);
    for (const l of lines) this.highlighter?.toggleSelectEdge(l);
    this.requestRender();
  }

  /** Smart select (Plasticity-style): select every face coplanar with the given
   *  one. Switches to face mode, clears the current selection, selects the set,
   *  fires onSelectionChange. Returns the count selected. */
  selectCoplanarFaces(faceId: number): number {
    if (!this.model || !this.highlighter) return 0;
    this.setSelectionMode("faces");
    const n0 = this.faceNormalWorld(faceId);
    const c0 = this.faceCentroidWorld(faceId);
    const d0 = n0.dot(c0); // plane offset along the normal
    const diag = this.model.box.getSize(new THREE.Vector3()).length() || 1;
    const tol = 1e-3 * diag + 1e-4;
    this.highlighter.clearSelection();
    let count = 0;
    for (const body of this.model.bodies) {
      for (const fid of body.faceTriangles.keys()) {
        const n = this.faceNormalWorld(fid);
        if (n.dot(n0) < 0.999) continue; // parallel + same facing
        if (Math.abs(n.dot(this.faceCentroidWorld(fid)) - d0) > tol) continue; // same plane
        this.highlighter.toggleSelectFace(fid);
        count++;
      }
    }
    this.onSelectionChange?.();
    this.requestRender();
    return count;
  }

  // --- cross-section mode ----------------------------------------------------
  // Owned here so it survives rebuilds. The far half is a faint child mesh sharing
  // each body's geometry with the mirrored clip plane, so it follows move ghosts.
  private section: { ghost: number } | null = null;
  /** The live cut. Materials hold a REFERENCE to it, so moving the section is a
   *  mutation here rather than a re-assignment across every material. */
  private sectionPlane = new THREE.Plane();
  /** The same cut, mirrored: what the ghost pass keeps. */
  private ghostPlane = new THREE.Plane();
  private ghostMat: THREE.MeshLambertMaterial | null = null;
  private ghostMeshes: THREE.Mesh[] = [];
  private caps = new SectionCaps();

  /** Enter/update cross-section mode: clip the model (faces + edges) by `plane`,
   *  drawing what it cuts away at `ghost` alpha (0 = not drawn at all, the old
   *  behaviour). Null leaves the mode. */
  setSectionView(view: { plane: THREE.Plane; ghost: number } | null) {
    if (!view) {
      if (!this.section) return;
      this.section = null;
      this.applySection();
      return;
    }
    // A dragged section changes its plane many times a second but its ghost
    // level almost never; only the latter costs anything to re-apply.
    const remount = !this.section || this.section.ghost !== view.ghost;
    this.sectionPlane.copy(view.plane);
    this.ghostPlane.copy(view.plane).negate();
    this.section = { ghost: view.ghost };
    if (remount) this.applySection();
    else {
      this.caps.place(this.sectionPlane);
      this.requestRender();
    }
  }

  /** True while cross-section mode is on, for anything that has to draw or
   *  behave differently underneath it. */
  get sectioned(): boolean {
    return !!this.section;
  }

  private applySection() {
    const on = !!this.section;
    this.scene.renderer.localClippingEnabled = on;
    const planes = on ? [this.sectionPlane] : null;
    if (this.model) {
      for (const b of this.model.bodies) {
        for (const mat of bodyMaterials(b)) mat.clippingPlanes = planes;
      }
      for (const d of edgeObjects(this.model)) d.material.clippingPlanes = planes;
    }
    this.mountGhost();
    this.mountCaps(on);
    this.requestRender();
  }

  private mountCaps(on: boolean) {
    if (!on || !this.model) {
      this.caps.clear();
      return;
    }
    if (!this.caps.group.parent) this.scene.scene.add(this.caps.group);
    this.caps.mount(this.model.bodies, this.sectionPlane, (id) => new THREE.Color(this.finish.bodyPaint[id] ?? BASE_COLOR));
  }

  private mountGhost() {
    for (const g of this.ghostMeshes) g.removeFromParent();
    this.ghostMat?.dispose();
    const built = buildSectionGhosts(
      this.model?.bodies ?? [],
      this.ghostPlane,
      this.section?.ghost ?? 0,
    );
    this.ghostMeshes = built.meshes;
    this.ghostMat = built.material;
  }

  /** The model's world bounding box (for placing the section plane), or null. */
  modelBox(): THREE.Box3 | null {
    return this.model?.box ?? null;
  }

  /** Mass/geometry properties of the given bodies (or the whole model if null),
   *  computed from the tessellation: volume + center of mass (divergence theorem
   *  over the triangles), surface area, and bounding box. */
  bodyProperties(
    ids: string[] | null,
  ): { volume: number; area: number; com: THREE.Vector3; bbox: THREE.Box3; names: string[] } | null {
    if (!this.model) return null;
    const all = this.model.bodies;
    const bodies = ids && ids.length ? all.filter((b) => ids.includes(b.id)) : all;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const bbox = new THREE.Box3().makeEmpty();
    const com = new THREE.Vector3();
    let area = 0;
    let vol = 0;
    for (const body of bodies) {
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const mw = body.mesh.matrixWorld;
      for (let t = 0; t < body.faceIds.length; t++) {
        a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
        b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
        c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
        bbox.expandByPoint(a);
        bbox.expandByPoint(b);
        bbox.expandByPoint(c);
        area += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
        const v = a.dot(b.clone().cross(c)) / 6; // signed tet (origin,a,b,c) volume
        vol += v;
        com.addScaledVector(a.clone().add(b).add(c), v / 4); // tet centroid · weight
      }
    }
    if (Math.abs(vol) > 1e-9) com.divideScalar(vol);
    return {
      volume: Math.abs(vol),
      area,
      com,
      bbox,
      names: bodies.map((x) => x.name),
    };
  }

  /** A by:"nearest" face selector, the surface normal and the hit point under the cursor. */
  pickFaceForPressPull(
    clientX: number,
    clientY: number,
  ): { selector: Selector; faceId: number; normal: THREE.Vector3; anchor: THREE.Vector3; bodyId: string | null } | null {
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    if (!hit || !hit.face) return null;
    const mesh = hit.object as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const normal = b.sub(a).cross(c.sub(a)).normalize().transformDirection(mesh.matrixWorld).normalize();
    const anchor = hit.point.clone();
    const faceId = faceIdOfHit(hit);
    return {
      selector: { kind: "face", by: "nearest", point: [anchor.x, anchor.y, anchor.z] },
      faceId,
      normal,
      anchor,
      bodyId: this.faceIdToBodyId(faceId),
    };
  }

  /** Every unoccluded edge under (x, y), nearest first. */
  pickableEdgeCandidates(clientX: number, clientY: number, rect: DOMRect): EdgeCandidate[] {
    if (!this.model) return [];
    const cands = this.picker.pickEdgeCandidates(clientX, clientY, rect, this.rig.active, this.model);
    const faceDist = this.picker.faceDepthAt(this.rig.active, this.model);
    const scale = this.modelDiagonal() ?? 0;
    return cands.filter((c) => !occludedEdge(c.depth, faceDist, scale));
  }

  /** Emphasise the edge a menu row names, over everything; null clears it. */
  emphasiseEdge(line: EdgeRef | null) {
    this.emphasiseEdges(line ? [line] : []);
  }

  /** Emphasise several edges together, a loop about to be acted on; [] clears. */
  emphasiseEdges(lines: readonly { readonly points: readonly (readonly number[])[] }[]) {
    if (!lines.length) {
      this.emphasis?.hide();
      this.requestRender();
      return;
    }
    if (!this.emphasis) {
      this.emphasis = new EdgeEmphasis(this.resolution, EDGE_HOVER_COLOR);
      this.addToScene(this.emphasis.object);
    }
    this.emphasis.showAll(lines.map((l) => l.points));
    this.requestRender();
  }

  hoverEdge(line: EdgeRef | null) {
    this.highlighter?.clearHover();
    if (line) this.highlighter?.hoverEdge(line);
    this.requestRender();
  }

  /** Light up ALL model edges as "selectable" while the fillet/chamfer edge
   *  tool is active, so they're easy to see and target (MCAD-style): bright
   *  color + thicker lines. */
  emphasizeEdges(on: boolean) {
    this.edgesEmphasized = on;
    this.highlighter?.setEdgeBase(on ? EDGE_PICKABLE : this.wireframe ? EDGE_WIRE : EDGE_IDLE);
    if (this.model) {
      for (const d of edgeObjects(this.model)) d.material.linewidth = on ? 2.8 : 1.6;
    }
    this.requestRender();
  }

  private surfaceRaycaster = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });
  /** The nearest visible body surface under (x, y): its ray distance and face. */
  surfaceHitAt(clientX: number, clientY: number): { distance: number; faceId: number } | null {
    if (!this.model) return null;
    flushRaycastIndex();
    this.surfaceRaycaster.ray.copy(this.rayFrom(clientX, clientY).ray);
    const hit = this.surfaceRaycaster.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return hit ? { distance: hit.distance, faceId: faceIdOfHit(hit) } : null;
  }

  /** The faceId under (x, y), without touching the hover highlight. */
  faceIdAt(clientX: number, clientY: number): number | null {
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    return hit ? faceIdOfHit(hit) : null;
  }

  hoverFaceAt(clientX: number, clientY: number): number | null {
    this.highlighter?.clearHover();
    this.requestRender();
    if (!this.model) return null;
    const ray = this.rayFrom(clientX, clientY);
    const hit = ray.intersectObjects(visibleBodyMeshes(this.model), false)[0];
    if (!hit) return null;
    const faceId = faceIdOfHit(hit);
    this.highlighter?.hoverFace(faceId);
    return faceId;
  }

  /** Clear any hover highlight (used when leaving an interactive pick mode). */
  clearHover() {
    this.highlighter?.clearHover();
    this.requestRender();
  }

  /** A point on a face: the vertex mean snapped to the nearest triangle centroid. The
   *  mean alone lands on a cylinder's axis, where by:"nearest" finds the inner wall. */
  private faceCentroidWorld(faceId: number): THREE.Vector3 {
    const acc = new THREE.Vector3();
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) return acc;
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const tmp = new THREE.Vector3();
    const seen = new Set<number>();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k);
        if (seen.has(vi)) continue;
        seen.add(vi);
        acc.add(tmp.fromBufferAttribute(pos, vi));
      }
    }
    if (seen.size) acc.divideScalar(seen.size);

    // snap the seed onto the surface: the nearest triangle's centroid
    const cent = new THREE.Vector3();
    const best = new THREE.Vector3();
    let bestD = Infinity;
    for (const t of tris) {
      cent.set(0, 0, 0);
      for (let k = 0; k < 3; k++) cent.add(tmp.fromBufferAttribute(pos, index.getX(t * 3 + k)));
      cent.divideScalar(3);
      const d = cent.distanceToSquared(acc);
      if (d < bestD) { bestD = d; best.copy(cent); }
    }
    if (bestD < Infinity) acc.copy(best);
    return acc.applyMatrix4(body.mesh.matrixWorld);
  }

  /** Area-weighted average normal of a B-rep face (world space), averaging its
   *  triangles' normals. For a planar face this is the exact normal; for a curved
   *  face it's a representative outward direction. */
  private faceNormalWorld(faceId: number): THREE.Vector3 {
    const acc = new THREE.Vector3();
    const body = this.model && bodyOfFace(this.model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    if (!body || !tris) { acc.set(0, 0, 1); return acc; }
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const t of tris) {
      a.fromBufferAttribute(pos, index.getX(t * 3));
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
      n.copy(b.sub(a).cross(c.sub(a))); // length = 2× triangle area → area-weighted
      acc.add(n);
    }
    if (acc.lengthSq() < 1e-12) acc.set(0, 0, 1);
    return acc.normalize().transformDirection(body.mesh.matrixWorld).normalize();
  }

  /** a reusable Raycaster aimed at the given client coords (no allocation) */
  private sharedRaycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  rayFrom(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.sharedRaycaster.setFromCamera(this.ndc, this.rig.active);
    return this.sharedRaycaster;
  }

  cycleProjection(): ProjectionMode {
    const mode = this.rig.projectionMode();
    const next: ProjectionMode =
      mode === "persp" ? "ortho" : mode === "ortho" ? "auto" : "persp";
    this.rig.setProjectionMode(next);
    this.requestRender();
    return next;
  }

  /** Keep the view cube clear of chrome floating over the right edge. */
  setViewCubeInset(px: number) {
    if (this.cube.rightInset === px) return;
    this.cube.rightInset = px;
    this.requestRender();
  }

  get projection(): ProjectionMode {
    return this.rig.projectionMode();
  }

  setProjection(mode: ProjectionMode) {
    this.rig.setProjectionMode(mode);
    this.requestRender();
  }

  setStandardView(v: StandardView) {
    // toolbar buttons + SpaceMouse route here; honor a redefined side so "Top"
    // means whatever the user mapped, not the world default.
    const side = v as ViewCubeSide;
    this.requestRender();
    if (this.applyOverride(side)) return;
    this.rig.setStandardView(v);
  }

  // ---- ViewCube side application + redefinition ----------------------------

  /** Apply a cube side: a user override if one exists, else the default view. */
  private applyCubeSide(side: ViewCubeSide) {
    this.requestRender();
    if (this.applyOverride(side)) return;
    this.rig.setStandardView(FACE_VIEWS[side].view);
  }

  /** If `side` has an override, orient that stored face toward the camera and
   *  return true; otherwise return false. */
  private applyOverride(side: ViewCubeSide): boolean {
    const ov = this.store?.viewOverrides?.[side];
    if (!ov) return false;
    const normal = new THREE.Vector3(...ov.normal);
    const up = new THREE.Vector3(...ov.up);
    this.rig.setViewDir(normal, up);
    return true;
  }

  /** Enter "pick a model face to redefine this cube side" mode. */
  private beginSetOverride(side: ViewCubeSide) {
    this.setOverrideSide = side;
    setPrompt(`Click a model face to set as "${FACE_VIEWS[side].label}" (Esc to cancel)`);
    // listen once for Escape to cancel
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.cancelSetOverride();
        window.removeEventListener("keydown", onKey);
      }
    };
    window.addEventListener("keydown", onKey);
  }

  private cancelSetOverride() {
    this.setOverrideSide = null;
    this.clearHover();
    setPrompt(null);
  }

  /** Capture the clicked model face's plane as the active side's override. */
  private captureOverrideFace(e: PointerEvent) {
    const side = this.setOverrideSide!;
    const plane = this.pickFacePlane(e.clientX, e.clientY);
    if (!plane) {
      setPrompt("No face there, click a model face (Esc to cancel)");
      return;
    }
    // store the face normal (faces the camera when this side is applied) and an
    // up derived from the face's in-plane x axis (xdir × normal = in-plane up).
    const normal = new THREE.Vector3(...plane.normal).normalize();
    const xdir = new THREE.Vector3(...plane.xdir).normalize();
    const up = new THREE.Vector3().crossVectors(normal, xdir).normalize();
    if (up.lengthSq() < 1e-6) up.set(0, 0, 1);
    this.store?.setViewOverride(side, {
      normal: [normal.x, normal.y, normal.z],
      up: [up.x, up.y, up.z],
    });
    this.cube.refreshOverrideMarks();
    this.cancelSetOverride();
    // immediately snap to the newly-defined side so the user sees the result
    this.applyCubeSide(side);
  }

  clearSelection() {
    this.highlighter?.clearSelection();
    this.edgeScope = { scope: "chain", reason: "tangent" };
    this.onSelectionChange?.();
    this.requestRender();
  }

  /** Select exactly the given B-rep face (clears any prior selection). Used by the
   *  right-click "Delete Face" menu so the face-delete path has a definite target. */
  selectOnlyFace(faceId: number) {
    this.highlighter?.clearSelection();
    this.edgeScope = { scope: "chain", reason: "tangent" };
    this.highlighter?.toggleSelectFace(faceId);
    this.onSelectionChange?.();
    this.requestRender();
  }

  /** Select exactly the given edge line (clears any prior selection). Used by the
   *  right-click Fillet/Chamfer menu, the edge tools consume the pre-selection. */
  selectOnlyEdge(line: EdgeRef) {
    this.highlighter?.clearSelection();
    this.highlighter?.toggleSelectEdge(line);
    // Scoped like a left-click, so the menu's Fillet means the same thing.
    this.noteEdgePickScope(line, false, false);
    this.onSelectionChange?.();
    this.requestRender();
  }

  // --- accessors + helpers for the sketch system ---
  get camera(): THREE.Camera {
    return this.rig.active;
  }
  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }
  addToScene(obj: THREE.Object3D) {
    this.scene.scene.add(obj);
    this.requestRender();
  }
  removeFromScene(obj: THREE.Object3D) {
    this.scene.scene.remove(obj);
    this.requestRender();
  }

  // --- drag previews, all of them in ghosts.ts ------------------------------
  setPressPullGhost(faceIds: number[], distance: number, round?: RoundFace | null) {
    this.ghosts.setPressPullGhost(faceIds, distance, round);
  }
  clearPressPullGhost() {
    this.ghosts.clearPressPullGhost();
  }
  beginBodyMoveGhost(bodyIds: string[]) {
    this.ghosts.beginBodyMoveGhost(bodyIds);
  }
  setBodyMoveOffset(offset: THREE.Vector3) {
    this.ghosts.setBodyMoveOffset(offset);
  }
  setBodyMoveTransform(m: THREE.Matrix4) {
    this.ghosts.setBodyMoveTransform(m);
  }
  endBodyMoveGhost(restore: boolean) {
    this.ghosts.endBodyMoveGhost(restore);
  }
  setPatternGhost(bodyIds: readonly string[], matrices: readonly THREE.Matrix4[]) {
    this.ghosts.setPatternGhost(bodyIds, matrices);
  }
  clearPatternGhost() {
    this.ghosts.clearPatternGhost();
  }


  private projScratch = new THREE.Vector3();
  /** project a world point to screen pixels (client coords) */
  projectToScreen(world: THREE.Vector3): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const v = this.projScratch.copy(world).project(this.rig.active);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    };
  }

  /** unproject screen (client) coords onto a plane; null if no hit */
  /** The direction the camera is looking, in world space. Read by the sketch's
   *  edge-on guard, which needs the angle between this and a plane's normal. */
  viewDirection(): THREE.Vector3 {
    const cam = this.rig.active;
    cam.updateMatrixWorld();
    return cam.getWorldDirection(new THREE.Vector3());
  }

  screenToPlane(
    clientX: number,
    clientY: number,
    plane: THREE.Plane,
  ): THREE.Vector3 | null {
    const ray = this.rayFrom(clientX, clientY).ray;
    const out = new THREE.Vector3();
    return ray.intersectPlane(plane, out) ? out : null;
  }

  enterSketchView(origin: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3) {
    // Stay on the side of the plane the camera is already on (viewFlight.viewSideNormal).
    const eye = this.rig.controls.getPosition(new THREE.Vector3());
    const side = viewSideNormal(
      [normal.x, normal.y, normal.z],
      [eye.x, eye.y, eye.z],
      [origin.x, origin.y, origin.z],
    );
    const n = new THREE.Vector3(side[0], side[1], side[2]).normalize();
    // Of the four square in-plane rotations, keep the one nearest the current up.
    const camUp = new THREE.Vector3().setFromMatrixColumn(
      this.rig.active.matrixWorld, 1);
    const v = up.clone().normalize();
    const u = new THREE.Vector3().crossVectors(n, v).normalize();
    let bestUp = v;
    let bestDot = -Infinity;
    for (const cand of [v, v.clone().negate(), u, u.clone().negate()]) {
      const d = cand.dot(camUp);
      if (d > bestDot) { bestDot = d; bestUp = cand; }
    }
    // Flat after the flight: in ortho the dolly in is invisible.
    this.rig.lookAtPlane(origin, n, bestUp, {
      animate: true,
      onArrive: () => this.setSketchFlat(true),
    });
    this.scene.grid.group.visible = false; // hide the world ground grid; only the sketch grid shows
    this.setModelDimmed(true);
    this.sketchDimmed = true;
    this.syncBloomable();
    this.requestRender();
  }
  /** Forces the ortho mode rather than swapping cameras, so 'auto' cannot flip back on
   *  an off-axis plane. The prior mode is captured once. */
  setSketchFlat(on: boolean) {
    if (on === this.sketchOrtho) return;
    if (on) {
      this.sketchPrevMode = this.rig.projectionMode();
      this.rig.setProjectionMode("ortho");
    } else {
      this.rig.setProjectionMode(this.sketchPrevMode);
    }
    this.sketchOrtho = on;
    this.requestRender();
  }
  exitSketchView() {
    this.showSketchFace(null);
    this.setSketchFlat(false);
    this.scene.grid.group.visible = true;
    this.rig.restoreUp();
    this.setModelDimmed(false);
    this.sketchDimmed = false;
    this.syncBloomable();
    this.requestRender();
  }
  private sketchPrevMode: ProjectionMode = "auto";
  private sketchOrtho = false; // currently in the sketch's forced flat (ortho) view
  private sketchDimmed = false;

  /** Dim the model behind an open sketch. depthWrite stays off so the sketch grid
   *  draws through the body. */
  setModelDimmed(on: boolean) {
    if (!this.model) return;
    for (const b of this.model.bodies) {
      for (const mat of bodyMaterials(b)) {
        mat.transparent = on;
        mat.opacity = on ? SKETCH_DIM_OPACITY : 1;
        mat.depthWrite = !on;
      }
    }
    for (const d of edgeObjects(this.model)) {
      d.material.opacity = on ? SKETCH_DIM_EDGE_OPACITY : 1;
      d.material.transparent = true;
    }
    this.requestRender();
  }

  /** world-space size of one screen pixel at a given world point (for glyphs) */
  pixelWorldSize(at: THREE.Vector3): number {
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.rig.active;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = cam as THREE.OrthographicCamera;
      return (oc.top - oc.bottom) / oc.zoom / rect.height;
    }
    const pc = cam as THREE.PerspectiveCamera;
    const dist = pc.position.distanceTo(at);
    return (2 * Math.tan((pc.fov * Math.PI) / 180 / 2) * dist) / rect.height;
  }

  /** Notified when the spacing of the grid on screen changes, in mm. The
   *  viewport does not know what shows it; the shell hangs a readout off this.
   *  Fires only on a real change, so it is safe to call every frame. */
  onGridStep: ((mm: number) => void) | null = null;
  private gridStepMm = 0;

  /** One grid cell's size, from the ground grid or the sketch lattice, whichever shows. */
  reportGridStep(mm: number) {
    if (!(mm > 0) || mm === this.gridStepMm) return;
    this.gridStepMm = mm;
    this.onGridStep?.(mm);
  }

  /** The viewport's diagonal in CSS pixels: the span anything that has to cover
   *  the whole view, corner to corner, is measured against. In the same units
   *  pixelWorldSize() answers in, so the two multiply. */
  viewDiagonalPx(): number {
    const rect = this.canvas.getBoundingClientRect();
    return Math.hypot(Math.max(1, rect.width), Math.max(1, rect.height));
  }

  /** Where the camera is pointed, in world space, the centre of what is on
   *  screen, and so the centre anything view-sized should be built around. */
  cameraTarget(out = new THREE.Vector3()): THREE.Vector3 {
    return this.rig.controls.getTarget(out);
  }

  /** A clean drag snap step (nice 1/2/5 mm) for the current zoom at a world
   *  point, so manipulator values read 5/1/0.5/0.1 mm, not 0.3425. `fine` is the
   *  Shift modifier. See viewport/dragStep.ts for how the number is chosen. */
  snapStep(at: THREE.Vector3, fine = false): number {
    return dragStep(this.pixelWorldSize(at), fine);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.scene.renderer.setSize(w, h, false);
    // The post chain owns its own render targets and does not hear about this
    // any other way; left unsized, bloom is sampled from a stale buffer and the
    // glow lands in the wrong place after every resize.
    this.scene.post.setSize(w, h);
    this.rig.resize(w, h);
    // CSS pixels: a DPR-scaled size thins fat lines and shrinks the edge pick radius.
    this.resolution.set(w, h);
    setEdgeResolution(this.model, this.resolution);
    this.emphasis?.setResolution(this.resolution);
    if (this.model && !this.userMovedCamera && w > 10 && h > 10) {
      this.rig.fit(this.model.box, false);
    }
    this.requestRender();
  }

  /** Counters for a bug report (diagnostics/sceneStats). */
  sceneStats(): string[] {
    return sceneStats({
      model: this.model,
      canvas: this.canvas,
      pixelRatio: this.scene.renderer.getPixelRatio(),
      frameMs: this.fps.lastFrameMs(),
      render: this.scene.renderer.info.render,
      seam: { ms: this.seamMs, skipped: this.seamSkipped },
    });
  }

  screenshotPNG(): string {
    this.scene.post.render(this.rig.active);
    const url = this.canvas.toDataURL("image/png");
    this.requestRender(); // repaint with the ViewCube overlay
    return url;
  }

  /** The current view at `scale` times the size without grid, origin arrows or planes.
   *  Resizes the drawing buffer (updateStyle false) so the post chain is reused.
   *  Must stay synchronous: without preserveDrawingBuffer an await reads a blank
   *  image. `scale` is capped because an oversized buffer fails silently. */
  renderStill(scale = 2, opts: { edges?: boolean } = {}): string {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const cap = this.scene.renderer.capabilities.maxTextureSize || 4096;
    const k = Math.max(1, Math.min(scale, cap / Math.max(w, h)));

    const grid = this.scene.grid.group.visible;
    const triad = this.scene.triad.group.visible;
    const planes = Object.values(this.scene.planes).map((m) => m.visible);
    const lines = this.model ? edgeObjects(this.model) : [];
    const wereLit = lines.map((e) => e.object.visible);
    const dpr = this.scene.renderer.getPixelRatio();
    this.scene.grid.group.visible = false;
    this.scene.triad.group.visible = false;
    for (const m of Object.values(this.scene.planes)) m.visible = false;
    // Hidden rather than removed: a body whose edges were already off (a hidden
    // body's are) must come back off, which is what the saved flags are for.
    if (!opts.edges) for (const e of lines) e.object.visible = false;

    let url = "";
    try {
      this.scene.renderer.setPixelRatio(1);
      this.scene.renderer.setSize(w * k, h * k, false);
      this.scene.post.setSize(w * k, h * k);
      this.scene.post.focusDistance = this.rig.active.position.distanceTo(this.cameraTarget());
      this.scene.post.render(this.rig.active);
      url = this.canvas.toDataURL("image/png");
    } finally {
      // Whatever happened, the viewport goes back to being the viewport. A throw
      // between the resize and the restore would otherwise leave the canvas
      // drawing at twice its size with no furniture on it and no way back.
      this.scene.renderer.setPixelRatio(dpr);
      this.scene.grid.group.visible = grid;
      this.scene.triad.group.visible = triad;
      Object.values(this.scene.planes).forEach((m, i) => { m.visible = planes[i] ?? false; });
      lines.forEach((e, i) => { e.object.visible = wereLit[i] ?? true; });
      this.resize();
      this.requestRender();
    }
    return url;
  }

  // Counts frames the loop ACTUALLY draws. Render-on-demand means most rAF
  // ticks draw nothing, so this is incremented at the draw, not at the tick.
  private fps = new FpsMeter();

  /** Notified when the view starts or stops stuttering under the full render. */
  onStutterChange: ((stuttering: boolean) => void) | null = null;
  private stutter = new StutterWatch();
  private stuttering = false;
  /** Start of the tick that drew a camera move, 0 when the last tick was not one. */
  private movedDrawAt = 0;

  private setStuttering(on: boolean) {
    if (on === this.stuttering) return;
    this.stuttering = on;
    this.onStutterChange?.(on);
  }

  // Only camera moves are timed: that is where a slow frame is felt, and it keeps
  // a rebuild's main thread work from reading as a slow GPU.
  private watchStutter(now: number) {
    if (!this.movedDrawAt) return;
    const period = now - this.movedDrawAt;
    this.movedDrawAt = 0;
    if (isRenderLowPower() || this.store?.buildState.building || this.store?.busyState.active) return;
    if (document.visibilityState !== "visible") return;
    if (this.stutter.sample(period)) this.setStuttering(true);
  }

  private scratchTarget = new THREE.Vector3();
  private loop = () => {
    // Never let a single bad frame kill the loop: if any step throws, log and
    // keep scheduling, so a transient camera/geometry glitch can't freeze the
    // whole app (the rAF used to be unreachable after a throw).
    try {
      const now = performance.now();
      this.watchStutter(now);
      const dt = this.clock.getDelta();
      // Always advanced so damping and transitions progress; returns whether it moved.
      const moved = this.rig.update(dt);
      // Render-on-demand: skip the (relatively expensive) grid rebuild + GPU
      // draw entirely when nothing changed, camera didn't move, no mutation
      // flagged requestRender(), and we've drained the post-mutation linger.
      if (moved || this.needsRender || this.lingerFrames > 0) {
        // keep the ground grid spacing/extent matched to the current zoom + pan
        const t = this.rig.controls.getTarget(this.scratchTarget);
        this.scene.grid.update(t.x, t.y, this.pixelWorldSize(t), this.viewDiagonalPx(), this.targetGridZ);
        // Only while the ground grid is the one being drawn: inside a sketch it
        // is hidden and SketchMode reports the plane lattice instead.
        if (this.scene.grid.group.visible) this.reportGridStep(this.scene.grid.step);
        // ...and the origin arrows to a constant size on screen. Measured AT THE
        // ORIGIN rather than at the camera target, because that is where they
        // are drawn and a perspective pixel is a different size at each depth.
        this.scene.triad.update(this.pixelWorldSize(WORLD_ORIGIN), this.modelDiagonal());
        // What stays sharp when the lens is open: whatever the view is centred
        // on. Written every frame because the orbit distance changes every frame
        // a wheel is turned, and it costs one subtraction.
        this.scene.post.focusDistance = this.rig.active.position.distanceTo(t);
        this.scene.post.render(this.rig.active);
        this.cube.render(this.rig.active); // draw the ViewCube overlay in the corner
        this.fps.frame();
        if (moved) this.movedDrawAt = now;
        this.needsRender = false;
        if (this.lingerFrames > 0) this.lingerFrames--;
      }
    } catch (e) {
      console.error("[viewport] render loop frame error (continuing):", e);
    }
    requestAnimationFrame(this.loop);
  };
}
