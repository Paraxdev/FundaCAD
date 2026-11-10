import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import {
  awaitTreePick,
  endCommandedPick,
  endPickSession,
  endRewoundPick,
  offerPicks,
  resetTreePicks,
  routeTreeClick,
  treePickRefusal,
  treePickWaiting,
  type NamedPick,
  type TreePickAnswer,
} from "../../src/ui/treePick";

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
    awaitTreePick(
      (p) => {
        got = p;
        return true;
      },
      () => {},
    );
    expect(routeTreeClick(YZ, deps("busy"))).toBe("taken");
    expect(got).toEqual(YZ);
  });

  it("says why a refused row was refused, and keeps waiting", () => {
    awaitTreePick(
      (p) => treePickRefusal(p, "one body"),
      () => {},
    );
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
    awaitTreePick(
      () => {
        seen.push("first");
        return true;
      },
      () => {
        firstEnded++;
      },
    );
    awaitTreePick(
      () => {
        seen.push("second");
        return true;
      },
      () => {},
    );
    expect(firstEnded).toBe(1);
    routeTreeClick(YZ, deps());
    expect(seen).toEqual(["second"]);
  });

  it("ending the session runs its cleanup once, and a released session is not ended again", () => {
    let ended = 0;
    let release = () => {};
    release = awaitTreePick(
      () => true,
      () => {
        ended++;
        release();
      },
    );
    endPickSession();
    endPickSession();
    expect(ended).toBe(1);
    expect(treePickWaiting()).toBe(false);
    expect(routeTreeClick(YZ, deps())).toBe("row");
    const r2 = awaitTreePick(
      () => true,
      () => {
        ended++;
      },
    );
    r2();
    endPickSession();
    expect(ended).toBe(1);
  });
  it("a rewind ends a waiting pick, but not one whose tool goes on through an undo", () => {
    const ended: string[] = [];
    awaitTreePick(
      () => true,
      () => ended.push("wait"),
    );
    endRewoundPick();
    expect([ended, treePickWaiting()]).toEqual([["wait"], false]);
    awaitTreePick(
      () => true,
      () => ended.push("tool"),
      { keepsOnRewind: true },
    );
    endRewoundPick();
    expect([ended, routeTreeClick(YZ, deps())]).toEqual([["wait"], "taken"]);
    endPickSession();
    expect(ended).toEqual(["wait", "tool"]);
  });

  it("a command ends a plain pick but not one that keeps on command", () => {
    const ended: string[] = [];
    awaitTreePick(
      () => true,
      () => ended.push("plain"),
    );
    endCommandedPick();
    expect([ended, treePickWaiting()]).toEqual([["plain"], false]);
    awaitTreePick(
      () => true,
      () => ended.push("tool"),
      { keepsOnCommand: true },
    );
    endCommandedPick();
    expect([ended, treePickWaiting()]).toEqual([["plain"], true]);
  });

  it("a new pick still ends one that keeps on command, and keeping on command is not keeping through a rewind", () => {
    const ended: string[] = [];
    awaitTreePick(
      () => true,
      () => ended.push("first"),
      { keepsOnCommand: true },
    );
    endRewoundPick();
    expect([ended, treePickWaiting()]).toEqual([["first"], false]);
    awaitTreePick(
      () => true,
      () => ended.push("second"),
      { keepsOnCommand: true },
    );
    awaitTreePick(
      () => true,
      () => ended.push("third"),
    );
    expect(ended).toEqual(["first", "second"]);
    expect(treePickWaiting()).toBe(true);
  });
});

