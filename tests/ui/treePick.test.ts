import { afterEach, describe, expect, it } from "vitest";
import { awaitTreePick, resetTreePicks, routeTreeClick, treePickRefusal, treePickWaiting } from "../../src/ui/treePick";

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
    awaitTreePick((p) => { got = p; return true; });
    expect(routeTreeClick(YZ, deps("busy"))).toBe("taken");
    expect(got).toEqual(YZ);
  });

  it("says why a refused row was refused, and keeps waiting", () => {
    awaitTreePick((p) => treePickRefusal(p, "one body"));
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

  it("the latest wait answers, and releasing it hands back to the one before", () => {
    const seen: string[] = [];
    awaitTreePick(() => { seen.push("outer"); return true; });
    const release = awaitTreePick(() => { seen.push("inner"); return true; });
    routeTreeClick(YZ, deps());
    release();
    release();
    routeTreeClick(YZ, deps());
    expect(seen).toEqual(["inner", "outer"]);
  });
});
