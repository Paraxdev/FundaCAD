import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Plane3 } from "../types";
import { setPrompt } from "../ui/prompt";
import { isEditableTarget } from "../ui/focus";
import { awaitTreePick, treePickRefusal, type TreePick, type TreePickAnswer } from "../ui/treePick";
import { CanvasGesture } from "./canvasGesture";
import { freshIds } from "./moveTarget";
import { pickPlaneTarget, type PlanePickTarget } from "./facePlanePick";
import { featureLabel } from "./patternSources";
import { showMirrorPanel } from "./mirrorPanel";
import { mirrorLineColor } from "./mirrorColors";
import { mirrorFeatures, planeDefOf, reflectionMatrix, type MirrorPlanePick } from "./mirrorMath";
import {
  activate,
  addObjects,
  clearField,
  countLabel,
  enterStep,
  isReady,
  nextPick,
  pickLine,
  pickObject,
  removeAt,
  startFields,
  switchField,
  type MirrorFieldKey,
  type MirrorFields,
} from "./mirrorFields";

const BASE_PLANES: readonly Plane3[] = ["XY", "XZ", "YZ"];
export const PLANE_REFUSED = "That face is curved, pick a flat face or a plane";

type PlaneAt = (viewport: Viewport, x: number, y: number) => PlanePickTarget;

let nextPanelId = 1;

