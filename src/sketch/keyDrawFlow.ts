// Drawing a line, rectangle or circle without a pointer: Enter, a digit, -, . or @ opens a box with X and Y for a point,
// and @ as the first character of a size field turns that box into X and Y for the next one.

import * as THREE from "three";
import { singleKeysOn } from "../ui/a11yPrefs";
import { announce, cancelAnnouncement } from "../ui/announce";
import { escapeClaimed } from "../ui/escapeClaim";
import { isEditableTarget, keyTargetFree, widgetOwnsKey } from "../ui/focus";
import type { DimInput } from "./dimInput";
import { coarseStep, fineStep, hasSnap, hitAt, snapRing, stepCoord } from "./keyCursor";
import { readPoint, tooFar, within } from "./pointEntry";
import { cursorSentence, drawnSentence, pointSentence, walkEndSentence } from "./sketchSpeech";
import type { ResolvedEntity, SnapCandidate, SnapKind, SnapRef } from "./snap";

export const KEY_DRAW_TOOLS: ReadonlySet<string> = new Set(["line", "rectangle", "circle"]);

// Up is +Y and Right is +X of the sketch plane, whichever way the camera looks at it.
const ARROWS: Readonly<Record<string, readonly ["x" | "y", 1 | -1]>> = {
  ArrowRight: ["x", 1],
  ArrowLeft: ["x", -1],
  ArrowUp: ["y", 1],
  ArrowDown: ["y", -1],
};

const OPENERS: ReadonlySet<string> = new Set([..."0123456789", "-", ".", "@"]);

export const KEY_PROMPTS = {
  armed: "Enter or a digit types X and Y · arrows move the cursor · Esc",
  moved: "Arrows move · Enter places · Tab next snap · Esc",
  movedBare: "Arrows move · Enter places · Esc",
  point: "Type X and Y, or @dx,dy from the last point · Enter · Esc",
  size: "Type the size, or @dx,dy · arrows move · Enter · Esc",
};

export const EDGE_ON_PROMPT = "The sketch plane is edge-on, turn the view to draw on it";
export const TOO_SMALL = "Too small to draw, give it a size";

/** What a placed point carries, the same fields a pointer click's snap result does. */
export interface KeyHit {
  p: THREE.Vector2;
  kind: SnapKind;
  label?: string | undefined;
  ref?: SnapRef | undefined;
}

/** A shape a placed point finished. */
export interface Drawn {
  entity: ResolvedEntity;
  closed: boolean;
  angle?: number | null | undefined;
}

export interface BoxEnd {
  hit: KeyHit;
  said: string;
}

export interface KeyDrawHost {
  tool(): string;
  base(): THREE.Vector2 | null;
  cursor(): THREE.Vector2;
  candidates(): SnapCandidate[];
  entities(): ResolvedEntity[];
  planeTooEdgeOn(): boolean;
  /** The grid spacing on screen in mm, which the drawn grid and the snap lattice share. */
  step(): number;
  /** The cursor stands at `hit`: marker, tag, previews and live values follow, as they follow a pointer. */
  moveTo(hit: KeyHit): void;
  dim(): DimInput;
  place(hit: KeyHit): Drawn | null;
  /** What the size box's Enter would draw, null with no first point. */
  shape(): ResolvedEntity | null;
  positionBox(p: THREE.Vector2): void;
  prompt(text: string): void;
  focusSurface(): boolean;
  /** The prompt or the surface's state may have changed. */
  changed(): void;
}

// How far from the origin the shape reaches along X and along Y.
function reach(e: ResolvedEntity): [number, number] {
  if (e.type === "rectangle") return [Math.abs(e.x) + e.width / 2, Math.abs(e.y) + e.height / 2];
  if (e.type === "circle") return [Math.abs(e.x) + e.radius, Math.abs(e.y) + e.radius];
  if (e.type === "line") return [Math.max(Math.abs(e.x1), Math.abs(e.x2)), Math.max(Math.abs(e.y1), Math.abs(e.y2))];
  return [0, 0];
}

