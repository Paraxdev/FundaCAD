// Construction toggle on a sketch selection: the mixed selection rule, one undo step with constraints kept, and a closed
// profile that stops being a region. SketchMode's methods are the real ones off the prototype, its canvas is stubbed.

import { describe, expect, it } from "vitest";
import { SketchMode } from "../../src/sketch/sketchMode";
import { SketchHistory, type SketchSnapshot } from "../../src/sketch/history";
import { allConstruction, toggleConstruction } from "../../src/sketch/construction";
import { detectRegions } from "../../src/sketch/region";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : inert),
  apply: () => inert,
});

const l1: ResolvedEntity = { type: "line", id: "l1", x1: 12, y1: 1.5, x2: -4.25, y2: 7 };
const ax: ResolvedEntity = { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25, construction: true };
const c1: ResolvedEntity = { type: "circle", id: "c1", radius: 2.75, x: 8, y: 9 };
const ents = () => [l1, ax, c1].map((e) => ({ ...e }));

describe("toggleConstruction", () => {
  it("turns a mixed selection to construction", () => {
    expect(toggleConstruction(ents(), new Set(["l1", "ax"]))).toEqual([{ ...l1, construction: true }, ax, c1]);
  });

  it("turns an all construction selection back to normal, removing the flag", () => {
    const all = toggleConstruction(ents(), new Set(["l1", "ax", "c1"]));
    expect(all.every((e) => e.construction === true)).toBe(true);
    const back = toggleConstruction(all, new Set(["l1", "ax", "c1"]));
    expect(back).toEqual([l1, { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25 }, c1]);
    expect(back.some((e) => "construction" in e)).toBe(false);
  });

  it("toggles a lone construction entity back and leaves the rest alone", () => {
    expect(toggleConstruction(ents(), new Set(["ax"]))).toEqual([
      l1,
      { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25 },
      c1,
    ]);
  });

  it("changes nothing for an empty selection or unknown ids", () => {
    expect(toggleConstruction(ents(), new Set())).toEqual(ents());
    expect(toggleConstruction(ents(), new Set(["gone"]))).toEqual(ents());
  });

  it("allConstruction is false for nothing picked and for a mix, true only when every pick is construction", () => {
    expect([
      allConstruction(ents(), new Set()),
      allConstruction(ents(), new Set(["gone"])),
      allConstruction(ents(), new Set(["l1", "ax"])),
      allConstruction(ents(), new Set(["ax"])),
      allConstruction(ents(), new Set(["ax", "gone"])),
    ]).toEqual([false, false, false, true, true]);
  });
});

type Internals = {
  active: boolean;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  selected: Set<string>;
  history: SketchHistory;
  snapshot(): SketchSnapshot;
  toggleSelectedConstruction(): boolean;
};

function makeSketch(entities: ResolvedEntity[], constraints: SketchConstraint[], pre: string[]) {
  const s = Object.create(SketchMode.prototype) as Internals;
  let states = 0;
  Object.assign(s, {
    active: true,
    entities,
    constraints,
    patterns: [],
    selected: new Set(pre),
    history: new SketchHistory(),
    originPin: null,
    overlay: inert,
    refreshActive() {},
    pump: async () => {},
    onState: () => states++,
  });
  s.history.reset(s.snapshot());
  return { s, states: () => states };
}

describe("SketchMode.toggleSelectedConstruction", () => {
  it("is one undo step and keeps the constraints on the toggled entities", () => {
    const cons: SketchConstraint[] = [
      { type: "distance", line: "l1", value: 17.15 },
      { type: "coincident", e1: "l1", p1: 0, e2: "ax", p2: 1 },
    ];
    const { s, states } = makeSketch(ents(), cons, ["l1", "c1"]);
    const before = s.snapshot();
    expect(s.toggleSelectedConstruction()).toBe(true);
    expect(s.entities).toEqual([{ ...l1, construction: true }, ax, { ...c1, construction: true }]);
    expect(s.constraints).toEqual(cons);
    expect(states()).toBe(1);
    expect(s.history.canUndo).toBe(true);
    expect(s.history.undo(s.snapshot())).toEqual(before);
    expect(s.history.canUndo).toBe(false);
  });

  it("returns false and changes nothing with nothing selected, so the tool arms its mode instead", () => {
    const { s, states } = makeSketch(ents(), [], []);
    expect(s.toggleSelectedConstruction()).toBe(false);
    expect(s.entities).toEqual(ents());
    expect([states(), s.history.canUndo]).toEqual([0, false]);
  });

  it("a closed slanted profile turned into construction is no longer a region, and back again it is", () => {
    const quad: ResolvedEntity[] = [
      { type: "line", id: "a", x1: 4.5, y1: 1.25, x2: 13, y2: 3.75 },
      { type: "line", id: "b", x1: 13, y1: 3.75, x2: 10.5, y2: 11 },
      { type: "line", id: "c", x1: 10.5, y1: 11, x2: 2.75, y2: 8.5 },
      { type: "line", id: "d", x1: 2.75, y1: 8.5, x2: 4.5, y2: 1.25 },
    ];
    const { s } = makeSketch(quad, [], ["a", "b", "c", "d"]);
    expect(detectRegions("sk", s.entities)).toHaveLength(1);
    s.toggleSelectedConstruction();
    expect(detectRegions("sk", s.entities)).toEqual([]);
    s.toggleSelectedConstruction();
    expect(detectRegions("sk", s.entities)).toHaveLength(1);
  });
});
