// The panel asks for freedom only while the Shapes list is open and shown, and hands the newest result to the store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Freedom } from "../../src/sketch/freedom";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const probe = vi.hoisted(() => ({ calls: [] as ResolvedEntity[][], answer: new Map<string, unknown>() }));
vi.mock("../../src/sketch/freedom", () => ({
  shapeFreedom: async (ents: ResolvedEntity[]) => {
    probe.calls.push(ents);
    return probe.answer.size ? new Map(probe.answer as Map<string, Freedom>) : null;
  },
}));

import { RelationsPanel } from "../../src/sketch/relationsPanel";
import { useSketchPaletteStore } from "../../src/stores/sketchPalette";
import { useSketchRelationsStore } from "../../src/stores/sketchRelations";

const ents = (x2: number): ResolvedEntity[] => [
  { type: "line", id: "e1", x1: 3.5, y1: -2, x2, y2: 7.25 },
  { type: "circle", id: "e2", x: 20, y: 5.5, radius: 2.25 },
];
const cons: SketchConstraint[] = [{ type: "horizontal", line: "e1" }];
const none = new Set<number>();
const show = (p: RelationsPanel, x2: number, conflict = false) => p.show(ents(x2), cons, none, none, 3, conflict, true);

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  probe.calls = [];
  probe.answer = new Map([["e1", { x: true, y: false, size: false }]]);
});
afterEach(() => vi.useRealTimers());

describe("RelationsPanel shapes", () => {
  it("never probes while the list is closed", async () => {
    const p = new RelationsPanel();
    show(p, 11);
    show(p, 12);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.calls).toEqual([]);
    expect(useSketchRelationsStore().freedom).toBeNull();
  });

  it("probes the latest sketch once after the pause when the list opens", async () => {
    const p = new RelationsPanel();
    const rel = useSketchRelationsStore();
    show(p, 11);
    useSketchPaletteStore().shapesOpen = true;
    rel.hooks?.shapes(true);
    show(p, 12);
    show(p, 13);
    await vi.advanceTimersByTimeAsync(299);
    expect(probe.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.calls).toEqual([ents(13)]);
    expect(rel.shapes.map((s) => s.spoken)).toEqual(["Line 1, free in X", "Circle 1"]);
  });

  it("stops and forgets the words when the list closes", async () => {
    const p = new RelationsPanel();
    const rel = useSketchRelationsStore();
    useSketchPaletteStore().shapesOpen = true;
    show(p, 11);
    await vi.advanceTimersByTimeAsync(300);
    expect(rel.freedom).not.toBeNull();
    useSketchPaletteStore().shapesOpen = false;
    rel.hooks?.shapes(false);
    expect(rel.freedom).toBeNull();
    show(p, 12);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.calls).toHaveLength(1);
  });

  it("stops when Show Constraints is turned off", async () => {
    const p = new RelationsPanel();
    const rel = useSketchRelationsStore();
    useSketchPaletteStore().shapesOpen = true;
    show(p, 11);
    p.setVisible(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.calls).toEqual([]);
    p.setVisible(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(probe.calls).toEqual([ents(11)]);
    expect(rel.freedom).not.toBeNull();
  });

  it("a sketch exit cancels a pending probe, and the next sketch starts with no words", async () => {
    const p = new RelationsPanel();
    const rel = useSketchRelationsStore();
    useSketchPaletteStore().shapesOpen = true;
    show(p, 11);
    await vi.advanceTimersByTimeAsync(300);
    show(p, 12);
    p.hide();
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.calls).toHaveLength(1);
    expect(rel.freedom).toBeNull();
    expect(rel.shapes).toEqual([]);

    probe.answer = new Map();
    show(p, 20);
    expect(rel.shapes.map((s) => s.spoken)).toEqual(["Line 1", "Circle 1"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(rel.freedom).toBeNull();
  });
});
