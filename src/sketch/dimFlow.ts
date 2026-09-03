// The dimension tool's click flow: pick up to two operands, place the label,
// type the value, commit.
//
// Split out of sketchMode.ts, which had grown past four thousand lines. It
// follows the ConstraintTools / PatternFlow precedent: a live accessor into
// SketchMode (DimHost below) rather than a copy of its state, so nothing here
// can hold a stale entity list. The nine fields of in-progress state below —
// the picks, the resolved plan, the frozen placement, the value box's identity
// and the two right-click overrides — moved out of SketchMode entirely and are
// this collaborator's own.
//
// Picks accumulate (0-2 operands, dimensionTool.pickDimTarget); resolveDim
// decides WHICH dimension they describe — the type is a property of the pair,
// not of the first pick. A placement click freezes the label position and the
// DimInput commits the value. The tool re-arms after every commit
// (dimensioning is a batch activity), so no setTool() call happens here.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaceOffset, SketchConstraint } from "../types";
import type { SketchPlane } from "./plane";
import type { SketchOverlay } from "./overlay";
import { curveObjects, dimensionLineObjects, PREVIEW_COLOR } from "./overlay";
import type { DimInput } from "./dimInput";
import { linearDim } from "./entityDims";
import {
  clampPlace, isDimError, isRoundTarget, pickDimTarget, rebindTarget, resolveDim,
  targetIdentity, targetKey, unsupportedMessage,
  type DimOptions, type DimPlan, type DimTarget,
} from "./dimensionTool";
import { isDimConstraint } from "./id";
import type { FieldKind } from "../document/numFields";
import type { ResolvedEntity } from "./snap";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";

/** The slice of SketchMode this flow reads/writes — live accessors, not copies. */
export interface DimHost {
  /** live entity list; every solve replaces the objects in it */
  entities(): ResolvedEntity[];
  /** live constraint list — the implied parallel/concentric are pushed onto it */
  constraints(): SketchConstraint[];
  /** the shared on-canvas value box */
  dim(): DimInput;
  overlay(): SketchOverlay;
  viewport(): Viewport;
  plane(): SketchPlane;
  /** scratch the hover writes the cursor into, shared with the rest of the mode */
  lastCursor(): THREE.Vector2;
  /** the palette's Reference toggle: a driven (measured-only) dimension must not
   *  move geometry, so it also suppresses the implied constraints */
  referenceMode(): boolean;
  /** pick radius in sketch mm at the current zoom */
  pickTol(): number;
  planeMmPerPx(): number;
  planePoint(e: MouseEvent): THREE.Vector2 | null;
  textEntityAt(p: THREE.Vector2): Extract<ResolvedEntity, { type: "text" }> | null;
  /** the same evaluator a dimension label's inline editor uses, so `w/2` and
   *  `name=expr` work in the value box too */
  evalDimInput(raw: string, kind: FieldKind, key: string | null):
    { value: number; expr: string | null; name?: string } | { error: string };
  recordBinding(key: string, r: { value: number; expr: string | null; name?: string },
                kind: FieldKind): void;
  /** the shared placement path: stamps driven from the Reference toggle or the
   *  plan, pushes the constraint and solves */
  placeDim(c: SketchConstraint, forceDriven?: boolean): SketchConstraint;
  onState(): void;
}

export class DimFlow {
  // dimension tool: 0-2 accumulated picks and the plan they currently resolve
  // to (see dimensionTool.ts — the dimension TYPE is decided by the pair, not
  // by the first pick). `dimPlace` is frozen by the placement click.
  private dimPicks: DimTarget[] = [];
  private dimPlan: DimPlan | null = null;
  private dimPlace: PlaceOffset | null = null;
  // the click-to-place has happened. NOT the same as `dimPlace != null`, which
  // is null for the dims that render through entityDims and have no place slot.
  private dimPlaced = false;
  // where the value box currently sits (client px), so it only steps aside when
  // the cursor is genuinely about to land on it — and never once placed
  private dimBoxAt: { x: number; y: number } | null = null;
  private dimFieldKey = ""; // field set the open box was built for
  // full identity of the dimension the open box belongs to (kind + field set +
  // the picks). Two DIFFERENT dimensions can share a field set — a rect edge's
  // LENGTH and a circle-to-edge DISTANCE are both `distance:length` — so the
  // field key alone would carry a typed value silently across a plan change.
  private dimPlanKey = "";
  // Right-click overrides on the in-progress dimension. `dimTangentArmed` arms
  // the NEXT pick only and is consumed by the first circle/arc that uses it —
  // never sticky. `dimRoundPref` overrides radius-vs-diameter for a lone round
  // and persists for the whole in-progress dim (reset with the picks).
  private dimTangentArmed = false;
  private dimRoundPref: "radius" | "diameter" | undefined;

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
  /** the radius-vs-diameter override for a lone round */
  setRoundPref(pref: "radius" | "diameter") {
    this.dimRoundPref = pref;
  }

