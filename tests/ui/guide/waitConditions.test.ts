import { describe, expect, it } from "vitest";
import { GuideSession, type Resolution } from "../../../src/ui/guide/guideSession";
import { describeEvent, diffSnapshot, emptySnapshot, matchWait, type Snapshot } from "../../../src/ui/guide/wait";

const snap = (p: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot(), ...p });

describe("diffSnapshot", () => {
  it("names a started tool, a new feature, a selection and a typed value", () => {
    const before = snap({ features: [{ id: "f1", type: "box" }] });
    const after = snap({
      tool: "Fillet / Chamfer",
      features: [{ id: "f1", type: "box" }, { id: "fillet1", type: "fillet" }],
      selection: { faces: 0, edges: 1, bodies: 0 },
      value: { field: "radius", text: "3" },
    });
    expect(diffSnapshot(before, after).map(describeEvent)).toEqual([
      "tool started: Fillet / Chamfer",
      "feature added: fillet1 (fillet)",
      "selection: 1 edge",
      "value typed: radius = 3",
    ]);
    expect(diffSnapshot(after, after)).toEqual([]);
  });
});

describe("matchWait", () => {
  it("filters by kind, tool and field", () => {
    const tool = { kind: "tool", tool: "Fillet / Chamfer" } as const;
    expect(matchWait({ until: ["tool"], tool: "fillet" }, tool)).toBe(true);
    expect(matchWait({ until: ["tool"], tool: "extrude" }, tool)).toBe(false);
    expect(matchWait({ until: ["feature"] }, tool)).toBe(false);
    expect(matchWait({ until: ["feature", "tool"] }, tool)).toBe(true);
    expect(matchWait({ until: ["value"], field: "radius" }, { kind: "value", field: "distance", text: "2" })).toBe(false);
  });
});

describe("GuideSession waits", () => {
  const found = (): Resolution => ({ found: true });
  const rig = () => {
    let now = snap();
    const g = new GuideSession(found, () => now);
    return { g, set: (p: Partial<Snapshot>) => { now = snap(p); g.observe(); } };
  };

  it("counts only what happens after the wait is armed", () => {
    const { g, set } = rig();
    set({ tool: "Fillet / Chamfer" });
    g.apply([{ kind: "wait", seq: 1, until: ["tool"] }]);
    g.observe();
    expect(g.state.wait?.done).toBeNull();
    set({ tool: null });
    set({ tool: "Fillet / Chamfer" });
    expect(g.state.wait).toMatchObject({ done: "met", what: "tool started: Fillet / Chamfer" });
  });

  it("resolves a wait on Next, also when Next came first", () => {
    const { g } = rig();
    g.apply([{ kind: "highlight", seq: 1, target: { ui: "pick:fillet" }, step: 1, of: 3 }]);
    g.next();
    g.apply([{ kind: "wait", seq: 2, until: ["next", "tool"] }]);
    expect(g.state.wait).toMatchObject({ done: "next", what: "Next pressed" });
    expect(g.state.ack).toBe(2);
  });

  it("Stop resolves any wait, clears the step and counts the stop", () => {
    const { g } = rig();
    g.apply([{ kind: "highlight", seq: 1, target: { ui: "x" }, step: 2, of: 3 }, { kind: "wait", seq: 2, until: ["tool"] }]);
    expect(g.active).toBe(true);
    g.stop();
    expect(g.state.step).toBeNull();
    expect(g.state.wait).toMatchObject({ done: "stopped", what: "the user stopped the guide at step 2 of 3, everything is cleared" });
    expect(g.state.stopped).toEqual({ n: 1, step: 2, of: 3 });
    expect(g.active).toBe(false);
  });

  it("ignores a command it already acted on", () => {
    const { g } = rig();
    g.apply([{ kind: "highlight", seq: 3, target: { ui: "a" }, caption: "one" }]);
    g.apply([{ kind: "highlight", seq: 3, target: { ui: "b" }, caption: "two" }]);
    expect(g.state.step?.caption).toBe("one");
  });
});
