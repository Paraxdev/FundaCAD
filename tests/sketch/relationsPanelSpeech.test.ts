import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { RelationsPanel } from "../../src/sketch/relationsPanel";
import { attachAnnouncer, recentAnnouncements } from "../../src/ui/announce";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const ents: ResolvedEntity[] = [{ type: "line", id: "e1", x1: 3, y1: 2, x2: 11, y2: 7 }];
const cons: SketchConstraint[] = [{ type: "horizontal", line: "e1" }];
const none = new Set<number>();
let detach: () => void;

const said = () => recentAnnouncements().map((a) => `${a.priority}:${a.text}`);

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  detach = attachAnnouncer({ polite: { textContent: "" }, assertive: { textContent: "" } });
});
afterEach(() => {
  detach();
  vi.useRealTimers();
});

describe("RelationsPanel freedom speech", () => {
  it("stays silent on entry, speaks a change after 400 ms, and a conflict assertively", () => {
    const p = new RelationsPanel();
    const before = said().length;
    p.show(ents, cons, none, none, 3, false, true);
    p.show(ents, cons, none, none, 3, false, true);
    vi.advanceTimersByTime(1000);
    expect(said().length).toBe(before);

    p.show(ents, cons, none, none, 2, false, true);
    vi.advanceTimersByTime(380);
    expect(said().length).toBe(before);
    vi.advanceTimersByTime(40);
    expect(said().slice(before)).toEqual(["polite:2 degrees of freedom"]);

    p.show(ents, cons, new Set([0]), none, 2, true, true);
    vi.advanceTimersByTime(420);
    expect(said().slice(before)).toEqual(["polite:2 degrees of freedom", "assertive:Conflicting constraints"]);
  });

  it("collapses a burst of solves into the last line", () => {
    const p = new RelationsPanel();
    const before = said().length;
    p.show(ents, cons, none, none, 5, false, true);
    p.show(ents, cons, none, none, 4, false, true);
    p.show(ents, cons, none, none, 1, false, true);
    vi.advanceTimersByTime(420);
    expect(said().slice(before)).toEqual(["polite:1 degree of freedom"]);
  });

  it("says nothing before the first solve settles, and a closed sketch starts the next one silent", () => {
    const p = new RelationsPanel();
    const before = said().length;
    p.show(ents, cons, none, none, -1, false, false);
    p.show(ents, cons, none, none, 4, false, false);
    p.show(ents, cons, none, none, 2, false, true);
    p.show(ents, cons, none, none, 1, false, true);
    p.hide();
    vi.advanceTimersByTime(1000);
    expect(said().length).toBe(before);

    p.show(ents, cons, none, none, 6, false, true);
    vi.advanceTimersByTime(1000);
    expect(said().length).toBe(before);
  });
});
