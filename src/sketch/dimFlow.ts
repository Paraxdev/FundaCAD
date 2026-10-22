// The dimension tool's click flow: pick up to two operands, place the label, type the value, commit.
// The dimension type is a property of the pick pair (resolveDim); the tool re-arms after every commit.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaceOffset, SketchConstraint } from "../types";
import type { SketchPlane } from "./plane";
import type { SketchOverlay } from "./overlay";
import { curveObjects, dimensionLineObjects, PREVIEW_COLOR } from "./overlay";
import type { DimInput } from "./dimInput";
import { constraintDims, linearDim } from "./entityDims";
import {
  clampPlace,
  isDimError,
  isRoundTarget,
  pickDimTarget,
  rebindTarget,
  resolveDim,
  targetIdentity,
  targetKey,
  unsupportedMessage,
  type DimOptions,
  type DimPlan,
  type DimTarget,
} from "./dimensionTool";
import { isDimConstraint, newEntityId } from "./id";
import { existingFixedPoint, originCandidate, pinOriginPoint } from "./snap";
import type { FieldKind } from "../document/numFields";
import type { ResolvedEntity } from "./snap";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";

/** The slice of SketchMode this flow reads/writes, live accessors, not copies. */
export interface DimHost {
  /** live entity list; every solve replaces the objects in it */
  entities(): ResolvedEntity[];
  /** live constraint list, the implied parallel/concentric are pushed onto it */
  constraints(): SketchConstraint[];
  dim(): DimInput;
  overlay(): SketchOverlay;
  viewport(): Viewport;
  plane(): SketchPlane;
  /** scratch the hover writes the cursor into, shared with the rest of the mode */
  lastCursor(): THREE.Vector2;
  /** a driven dimension must not move geometry, so the Reference toggle also suppresses the implied constraints */
  referenceMode(): boolean;
  /** pick radius in sketch mm at the current zoom */
  pickTol(): number;
  planeMmPerPx(): number;
  planePoint(e: MouseEvent): THREE.Vector2 | null;
  textEntityAt(p: THREE.Vector2): Extract<ResolvedEntity, { type: "text" }> | null;
  /** the label inline editor's evaluator, so `w/2` and `name=expr` work in the value box too */
  evalDimInput(
    raw: string,
    kind: FieldKind,
    key: string | null,
  ): { value: number; expr: string | null; name?: string } | { error: string };
  recordBinding(key: string, r: { value: number; expr: string | null; name?: string }, kind: FieldKind): void;
  /** stamps driven from the Reference toggle or the plan, pushes the constraint and solves */
  placeDim(c: SketchConstraint, forceDriven?: boolean): SketchConstraint;
  onState(): void;
}

export class DimFlow {
  // `dimPlace` is frozen by the placement click.
  private dimPicks: DimTarget[] = [];
  private dimPlan: DimPlan | null = null;
  private dimPlace: PlaceOffset | null = null;
  // the click-to-place has happened. NOT the same as `dimPlace != null`, which
  // is null for the dims that render through entityDims and have no place slot.
  private dimPlaced = false;
  // where the value box currently sits (client px), so it only steps aside when
  // the cursor is genuinely about to land on it, and never once placed
  private dimBoxAt: { x: number; y: number } | null = null;
  private dimFieldKey = ""; // field set the open box was built for
  // Kind, field set and picks: a rect edge LENGTH and a circle to edge DISTANCE share `distance:length`,
  // so the field key alone would carry a typed value across a plan change.
  private dimPlanKey = "";
  // `dimTangentArmed` arms only the NEXT circle or arc pick; `dimRoundPref` (radius vs diameter for a lone round)
  // lasts for the whole in-progress dim.
  private dimTangentArmed = false;
  private dimRoundPref: "radius" | "diameter" | undefined;
  private dimReflex = false;
  // the cursor's offset from the plan's label anchor on the last hover, it picks the
  // mode (aligned, horizontal, vertical, the angle's wedge) until the label is placed
  private dimCursor: PlaceOffset | undefined;

  constructor(private host: DimHost) {}

