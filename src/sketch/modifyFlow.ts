// The sketch modify and transform tools: trim, extend, break, fillet, chamfer,
// offset, and the selection transforms (move, copy, rotate, scale).
//
// Split out of sketchMode.ts, following the ConstraintTools / PatternFlow /
// DimFlow / ProjectFlow precedent: ModifyHost below is a set of live accessors
// into SketchMode, never a copy. The entity list is the one thing here that is
// REPLACED rather than mutated (every op in ./modify returns a fresh array), so
// the host carries a setter for it as well as a reader, an accessor alone
// would have let a stale array survive a solve.
//
// The three pieces of in-progress state, the first line of a fillet/chamfer
// pair, the base point of a move, and the offset's live pick, moved out of
// SketchMode entirely and are this collaborator's own. They are cleared
// together by reset(), which is what Escape, a tool change and an undo all
// call; leaving any one of them set across those is how a modify tool ends up
// acting on geometry that is no longer there.

import * as THREE from "three";
import type { SketchConstraint } from "../types";
import type { SketchPlane } from "./plane";
import type { SketchOverlay } from "./overlay";
import { curveObjects, PREVIEW_COLOR } from "./overlay";
import type { DimInput } from "./dimInput";
import type { SketchTool } from "./sketchMode";
import type { ResolvedEntity } from "./snap";
import {
  pickEntity, trimEntity, filletCorner, chamferCorner, offsetEntity, offsetChain,
  signedOffsetAt, breakAt, extendLine, breakLink, PROJECTED_FIXED_MSG,
  type OffsetResult,
} from "./modify";
import { newEntityId } from "./id";
import { translated, rotated, scaled } from "./pattern";
import type { PlaneEdge } from "./faceFootprint";
import { pickPlaneEdge, planeEdgeChain } from "./planeEdgePick";
import { contextMenu } from "../ui/menu";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";

/** The slice of SketchMode these tools read/write, live accessors, not copies. */
export interface ModifyHost {
  /** live entity list */
  entities(): ResolvedEntity[];
  /** every modify op returns a NEW array; this is how it lands */
  setEntities(list: ResolvedEntity[]): void;
  /** live selection (entity ids) */
  selected(): Set<string>;
  setSelected(ids: Set<string>): void;
  /** the shared on-canvas value box (a fillet radius, a rotate angle…) */
  dim(): DimInput;
  overlay(): SketchOverlay;
  plane(): SketchPlane;
  tool(): SketchTool;
  /** pick radius in sketch mm at the current zoom */
  pickTol(): number;
  planePoint(e: MouseEvent): THREE.Vector2 | null;
  /** the shared tail every modify op ends on: prune, re-solve, repaint, bank */
  afterModify(): void;
  /** promote a measured dimension to a driving one, the offset distance */
  setDrivingDimension(c: SketchConstraint): void;
  /** exact model edges lying in the sketch plane, the ones offset may take */
  planeEdges(): readonly PlaneEdge<ModelEdge>[];
  /** land these model edges as projected entities, see ProjectFlow.projectModelEdges */
  projectModelEdges(edges: readonly ModelEdge[]): Promise<{ ids: string[][]; added: string[] } | null>;
  /** draw these model edges emphasised over the model; [] clears */
  emphasiseModelEdges(edges: readonly ModelEdge[]): void;
}

export interface ModelEdge {
  readonly body: string;
  readonly points: readonly (readonly [number, number, number])[];
}

/** Projected geometry offsets like the native curve it stands for. The ids are
 *  kept, so the offset constraint's pairs name the projected source and the copy
 *  follows the model when the projection refreshes. */
function offsetable(ents: ResolvedEntity[]): ResolvedEntity[] {
  const ids = new Set(ents.filter((e) => e.type === "projected").map((e) => e.id));
  return ids.size ? breakLink(ents, ids) : ents;
}

/** Model edge ends closer than this (mm) are one vertex. */
const EDGE_JOIN_TOL = 1e-3;

