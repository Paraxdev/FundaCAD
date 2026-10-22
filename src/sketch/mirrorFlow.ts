import type * as THREE from "three";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { mirrorCopies, type Pt } from "./mirror";
import type { ResolvedEntity } from "./snap";
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
  startFields,
  switchField,
  type MirrorFieldKey,
  type MirrorFields,
} from "../features/mirrorFields";
import type { MirrorPanelView } from "../stores/toolPanels";

export interface MirrorPreview {
  copies: ResolvedEntity[];
  objects: ResolvedEntity[];
  line: ResolvedEntity | null;
  hover: ResolvedEntity | null;
  /** The field a click on `hover` fills. */
  hoverField: MirrorFieldKey;
}

export interface MirrorAxis {
  a: Pt;
  b: Pt;
  label: string;
}

/** The slice of SketchMode the Mirror tool needs. `selected` is live and holds the Objects field. */
export interface MirrorHost {
  entities(): ResolvedEntity[];
  selected(): Set<string>;
  pickTol(): number;
  /** Text is found by its glyph areas, it has no curve segments to pick. */
  textAt(p: THREE.Vector2): ResolvedEntity | null;
  /** The curves around the closed area under `p`, [] when it is not inside one. */
  loopIdsAt(p: THREE.Vector2): string[];
  showPreview(view: MirrorPreview): void;
  showPanel(view: MirrorPanelView | null): void;
  prompt(text: string): void;
  warn(msg: string): void;
  refreshActive(): void;
  /** Prunes, repaints and banks the in sketch undo step. */
  afterModify(): void;
  armSelect(): void;
  newId(): string;
}

export const LINE_REFUSED = "Pick a line, arcs and circles cannot be a mirror line";
export const LINE_LEFT_OBJECTS = "That line is now the mirror line, it is no longer mirrored";

/** A line or a projected straight edge, as a mirror axis. */
export function axisOf(e: ResolvedEntity): MirrorAxis | null {
  if (e.type === "line") {
    const label = e.construction ? "Construction line" : "Line";
    return { a: { x: e.x1, y: e.y1 }, b: { x: e.x2, y: e.y2 }, label };
  }
  if (e.type === "projected" && e.curve.kind === "line") {
    const c = e.curve;
    return { a: { x: c.x1, y: c.y1 }, b: { x: c.x2, y: c.y2 }, label: "Projected edge" };
  }
  return null;
}

// An origin axis has no entity, so it is drawn as a long line through the origin.
const AXIS_HALF = 5000;

function originAxisAt(p: THREE.Vector2, tol: number): { id: string; axis: MirrorAxis } | null {
  const dx = Math.abs(p.y);
  const dy = Math.abs(p.x);
  if (Math.min(dx, dy) > tol) return null;
  return dx <= dy
    ? { id: "origin-x", axis: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, label: "X axis" } }
    : { id: "origin-y", axis: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 }, label: "Y axis" } };
}

function axisEntity(id: string, ax: MirrorAxis): ResolvedEntity {
  const len = Math.hypot(ax.b.x - ax.a.x, ax.b.y - ax.a.y) || 1;
  const ux = ((ax.b.x - ax.a.x) / len) * AXIS_HALF;
  const uy = ((ax.b.y - ax.a.y) / len) * AXIS_HALF;
  return { type: "line", id, x1: ax.a.x - ux, y1: ax.a.y - uy, x2: ax.a.x + ux, y2: ax.a.y + uy } as ResolvedEntity;
}

let nextPanelId = 1;

export class MirrorFlow {
  private fields: MirrorFields<MirrorAxis> | null = null;
  private pre: string[] = [];
  private hovered: ResolvedEntity | null = null;
  private panelId = 0;
  private refusal: string | null = null;

  constructor(private host: MirrorHost) {}

  get running(): boolean {
    return this.fields !== null;
  }

  get ready(): boolean {
    return !!this.fields && isReady(this.fields);
  }

  /** What is selected fills Objects; projected geometry stays out, it is a fixed reference. */
  begin(): void {
    const sel = this.host.selected();
    const projected = [...sel].filter((id) => this.entity(id)?.type === "projected");
    if (projected.length) {
      this.host.warn(PROJECTED_FIXED_MSG);
      for (const id of projected) sel.delete(id);
    }
    this.pre = this.host
      .entities()
      .filter((e) => sel.has(e.id))
      .map((e) => e.id);
    this.fields = startFields<MirrorAxis>(this.pre);
    this.panelId = nextPanelId++;
    this.hovered = null;
    this.refusal = null;
    this.update();
  }

  /** Drops the run without applying it or touching the selection. */
  reset(): void {
    if (!this.fields) return;
    this.fields = null;
    this.hovered = null;
    this.host.showPreview({ copies: [], objects: [], line: null, hover: null, hoverField: "objects" });
    this.host.showPanel(null);
  }

