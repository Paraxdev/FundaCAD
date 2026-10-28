// A box drag shows its rectangle on every move, previews the take once a frame at the latest point, and on release
// drops a pending preview and announces the final take once.
import { describe, expect, it, vi } from "vitest";
import { Viewport, type AreaDrag } from "../../src/viewport/viewport";
import { dragBox, FrameCoalescer } from "../../src/viewport/areaSelect";

type Handler = (e: Record<string, unknown>) => void;
const fire = (list: Handler[] | undefined, e: Record<string, unknown>) => list?.forEach((fn) => fn(e));

function rig() {
  const handlers: Record<string, Handler[]> = {};
  const frames = new Map<number, () => void>();
  let id = 0;
  const vp = Object.create(Viewport.prototype) as Record<string, unknown>;
  const box = { visible: false, show: vi.fn(() => (box.visible = true)), hide: vi.fn(() => (box.visible = false)) };
  const highlighter = { settle: vi.fn() };
  Object.assign(vp, {
    canvas: { addEventListener: (type: string, fn: Handler) => (handlers[type] ??= []).push(fn) },
    areaBox: box,
    highlighter,
    downPos: { x: 100, y: 100 },
    areaProj: {},
    requestRender: vi.fn(),
    queueHover: vi.fn(),
    onAreaDrag: vi.fn(),
    onAreaBegin: vi.fn(),
    selectInBox: vi.fn(),
    areaFrame: new FrameCoalescer(
      () => {
        (vp.showAreaBox as () => void).call(vp);
        highlighter.settle();
      },
      (fn) => (frames.set(++id, fn), id),
      (n) => frames.delete(n),
    ),
  });
  (vp.installPointer as () => void).call(vp);
  const down: AreaDrag = { x: 100, y: 100, additive: false, faces: [], edges: [], bodies: [] };
  vp.areaDown = down;
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, buttons: 1, button: 0, pointerType: "mouse" });
  return {
    vp,
    box,
    down,
    frames,
    move: (x: number, y: number) => fire(handlers.pointermove, at(x, y)),
    up: (x: number, y: number) => fire(handlers.pointerup, { ...at(x, y), buttons: 0 }),
    frame: () => {
      const run = [...frames.values()];
      frames.clear();
      for (const fn of run) fn();
    },
    selectInBox: vp.selectInBox as ReturnType<typeof vi.fn>,
    settle: highlighter.settle,
  };
}

const rectOf = (x: number, y: number) => dragBox(100, 100, x, y);

describe("box drag wiring", () => {
  it("shows the rectangle at once and previews once a frame at the latest point", () => {
    const r = rig();
    for (let i = 1; i <= 10; i++) r.move(100 + i * 10, 100 + i * 5);
    const last = rectOf(200, 150).rect;
    expect(r.box.show).toHaveBeenCalledTimes(10);
    expect(r.box.show).toHaveBeenLastCalledWith(last.x0, last.y0, last.x1, last.y1, rectOf(200, 150).mode);
    expect(r.frames.size).toBe(1);
    expect(r.selectInBox).not.toHaveBeenCalled();
    r.frame();
    expect(r.selectInBox.mock.calls).toEqual([[last, rectOf(200, 150).mode, r.down, false]]);
    expect(r.settle).toHaveBeenCalledTimes(1);
  });

  it("drops a pending preview on release and announces the release box once", () => {
    const r = rig();
    r.move(150, 130);
    r.frame();
    r.move(180, 170);
    expect(r.frames.size).toBe(1);
    r.up(190, 175);
    expect(r.frames.size).toBe(0);
    expect(r.selectInBox.mock.calls).toEqual([
      [rectOf(150, 130).rect, rectOf(150, 130).mode, r.down, false],
      [rectOf(190, 175).rect, rectOf(190, 175).mode, r.down, true],
    ]);
    expect(r.box.hide).toHaveBeenCalledTimes(1);
    expect(r.vp.areaProj).toBeNull();
  });
});
