// Drawing a line, rectangle or circle without a pointer: Enter, a digit, -, . or @ opens a box with X and Y for the first point.

import * as THREE from "three";
import { announce } from "../ui/announce";
import { singleKeysOn } from "../ui/a11yPrefs";
import { keyTargetFree } from "../ui/focus";
import type { DimInput } from "./dimInput";
import { hitAt } from "./keyCursor";
import { readPoint } from "./pointEntry";
import { pointSentence } from "./sketchSpeech";
import type { ResolvedEntity, SnapCandidate, SnapKind, SnapRef } from "./snap";

export const KEY_DRAW_TOOLS: ReadonlySet<string> = new Set(["line", "rectangle", "circle"]);

const OPENERS: ReadonlySet<string> = new Set([..."0123456789", "-", ".", "@"]);

export const EDGE_ON_PROMPT = "The sketch plane is edge-on, turn the view to draw on it";

/** What a placed point carries, the same fields a pointer click's snap result does. */
export interface KeyHit {
  p: THREE.Vector2;
  kind: SnapKind;
  label?: string | undefined;
  ref?: SnapRef | undefined;
}

export interface KeyDrawHost {
  tool(): string;
  base(): THREE.Vector2 | null;
  cursor(): THREE.Vector2;
  candidates(): SnapCandidate[];
  entities(): ResolvedEntity[];
  planeTooEdgeOn(): boolean;
  dim(): DimInput;
  place(hit: KeyHit): void;
  positionBox(p: THREE.Vector2): void;
  prompt(text: string): void;
}

export class KeyDrawFlow {
  private last: THREE.Vector2 | null = null;

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
  }

  reset() {
    this.last = null;
  }

  onKey(e: KeyboardEvent): boolean {
    const opener = OPENERS.has(e.key);
    if ((e.key !== "Enter" && !opener) || e.repeat || e.metaKey) return false;
    // AltGr arrives as Ctrl+Alt on Windows, and it is how some layouts type @.
    const altGr = e.key === "@" && e.ctrlKey && e.altKey;
    if (!altGr && (e.ctrlKey || e.altKey)) return false;
    if (opener && !singleKeysOn()) return false;
    if (!this.armed() || this.host.base() || !keyTargetFree(e.target)) return false;
    e.preventDefault();
    if (this.host.planeTooEdgeOn()) {
      this.host.prompt(EDGE_ON_PROMPT);
      return true;
    }
    if (this.host.dim().isActive) this.host.dim().focus();
    else this.open();
    if (opener) this.host.dim().typeInto("x", e.key);
    return true;
  }

  private open() {
    const dim = this.host.dim();
    const at = this.host.cursor();
    dim.show(
      [
        { name: "x", label: "X", free: true },
        { name: "y", label: "Y", free: true },
      ],
      () => this.commit(),
    );
    dim.updateFromCursor({ x: at.x, y: at.y });
    this.host.positionBox(at);
  }

  private commit() {
    const dim = this.host.dim();
    const from = this.host.base() ?? this.last ?? { x: 0, y: 0 };
    const r = readPoint(
      { x: dim.getRaw("x"), y: dim.getRaw("y"), xTyped: dim.wasTyped("x"), yTyped: dim.wasTyped("y") },
      { x: dim.unitOf("x"), y: dim.unitOf("y") },
      from,
    );
    if (!r.ok) {
      dim.flag(r.problem);
      dim.focusField(r.field);
      announce(r.problem, "assertive");
      return;
    }
    const p = new THREE.Vector2(r.x, r.y);
    const c = hitAt(p, this.host.candidates());
    this.host.place({ p, kind: c?.kind ?? "free", label: c?.label, ref: c?.ref });
    announce(pointSentence(p, c, this.host.entities()), "polite", { key: "sketch-point" });
  }
}
