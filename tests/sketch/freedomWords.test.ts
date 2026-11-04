// Freedom words, and which probe solves shapeFreedom asks for, with the solver stubbed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProbeAxis } from "../../src/sketch/sketchSolve";

// Note: a vi.fn reset in beforeEach failed a test even though shapeFreedom caught its rejection, so this is a plain stub.
const solver = vi.hoisted(() => ({
  calls: [] as unknown[][],
  run: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error("no stub")),
}));
vi.mock("../../src/sketch/sketchSolve", () => ({
  compileAndSolve: (...args: unknown[]) => {
    solver.calls.push(args);
    return solver.run(...args);
  },
}));

import { freedomWords, shapeFreedom, MAX_PROBED, type Freedom } from "../../src/sketch/freedom";
import type { ResolvedEntity } from "../../src/sketch/snap";
import { circle, line, pl } from "./solveFixtures";

const pass = (dof: number, conflicts: string[] = []) => ({
  entities: [],
  dof,
  ok: !conflicts.length,
  conflicts,
  overDefined: [],
});
type Opts = { probe?: { entity: string; axis: ProbeAxis } } | undefined;
const probes = () =>
  solver.calls.map((c) => (c[3] as Opts)?.probe).flatMap((p) => (p ? [`${p.entity}.${p.axis}`] : []));
const always = (r: unknown) => () => Promise.resolve(r);
const slot: ResolvedEntity = { type: "slot", id: "s", x1: 3.5, y1: -6.2, x2: 19.4, y2: 8.8, width: 4.6 };

beforeEach(() => {
  solver.calls = [];
});

describe("freedomWords", () => {
  it.each<[Freedom | undefined, string]>([
    [undefined, ""],
    [{ x: false, y: false, size: false }, "fixed"],
    [{ x: true, y: false, size: false }, "free in X"],
    [{ x: false, y: true, size: false }, "free in Y"],
    [{ x: false, y: false, size: true }, "free in size"],
    [{ x: true, y: true, size: false }, "free in X and Y"],
    [{ x: true, y: false, size: true }, "free in X and size"],
    [{ x: false, y: true, size: true }, "free in Y and size"],
    [{ x: true, y: true, size: true }, "free in X, Y and size"],
  ])("%o reads %j", (f, words) => {
    expect(freedomWords(f)).toBe(words);
  });
});

describe("shapeFreedom probes", () => {
  it("probes X and Y of a line, and size too of a circle, skipping projected and slot shapes", async () => {
    const held: Record<string, number> = { x: 2, y: 3, size: 1 };
    solver.run = async (...args) => {
      const probe = (args[3] as Opts)?.probe;
      return pass(probe ? held[probe.axis]! : 3);
    };
    const ents = [
      line("a", 12.5, 7.25, 41.75, 23.5),
      pl("p", -9.1, 4.3, 7.7, 15.2),
      slot,
      circle("c", 27.3, -14.6, 8.4),
    ];
    const r = await shapeFreedom(ents, []);
    expect(probes()).toEqual(["a.x", "a.y", "c.x", "c.y", "c.size"]);
    expect(r).toEqual(
      new Map([
        ["a", { x: true, y: false, size: false }],
        ["p", { x: false, y: false, size: false }],
        ["c", { x: true, y: false, size: true }],
      ]),
    );
  });

  it("no freedom left means no probes and every solved shape fixed", async () => {
    solver.run = always(pass(0));
    const r = await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5), slot, circle("c", 27.3, -14.6, 8.4)], []);
    expect(probes()).toEqual([]);
    expect(r).toEqual(
      new Map([
        ["a", { x: false, y: false, size: false }],
        ["c", { x: false, y: false, size: false }],
      ]),
    );
  });

  it("one degree of freedom still probes", async () => {
    solver.run = always(pass(1));
    await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5)], []);
    expect(probes()).toEqual(["a.x", "a.y"]);
  });

  it("shapes past the cap get no entry, the last one under it does", async () => {
    solver.run = always(pass(7));
    const ents = Array.from({ length: MAX_PROBED + 2 }, (_, i) =>
      line(`l${i}`, i * 3.1, 2.4 + i, i * 3.1 + 8.6, 9.7 - i),
    );
    const r = await shapeFreedom([pl("p", -9.1, 4.3, 7.7, 15.2), ...ents], []);
    expect([...(r?.keys() ?? [])]).toEqual(["p", ...ents.slice(0, MAX_PROBED).map((e) => e.id)]);
    expect(probes().length).toBe(MAX_PROBED * 2);
  });

  it("a conflict or a pass that did not converge gives null without probing", async () => {
    solver.run = always(pass(2, ["k1"]));
    expect(await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5)], [])).toBeNull();
    solver.run = always({ ...pass(2), ok: false });
    expect(await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5)], [])).toBeNull();
    expect(probes()).toEqual([]);
  });

  it("long probe work yields to waiting tasks, short work runs straight through", async () => {
    const seen = async (msPerSolve: number) => {
      let fired = false;
      const at: boolean[] = [];
      solver.run = async () => {
        at.push(fired);
        for (const t = performance.now(); performance.now() - t < msPerSolve;);
        return pass(3);
      };
      setTimeout(() => (fired = true), 0);
      await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5), circle("c", 27.3, -14.6, 8.4)], []);
      return at;
    };
    expect(await seen(0)).toEqual([false, false, false, false, false, false]);
    // 7 ms a solve: the first probe starts a fresh slice, by the last one at least one slice has run out
    const slow = await seen(7);
    expect([slow[0], slow[1], slow[5]]).toEqual([false, false, true]);
    expect(solver.calls.length).toBe(12);
  });

  it("a solver that fails to start gives null", async () => {
    solver.run = () => Promise.reject(new Error("The 2D constraint solver could not start"));
    expect(await shapeFreedom([line("a", 12.5, 7.25, 41.75, 23.5)], [])).toBeNull();
  });
});
