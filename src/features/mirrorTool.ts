import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Plane3 } from "../types";
import { setPrompt } from "../ui/prompt";
import { isEditableTarget } from "../ui/focus";
import { awaitTreePick, treePickRefusal, type TreePick, type TreePickAnswer } from "../ui/treePick";
import { CanvasGesture } from "./canvasGesture";
import { pickPlaneTarget, type PlanePickTarget } from "./facePlanePick";
import { featureLabel } from "./patternSources";
import { showMirrorPanel } from "./mirrorPanel";
import { mirrorFeatures, planeDefOf, reflectionMatrix, type MirrorPlanePick } from "./mirrorMath";
import {
  activate,
  addObjects,
  clearField,
  countLabel,
  isReady,
  pickLine,
  pickObject,
  startFields,
  switchField,
  type MirrorFieldKey,
  type MirrorFields,
} from "./mirrorFields";

const BASE_PLANES: readonly Plane3[] = ["XY", "XZ", "YZ"];
export const PLANE_REFUSED = "Pick an origin plane or a datum plane";

type PlaneAt = (viewport: Viewport, x: number, y: number) => PlanePickTarget;

let nextPanelId = 1;

/** 3D Mirror: bodies in Objects, an origin or datum plane in the plane field, ghost copies as the preview. */
export class MirrorTool {
  active = false;
  private fields: MirrorFields<MirrorPlanePick> = startFields([]);
  private pre: string[] = [];
  private panelId = 0;
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
    const [feature] = mirrorFeatures(() => this.store.nextId(), f.objects, f.line);
    const done = this.onDone;
    this.viewport.setSelectedBodies([]);
    this.cleanup();
    this.store.addFeature(feature!);
    done?.(feature!.id);
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

  setBasePlane(p: Plane3): void {
    if (this.active) this.set(pickLine(this.fields, { kind: "base", plane: p }, null));
  }

  private set(f: MirrorFields<MirrorPlanePick>): void {
    this.fields = f;
    this.viewport.setSelectedBodies([...f.objects]);
    this.viewport.showAllPlanes(f.active === "line");
    if (f.line && f.objects.length) {
      this.viewport.setPatternGhost(f.objects, [new THREE.Matrix4(), reflectionMatrix(planeDefOf(f.line))]);
    } else this.viewport.clearPatternGhost();
    this.update();
  }

  private bodyIds(): string[] {
    return (this.store.buildState.result?.bodies ?? []).map((b) => b.id);
  }

  private planeOf(t: PlanePickTarget): MirrorPlanePick | null {
    if (t?.kind === "base") return { kind: "base", plane: t.spec };
    if (t?.kind === "datum") return { kind: "datum", id: t.id, def: t.spec };
    return null;
  }

  private onMove(e: PointerEvent): void {
    const keep = e.shiftKey || e.ctrlKey || e.metaKey;
    const vp = this.viewport;
    if (this.fields.active === "objects" || keep) {
      vp.hoverPlane(null);
      vp.hoverDatum(null);
      const id = vp.bodyIdAt(e.clientX, e.clientY);
      vp.hoverBody(id);
      vp.domElement.style.cursor = id ? "pointer" : "default";
      return;
    }
    vp.hoverBody(null);
    const t = this.planeAt(vp, e.clientX, e.clientY);
    vp.hoverPlane(t?.kind === "base" ? t.spec : null);
    vp.hoverDatum(t?.kind === "datum" ? t.id : null);
    vp.domElement.style.cursor = this.planeOf(t) ? "pointer" : "default";
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
    this.set(pickObject(this.fields, id, keep));
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
      this.commit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.set(switchField(this.fields));
    }
  }

  private treePick(pick: TreePick): TreePickAnswer {
    if (pick.kind === "body") {
      this.set(pickObject(this.fields, pick.id, false));
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
    const f = this.store.document.features.find((x) => x.id === p.id);
    return f ? featureLabel(f) : p.id;
  }

  private update(refusal?: string): void {
    const f = this.fields;
    const objects = countLabel(f.objects.length, "body", "bodies");
    const want =
      f.active === "objects" ? "Objects · click a body to mirror" : "Mirror plane · click an origin or datum plane";
    setPrompt(`${refusal ? `${refusal} · ` : ""}${want} · ${objects} · Enter · Esc`);
    showMirrorPanel({
      id: this.panelId,
      fields: [
        { key: "objects", label: "Objects", icon: "select-all", value: objects, filled: f.objects.length > 0 },
        {
          key: "line",
          label: "Mirror plane",
          icon: "plane",
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
    vp.hoverBody(null);
    vp.clearPatternGhost();
    vp.domElement.style.cursor = "default";
    vp.suspendPicking = false;
    this.onDone = null;
    this.fields = startFields([]);
    setPrompt(null);
    showMirrorPanel(null);
  }
}