  /** is a dimension part-way through being made? */
  get picking(): boolean {
    return this.dimPicks.length > 0;
  }
  get pickCount(): number {
    return this.dimPicks.length;
  }
  /** the resolved plan, or null when the picks so far describe no dimension */
  get plan(): DimPlan | null {
    return this.dimPlan;
  }
  /** a single round operand, the case the right-click menu offers overrides for */
  get loneRound(): boolean {
    const first = this.dimPicks[0];
    return this.dimPicks.length === 1 && first !== undefined && isRoundTarget(first);
  }
  get tangentArmed(): boolean {
    return this.dimTangentArmed;
  }
  /** toggle Pick Circle/Arc Tangent; returns the new state for the prompt */
  toggleTangent(): boolean {
    this.dimTangentArmed = !this.dimTangentArmed;
    return this.dimTangentArmed;
  }
  /** measure the outside of the angle's wedge; returns the new state for the prompt */
  toggleReflex(): boolean {
    this.dimReflex = !this.dimReflex;
    this.refreshDimPlan();
    return this.dimReflex;
  }
  get reflex(): boolean {
    return this.dimReflex;
  }
  /** the offset that picks the plan's mode: the frozen label, else the last hover */
  private modeOffset(): PlaceOffset | undefined {
    return this.dimPlace ?? this.dimCursor;
  }
  setRoundPref(pref: "radius" | "diameter") {
    this.dimRoundPref = pref;
  }

  /** Select tool entities become the operands on switching to this tool (Fusion: click the line, press D).
   *  Whole entities only; a rectangle names no single edge, so resolveDim refuses it and the tool starts empty. */
  seedDimPicks(ids: string[]) {
    if (ids.length > 2) return; // a dimension has at most two operands
    const picks: DimTarget[] = [];
    for (const id of ids) {
      const e = this.host.entities().find((x) => x.id === id);
      if (!e) return;
      picks.push({ kind: "entity", e });
    }
    const r = resolveDim(picks, this.dimOptions());
    if (isDimError(r)) {
      if (r.message) toast(r.message);
      return; // unusable selection: start clean rather than half-armed
    }
    this.dimPicks = picks;
    this.dimPlan = r;
    setPrompt(r.hint);
    this.syncDimBox();
  }

  /** Pre-sets the first-picked entity to the typed value before solving: planegcs meets a radial gap by moving both
   *  radii (60/50 asked for a 3mm wall gave 57.838/51.838), and this keeps the second circle's size.
   *  defer: the same for c2cDistance rim clearance, which also depends on the centre distance. */
  private seedFirstPicked(c: SketchConstraint, firstPicked: string | null) {
    if (c.type !== "radialGap" || !firstPicked) return;
    const byId = new Map(this.host.entities().map((e) => [e.id, e]));
    const inner = byId.get(c.inner),
      outer = byId.get(c.outer);
    if (!inner || inner.type !== "circle" || !outer || outer.type !== "circle") return;
    if (firstPicked === c.inner) {
      const r = outer.radius - c.value;
      if (r > 1e-6) inner.radius = r;
    } else if (firstPicked === c.outer) {
      const r = inner.radius + c.value;
      if (r > 1e-6) outer.radius = r;
    }
  }

  resetDimPicks() {
    this.dimPicks = [];
    this.dimPlan = null;
    this.dimPlace = null;
    this.dimPlaced = false;
    this.dimBoxAt = null;
    this.dimFieldKey = "";
    this.dimPlanKey = "";
    this.dimTangentArmed = false;
    this.dimRoundPref = undefined;
    this.dimReflex = false;
    this.dimCursor = undefined;
  }

  /** the right-click overrides the pair matrix reads */
  private dimOptions(): DimOptions {
    return {
      ...(this.dimRoundPref ? { roundPref: this.dimRoundPref } : {}),
      ...(this.dimReflex ? { reflex: true } : {}),
    };
  }

  /** Plan shape plus picks, rim or tangent mode included: a rim and a centre distance on one pair share a field set.
   *  Re-showing the box when this changes stops a value typed for one dimension committing as another. */
  private dimIdentity(plan: DimPlan): string {
    return `${plan.kind}:${plan.fieldKey}|${this.dimPicks.map(targetIdentity).join("+")}`;
  }