export class ModifyFlow {
  /** first line picked for a sketch fillet or chamfer */
  private filletFirst: number | null = null;
  /** Move/Copy's base point, set by the first of the two clicks */
  private moveBase: THREE.Vector2 | null = null;

  constructor(private readonly host: ModifyHost) {}

  /** is a fillet/chamfer waiting for its second line? */
  get filletArmed(): boolean { return this.filletFirst != null; }
  /** is an offset mid-placement? it owns the preview and the Escape stack */
  get offsetting(): boolean { return this.offsetPick != null; }
  /** the armed line's index, for the hover preview and the constraint tools */
  getFilletFirst(): number | null { return this.filletFirst; }
  setFilletFirst(v: number | null) { this.filletFirst = v; }

  /** drop every half-finished gesture: a tool change, Escape and undo all land
   *  here, and any one of these left set would act on geometry that has moved */
  reset() {
    this.filletFirst = null;
    this.moveBase = null;
    this.dropAutoProjected();
    this.offsetPick = null;
    this.emphasise([]);
  }

  /** hover-highlight the entity under the cursor in red */
  modifyHover(e: PointerEvent) {
    // An offset being placed owns the preview: this is the MODIFY_TOOLS hover
    // branch and it runs on every move, so without this it would overwrite the
    // offset's live preview with a plain hover highlight one frame later.
    this.lastMove = e;
    if (this.offsetPick) { this.offsetMove(e); return; }
    const p = this.host.planePoint(e);
    if (!p) return;
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    const preview: THREE.Object3D[] = [];
    const first = this.filletFirst != null ? this.host.entities()[this.filletFirst] : undefined;
    if (first) preview.push(...curveObjects([first], this.host.plane(), 0x33aaff, true));
    const hit = idx >= 0 ? this.host.entities()[idx] : undefined;
    if (hit) preview.push(...curveObjects([hit], this.host.plane(), 0xff5555, true));
    if (!this.edgePickPending) this.emphasise(!hit && this.host.tool() === "offset" ? this.modelEdgeChainAt(p) : []);
    this.host.overlay().setPreview(preview);
  }

  private emphasised = "";
  /** Light up these in-plane model edges. A sketch overlay line cannot do it: the
   *  edge lies exactly in the plane and the model's own wider line covers it. */
  private emphasise(chain: readonly number[]) {
    const key = chain.join(",");
    if (key === this.emphasised) return;
    this.emphasised = key;
    const all = this.host.planeEdges();
    this.host.emphasiseModelEdges(chain.map((k) => all[k]!.edge));
  }

  /** The model edges a click at `p` would offset: the edge under it, with its
   *  whole loop when Chain Selection is on. */
  private modelEdgeChainAt(p: THREE.Vector2): number[] {
    const polys = this.host.planeEdges().map((x) => x.poly);
    const k = pickPlaneEdge(polys, p, this.host.pickTol());
    if (k < 0) return [];
    return this.offsetChainMode ? planeEdgeChain(polys, k, EDGE_JOIN_TOL) : [k];
  }

  /** Fusion's in-command marking menu for the Offset tool: the two things the
   *  cursor alone can't say, whether to take the whole connected chain, and
   *  which side to land on when the cursor is nowhere near the curve. */
  openOffsetMenu(e: MouseEvent) {
    e.preventDefault();
    const pick = this.offsetPick;
    contextMenu(e.clientX, e.clientY, [
      {
        label: "Chain Selection", checked: this.offsetChainMode,
        onClick: () => {
          this.offsetChainMode = !this.offsetChainMode;
          setPrompt(this.offsetChainMode
            ? "Chain Selection on, the whole connected profile offsets as a unit"
            : "Chain Selection off, only the clicked curve offsets");
        },
      },
      {
        label: "Flip", disabled: !pick,
        onClick: () => { if (pick) pick.side = -pick.side; },
      },
      { separator: true, label: "" },
      { label: "OK", disabled: !pick, onClick: () => { if (pick) this.commitOffset(); } },
      { label: "Cancel", disabled: !pick, onClick: () => this.cancelOffset() },
    ]);
  }

