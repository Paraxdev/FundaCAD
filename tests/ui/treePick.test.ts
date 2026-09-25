import { afterEach, describe, expect, it } from "vitest";
import { awaitTreePick, endPickSession, resetTreePicks, routeTreeClick, treePickRefusal, treePickWaiting } from "../../src/ui/treePick";

const YZ = { kind: "basePlane", plane: "YZ" } as const;

function deps(busy: string | null = null) {
  const hints: string[] = [];
  return { hints, busyHint: () => busy, hint: (t: string) => hints.push(t) };
}

afterEach(resetTreePicks);

describe("routing a row click", () => {
  it("runs the row's own action when nothing is waiting", () => {
    const d = deps();
    expect(routeTreeClick(YZ, d)).toBe("row");
    expect(d.hints).toEqual([]);
  });

  it("offers the row to the waiting pick first", () => {
    let got: unknown = null;
    awaitTreePick((p) => { got = p; return true; }, () => {});
    expect(routeTreeClick(YZ, deps("busy"))).toBe("taken");
    expect(got).toEqual(YZ);
  });

  it("says why a refused row was refused, and keeps waiting", () => {
    awaitTreePick((p) => treePickRefusal(p, "one body"), () => {});
    const d = deps();
    expect(routeTreeClick(YZ, d)).toBe("refused");
    expect(d.hints).toEqual(["That row is a base plane, this step needs one body"]);
    expect(treePickWaiting()).toBe(true);
  });

  it("a busy tool that takes no rows refuses them with its hint", () => {
    const d = deps("finish it first");
    expect(routeTreeClick(YZ, d)).toBe("refused");
    expect(d.hints).toEqual(["finish it first"]);
  });

  it("one session at a time: a new wait ends the old one through its own cleanup", () => {
    const seen: string[] = [];
    let firstEnded = 0;
    awaitTreePick(() => { seen.push("first"); return true; }, () => { firstEnded++; });
    awaitTreePick(() => { seen.push("second"); return true; }, () => {});
    expect(firstEnded).toBe(1);
    routeTreeClick(YZ, deps());
    expect(seen).toEqual(["second"]);
  });

  it("ending the session runs its cleanup once, and a released session is not ended again", () => {
    let ended = 0;
    let release = () => {};
    release = awaitTreePick(() => true, () => { ended++; release(); });
    endPickSession();
    endPickSession();
    expect(ended).toBe(1);
    expect(treePickWaiting()).toBe(false);
    expect(routeTreeClick(YZ, deps())).toBe("row");
    const r2 = awaitTreePick(() => true, () => { ended++; });
    r2();
    endPickSession();
    expect(ended).toBe(1);
  });
});
