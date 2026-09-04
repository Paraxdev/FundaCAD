// One gesture on the 3D canvas: the pointer and key listeners a modal tool puts
// up while it is running, and the animation frame it drives its gizmo from.
//
// Nine tools were each declaring five bound-method fields, binding them in a
// constructor, adding four listeners in start() and removing the same four in
// cleanup(), plus their own raf handle to cancel. That is not shared behaviour
// by accident: the set is the same because the contract is the same — a modal
// tool takes the canvas, and it must give every part of it back. Splitting the
// add from the remove across two hundred lines of a tool file is exactly how
// one of the four gets forgotten and a dead tool keeps eating clicks.
//
// pointerdown is captured, so a tool sees a click before the viewport's own
// selection handler does and can claim it; pointermove and pointerup are not,
// because a tool only ever wants those after it has already claimed a drag.
// keydown goes on window, captured, because focus may be anywhere.
//
// Extrude is deliberately NOT one of the callers: it binds pointerdown without
// capture, so the viewport's own pick runs first and a click can change which
// profile it is extruding. That is a different bargain, not an oversight, and
// folding it in behind a flag would put the difference somewhere nobody reading
// extrudeTool.ts would see it.

/** What the tool wants to be told. `frame` is optional: a tool with no live
 *  gizmo never asks for one. */
export interface GestureHandlers {
  move(e: PointerEvent): void;
  down(e: PointerEvent): void;
  up?(e: PointerEvent): void;
  key(e: KeyboardEvent): void;
  /** the per-frame pass; call `frame()` again from inside it to keep going */
  frame?(): void;
}

export class CanvasGesture {
  private readonly move: (e: PointerEvent) => void;
  private readonly down: (e: PointerEvent) => void;
  private readonly up: (e: PointerEvent) => void;
  private readonly key: (e: KeyboardEvent) => void;
  private readonly tick: () => void;
  private raf = 0;

  constructor(
    private readonly el: HTMLElement,
    handlers: GestureHandlers,
  ) {
    this.move = (e) => handlers.move(e);
    this.down = (e) => handlers.down(e);
    this.up = (e) => handlers.up?.(e);
    this.key = (e) => handlers.key(e);
    // raf is cleared BEFORE the pass runs, so a re-arm from inside it takes
    this.tick = () => { this.raf = 0; handlers.frame?.(); };
  }

  /** Idempotent: a tool that re-enters its own pick phase calls this again, and
   *  addEventListener ignores a repeat of the same type/listener/capture. */
  attach() {
    this.el.addEventListener("pointermove", this.move);
    this.el.addEventListener("pointerdown", this.down, true);
    this.el.addEventListener("pointerup", this.up);
    window.addEventListener("keydown", this.key, true);
  }

  /** Give the canvas back, pending frame included. */
  detach() {
    this.el.removeEventListener("pointermove", this.move);
    this.el.removeEventListener("pointerdown", this.down, true);
    this.el.removeEventListener("pointerup", this.up);
    window.removeEventListener("keydown", this.key, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Ask for one animation frame. Coalescing: a second call while one is
   *  already pending is a no-op rather than a second queued pass. */
  frame() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** is a frame pending? (for tests, and for a tool that gates on it) */
  get framePending(): boolean {
    return this.raf !== 0;
  }
}
