// The listener lifecycle every modal tool shares: it takes the canvas, and it
// must give all of it back. The controls here are the removals — an attach that
// works proves nothing on its own, since a leaked listener also fires.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CanvasGesture } from "../../src/features/canvasGesture";

function makeEl() {
  return document.createElement("canvas");
}

describe("CanvasGesture", () => {
  let frames: (() => void)[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length; // 1-based: 0 is the "no frame pending" sentinel
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("delivers pointer and key events while attached", () => {
    const el = makeEl();
    const seen: string[] = [];
    const g = new CanvasGesture(el, {
      move: () => seen.push("move"),
      down: () => seen.push("down"),
      up: () => seen.push("up"),
      key: () => seen.push("key"),
    });
    g.attach();
    el.dispatchEvent(new Event("pointermove"));
    el.dispatchEvent(new Event("pointerdown"));
    el.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("keydown"));
    expect(seen).toEqual(["move", "down", "up", "key"]);
  });

  it("gives every one of them back on detach", () => {
    // The control for the test above: this is the failure that matters, because
    // a tool that leaks one listener keeps eating clicks after it has closed.
    const el = makeEl();
    const seen: string[] = [];
    const g = new CanvasGesture(el, {
      move: () => seen.push("move"),
      down: () => seen.push("down"),
      up: () => seen.push("up"),
      key: () => seen.push("key"),
    });
    g.attach();
    g.detach();
    el.dispatchEvent(new Event("pointermove"));
    el.dispatchEvent(new Event("pointerdown"));
    el.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("keydown"));
    expect(seen).toEqual([]);
  });

  it("attaching twice still only delivers once", () => {
    // edgeFeatureTool re-enters its pick phase and calls attach() again.
    const el = makeEl();
    const seen: string[] = [];
    const g = new CanvasGesture(el, {
      move: () => seen.push("move"),
      down: () => {},
      key: () => {},
    });
    g.attach();
    g.attach();
    el.dispatchEvent(new Event("pointermove"));
    expect(seen).toEqual(["move"]);
    g.detach();
    el.dispatchEvent(new Event("pointermove"));
    expect(seen).toEqual(["move"]);
  });

  it("a gesture with no up handler ignores pointerup", () => {
    const el = makeEl();
    const g = new CanvasGesture(el, { move: () => {}, down: () => {}, key: () => {} });
    g.attach();
    expect(() => el.dispatchEvent(new Event("pointerup"))).not.toThrow();
  });

  it("runs one frame per request and coalesces repeats", () => {
    const el = makeEl();
    let passes = 0;
    const g = new CanvasGesture(el, {
      move: () => {}, down: () => {}, key: () => {},
      frame: () => { passes++; },
    });
    g.frame();
    g.frame(); // already pending — must not queue a second
    expect(g.framePending).toBe(true);
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(passes).toBe(1);
    expect(g.framePending).toBe(false);
  });

  it("lets the pass re-arm itself from inside", () => {
    // This is how every tool's tick() keeps a gizmo live: raf must be cleared
    // BEFORE the pass runs, or the re-arm would be swallowed by the coalescing.
    const el = makeEl();
    let passes = 0;
    const g: CanvasGesture = new CanvasGesture(el, {
      move: () => {}, down: () => {}, key: () => {},
      frame: () => { passes++; if (passes < 3) g.frame(); },
    });
    g.frame();
    for (let i = 0; i < frames.length && i < 5; i++) frames[i]!();
    expect(passes).toBe(3);
    expect(g.framePending).toBe(false);
  });

  it("detach cancels a pending frame", () => {
    const el = makeEl();
    let passes = 0;
    const g = new CanvasGesture(el, {
      move: () => {}, down: () => {}, key: () => {},
      frame: () => { passes++; },
    });
    g.frame();
    g.detach();
    expect(g.framePending).toBe(false);
    frames.forEach((f) => f());
    expect(passes).toBe(0);
  });
});