  // --- dimension tool ----------------------------------------------------
  // Picks accumulate (0-2 operands, dimensionTool.pickDimTarget); resolveDim
  // decides WHICH dimension they describe — the type is a property of the pair,
  // not of the first pick. A placement click freezes the label position and the
  // DimInput commits the value. The tool re-arms after every commit
  // (dimensioning is a batch activity), so no setTool() call happens here.

  /** clear the whole in-progress dimension (picks, plan, frozen placement, box) */
  /** Entities selected in the select tool become this dimension's operands when
   *  the user switches to the dimension tool (Fusion: click the line, press D).
   *  Whole-entity picks only — a rectangle selected as a unit names no single
   *  edge, so resolveDim refuses it and the tool just starts empty. */
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

  /** Put the typed value into the entity the user picked FIRST, before solving.
   *
   *  A radial gap is one equation over two free radii, so planegcs satisfies it
   *  by minimising total movement — it slides BOTH circles (a 60/50 pair asked
   *  for a 3mm wall came back 57.838/51.838). The gap is right but the result is
   *  not what anyone means: you point at the ring you want resized first, and
   *  expect the other one to stay put. Pre-setting the first-picked radius makes
   *  the system already satisfied, so the solver has nothing to redistribute and
   *  the second circle keeps its size. If other constraints disagree the solver
   *  still wins — this only chooses WHERE the slack is taken from.
   *  defer: the same treatment for c2cDistance rim clearance, whose branch
   *  depends on the centre distance too; revisit when a user reports it. */
  private seedFirstPicked(c: SketchConstraint, firstPicked: string | null) {
    if (c.type !== "radialGap" || !firstPicked) return;
    const byId = new Map(this.host.entities().map((e) => [e.id, e]));
    const inner = byId.get(c.inner), outer = byId.get(c.outer);
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
  }

  /** the right-click overrides the pair matrix reads */
  private dimOptions(): DimOptions {
    return this.dimRoundPref ? { roundPref: this.dimRoundPref } : {};
  }

  /** WHICH dimension the open box belongs to: the plan shape plus the picks it
   *  came from (rim/tangent MODE included — a rim distance and a centre distance
   *  between the same pair share a field set but are different dimensions).
   *  Re-showing the box on a change is what stops a value typed for one
   *  dimension being committed as another. */
  private dimIdentity(plan: DimPlan): string {
    return `${plan.kind}:${plan.fieldKey}|${this.dimPicks.map(targetIdentity).join("+")}`;
  }

