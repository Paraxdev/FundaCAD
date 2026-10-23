// A canvas press blurs the value field, so a release that keeps the tool open must hand focus back.
import { describe, expect, it, vi } from "vitest";
import { PressPullTool } from "../../src/features/pressPullTool";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";

type Rig = Record<string, unknown>;

function release(proto: object, extra: Rig, ev: { x: number; y: number }, fluent: boolean, neutral: boolean) {
  const focus = vi.fn();
  const commit = vi.fn();
  const cancel = vi.fn();
  const tool = Object.create(proto) as Rig & { onUp(e: unknown): void };
  Object.assign(tool, {
    phase: "drag",
    grabbing: true,
    fluentGrab: fluent,
    value: neutral ? 0 : 7,
    round: null,
    hovering: false,
    pickingTarget: false,
    taperGrabbing: false,
    downPos: { x: 100, y: 200 },
    viewport: { domElement: { style: {} } },
    dim: { focus, updateFromCursor() {} },
    flushPreviewNow() {},
    commit,
    cancel,
    ...extra,
  });
  tool.onUp({ button: 0, clientX: ev.x, clientY: ev.y });
  return { focus, commit, cancel };
}

describe("Press/Pull release", () => {
  const rig = (fluent: boolean, neutral: boolean, ev: { x: number; y: number }) =>
    release(PressPullTool.prototype, {}, ev, fluent, neutral);

  it("refocuses the value field after a press that never travelled", () => {
    const r = rig(true, false, { x: 101, y: 202 });
    expect(r.focus).toHaveBeenCalledTimes(1);
    expect(r.commit).not.toHaveBeenCalled();
  });

  it("refocuses after a handle drag on the tool's own gizmo", () => {
    const r = rig(false, false, { x: 160, y: 237 });
    expect(r.focus).toHaveBeenCalledTimes(1);
  });

  it("does not refocus when the release commits or cancels", () => {
    const c = rig(true, false, { x: 160, y: 237 });
    expect([c.commit.mock.calls.length, c.cancel.mock.calls.length, c.focus.mock.calls.length]).toEqual([1, 0, 0]);
    const x = rig(true, true, { x: 160, y: 237 });
    expect([x.commit.mock.calls.length, x.cancel.mock.calls.length, x.focus.mock.calls.length]).toEqual([0, 1, 0]);
  });
});

describe("Fillet and chamfer release", () => {
  const extra = {
    kind: "fillet",
    bounds: () => ({}),
    clearanceLimitMm: 5,
    setValue() {},
    refreshGhost() {},
    pushPreview() {},
    promptForPhase() {},
  };
  const rig = (fluent: boolean, ev: { x: number; y: number }) =>
    release(EdgeFeatureTool.prototype, extra, ev, fluent, false);

  it("refocuses after a press that never travelled and after an explicit-commit drag", () => {
    expect(rig(true, { x: 99, y: 203 }).focus).toHaveBeenCalledTimes(1);
    expect(rig(false, { x: 170, y: 260 }).focus).toHaveBeenCalledTimes(1);
  });

  it("does not refocus when the release commits", () => {
    const r = rig(true, { x: 170, y: 260 });
    expect([r.commit.mock.calls.length, r.focus.mock.calls.length]).toEqual([1, 0]);
  });
});