  /** Break Link (context menu): the selected projected entities become native
   *  geometry with the SAME ids, attached constraints/dims stay valid, the
   *  geometry unfreezes, and the associative refresh skips them from now on
   *  (they are no longer type "projected"). Breaking one member of a
   *  multi-curve group (a face boundary's siblings) breaks only that member,
   *  the others stay linked (Fusion behavior). */
  breakSelectedLinks() {
    const ids = this.selectedProjectedIds();
    if (!ids.size) return;
    this.host.setEntities(breakLink(this.host.entities(), ids));
    this.host.afterModify(); // selection stays: the entities still exist, now native
  }
  trimClick(p: THREE.Vector2) {
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (idx < 0 || this.guardProjected(this.host.entities()[idx])) return;
    this.host.setEntities(trimEntity(this.host.entities(), idx, p));
    this.host.afterModify();
  }
  filletClick(p: THREE.Vector2) {
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (this.guardProjected(idx >= 0 ? this.host.entities()[idx] : undefined)) return;
    if (idx < 0 || this.host.entities()[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.host.dim().show([{ name: "radius", label: "R", kind: "length", positive: true }], () =>
      this.applyFillet(first, second),
    );
  }
  private applyFillet(iA: number, iB: number) {
    const r = this.host.dim().getValue("radius") ?? 2;
    const res = filletCorner(this.host.entities(), iA, iB, r);
    if (res) this.host.setEntities(res);
    this.filletFirst = null;
    this.host.dim().hide();
    this.host.afterModify();
  }
  chamferClick(p: THREE.Vector2) {
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (this.guardProjected(idx >= 0 ? this.host.entities()[idx] : undefined)) return;
    if (idx < 0 || this.host.entities()[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.host.dim().show([{ name: "distance", label: "D", kind: "length", positive: true }], () =>
      this.applyChamfer(first, second),
    );
  }
  private applyChamfer(iA: number, iB: number) {
    const d = this.host.dim().getValue("distance") ?? 2;
    const res = chamferCorner(this.host.entities(), iA, iB, d);
    if (res) this.host.setEntities(res);
    this.filletFirst = null;
    this.host.dim().hide();
    this.host.afterModify();
  }

  /** Projected geometry is FIXED reference geometry: every modify/transform seam
   *  calls this and bails with one consistent toast. Delete stays allowed. */
  guardProjected(e: ResolvedEntity | undefined): boolean {
    if (e?.type !== "projected") return false;
    toast(PROJECTED_FIXED_MSG);
    return true;
  }

  /** ids of the currently-selected projected (linked reference) entities. */
  selectedProjectedIds(): Set<string> {
    return new Set(
      this.host.entities().filter((e) => e.type === "projected" && this.host.selected().has(e.id)).map((e) => e.id),
    );
  }

  /** The selected projected (linked reference) ids, toasting PROJECTED_FIXED_MSG
   *  once when any exist, the shared seam for tools that transform the
   *  selection. Each caller keeps its own retention semantics (deselect /
   *  keep-selected / skip from copies). */
  warnSelectedProjected(): Set<string> {
    const ids = this.selectedProjectedIds();
    if (ids.size) toast(PROJECTED_FIXED_MSG);
    return ids;
  }

  /** replace each selected entity with map(e) (flattened); others unchanged. Owns
   *  the selection: it re-selects the transform's output, so a rotate that explodes
   *  a rectangle into fresh-id lines leaves those lines selected (not a stale id). */
  private transformSelection(map: (e: ResolvedEntity) => ResolvedEntity[]) {
    const next: ResolvedEntity[] = [];
    const sel = new Set<string>();
    // fixed reference geometry: keep it (and its selection) untouched
    const projected = this.warnSelectedProjected();
    for (const e of this.host.entities()) {
      if (this.host.selected().has(e.id) && !projected.has(e.id)) {
        for (const m of map(e)) { next.push(m); sel.add(m.id); }
      } else {
        next.push(e);
        if (projected.has(e.id)) sel.add(e.id);
      }
    }
    this.host.setEntities(next);
    this.host.setSelected(sel);
    this.host.afterModify();
  }

  /** The gizmo's commit: each selected entity through `map`, in place or, with
   *  `copy`, as new entities beside the originals, which end up selected. */
  applyTransform(map: (e: ResolvedEntity, id: string) => ResolvedEntity[], copy: boolean) {
    if (!copy) {
      this.transformSelection((e) => this.reid(map(e, e.id)));
      return;
    }
    const projected = this.warnSelectedProjected();
    const copies: ResolvedEntity[] = [];
    for (const e of this.host.entities()) {
      if (!this.host.selected().has(e.id) || projected.has(e.id)) continue;
      const out = map(e, newEntityId());
      copies.push(...(out.length === 1 ? out : out.map((x) => ({ ...x, id: newEntityId() }))));
    }
    this.host.setEntities([...this.host.entities(), ...copies]);
    this.host.setSelected(new Set(copies.map((c) => c.id)));
    this.host.afterModify();
  }

  /** keep the id for a single-entity result; give an exploded result (a rotated
   *  rectangle → 4 lines) fresh ids so nothing collides. */
  private reid(rot: ResolvedEntity[]): ResolvedEntity[] {
    return rot.length === 1 ? rot : rot.map((r) => ({ ...r, id: newEntityId() }));
  }

  /** Move/Copy: click a base point, then a destination, translate the whole
   *  selection. Move mutates in place; Copy leaves the originals and selects the copies. */
  moveClick(p: THREE.Vector2) {
    if (!this.host.selected().size) { toast("Select entities first, then Move/Copy"); return; }
    if (!this.moveBase) { this.moveBase = p.clone(); toast("Click the destination point"); return; }
    const dx = p.x - this.moveBase.x, dy = p.y - this.moveBase.y;
    this.moveBase = null;
    if (this.host.tool() === "copy") {
      const copies: ResolvedEntity[] = [];
      const sel = new Set<string>();
      const projected = this.warnSelectedProjected(); // linked, can't clone the link
      for (const e of this.host.entities()) {
        if (!this.host.selected().has(e.id) || projected.has(e.id)) continue;
        const id = newEntityId();
        copies.push(translated(e, dx, dy, id));
        sel.add(id);
      }
      this.host.setEntities([...this.host.entities(), ...copies]);
      this.host.setSelected(sel); // leave the copies selected (Fusion-style)
      this.host.afterModify();
    } else {
      this.transformSelection((e) => [translated(e, dx, dy, e.id)]);
    }
  }

  /** Rotate the selection about a clicked center by a typed angle (degrees). */
  rotateClick(p: THREE.Vector2) {
    if (!this.host.selected().size) { toast("Select entities first, then Rotate"); return; }
    const cx = p.x, cy = p.y;
    this.host.dim().show([{ name: "angle", label: "Angle", icon: "angle", kind: "angle" }], () => {
      const ang = ((this.host.dim().getValue("angle") ?? 0) * Math.PI) / 180;
      this.host.dim().hide();
      this.transformSelection((e) => this.reid(rotated(e, cx, cy, ang, e.id)));
    });
    toast("Rotate: type an angle in degrees");
  }

  /** Scale the selection about a clicked base point by a typed factor. */
  scaleClick(p: THREE.Vector2) {
    if (!this.host.selected().size) { toast("Select entities first, then Scale"); return; }
    const cx = p.x, cy = p.y;
    this.host.dim().show([{ name: "factor", label: "Factor", icon: "scale", kind: "count", positive: true }], () => {
      const f = this.host.dim().getValue("factor") ?? 1;
      this.host.dim().hide();
      if (f > 0) this.transformSelection((e) => [scaled(e, cx, cy, f, e.id)]);
    });
    toast("Scale: type a factor (e.g. 2 or 0.5)");
  }
  /** Offset (Fusion parity), two-phase: click a curve, then move the cursor to
   *  choose the SIDE and distance, or type one, and click again (or Enter) to
   *  apply. `side` and `mag` are kept apart on purpose: the box displays the
   *  magnitude, so folding them into one signed number is how typing a value
   *  silently flips an inward offset outward (the abs-display trap). */
  /** `added` holds the projected entities a face-edge pick brought in, which
   *  leave again if the offset is cancelled. */
  private offsetPick: { idx: number; side: number; mag: number; added: string[] } | null = null;
  /** Fusion's in-command "Chain Selection" toggle, default ON: offset the whole
   *  connected chain rather than only the clicked curve. */
  private offsetChainMode = true;
  /** a face-edge pick waiting on the engine */
  private edgePickPending = false;
  private lastMove: PointerEvent | null = null;

  offsetClick(p: THREE.Vector2) {
    if (this.offsetPick) { this.commitOffset(); return; } // second click applies
    if (this.edgePickPending) return;
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (idx < 0) {
      const chain = this.modelEdgeChainAt(p);
      if (chain.length) void this.offsetModelEdges(chain);
      return;
    }
    const e = this.host.entities()[idx];
    if (!e) return;
    // Nothing may end in silence here: the user is mid-gesture, and a tool that
    // does nothing without saying why reads as broken.
    if (e.type === "text") { toast("Offset doesn't apply to sketch text"); return; }
    if (e.type === "point") { toast("Offset needs a curve, not a point"); return; }
    this.beginOffset(idx, []);
  }

  private beginOffset(idx: number, added: string[]) {
    this.offsetPick = { idx, side: 1, mag: 0, added };
    this.host.dim().show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.commitOffset(),
      () => this.cancelOffset(),
    );
    setPrompt("Move to pick the side, or type a distance · Enter · Esc");
  }

  /** A face edge clicked straight off the model: project it (and its loop) in,
   *  then carry on exactly as if a projected curve had been clicked. The
   *  clicked edge is chain[0]. */
  private async offsetModelEdges(chain: number[]) {
    const all = this.host.planeEdges();
    const edges = chain.map((k) => all[k]!.edge);
    this.edgePickPending = true;
    setPrompt("Reading the face edge…");
    let landed;
    try {
      landed = await this.host.projectModelEdges(edges);
    } finally {
      this.edgePickPending = false;
    }
    const stillHere = this.host.tool() === "offset" && !this.offsetPick;
    const first = landed?.ids[0]?.[0];
    const idx = first ? this.host.entities().findIndex((x) => x.id === first) : -1;
    if (!landed || !stillHere || idx < 0) {
      if (landed) this.removeEntities(landed.added);
      this.emphasise([]);
      if (stillHere) setPrompt("Offset: click a curve or a face edge to offset");
      return;
    }
    this.beginOffset(idx, landed.added);
    if (this.lastMove) this.offsetMove(this.lastMove);
  }

  private removeEntities(ids: readonly string[]) {
    if (!ids.length) return;
    const gone = new Set(ids);
    this.host.setEntities(this.host.entities().filter((x) => !gone.has(x.id)));
  }

  private dropAutoProjected() {
    if (this.offsetPick) this.removeEntities(this.offsetPick.added);
  }

  /** The offset result for the current pick, honouring Chain Selection. Chain
   *  first (a connected profile offsets as a unit), falling back to the single
   *  curve, which is also what a lone curve or a junction lands on. */
  private offsetResultFor(idx: number, dist: number): OffsetResult | null {
    if (Math.abs(dist) < 1e-6) return null;
    const ents = this.host.entities();
    const work = offsetable(ents);
    const res = (this.offsetChainMode ? offsetChain(work, idx, dist) : null) ?? offsetEntity(work, idx, dist);
    return res && { ...res, entities: [...ents, ...res.entities.slice(work.length)] };
  }

  /** Live side/distance + preview while the offset is being placed. */
  private offsetMove(ev: PointerEvent) {
    const pick = this.offsetPick;
    const p = this.host.planePoint(ev);
    const src = pick ? this.host.entities()[pick.idx] : undefined;
    if (!pick || !src || !p) return;
    const signed = signedOffsetAt(offsetable([src])[0]!, p);
    const typed = this.host.dim().isUserDriven("offset") ? this.host.dim().getValue("offset") : null;
    if (typed !== null) {
      // Once a value is typed, the SIGN the user wrote owns the side, that is
      // what the minus is FOR, and the old tool worked that way. Previously the
      // cursor always took precedence, so typing -1 silently offset outward and the minus
      // looked ignored. Clear the field to hand the side back to the cursor.
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    } else if (signed !== null) {
      if (Math.abs(signed) > 1e-6) pick.side = signed < 0 ? -1 : 1;
      pick.mag = Math.abs(signed);
      this.host.dim().updateFromCursor({ offset: pick.mag });
    }
    this.host.dim().position(ev.clientX, ev.clientY);
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    const added = res ? res.entities.slice(this.host.entities().length) : [];
    // keep the source highlighted so it stays obvious what is being offset
    const preview = [...curveObjects([src], this.host.plane(), 0x33aaff, true)];
    if (added.length) preview.push(...curveObjects(added, this.host.plane(), PREVIEW_COLOR, true));
    this.host.overlay().setPreview(preview);
  }

  private commitOffset() {
    const pick = this.offsetPick;
    if (!pick) return;
    // An empty box CANCELS. It used to fall back to `?? 1`, so pressing Enter on
    // an untouched field silently produced a 1 mm offset nobody asked for.
    if (this.host.dim().isUserDriven("offset")) {
      const typed = this.host.dim().getValue("offset");
      if (typed === null) { toast("Offset: type a distance, or Esc to cancel"); return; }
      // same rule as the live preview: a typed sign is the side (see offsetMove)
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    }
    if (pick.mag < 1e-6) { toast("Offset: type a distance, or Esc to cancel"); return; }
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    if (!res) {
      toast("Offset: that distance collapses the geometry");
      this.cancelOffset();
      return;
    }
    this.offsetPick = null;
    this.emphasise([]);
    this.host.dim().hide();
    this.host.setEntities(res.entities);
    if (res.linked && res.pairs.length) {
      // the associative link + its single editable dimension
      this.host.setDrivingDimension({ type: "offset", pairs: res.pairs, value: pick.side * pick.mag });
    } else if (!res.linked) {
      toast("Offset copy created, not linked to the source (this shape type is rigid)");
    }
    this.host.afterModify();
  }

  cancelOffset() {
    const hadProjected = !!this.offsetPick?.added.length;
    this.dropAutoProjected();
    this.offsetPick = null;
    this.emphasise([]);
    this.host.dim().hide();
    if (hadProjected) this.host.afterModify();
    else this.host.overlay().setPreview([]);
    setPrompt("Offset: click a curve or a face edge to offset");
  }
  extendClick(p: THREE.Vector2) {
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (idx < 0 || this.guardProjected(this.host.entities()[idx])) return;
    const res = extendLine(this.host.entities(), idx, p);
    if (res) this.host.setEntities(res);
    this.host.afterModify();
  }
  breakClick(p: THREE.Vector2) {
    const idx = pickEntity(this.host.entities(), p, this.host.pickTol());
    if (idx < 0 || this.guardProjected(this.host.entities()[idx])) return;
    this.host.setEntities(breakAt(this.host.entities(), idx, p));
    this.host.afterModify();
  }
}