/** 3D Mirror: bodies in Objects, an origin plane, datum plane or flat face in the plane field, ghosts as the preview. */
export class MirrorTool {
  active = false;
  private fields: MirrorFields<MirrorPlanePick> = startFields([]);
  private pre: string[] = [];
  private panelId = 0;
  private datumLit = false;
  private onDone: ((id: string | null) => void) | null = null;
  private releaseTree: (() => void) | null = null;
  private readonly gesture: CanvasGesture;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private planeAt: PlaneAt = pickPlaneTarget,
  ) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      key: (e) => this.onKey(e),
    });
  }

  get ready(): boolean {
    return this.active && isReady(this.fields);
  }

  start(pre: readonly string[], onDone: (id: string | null) => void): void {
    if (this.active) return;
    this.active = true;
    this.pre = [...pre];
    this.onDone = onDone;
    this.fields = startFields(pre);
    this.panelId = nextPanelId++;
    this.viewport.suspendPicking = true;
    this.gesture.attach();
    this.releaseTree = awaitTreePick(
      (pick) => this.treePick(pick),
      () => this.cancel(),
    );
    this.set(this.fields);
  }

  /** False, with nothing written, until both fields hold something. */
  commit(): boolean {
    const f = this.fields;
    if (!this.active || !f.line || !f.objects.length) return false;
    const ids = freshIds(this.store, 2);
    const features = mirrorFeatures(() => ids.shift()!, f.objects, f.line);
    const done = this.onDone;
    this.viewport.setSelectedBodies([]);
    this.cleanup();
    this.store.addFeatures(features);
    done?.(features[features.length - 1]!.id);
    return true;
  }

  /** The bodies selected before the start come back, and with them the Move gizmo. */
  cancel(): void {
    if (!this.active) return;
    const done = this.onDone;
    const pre = this.pre;
    this.cleanup();
    this.viewport.setSelectedBodies(pre);
    done?.(null);
  }

  activate(k: MirrorFieldKey): void {
    if (this.active) this.set(activate(this.fields, k));
  }

  clear(k: MirrorFieldKey): void {
    if (this.active) this.set(clearField(this.fields, k));
  }

  remove(k: MirrorFieldKey, i: number): void {
    if (this.active) this.set(removeAt(this.fields, k, i));
  }

  setBasePlane(p: Plane3): void {
    if (this.active) this.set(pickLine(this.fields, { kind: "base", plane: p }, null));
  }

  private set(f: MirrorFields<MirrorPlanePick>): void {
    this.fields = f;
    const vp = this.viewport;
    vp.setSelectedBodies([...f.objects]);
    vp.showAllPlanes(f.active === "line" || f.line?.kind === "base");
    vp.hoverPlane(this.pickedBase());
    const datum = f.line?.kind === "datum" ? f.line.id : null;
    // Only a datum this run lit is put out, a datum selected before the run keeps its highlight.
    if (datum || this.datumLit) vp.highlightDatum(datum);
    this.datumLit = datum !== null;
    const face = f.line?.kind === "face" ? f.line.face.faceId : null;
    vp.setFaceMarks(face === null ? null : [{ faceIds: [face], color: mirrorLineColor() }], "mirror");
    if (f.line && f.objects.length) {
      this.viewport.setPatternGhost(f.objects, [new THREE.Matrix4(), reflectionMatrix(planeDefOf(f.line))]);
    } else this.viewport.clearPatternGhost();
    this.update();
  }

  private pickedBase(): Plane3 | null {
    return this.fields.line?.kind === "base" ? this.fields.line.plane : null;
  }

  private bodyIds(): string[] {
    return (this.store.buildState.result?.bodies ?? []).map((b) => b.id);
  }

  private bodyLabel(id: string): string {
    const built = this.store.buildState.result?.bodies?.find((b) => b.id === id);
    return this.store.bodyName(id) ?? built?.name ?? id;
  }

  private planeOf(t: PlanePickTarget): MirrorPlanePick | null {
    if (t?.kind === "base") return { kind: "base", plane: t.spec };
    if (t?.kind === "datum") return { kind: "datum", id: t.id, def: t.spec };
    if (t?.kind === "face" && t.face.kind === "planar") return { kind: "face", face: t.face };
    return null;
  }

  private onMove(e: PointerEvent): void {
    const keep = e.shiftKey || e.ctrlKey || e.metaKey;
    const vp = this.viewport;
    if (this.fields.active === "objects" || keep) {
      vp.hoverPlane(this.pickedBase());
      vp.hoverDatum(null);
      vp.clearHover();
      const id = vp.bodyIdAt(e.clientX, e.clientY);
      vp.hoverBody(id);
      vp.domElement.style.cursor = id ? "pointer" : "default";
      return;
    }
    vp.hoverBody(null);
    const t = this.planeAt(vp, e.clientX, e.clientY);
    const plane = this.planeOf(t);
    if (plane?.kind === "face") vp.hoverFaceAt(e.clientX, e.clientY);
    else vp.clearHover();
    vp.hoverPlane(plane?.kind === "base" ? plane.plane : this.pickedBase());
    vp.hoverDatum(plane?.kind === "datum" ? plane.id : null);
    vp.domElement.style.cursor = plane ? "pointer" : "default";
  }

  /** A miss is not a cancel, and lets the press through so the view still orbits. */
  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const keep = e.shiftKey || e.ctrlKey || e.metaKey;
    if (this.fields.active === "line" && !keep) {
      const t = this.planeAt(this.viewport, e.clientX, e.clientY);
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const plane = this.planeOf(t);
      if (plane) this.set(pickLine(this.fields, plane, null));
      else this.update(PLANE_REFUSED);
      return;
    }
    const id = this.viewport.bodyIdAt(e.clientX, e.clientY);
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.set(pickObject(this.fields, id));
  }

  // Keys typed in the panel or a field belong to them: Tab moves focus there and Enter presses the focused button.
  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    const own = isEditableTarget(e.target) || (e.target instanceof Element && !!e.target.closest(".mirror-panel"));
    if (own) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const step = enterStep(this.fields);
      if (step === "commit") this.commit();
      else this.set(step);
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.set(switchField(this.fields));
    }
  }

  private treePick(pick: TreePick): TreePickAnswer {
    if (pick.kind === "body") {
      this.set(pickObject(this.fields, pick.id));
      return true;
    }
    if (pick.kind === "bodies") {
      const built = new Set(this.bodyIds());
      const f = addObjects(
        this.fields,
        pick.ids.filter((id) => built.has(id)),
      );
      if (f === this.fields) return "Those bodies are already picked";
      this.set(f);
      return true;
    }
    if (pick.kind === "basePlane") {
      this.set(pickLine(this.fields, { kind: "base", plane: pick.plane }, null));
      return true;
    }
    if (pick.kind === "datumPlane") {
      this.set(pickLine(this.fields, { kind: "datum", id: pick.id, def: pick.def }, null));
      return true;
    }
    return treePickRefusal(pick, "a body or a plane");
  }

  private planeLabel(p: MirrorPlanePick | null): string {
    if (!p) return "Nothing picked";
    if (p.kind === "base") return `${p.plane} plane`;
    if (p.kind === "face") return "Flat face";
    const f = this.store.document.features.find((x) => x.id === p.id);
    return f ? featureLabel(f) : p.id;
  }

  private update(refusal?: string): void {
    const f = this.fields;
    const objects = countLabel(f.objects.length, "body", "bodies");
    setPrompt(`${refusal ? `${refusal} · ` : ""}${nextPick(f, "plane")} · ${objects} · Esc to cancel`);
    showMirrorPanel({
      id: this.panelId,
      fields: [
        {
          key: "objects",
          label: "Objects",
          items: f.objects.map((id) => this.bodyLabel(id)),
          value: objects,
          filled: f.objects.length > 0,
        },
        {
          key: "line",
          label: "Mirror plane",
          items: f.line ? [this.planeLabel(f.line)] : [],
          value: this.planeLabel(f.line),
          filled: f.line !== null,
        },
      ],
      active: f.active,
      planes: BASE_PLANES,
      plane: f.line?.kind === "base" ? f.line.plane : null,
      ready: isReady(f),
      onActivate: (k) => this.activate(k),
      onClear: (k) => this.clear(k),
      onRemove: (k, i) => this.remove(k, i),
      onPlane: (p) => this.setBasePlane(p as Plane3),
      onCommit: () => void this.commit(),
      onCancel: () => this.cancel(),
    });
  }

  private cleanup(): void {
    const vp = this.viewport;
    this.active = false;
    this.gesture.detach();
    const release = this.releaseTree;
    this.releaseTree = null;
    release?.();
    vp.showAllPlanes(false);
    vp.hoverPlane(null);
    vp.hoverDatum(null);
    if (this.datumLit) vp.highlightDatum(null);
    this.datumLit = false;
    vp.setFaceMarks(null, "mirror");
    vp.hoverBody(null);
    vp.clearHover();
    vp.clearPatternGhost();
    vp.domElement.style.cursor = "default";
    vp.suspendPicking = false;
    this.onDone = null;
    this.fields = startFields([]);
    setPrompt(null);
    showMirrorPanel(null);
  }
}