  /** `keep` is Shift or Ctrl: an object pick whichever field is active. */
  click(p: THREE.Vector2, keep: boolean): void {
    const f = this.fields;
    if (!f) return;
    this.refusal = null;
    if (f.active === "line" && !keep) {
      const hit = this.hitAt(p);
      const axis = hit ? axisOf(hit) : null;
      const origin = axis ? null : originAxisAt(p, this.host.pickTol());
      if (axis && hit) {
        const left = f.objects.includes(hit.id);
        this.set(pickLine(f, axis, hit.id));
        if (left) this.refusal = LINE_LEFT_OBJECTS;
      } else if (origin) {
        this.set(pickLine(f, origin.axis, null));
      } else if (hit) {
        this.refusal = LINE_REFUSED;
      }
      this.update();
      return;
    }
    const hit = this.hitAt(p);
    if (hit?.type === "projected") {
      this.host.warn(PROJECTED_FIXED_MSG);
      return;
    }
    if (hit) {
      this.set(pickObject(f, hit.id));
      return;
    }
    const loop = this.host.loopIdsAt(p).filter((id) => this.entity(id)?.type !== "projected");
    if (loop.length) this.set(addObjects(f, loop));
  }

  hover(p: THREE.Vector2 | null): void {
    const f = this.fields;
    if (!f) return;
    const hit = p ? this.hitAt(p) : undefined;
    let next: ResolvedEntity | null = null;
    if (f.active === "line") {
      const origin = p && !(hit && axisOf(hit)) ? originAxisAt(p, this.host.pickTol()) : null;
      next = hit && axisOf(hit) ? hit : origin ? axisEntity(origin.id, origin.axis) : null;
    } else if (hit && hit.type !== "projected") next = hit;
    if ((next?.id ?? null) === (this.hovered?.id ?? null)) return;
    this.hovered = next;
    this.drawPreview();
  }

  /** Enter: on to the empty field, or apply once both hold something. */
  enter(): void {
    const f = this.fields;
    if (!f) return;
    const step = enterStep(f);
    if (step === "commit") this.commit();
    else this.set(step);
  }

  /** False, with nothing changed, until both fields hold something. */
  commit(): boolean {
    const f = this.fields;
    if (!f || !f.line) return false;
    const copies = mirrorCopies(this.host.entities(), new Set(f.objects), { id: f.lineId, ...f.line }, () =>
      this.host.newId(),
    );
    if (!copies.length) return false;
    this.reset();
    this.host.entities().push(...copies);
    this.host.selected().clear();
    this.host.afterModify();
    this.host.armSelect();
    return true;
  }

  /** The selection from before the start comes back. */
  cancel(): void {
    if (!this.fields) return;
    this.reset();
    this.host.armSelect();
    const sel = this.host.selected();
    sel.clear();
    for (const id of this.pre) sel.add(id);
    this.host.refreshActive();
  }

  activate(k: MirrorFieldKey): void {
    if (this.fields) this.set(activate(this.fields, k));
  }

  clear(k: MirrorFieldKey): void {
    if (this.fields) this.set(clearField(this.fields, k));
  }

  switchField(): void {
    if (this.fields) this.set(switchField(this.fields));
  }

  private set(f: MirrorFields<MirrorAxis>): void {
    this.fields = f;
    this.refusal = null;
    const sel = this.host.selected();
    sel.clear();
    for (const id of f.objects) sel.add(id);
    this.host.refreshActive();
    this.update();
  }

  private hitAt(p: THREE.Vector2): ResolvedEntity | undefined {
    const ents = this.host.entities();
    const idx = pickEntity(ents, p, this.host.pickTol());
    return idx >= 0 ? ents[idx] : (this.host.textAt(p) ?? undefined);
  }

  private entity(id: string | null): ResolvedEntity | undefined {
    return id === null ? undefined : this.host.entities().find((e) => e.id === id);
  }

  private drawPreview(): void {
    const f = this.fields;
    if (!f) return;
    const ents = this.host.entities();
    const copies = f.line
      ? mirrorCopies(ents, new Set(f.objects), { id: f.lineId, ...f.line }, () => "mirror-preview")
      : [];
    const line = f.line
      ? (this.entity(f.lineId) ?? axisEntity(`origin-${f.line.label[0]!.toLowerCase()}`, f.line))
      : null;
    this.host.showPreview({
      copies,
      objects: ents.filter((e) => f.objects.includes(e.id)),
      line,
      hover: this.hovered,
      hoverField: f.active,
    });
  }

  private update(): void {
    const f = this.fields;
    if (!f) return;
    this.drawPreview();
    const objects = countLabel(f.objects.length, "object", "objects");
    const next = nextPick(f, "line");
    this.host.prompt(`${this.refusal ? `${this.refusal} · ` : ""}${next} · ${objects} · Esc to cancel`);
    this.host.showPanel({
      id: this.panelId,
      fields: [
        { key: "objects", label: "Objects", icon: "select-all", value: objects, filled: f.objects.length > 0 },
        {
          key: "line",
          label: "Mirror line",
          icon: "line",
          value: f.line?.label ?? "Nothing picked",
          filled: f.line !== null,
        },
      ],
      active: f.active,
      planes: [],
      plane: null,
      ready: isReady(f),
      onActivate: (k) => this.activate(k),
      onClear: (k) => this.clear(k),
      onPlane: () => {},
      onCommit: () => void this.commit(),
      onCancel: () => this.cancel(),
    });
  }
}