describe("offering named picks", () => {
  const face = (faceId: number): NamedPick => ({
    pick: { kind: "face", faceId },
    name: `Flat face ${faceId} of Bracket`,
  });
  const edge = (n: number): NamedPick => ({
    pick: { kind: "edge", edge: { body: "b7", points: [[n, 2 * n, 3]] } as never },
    name: `Line edge ${n} of Bracket`,
  });

  function offering(answers: TreePickAnswer[], opts: { onTake?: (n: number) => void; batch?: boolean } = {}) {
    const log: string[] = [];
    const seen: unknown[] = [];
    let taken = 0;
    awaitTreePick(
      (pick) => {
        seen.push(pick);
        opts.onTake?.(seen.length);
        return answers[seen.length - 1] ?? true;
      },
      () => {},
      opts.batch ? { batch: (run) => (log.push("batch in"), run(), log.push("batch out")) } : {},
    );
    const d = {
      busyHint: () => null,
      hint: (t: string) => log.push(`hint: ${t}`),
      say: (t: string) => log.push(`say: ${t}`),
      taken: () => {
        taken++;
        log.push("taken");
      },
    };
    return { log, seen, d, taken: () => taken };
  }

  it("says nothing and calls no taker for no offers", () => {
    const o = offering([]);
    offerPicks([], o.d);
    expect([o.log, o.seen]).toEqual([[], []]);
  });

  it("says nothing with no session, whatever is offered", () => {
    const d = deps();
    const log: string[] = [];
    offerPicks([face(4), face(5)], { ...d, say: (t) => log.push(t), taken: () => log.push("taken") });
    expect([log, d.hints]).toEqual([[], []]);
  });

  it("names one pick taken with true as picked, and drops old refusals once", () => {
    const o = offering([true]);
    offerPicks([face(6)], o.d);
    expect(o.seen).toEqual([{ kind: "face", faceId: 6 }]);
    expect(o.log).toEqual(["taken", "say: Flat face 6 of Bracket picked"]);
  });

  it.each([
    ["added", "Line edge 3 of Bracket added"],
    ["takenOut", "Line edge 3 of Bracket taken out"],
    ["mirrorPlane", "Line edge 3 of Bracket is the mirror plane"],
  ] as const)("says the %s words for one pick", (done, words) => {
    const o = offering([{ done }]);
    offerPicks([edge(3)], o.d);
    expect(o.log).toEqual(["taken", `say: ${words}`]);
  });

  it("says a run of three taken with one word as a count with that word", () => {
    const o = offering([{ done: "added" }, { done: "added" }, { done: "added" }]);
    offerPicks([edge(1), edge(2), edge(3)], o.d);
    expect(o.seen).toHaveLength(3);
    expect(o.log).toEqual(["taken", "say: 3 rows added"]);
  });

  it("reads a pick's name only when one is taken, so a long run is never named row by row", () => {
    const reads: number[] = [];
    const named = (pick: NamedPick["pick"], n: number): NamedPick => ({
      pick,
      get name() {
        reads.push(n);
        return `Row ${n}`;
      },
    });
    const run = offering([true, true, true]);
    offerPicks([named(edge(1).pick, 1), named(edge(2).pick, 2), named(edge(3).pick, 3)], run.d);
    endPickSession();
    const one = offering([true, "x"]);
    offerPicks([named(edge(4).pick, 4), named(face(5).pick, 5)], one.d);
    expect([run.log, one.log, reads]).toEqual([
      ["taken", "say: 3 rows picked"],
      ["taken", "hint: Row 4 picked. x"],
      [4],
    ]);
  });

  it("says a run taken with mixed words as picked, and two rows as many", () => {
    const o = offering([{ done: "added" }, { done: "takenOut" }]);
    offerPicks([edge(4), edge(5)], o.d);
    expect(o.log).toEqual(["taken", "say: 2 rows picked"]);
  });

  it("a refusal first is the hint alone, nothing is said and nothing was taken", () => {
    const o = offering(["That row is an edge, this step needs a face"]);
    offerPicks([edge(2), face(9)], o.d);
    expect(o.seen).toHaveLength(1);
    expect(o.log).toEqual(["hint: That row is an edge, this step needs a face"]);
    expect(o.taken()).toBe(0);
  });

  it("a refusal after two taken says both in one hint and stops there", () => {
    const o = offering([true, true, "That row is a face, this step needs an edge"]);
    offerPicks([edge(1), edge(2), face(7), edge(4)], o.d);
    expect(o.seen).toHaveLength(3);
    expect(o.log).toEqual(["taken", "hint: 2 rows picked. That row is a face, this step needs an edge"]);
  });

  it("a refusal after one taken names that pick", () => {
    const o = offering([{ done: "added" }, "That row is a face, this step needs an edge"]);
    offerPicks([edge(6), face(7)], o.d);
    expect(o.log).toEqual(["taken", "hint: Line edge 6 of Bracket added. That row is a face, this step needs an edge"]);
  });

  it("joins the taken words and a refusal as the language does", async () => {
    const o = offering([{ done: "added" }, "x"]);
    await setLanguage("ja");
    let taken = "";
    try {
      offerPicks([edge(6), face(7)], o.d);
      taken = t("pick.done", { name: "Line edge 6 of Bracket", done: "added" });
    } finally {
      await setLanguage("system");
    }
    expect(taken).not.toBe(t("pick.done", { name: "Line edge 6 of Bracket", done: "added" }));
    expect(o.log).toEqual(["taken", `hint: ${taken}。x`]);
  });

  it("stops when a taker ends the session on the second offer, and says the two", () => {
    const o = offering([true, true], { onTake: (n) => n === 2 && endPickSession() });
    offerPicks([face(1), face(2), face(3), face(4)], o.d);
    expect(o.seen).toHaveLength(2);
    expect(o.log).toEqual(["taken", "say: 2 rows picked"]);
    expect(treePickWaiting()).toBe(false);
  });

  it("wraps the whole run in the session's batch once, and speaks after it", () => {
    const o = offering([true, true, true], { batch: true });
    offerPicks([face(1), face(2), face(3)], o.d);
    expect(o.log).toEqual(["batch in", "batch out", "taken", "say: 3 rows picked"]);
  });

  it("two offers in a row are two runs, each with its own batch", () => {
    const o = offering([true, true], { batch: true });
    offerPicks([face(1)], o.d);
    offerPicks([face(2)], o.d);
    expect(o.log.filter((l) => l === "batch in")).toHaveLength(2);
    expect(o.taken()).toBe(2);
  });

  it("routeTreeClick counts a done answer as taken", () => {
    const d = deps();
    awaitTreePick(
      () => ({ done: "added" }),
      () => {},
    );
    expect([routeTreeClick(YZ, d), d.hints]).toEqual(["taken", []]);
  });
});
