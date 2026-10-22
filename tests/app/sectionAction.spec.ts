// The Section command over another tool: refused with a status while that tool is at work, so the section's
// handle, Offset box and keys never run beside it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const choose = vi.hoisted(() => vi.fn(async () => "Z"));
vi.mock("../../src/ui/choice", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/choice")>()),
  choose,
}));

import { createActions } from "../../src/app/actions";
import type { Engine } from "../../src/app/engine";

function rig(o: { atWork: boolean; picking?: boolean; active?: boolean; body?: boolean }) {
  const calls: unknown[] = [];
  const setStatus = vi.fn();
  const act = createActions({
    sketch: { active: false },
    tools: {
      section: {
        picking: o.picking ?? false,
        active: o.active ?? false,
        start: (src: unknown) => calls.push(["start", src]),
        stop: () => calls.push("stop"),
      },
    },
    hasBody: () => o.body ?? true,
    toolAtWork: () => o.atWork,
    toolBusy: () => o.atWork,
    dropBodyGizmo: () => calls.push("drop"),
    setStatus,
    lastAction: null,
  } as unknown as Engine);
  return { act, calls, setStatus };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  choose.mockClear();
});

describe("the Section command", () => {
  it("starts on the chosen axis when no tool is at work", async () => {
    const r = rig({ atWork: false });
    r.act("section");
    await settle();
    expect([r.calls, choose.mock.calls.length, r.setStatus.mock.calls]).toEqual([["drop", ["start", "Z"]], 1, []]);
  });

  it("is refused with a status while a tool is at work, before anything is asked", async () => {
    const r = rig({ atWork: true });
    r.act("section");
    await settle();
    expect([r.calls, choose.mock.calls.length]).toEqual([[], 0]);
    expect(r.setStatus.mock.calls).toHaveLength(1);
    expect(r.setStatus.mock.calls[0]![0]).toMatch(/^Section: finish/);
  });

  it("still ends its own aiming, which counts as a tool at work, and a cut that is on", () => {
    const aiming = rig({ atWork: true, picking: true });
    aiming.act("section");
    const on = rig({ atWork: true, active: true });
    on.act("section");
    expect([aiming.calls, on.calls, aiming.setStatus.mock.calls, on.setStatus.mock.calls]).toEqual([["stop"], ["stop"], [], []]);
  });

  it("asks for a body first when there is none, whatever is at work", () => {
    const r = rig({ atWork: true, body: false });
    r.act("section");
    expect([r.calls, choose.mock.calls.length]).toEqual([[], 0]);
    expect(r.setStatus.mock.calls[0]![0]).toMatch(/body first/);
  });
});