  /** Every solve replaces the entity objects, so held picks are re-read (rebindTarget) and vanished ones dropped.
   *  A dropped pick or changed plan must reach the box too, or the commit builds a constraint the user never saw. */
  refreshDimPlan() {
    const before = this.dimPicks.map(targetKey).join("+");
    this.dimPicks = this.dimPicks
      .map((t) => rebindTarget(t, this.host.entities()))
      .filter((t): t is DimTarget => t !== null);
    const r = resolveDim(this.dimPicks, this.dimOptions());
    this.dimPlan = isDimError(r) ? null : r;
    if (this.dimPicks.map(targetKey).join("+") !== before) {
      toast("The geometry this dimension referenced is gone, dimension cancelled");
      this.cancelDim();
      return;
    }
    // steady state: same picks, same plan → leave the box (and its focus /
    // anything half-typed) alone
    if (!this.dimPlan) {
      if (this.host.dim().isActive) {
        this.host.dim().hide();
        this.dimFieldKey = "";
        this.dimPlanKey = "";
      }
      return;
    }
    if (this.dimIdentity(this.dimPlan) !== this.dimPlanKey) this.syncDimBox();
  }

  /** The candidate is recomputed here, not read from hover: a synthetic pointerdown has no pointermove before it. */
  dimensionClick(p: THREE.Vector2, ev: PointerEvent) {
    const cand = this.pickOrigin(p) ?? pickDimTarget(this.host.entities(), p, this.host.pickTol());
    // Text has no entitySegments, so pickDimTarget never returns it; without this its message would be unreachable.
    if (!cand && !this.dimPlan && this.host.textEntityAt(p)) {
      toast(unsupportedMessage("text"));
      return;
    }
    const fresh = cand != null && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand));
    if (cand && fresh && this.dimPicks.length < 2) this.dimPick(this.commitOriginPick(cand), ev);
    else this.dimPlaceClick(p, ev);
  }

  /** Null off a plane that misses the world origin, the same gate as snap.ts originCandidate. */
  private originAnchorPos(): THREE.Vector2 | null {
    return originCandidate(this.host.plane())[0]?.p ?? null;
  }

  /** SK-4: the Origin wins within its hover radius, before the entity pick, as pickDimTarget prefers points over edges.
   *  Safe from hover: a missing origin point is previewed with a placeholder id that commitOriginPick() makes real. */
  private pickOrigin(p: THREE.Vector2): DimTarget | null {
    const pos = this.originAnchorPos();
    if (!pos || pos.distanceTo(p) > this.host.pickTol()) return null;
    const e: ResolvedEntity = existingFixedPoint(this.host.entities(), this.host.constraints(), pos) ?? {
      type: "point",
      id: "__origin__",
      x: pos.x,
      y: pos.y,
      construction: true,
    };
    return { kind: "point", e, p: 0, pos: pos.clone() };
  }

  /** On a real pick, turns the placeholder into a fixed construction point, so the dim is an ordinary p2pDistance or
   *  p2lDistance. Shares snap.ts pinOriginPoint, so a corner snapped to the Origin and this land on the SAME point. */
  private commitOriginPick(t: DimTarget): DimTarget {
    if (t.kind !== "point" || t.e.id !== "__origin__") return t;
    const point = pinOriginPoint(this.host.entities(), this.host.constraints(), t.pos, newEntityId);
    return { kind: "point", e: point, p: 0, pos: t.pos.clone() };
  }

  private dimPick(t: DimTarget, ev: PointerEvent) {
    const prev = this.dimPicks.slice();
    // Fusion's tangent arm: consumed by the first circle/arc that can use it,
    // and only by that one, a line/point pick leaves it armed for the next.
    const pick: DimTarget = this.dimTangentArmed && isRoundTarget(t) && t.kind !== "edge" ? { ...t, rim: true } : t;
    if (pick !== t) this.dimTangentArmed = false;
    this.dimPicks.push(pick);
    const r = resolveDim(this.dimPicks, this.dimOptions());
    if (isDimError(r)) {
      // Click only, never hover. A kept pick's message is the prompt: a toast per pick ate a later pick (FR-1).
      if (r.message) {
        if (r.keepPicks) setPrompt(r.message);
        else toast(r.message);
      }
      // a dead combination (concentric, coincident, same operand) drops the new
      // pick and keeps whatever already resolved, never a silent dead end
      if (!r.keepPicks) this.dimPicks = prev;
      this.refreshDimPlan();
    } else {
      this.dimPlan = r;
      setPrompt(r.hint);
    }
    this.dimPlace = null; // a new pick invalidates any earlier placement
    this.dimCursor = undefined;
    this.syncDimBox(ev);
  }

  /** Freezes the label position at the cursor without committing: only the value box commits. */
  private dimPlaceClick(p: THREE.Vector2, ev: PointerEvent) {
    if (!this.dimPlan) {
      // A lone pick plus a click on nothing is a missed second pick (common on a long distance): keep it and re-prompt.
      if (this.dimPicks.length) {
        const r = resolveDim(this.dimPicks, this.dimOptions());
        if (isDimError(r) && r.message) setPrompt(r.message);
      }
      return;
    }
    const anchor = this.dimPlan.labelAnchor();
    // distance and diameter render through entityDims and have no place slot, so dimPlace stays null for them
    this.dimPlace = anchor ? clampPlace(p.x - anchor.x, p.y - anchor.y, this.host.planeMmPerPx()) : null;
    this.dimPlaced = true;
    this.positionDimBox(ev);
    this.host.dim().setClickThrough(false); // confirm / cancel / the field are live from here on
    this.host.dim().focus(); // the canvas click blurred the input
  }

  /** DimInput.show() starts with hide(), which discards typed input, so re-show only when the dimension's identity
   *  changes, and say so when that throws input away. */
  private syncDimBox(ev?: PointerEvent) {
    const plan = this.dimPlan;
    if (!plan) {
      this.host.dim().hide();
      this.dimFieldKey = "";
      this.dimPlanKey = "";
      return;
    }
    const key = this.dimIdentity(plan);
    if (key !== this.dimPlanKey) {
      const prevField = this.dimFieldKey.split(":")[0] ?? "";
      const discarded = prevField !== "" && this.host.dim().isUserDriven(prevField);
      this.dimFieldKey = plan.fieldKey;
      this.dimPlanKey = key;
      this.host.dim().show(
        plan.fields.map((f) => ({ ...f, free: true })),
        () => this.commitDim(),
        () => this.cancelDim(),
      );
      if (discarded) toast("This is a different dimension now, retype the value");
    }
    this.host.dim().updateFromCursor({ [plan.field]: plan.measure(this.modeOffset()) });
    this.positionDimBox(ev);
    // Until placed, the box must not intercept the placing click, or it lands on confirm and commits the measurement.
    this.host.dim().setClickThrough(!this.dimPlaced);
    this.host.dim().focus();
  }

  /** The typed text goes through the label editor's evaluator, so `w/2` and `name=expr` work and a bad value is
   *  refused out loud. Only an EMPTY box accepts the measurement. */
  commitDim() {
    const plan = this.dimPlan;
    if (!plan) {
      this.cancelDim();
      return;
    }
    const kind: FieldKind = plan.kind === "angle" ? "angle" : "length";
    const raw = this.host.dim().getRaw(plan.field).trim();
    let value = plan.measure(this.modeOffset());
    let typed: { value: number; expr: string | null; name?: string } | null = null;
    if (raw !== "") {
      const r = this.host.evalDimInput(raw, kind, null);
      if ("error" in r) {
        toast(`Dimension not created, ${r.error}`);
        this.host.dim().focus(); // leave the box open on the bad value
        return;
      }
      value = r.value;
      typed = r;
    }
    const c = this.dimPlace ? plan.make(value, this.dimPlace) : plan.make(value, undefined, this.dimCursor);
    const forceDriven = plan.forceDriven === true;
    const firstPicked = this.dimPicks[0]?.e.id ?? null;
    this.host.dim().hide();
    const pair = plan.parallelPair;
    const conc = plan.implyConcentric;
    this.resetDimPicks();
    this.host.overlay().setPreview([]);
    // The parallelism a distance between parallel lines implies, added before the dim so one solve covers both,
    // and only for a driving dim (a reference dim must not move geometry).
    if (pair && !this.host.referenceMode() && !forceDriven) this.addParallelPair(pair.l1, pair.l2);
    // Likewise the concentricity a radial gap dim implies: `difference` ties only the radii (see types.ts).
    if (conc && !this.host.referenceMode() && !forceDriven) this.addConcentricPair(conc.c1, conc.c2);
    if (!this.host.referenceMode() && !forceDriven) this.seedFirstPicked(c, firstPicked);
    const placed = this.host.placeDim(c, forceDriven);
    // bind exactly as the label editor does: a formula binds, and a plain number
    // over a dim that WAS bound (the id carries over on replace) rewrites that
    // binding to the literal instead of leaving a stale expression behind
    if (typed && isDimConstraint(placed) && placed.id) this.host.recordBinding(`c:${placed.id}`, typed, kind);
    this.host.onState();
  }

  /** Skipped when redundant (both horizontal or vertical, a rectangle edge, an existing parallel or collinear),
   *  as a redundant constraint shows an amber over-constrained chip. */
  private addParallelPair(l1: string, l2: string) {
    const orient = (id: string): "h" | "v" | null => {
      const t = id.indexOf("~");
      if (t >= 0) {
        // rect edge: bottom/top are horizontal, right/left vertical
        const k = Number(id.slice(t + 1));
        return k === 0 || k === 2 ? "h" : k === 1 || k === 3 ? "v" : null;
      }
      for (const c of this.host.constraints()) {
        if (c.type === "horizontal" && c.line === id) return "h";
        if (c.type === "vertical" && c.line === id) return "v";
      }
      return null;
    };
    const o1 = orient(l1);
    if (o1 !== null && o1 === orient(l2)) return;
    const already = this.host
      .constraints()
      .some(
        (c) =>
          (c.type === "parallel" || c.type === "collinear") &&
          ((c.l1 === l1 && c.l2 === l2) || (c.l1 === l2 && c.l2 === l1)),
      );
    if (!already) this.host.constraints().push({ type: "parallel", l1, l2 });
  }

  /** Skipped when an existing concentric holds the pair, so a radial gap dim does not raise an amber chip. */
  private addConcentricPair(c1: string, c2: string) {
    const already = this.host
      .constraints()
      .some((c) => c.type === "concentric" && ((c.c1 === c1 && c.c2 === c2) || (c.c1 === c2 && c.c2 === c1)));
    if (!already) this.host.constraints().push({ type: "concentric", c1, c2 });
  }

  /** Esc / cancel: abandon the in-progress dimension, staying armed on the tool. */
  cancelDim() {
    this.host.dim().hide();
    this.resetDimPicks();
    this.host.overlay().setPreview([]);
    this.host.viewport().requestRender();
  }

  /** Parked once per dimension and left there: a box that fled the pointer made confirm unclickable. It is
   *  click-through until placed (DimInput.setClickThrough), so it need not dodge the placing click. */
  private positionDimBox(ev?: PointerEvent) {
    if (this.dimBoxAt) return; // already parked for this dimension
    const plan = this.dimPlan;
    const at = plan ? this.dimBoxAnchor(plan) : null;
    const s = at
      ? this.host.viewport().projectToScreen(this.host.plane().to3D(at.x, at.y))
      : ev
        ? { x: ev.clientX, y: ev.clientY }
        : null;
    if (!s) return;
    const rect = this.host.viewport().domElement.getBoundingClientRect();
    const boxW = 170,
      boxH = 46,
      m = 12,
      gap = 28;
    const cx = ev?.clientX ?? s.x + 1,
      cy = ev?.clientY ?? s.y + 1;
    const left = cx >= s.x ? s.x - gap - boxW : s.x + gap;
    const top = cy >= s.y ? s.y - gap - boxH : s.y + gap;
    const fx = Math.max(rect.left + m, Math.min(left, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(top, rect.bottom - boxH - m));
    this.dimBoxAt = { x: fx, y: fy };
    this.host.dim().position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  /** the plane point a plan's label hangs off: its own anchor, else the middle
   *  of its dimension line */
  private dimBoxAnchor(plan: DimPlan): THREE.Vector2 | null {
    const own = plan.labelAnchor();
    if (own) return own;
    const an = plan.anchors();
    return an ? an.a.clone().add(an.b).multiplyScalar(0.5) : null;
  }

  /** Dimension-tool hover: highlight what a click would pick (lit = picked,
   *  empty space = places), draw the live annotation, and track the value. */
  dimensionHover(e: PointerEvent) {
    const p = this.host.planePoint(e);
    if (!p) return;
    this.host.lastCursor().copy(p);
    const preview: THREE.Object3D[] = [];
    for (const t of this.dimPicks) preview.push(...this.dimTargetObjects(t, 0x33aaff));
    const cand =
      this.dimPicks.length < 2
        ? (this.pickOrigin(p) ?? pickDimTarget(this.host.entities(), p, this.host.pickTol()))
        : null;
    if (cand && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand))) {
      preview.push(...this.dimTargetObjects(cand, 0xff5555));
    }
    const plan = this.dimPlan;
    if (plan) {
      const own = plan.labelAnchor();
      this.dimCursor = own ? { ox: p.x - own.x, oy: p.y - own.y } : undefined;
      const segs = this.dimPreviewSegs(plan, p);
      if (segs.length) preview.push(...dimensionLineObjects([], this.host.plane(), segs, PREVIEW_COLOR));
      this.host.dim().updateFromCursor({ [plan.field]: plan.measure(this.modeOffset()) });
      this.positionDimBox(e);
    }
    this.host.overlay().setPreview(preview);
  }

  /** highlight geometry for one pick candidate (a synthetic line for a rect
   *  edge, a small cross for a reference point) */
  private dimTargetObjects(t: DimTarget, color: number): THREE.Object3D[] {
    if (t.kind === "entity") return curveObjects([t.e], this.host.plane(), color, true);
    if (t.kind === "edge") {
      return curveObjects(
        [{ type: "line", id: "__dimedge__", x1: t.a.x, y1: t.a.y, x2: t.b.x, y2: t.b.y }],
        this.host.plane(),
        color,
        true,
      );
    }
    const r = this.host.pickTol() * 0.6;
    return curveObjects(
      [
        { type: "line", id: "__dimptA__", x1: t.pos.x - r, y1: t.pos.y - r, x2: t.pos.x + r, y2: t.pos.y + r },
        { type: "line", id: "__dimptB__", x1: t.pos.x - r, y1: t.pos.y + r, x2: t.pos.x + r, y2: t.pos.y - r },
      ],
      this.host.plane(),
      color,
      true,
    );
  }

  /** the annotation segments (extension lines + dimension line + arrowheads)
   *  for the resolved plan, offset by the frozen placement or the live cursor */
  private dimPreviewSegs(plan: DimPlan, cursor: THREE.Vector2): [THREE.Vector2, THREE.Vector2][] {
    // the dims whose look depends on the mode render exactly as they will once placed
    const own = plan.labelAnchor();
    if (own) {
      const off = this.dimPlace ?? { ox: cursor.x - own.x, oy: cursor.y - own.y };
      const c = plan.make(plan.measure(off), off);
      if (
        c.type === "hDistance" ||
        c.type === "vDistance" ||
        c.type === "angle" ||
        c.type === "radius" ||
        c.type === "diameter"
      ) {
        const segs = constraintDims(this.host.entities(), [c]).flatMap((d) => d.lines);
        if (segs.length) return segs;
      }
    }
    const an = plan.anchors();
    if (!an) return [];
    const anchor = this.dimBoxAnchor(plan);
    // A plan without labelAnchor (line length, circle diameter) renders through entityDims and cannot persist a
    // placement, so preview it where it will land rather than at the cursor.
    const holdsPlace = plan.labelAnchor() !== null && plan.kind !== "length";
    const off = !holdsPlace
      ? null
      : this.dimPlace
        ? new THREE.Vector2(this.dimPlace.ox, this.dimPlace.oy)
        : anchor
          ? cursor.clone().sub(anchor)
          : new THREE.Vector2();
    if (plan.kind === "radius") {
      const d = off && off.lengthSq() > 1e-12 ? off.clone().normalize() : new THREE.Vector2(Math.SQRT1_2, Math.SQRT1_2);
      return [[an.a.clone(), an.a.clone().addScaledVector(d, plan.measure())]];
    }
    if (plan.kind === "diameter") return [[an.a.clone(), an.b.clone()]];
    const dir = an.b.clone().sub(an.a);
    if (dir.lengthSq() < 1e-12) return [];
    dir.normalize();
    const nrm = new THREE.Vector2(-dir.y, dir.x);
    return linearDim(an.a, an.b, nrm, plan.measure(), off ? off.x * nrm.x + off.y * nrm.y : undefined).lines;
  }
}
