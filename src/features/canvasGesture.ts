// The canvas listeners and animation frame a modal tool holds, added and removed in one place so none is left behind.
// Extrude does not use this: its uncaptured pointerdown lets the viewport pick change the profile first.

import { escapeClaimed } from "../ui/escapeClaim";
import { isMenuKey } from "../ui/focus";

export interface GestureHandlers {
  move(e: PointerEvent): void;
  down(e: PointerEvent): void;
  up?(e: PointerEvent): void;
  key(e: KeyboardEvent): void;
  /** call `frame()` again from inside it to keep going */
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
    this.key = (e) => {
      if (isMenuKey(e)) return;
      if (e.key !== "Escape" || !escapeClaimed()) handlers.key(e);
    };
    // raf is cleared before the pass runs, so a re-arm from inside it takes
    this.tick = () => {
      this.raf = 0;
      handlers.frame?.();
    };
  }

  /** Idempotent, for a tool re-entering its pick phase. pointerdown is captured so a tool claims a click before the
   *  viewport selects; move and up are not, a tool wants them only once it has. keydown is on window, focus may be
   *  anywhere. */
  attach() {
    this.el.addEventListener("pointermove", this.move);
    this.el.addEventListener("pointerdown", this.down, true);
    this.el.addEventListener("pointerup", this.up);
    window.addEventListener("keydown", this.key, true);
  }

  /** Also cancels a pending frame. */
  detach() {
    this.el.removeEventListener("pointermove", this.move);
    this.el.removeEventListener("pointerdown", this.down, true);
    this.el.removeEventListener("pointerup", this.up);
    window.removeEventListener("keydown", this.key, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Coalesces: a call while one is already pending is a no-op. */
  frame() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  get framePending(): boolean {
    return this.raf !== 0;
  }
}