const outAxis = (x: number, y: number) => (!within(x) ? "x" : !within(y) ? "y" : null);

const hitOf = (p: THREE.Vector2, c: SnapCandidate | null): KeyHit => ({
  p,
  kind: c?.kind ?? "free",
  label: c?.label,
  ref: c?.ref,
});

export class KeyDrawFlow {
  private last: THREE.Vector2 | null = null;
  // The point in flight came from X and Y, so Enter on its untouched size box has no click to wait for.
  private session = false;
  // A tool armed, or a point opened or placed, by keys: the prompt speaks keys and focus is kept off the page body.
  private keys = false;
  // An arrow moved the cursor since the last point, so Enter places there instead of opening X and Y.
  private engaged = false;
  private stepSaid: number | null = null;
  // Tab's walk over the snaps, frozen at its first Tab: `at` is -1 on the spot it started from.
  private ring: { from: THREE.Vector2; list: SnapCandidate[]; at: number } | null = null;
  // What the X and Y box was last filled with, in mm.
  private boxAt = { x: 0, y: 0 };

  constructor(private readonly host: KeyDrawHost) {}

  private armed(): boolean {
    return KEY_DRAW_TOOLS.has(this.host.tool());
  }

  /** The X and Y box is open with nothing placed, which Escape treats as geometry in flight. */
  pending(): boolean {
    return this.armed() && !this.host.base() && this.host.dim().isActive;
  }

  placed(p: THREE.Vector2) {
    this.last = p.clone();
    this.endWalk();
  }

  private endWalk() {
    this.engaged = false;
    this.ring = null;
    cancelAnnouncement("sketch-cursor");
  }

  pointerMoved() {
    this.engaged = false;
    this.ring = null;
  }

  reset() {
    this.last = null;
    this.stepSaid = null;
    this.disarm();
  }

  /** A tool change ends a keys session, the arming key starts the next one through armedByKeys. */
  disarm() {
    this.session = false;
    this.keys = false;
    this.engaged = false;
    this.ring = null;
  }

  /** A letter or a keyboard click on the rail armed the tool: focus goes where the next Enter or digit is heard. */
  armedByKeys() {
    if (!this.armed()) return;
    this.keys = true;
    this.host.focusSurface();
    this.host.changed();
  }

  /** The text for the prompt line in a keys session, null for a pointer's own prompt. */
  keyPrompt(): string | null {
    if (!this.keys || !this.armed()) return null;
    const dim = this.host.dim();
    if (dim.hasField("x")) return KEY_PROMPTS.point;
    if (this.host.base()) return KEY_PROMPTS.size;
    if (!this.engaged) return KEY_PROMPTS.armed;
    return this.snapsNearby() ? KEY_PROMPTS.moved : KEY_PROMPTS.movedBare;
  }

  /** A box closed onto the page body: focus goes back to the surface so the next key still reaches the sketch. */
  settleFocus() {
    if (!this.keys || !this.armed() || this.host.dim().isActive) return;
    const at = document.activeElement;
    if (!at || at === document.body) this.host.focusSurface();
  }

  /** Escape dropped what was half drawn. */
  cancelled() {
    this.settleFocus();
    if (this.keys) this.host.changed();
  }

  /** Undo or redo swapped the geometry: Tab's stops and the snap under the cursor may be gone, and a box that took the
   *  key blurred itself onto the body. */
  historyMoved() {
    this.ring = null;
    cancelAnnouncement("sketch-cursor");
    if (!this.keys || !this.armed()) return;
    if (this.engaged) {
      const p = this.host.cursor().clone();
      this.host.moveTo(hitOf(p, hitAt(p, this.host.candidates())));
    }
    const dim = this.host.dim();
    if (!dim.isActive) this.settleFocus();
    else if (!document.activeElement || document.activeElement === document.body) dim.focus();
  }

