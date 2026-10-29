// A box drag shows its rectangle on every move, previews the take once a frame at the latest point, in the render
// frame before it draws, and on release drops a pending preview and announces the final take once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Viewport, type AreaDrag } from "../../src/viewport/viewport";
import { dragBox, FrameCoalescer } from "../../src/viewport/areaSelect";
import { PREVIEW_REACH } from "../../src/viewport/areaProjection";
import { PREVIEW_PAINT } from "../../src/viewport/highlight";

const hoisted = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock("../../src/viewport/areaProjection", async (orig) => ({
  ...(await orig<typeof import("../../src/viewport/areaProjection")>()),
  collectInBox: hoisted.collect,
}));

type Handler = (e: Record<string, unknown>) => void;
const fire = (list: Handler[] | undefined, e: Record<string, unknown>) => list?.forEach((fn) => fn(e));

function rig() {
  const handlers: Record<string, Handler[]> = {};
  const frames = new Map<number, () => void>();
  let id = 0;
  const vp = Object.create(Viewport.prototype) as Record<string, unknown>;
  const box = { visible: false, show: vi.fn(() => (box.visible = true)), hide: vi.fn(() => (box.visible = false)) };
  const order: string[] = [];
  const highlighter = { settle: vi.fn(() => order.push("settle")) };
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
    selectInBox: vi.fn(() => order.push("preview")),
    areaFrame: new FrameCoalescer(
      () => (vp.previewAreaFrame as () => void).call(vp),
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
    order,
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

  afterEach(() => vi.unstubAllGlobals());

  it("previews and settles a move in the render frame that follows it, before that frame draws", () => {
    const r = rig();
    // Anything the frame reads beyond the box is a no-op that answers to every call and property.
    const anything: unknown = new Proxy(() => {}, { get: () => anything, apply: () => anything });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("document", { visibilityState: "visible" });
    Object.assign(r.vp, {
      watchStutter: anything,
      timer: anything,
      rig: anything,
      applyMotionScale: anything,
      edgeMotionTick: anything,
      syncOverlayMask: anything,
      trace: anything,
      power: anything,
      traceBaker: anything,
      freeze: anything,
      overlayDrawn: () => false,
      contactShadow: anything,
      shadowWatch: anything,
      cube: anything,
      fenceRef: anything,
      fps: anything,
      glowLinked: true,
      peek: new Set(),
      scene: {
        scene: anything,
        renderer: anything,
        post: { render: vi.fn(() => r.order.push("draw")) },
      },
    });
    r.move(160, 140);
    expect(r.order).toEqual([]);
    (r.vp.renderFrame as () => void).call(r.vp);
    expect({ order: r.order, pending: r.frames.size, errors: error.mock.calls }).toEqual({
      order: ["preview", "settle", "draw"],
      pending: 0,
      errors: [],
    });
    expect(r.selectInBox.mock.calls).toEqual([[rectOf(160, 140).rect, rectOf(160, 140).mode, r.down, false]]);
  });

  it("finishes a preview its reach budget cut short in the next frame, and takes the whole box on release", () => {
    const r = rig();
    delete r.vp.selectInBox;
    const setSelection = vi.fn((_: { faces: Set<number> }) => ({ changed: true, pending: false }));
    Object.assign(r.vp, {
      model: {},
      areaFilter: "all",
      selectionMode: "faces",
      onSelectionChange: vi.fn(),
      highlighter: { settle: vi.fn(), setSelection },
    });
    const part = { faces: [1], edges: [], bodies: [], pending: true };
    const full = { faces: [1, 2], edges: [], bodies: [], pending: false };
    hoisted.collect.mockReturnValueOnce(part).mockReturnValueOnce(full).mockReturnValueOnce(full);
    r.move(160, 140);
    r.frame();
    const queued = r.frames.size;
    r.frame();
    const after = r.frames.size;
    r.up(160, 140);
    expect({
      budgets: hoisted.collect.mock.calls.map((c) => c[3]),
      queued,
      after,
      takes: setSelection.mock.calls.map(([w]) => [...w.faces]),
    }).toEqual({
      budgets: [PREVIEW_REACH, PREVIEW_REACH, Infinity],
      queued: 1,
      after: 0,
      takes: [[1], [1, 2], [1, 2]],
    });
  });

  it("goes on painting in the next frame while the take is past a frame's paint budget, and paints it whole on release", () => {
    const r = rig();
    delete r.vp.selectInBox;
    const setSelection = vi
      .fn((_: { faces: Set<number> }, __?: number) => ({ changed: true, pending: false }))
      .mockReturnValueOnce({ changed: true, pending: true });
    Object.assign(r.vp, {
      model: {},
      areaFilter: "all",
      selectionMode: "faces",
      onSelectionChange: vi.fn(),
      highlighter: { settle: vi.fn(), setSelection },
    });
    const full = { faces: [1, 2], edges: [], bodies: [], pending: false };
    hoisted.collect.mockReturnValueOnce(full).mockReturnValueOnce(full).mockReturnValueOnce(full);
    r.move(160, 140);
    r.frame();
    const queued = r.frames.size;
    r.frame();
    const after = r.frames.size;
    r.up(160, 140);
    expect({ budgets: setSelection.mock.calls.map((c) => c[1]), queued, after }).toEqual({
      budgets: [PREVIEW_PAINT, PREVIEW_PAINT, Infinity],
      queued: 1,
      after: 0,
    });
  });
});