  /** Re-resolve the current picks against the LIVE entity list. Every solve
   *  replaces the entity objects, so a held pick reference goes stale;
   *  rebindTarget re-reads it and drops picks whose geometry vanished.
   *  A dropped pick or a changed plan must reach the BOX too — otherwise the
   *  box keeps showing a field the new plan doesn't have, and the commit builds
   *  a different constraint at a value the user never saw. */
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
      if (this.host.dim().isActive) { this.host.dim().hide(); this.dimFieldKey = ""; this.dimPlanKey = ""; }
      return;
    }
    if (this.dimIdentity(this.dimPlan) !== this.dimPlanKey) this.syncDimBox();
  }

  /** A dimension-tool click: pick an operand, or place the resolved dimension.
   *  The candidate is recomputed HERE, never read from hover state — a
   *  synthetic pointerdown arrives with no preceding pointermove. */
  dimensionClick(p: THREE.Vector2, ev: PointerEvent) {
    const cand = pickDimTarget(this.host.entities(), p, this.host.pickTol());
    // Text has no entitySegments, so pickDimTarget can never return it — without
    // this its "can't be dimensioned yet" message would be unreachable and a
    // click on the glyphs would be a total no-op.
    if (!cand && !this.dimPlan && this.host.textEntityAt(p)) {
      toast(unsupportedMessage("text"));
      return;
    }
    const fresh = cand != null && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand));
    if (cand && fresh && this.dimPicks.length < 2) this.dimPick(cand, ev);
    else this.dimPlaceClick(p, ev);
  }

  private dimPick(t: DimTarget, ev: PointerEvent) {
    const prev = this.dimPicks.slice();
    // Fusion's tangent arm: consumed by the first circle/arc that can use it,
    // and only by that one — a line/point pick leaves it armed for the next.
    const pick: DimTarget = this.dimTangentArmed && isRoundTarget(t) && t.kind !== "edge"
      ? { ...t, rim: true }
      : t;
    if (pick !== t) this.dimTangentArmed = false;
    this.dimPicks.push(pick);
    const r = resolveDim(this.dimPicks, this.dimOptions());
    if (isDimError(r)) {
      if (r.message) toast(r.message); // toast on CLICK only, never from hover
      // a dead combination (concentric, coincident, same operand) drops the new
      // pick and keeps whatever already resolved — never a silent dead end
      if (!r.keepPicks) this.dimPicks = prev;
      this.refreshDimPlan();
    } else {
      this.dimPlan = r;
      setPrompt(r.hint);
    }
    this.dimPlace = null; // a new pick invalidates any earlier placement
    this.syncDimBox(ev);
  }

  /** Freeze the label position (`place`) at the cursor. Does NOT commit —
   *  Enter / the confirm button in the value box does, so nothing reaches setDrivingDimension
   *  without passing through the box. */
  private dimPlaceClick(p: THREE.Vector2, ev: PointerEvent) {
    if (!this.dimPlan) {
      // Nothing resolved yet: a lone armed operand plus a click that hit
      // nothing (a missed second pick, which is exactly what happens on a long
      // two-point distance). Keep the pick — Escape is the way to clear it —
      // and re-state what the tool is waiting for.
      if (this.dimPicks.length) {
        const r = resolveDim(this.dimPicks, this.dimOptions());
        if (isDimError(r) && r.message) toast(r.message);
      }
      return;
    }
    const anchor = this.dimPlan.labelAnchor();
    this.dimPlace = anchor
      ? clampPlace(p.x - anchor.x, p.y - anchor.y, this.host.planeMmPerPx())
      : null; // distance/diameter render through entityDims — no place slot
    this.dimPlaced = true; // NOT `dimPlace != null` — that is null for those two
    this.positionDimBox(ev);
    this.host.dim().setClickThrough(false); // confirm / cancel / the field are live from here on
    this.host.dim().focus(); // the canvas click blurred the input
  }

  /** Open / refresh the value box for the current plan. DimInput.show() starts
   *  with hide(), which throws away anything typed — so re-show ONLY when the
   *  dimension's identity actually changes, and say so when that discards input
   *  the user had already entered. */
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
      this.host.dim().show(plan.fields, () => this.commitDim(), () => this.cancelDim());
      if (discarded) toast("This is a different dimension now, retype the value");
    }
    this.host.dim().updateFromCursor({ [plan.field]: plan.measure() });
    this.positionDimBox(ev);
    // Until the label is placed the box must not intercept the click that
    // places it — that click landed on confirm and committed the measured value.
    this.host.dim().setClickThrough(!this.dimPlaced);
    this.host.dim().focus();
  }

  /** Enter / confirm: evaluate what was typed, build the constraint and hand it to
   *  the shared placement path (which stamps driven from the Reference toggle or
   *  the plan), then re-arm. The raw text goes through the SAME evaluator as a
   *  dimension label's inline editor, so `w/2` and `name=expr` work here too and
   *  a bad value is refused out loud instead of being replaced by the
   *  measurement. Only a genuinely EMPTY box means "accept the measurement". */
  commitDim() {
    const plan = this.dimPlan;
    if (!plan) { this.cancelDim(); return; }
    const kind: FieldKind = plan.kind === "angle" ? "angle" : "length";
    const raw = this.host.dim().getRaw(plan.field).trim();
    let value = plan.measure();
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
    const c = this.dimPlace ? plan.make(value, this.dimPlace) : plan.make(value);
    const forceDriven = plan.forceDriven === true;
    const firstPicked = this.dimPicks[0]?.e.id ?? null;
    this.host.dim().hide();
    const pair = plan.parallelPair;
    const conc = plan.implyConcentric;
    this.resetDimPicks();
    this.host.overlay().setPreview([]);
    // the parallelism a "distance between two parallel lines" implies — added
    // BEFORE the dim so one solve covers both, and only for a DRIVING dim (a
    // reference dim must not move geometry)
    if (pair && !this.host.referenceMode() && !forceDriven) this.addParallelPair(pair.l1, pair.l2);
    // likewise the concentricity a radial-gap (wall-thickness) dim implies:
    // `difference` ties only the two radii, so without it the typed number stops
    // being the radial gap the moment either centre moves (see types.ts)
    if (conc && !this.host.referenceMode() && !forceDriven) this.addConcentricPair(conc.c1, conc.c2);
    if (!this.host.referenceMode() && !forceDriven) this.seedFirstPicked(c, firstPicked);
    const placed = this.host.placeDim(c, forceDriven);
    // bind exactly as the label editor does: a formula binds, and a plain number
    // over a dim that WAS bound (the id carries over on replace) rewrites that
    // binding to the literal instead of leaving a stale expression behind
    if (typed && isDimConstraint(placed) && placed.id) this.host.recordBinding(`c:${placed.id}`, typed, kind);
    this.host.onState();
  }

  /** Hold two line operands parallel, unless something already does. Skipped
   *  when redundant, because a redundant constraint shows as an amber
   *  over-constrained chip: both explicitly horizontal (or both vertical),
   *  a rectangle edge whose orientation the rectangle itself fixes, or an
   *  existing parallel/collinear between the pair. */
  private addParallelPair(l1: string, l2: string) {
    const orient = (id: string): "h" | "v" | null => {
      const t = id.indexOf("~");
      if (t >= 0) { // rect edge: bottom/top are horizontal, right/left vertical
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
    const already = this.host.constraints().some(
      (c) => (c.type === "parallel" || c.type === "collinear") &&
        ((c.l1 === l1 && c.l2 === l2) || (c.l1 === l2 && c.l2 === l1)),
    );
    if (!already) this.host.constraints().push({ type: "parallel", l1, l2 });
  }

  /** Hold two rounds concentric, unless something already does. Skipped when
   *  redundant (an existing concentric on the same pair) so a radial-gap dim
   *  can't turn its own implied constraint into an amber over-constrained chip. */
  private addConcentricPair(c1: string, c2: string) {
    const already = this.host.constraints().some(
      (c) => c.type === "concentric" && ((c.c1 === c1 && c.c2 === c2) || (c.c1 === c2 && c.c2 === c1)),
    );
    if (!already) this.host.constraints().push({ type: "concentric", c1, c2 });
  }

  /** Esc / cancel: abandon the in-progress dimension, staying armed on the tool. */
  cancelDim() {
    this.host.dim().hide();
    this.resetDimPicks();
    this.host.overlay().setPreview([]);
    this.host.viewport().requestRender();
  }

  /** Park the value box near the dimension's own anchor (which doesn't move
   *  while you place), clamped inside the viewport — extrudeTool's rule: a
   *  cursor-glued box is unclickable. It sits on the side of the anchor AWAY
   *  from the cursor, because the quadrant the cursor is in is where the
   *  placement click is about to land, and a box under that click swallows it
   *  (the canvas never sees the pointerdown, so no placement is recorded). */
  /** Park the value box once per dimension and then LEAVE IT THERE.
   *
   *  It used to be repositioned on every pointer move, to the side of the anchor
   *  away from the cursor, so it could never swallow the click-to-place. That
   *  made the box flee an approaching pointer and rendered confirm unclickable. The
   *  box is click-through until the dimension is placed (see
   *  DimInput.setClickThrough), so it no longer needs to dodge anything —
   *  a stationary box is worth far more than a clever one. */
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
    const boxW = 170, boxH = 46, m = 12, gap = 28;
    const cx = ev?.clientX ?? s.x + 1, cy = ev?.clientY ?? s.y + 1;
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
    const cand = this.dimPicks.length < 2 ? pickDimTarget(this.host.entities(), p, this.host.pickTol()) : null;
    if (cand && !this.dimPicks.some((t) => targetKey(t) === targetKey(cand))) {
      preview.push(...this.dimTargetObjects(cand, 0xff5555));
    }
    const plan = this.dimPlan;
    if (plan) {
      const segs = this.dimPreviewSegs(plan, p);
      if (segs.length) preview.push(...dimensionLineObjects([], this.host.plane(), segs, PREVIEW_COLOR));
      this.host.dim().updateFromCursor({ [plan.field]: plan.measure() });
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
        this.host.plane(), color, true,
      );
    }
    const r = this.host.pickTol() * 0.6;
    return curveObjects(
      [
        { type: "line", id: "__dimptA__", x1: t.pos.x - r, y1: t.pos.y - r, x2: t.pos.x + r, y2: t.pos.y + r },
        { type: "line", id: "__dimptB__", x1: t.pos.x - r, y1: t.pos.y + r, x2: t.pos.x + r, y2: t.pos.y - r },
      ],
      this.host.plane(), color, true,
    );
  }

  /** the annotation segments (extension lines + dimension line + arrowheads)
   *  for the resolved plan, offset by the frozen placement or the live cursor */
  private dimPreviewSegs(plan: DimPlan, cursor: THREE.Vector2): [THREE.Vector2, THREE.Vector2][] {
    const an = plan.anchors();
    if (!an) return []; // angle dims render as a bare value (see entityDims)
    const anchor = this.dimBoxAnchor(plan);
    // A plan with no labelAnchor (line length, circle diameter) can't PERSIST a
    // placement — those render through entityDims, which has no constraint
    // access (see types.ts). Previewing at the cursor would promise a position
    // the commit throws away, so preview them exactly where they will land.
    const holdsPlace = plan.labelAnchor() !== null;
    const off = !holdsPlace
      ? null
      : this.dimPlace
        ? new THREE.Vector2(this.dimPlace.ox, this.dimPlace.oy)
        : anchor ? cursor.clone().sub(anchor) : new THREE.Vector2();
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