  /** The point a size box's Enter places: the cursor a key moved, unless a size was typed. Read before the commit, which changes the candidates. */
  boxEnd(): BoxEnd | null {
    if (!this.armed() || !this.engaged || this.host.dim().touched()) return null;
    const p = this.host.cursor().clone();
    const c = hitAt(p, this.host.candidates());
    return { hit: hitOf(p, c), said: pointSentence(p, c, this.host.entities()) };
  }

  drawn(done: Drawn, end?: BoxEnd | null) {
    this.endWalk();
    const base = this.host.base();
    const at = base ?? end?.hit.p;
    if (at) this.last = at.clone();
    if (this.keys) {
      this.session = true;
      // A typed length or angle put the chain's base where no cursor stood.
      if (base) this.host.moveTo(hitOf(base.clone(), hitAt(base, this.host.candidates())));
    }
    const shape = drawnSentence(done.entity, this.host.entities(), done.closed, done.angle) + this.chainKeys();
    announce(end ? `${end.said}. ${shape}` : shape, "polite", { key: "sketch-point" });
    this.settleFocus();
    this.host.changed();
  }

  pointerPressed() {
    const was = this.keys;
    this.disarm();
    if (was) this.host.changed();
  }

  /** Enter on a size box nobody touched, with the cursor still on the point: X and Y for the next one. */
  openForNext(): boolean {
    const base = this.host.base();
    const dim = this.host.dim();
    if (!this.session || !this.armed() || !base || !dim.isActive || dim.touched()) return false;
    if (this.host.cursor().distanceTo(base) > 1e-9) return false;
    this.open();
    return true;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key in ARROWS) return this.onArrow(e);
    if (e.key === "Tab") return this.onTab(e);
    if (e.key === "Enter" && e.repeat && !e.metaKey) return this.heldEnter(e);
    const opener = OPENERS.has(e.key);
    if ((e.key !== "Enter" && !opener) || e.repeat || e.metaKey) return false;
    // AltGr arrives as Ctrl+Alt on Windows, and it is how some layouts type @.
    const altGr = e.key === "@" && e.ctrlKey && e.altKey;
    if (!altGr && (e.ctrlKey || e.altKey)) return false;
    if (!this.armed()) return false;
    const dim = this.host.dim();
    if (e.key === "Enter" && e.shiftKey) {
      if (!keyTargetFree(e.target) && !dim.ownsField(e.target)) return false;
      return this.openByKey(e, false);
    }
    if (this.host.base()) {
      if (e.key === "Enter" && this.engaged && keyTargetFree(e.target) && !(dim.isActive && dim.touched())) {
        return this.placeByEnter(e);
      }
      return this.turnSizeToPoint(e);
    }
    if (opener && !singleKeysOn()) return false;
    if (!keyTargetFree(e.target)) return false;
    if (e.key === "Enter" && this.engaged && !(dim.isActive && dim.touched())) return this.placeByEnter(e);
    return this.openByKey(e, opener);
  }

  // Left to go on, the box's own Enter or the tool's would place what the first press only opened.
  private heldEnter(e: KeyboardEvent): boolean {
    if (!this.armed() || (!keyTargetFree(e.target) && !this.host.dim().ownsField(e.target))) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  private openByKey(e: KeyboardEvent, opener: boolean): boolean {
    this.ring = null;
    e.preventDefault();
    // The box's own Enter would commit what a Shift+Enter in it was only asking to reopen.
    if (this.host.dim().ownsField(e.target)) e.stopPropagation();
    if (this.host.planeTooEdgeOn()) {
      this.host.prompt(EDGE_ON_PROMPT);
      return true;
    }
    if (this.host.dim().hasField("x")) this.host.dim().focus();
    else this.open();
    if (opener) this.host.dim().typeInto("x", e.key);
    this.host.changed();
    return true;
  }

  private onArrow(e: KeyboardEvent): boolean {
    if (!this.armed() || e.ctrlKey || e.metaKey || e.defaultPrevented || escapeClaimed()) return false;
    if (this.host.planeTooEdgeOn()) return false;
    const dim = this.host.dim();
    const t = e.target;
    if (dim.ownsTarget(t)) {
      // Once something is typed the arrows are the caret's, and Alt+Down opens the unit list.
      if (!dim.ownsField(t) || dim.touched() || e.altKey) return false;
    } else if (!keyTargetFree(t)) {
      if (e.altKey || isEditableTarget(t) || widgetOwnsKey(e)) return false;
      // A plain control has no use for the key, so it only loses the view step.
      e.preventDefault();
      return true;
    }
    e.preventDefault();
    const [axis, dir] = ARROWS[e.key]!;
    const cell = this.host.step();
    const step = e.shiftKey ? fineStep(cell) : e.altKey ? coarseStep(cell) : cell;
    const at = this.host.cursor();
    const p = new THREE.Vector2(at.x, at.y);
    p[axis] = stepCoord(p[axis], step, dir);
    // Back in from past the limit is let through, so a cursor a pointer left out there can return.
    if (!within(p[axis]) && Math.abs(p[axis]) > Math.abs(at[axis])) return this.refuseFar(axis);
    this.keys = true;
    this.engaged = true;
    this.ring = null;
    const said = this.stepSaid === step ? null : step;
    this.stepSaid = step;
    const c = hitAt(p, this.host.candidates());
    this.moveTo(p, c, cursorSentence(p, c, this.host.entities(), said));
    this.host.changed();
    return true;
  }

  private moveTo(p: THREE.Vector2, c: SnapCandidate | null, said: string) {
    this.host.moveTo(hitOf(p, c));
    const dim = this.host.dim();
    if (dim.hasField("x")) {
      this.boxAt = { x: p.x, y: p.y };
      dim.updateFromCursor(this.boxAt);
      this.host.positionBox(p);
    }
    announce(said, "polite", { key: "sketch-cursor", delay: 150 });
  }

  // The prompt asks on every arrow, so this does not build the ring.
  private snapsNearby(): boolean {
    if (this.ring) return this.ring.list.length > 0;
    const base = this.host.base();
    return hasSnap(this.host.cursor(), this.host.candidates(), base ? [base] : []);
  }

  private buildRing(): SnapCandidate[] {
    const base = this.host.base();
    return snapRing(this.host.cursor(), this.host.candidates(), base ? [base] : []);
  }

  // Tab only cycles once the cursor was moved by keys and a snap exists, so it never takes the key from a page with none to offer.
  private onTab(e: KeyboardEvent): boolean {
    if (!this.armed() || !this.engaged || e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.defaultPrevented || escapeClaimed() || this.host.planeTooEdgeOn()) return false;
    const dim = this.host.dim();
    if (dim.hasField("x")) return false;
    const inBox = dim.ownsTarget(e.target);
    if (inBox ? !dim.ownsField(e.target) || dim.touched() : !keyTargetFree(e.target)) return false;
    if (!this.ring) {
      const list = this.buildRing();
      if (!list.length) return false;
      this.ring = { from: this.host.cursor().clone(), list, at: -1 };
    }
    const ring = this.ring;
    const last = ring.list.length - 1;
    ring.at = e.shiftKey ? (ring.at < 0 ? last : ring.at - 1) : ring.at >= last ? -1 : ring.at + 1;
    const c = ring.at < 0 ? hitAt(ring.from, this.host.candidates()) : ring.list[ring.at]!;
    e.preventDefault();
    if (inBox) e.stopPropagation();
    const p = (ring.at < 0 ? ring.from : ring.list[ring.at]!.p).clone();
    const ents = this.host.entities();
    this.moveTo(p, c, ring.at < 0 ? walkEndSentence(p, c, ents) : cursorSentence(p, c, ents, null));
    this.host.changed();
    return true;
  }

  private placeByEnter(e: KeyboardEvent): boolean {
    e.preventDefault();
    const p = this.host.cursor().clone();
    const far = outAxis(p.x, p.y);
    if (this.host.planeTooEdgeOn()) this.host.prompt(EDGE_ON_PROMPT);
    else if (far) this.refuseFar(far);
    else this.placePoint(p);
    return true;
  }

  /** A size that takes the shape past where a typed point may go is refused in the same words, on its field. */
  sizeTooFar(): boolean {
    const e = this.host.shape();
    const axis = e && outAxis(...reach(e));
    if (!e || !axis) return false;
    const field =
      e.type === "rectangle" ? (axis === "x" ? "width" : "height") : e.type === "circle" ? "diameter" : "length";
    this.host.dim().flag(tooFar(axis));
    this.host.dim().focusField(field);
    return this.refuseFar(axis);
  }

  private refuseFar(axis: "x" | "y"): true {
    announce(tooFar(axis), "assertive");
    this.host.changed();
    return true;
  }

  // Typing a character into a field is not a single key shortcut, so this is not gated on singleKeysOn.
  private turnSizeToPoint(e: KeyboardEvent): boolean {
    const dim = this.host.dim();
    if (e.key !== "@" || dim.hasField("x") || !dim.isFreshField(e.target)) return false;
    this.ring = null;
    e.preventDefault();
    e.stopPropagation();
    this.open();
    dim.typeInto("x", "@");
    this.host.changed();
    return true;
  }

  private open() {
    this.keys = true;
    const dim = this.host.dim();
    const at = this.host.cursor();
    dim.show(
      [
        { name: "x", label: "X", free: true },
        { name: "y", label: "Y", free: true },
      ],
      () => this.commit(),
    );
    this.boxAt = { x: at.x, y: at.y };
    dim.updateFromCursor(this.boxAt);
    this.host.positionBox(at);
  }

  private commit() {
    const dim = this.host.dim();
    const from = this.host.base() ?? this.last ?? { x: 0, y: 0 };
    const r = readPoint(
      { x: dim.getRaw("x"), y: dim.getRaw("y"), xTyped: dim.wasTyped("x"), yTyped: dim.wasTyped("y"), at: this.boxAt },
      { x: dim.unitOf("x"), y: dim.unitOf("y") },
      from,
    );
    if (!r.ok) {
      dim.flag(r.problem);
      dim.focusField(r.field);
      announce(r.problem, "assertive");
      return;
    }
    this.placePoint(new THREE.Vector2(r.x, r.y));
  }

  private placePoint(p: THREE.Vector2) {
    this.session = true;
    this.keys = true;
    const c = hitAt(p, this.host.candidates());
    const second = !!this.host.base();
    const inXY = this.host.dim().hasField("x");
    const done = this.host.place(hitOf(p, c));
    if (second && !done) return this.refused();
    const ents = this.host.entities();
    const at = pointSentence(p, c, ents);
    const keys = inXY ? "" : this.chainKeys();
    const text = done ? `${at}. ${drawnSentence(done.entity, ents, done.closed)}${keys}` : at;
    announce(text, "polite", { key: "sketch-point" });
    this.settleFocus();
    this.host.changed();
  }

  // The prompt line speaks only a change, and from a size box a chain's next point has the prompt its last one had.
  private chainKeys(): string {
    const keys = this.host.base() ? this.keyPrompt() : null;
    return keys ? `. ${keys}` : "";
  }

  /** The tool refused a second point as too small: the toast alone is lost on a listener. */
  refused() {
    const dim = this.host.dim();
    dim.flag(TOO_SMALL);
    if (dim.hasField("x")) dim.focusField("x");
    else if (!dim.ownsField(document.activeElement)) dim.focus();
    announce(TOO_SMALL, "assertive");
    this.host.changed();
  }
}
