import { describe, expect, it } from "vitest";
import { MERGE_MS, StressHistory, describeStressChange, setupKey } from "../../src/ui/stressHistory";
import { newLoad, newSetup, newSupport, type StressFaceSet, type StressSetup } from "../../src/ui/stress";

const faces = (point: number, faceIds: number[] = [7]): StressFaceSet => ({
  selectors: [{ kind: "face", by: "nearest", point: [point, 0, 0], body: "b1" }],
  faceIds,
  normalSum: [0, 0, 1],
  area: 2,
});

const empty = (): StressFaceSet => ({ selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 });

const copy = (s: StressSetup): StressSetup => JSON.parse(JSON.stringify(s)) as StressSetup;

function edit(s: StressSetup, change: (s: StressSetup) => void): StressSetup {
  const next = copy(s);
  change(next);
  return next;
}

describe("setupKey", () => {
  it("ignores the faces found on the current build, keeping only what the user picked", () => {
    const a = edit(newSetup("b1"), (s) => (s.supports[0]!.faces = faces(1, [7])));
    const b = edit(a, (s) => {
      s.supports[0]!.faces.faceIds = [9];
      s.supports[0]!.faces.normalSum = [1, 0, 0];
      s.supports[0]!.faces.area = 5;
      s.supports[0]!.faces.missing = 1;
      s.supports[0]!.faces.unshown = 0;
    });
    expect(setupKey(b)).toBe(setupKey(a));
    expect(setupKey(edit(a, (s) => (s.supports[0]!.faces = faces(2))))).not.toBe(setupKey(a));
  });

  it("reads an empty spot list the same as none", () => {
    const a = newSetup("b1");
    expect(setupKey(edit(a, (s) => (s.loads[0]!.spots = [])))).toBe(setupKey(a));
  });
});

describe("describeStressChange", () => {
  const base = newSetup("b1");
  const cases: [string, (s: StressSetup) => void, string, boolean][] = [
    ["body", (s) => (s.body = "b2"), "Body", false],
    ["support added", (s) => s.supports.push(newSupport(2)), "Add support", false],
    ["support removed", (s) => s.supports.splice(0, 1), "Remove support 1", false],
    ["support type", (s) => (s.supports[0]!.type = "pinned"), "Support 1 type", false],
    ["support faces", (s) => (s.supports[0]!.faces = faces(1)), "Support 1 faces", false],
    ["support spot", (s) => (s.supports[0]!.spots = [{ at: [0, 0, 0], radius: 2 }]), "Support 1 spots", false],
    ["load added", (s) => s.loads.push(newLoad(2)), "Add load", false],
    ["load removed", (s) => (s.loads = []), "Remove load 1", false],
    ["load kind", (s) => (s.loads[0]!.kind = "pressure"), "Load 1 kind", false],
    ["load faces", (s) => (s.loads[0]!.faces = faces(1)), "Load 1 faces", false],
    ["load force", (s) => (s.loads[0]!.force = 250), "Load 1 force", true],
    ["load direction", (s) => (s.loads[0]!.direction = "-Z"), "Load 1 direction", false],
    ["load custom vector", (s) => (s.loads[0]!.custom = [0, 0, 5]), "Load 1 direction", true],
    ["load pressure", (s) => (s.loads[0]!.pressure = 3), "Load 1 pressure", true],
    ["own weight", (s) => (s.gravity.on = true), "Own weight", false],
    ["own weight direction", (s) => (s.gravity.direction = "+X"), "Own weight", false],
    ["material", (s) => (s.material = "steel"), "Material", false],
    ["custom material value", (s) => (s.custom.E = 1234), "Material", true],
    ["mesh detail", (s) => (s.refine = "off"), "Mesh detail", false],
  ];
  for (const [what, change, label, merge] of cases)
    it(`names a ${what} change "${label}"`, () => {
      expect(describeStressChange(base, edit(base, change))).toEqual({ label, merge });
    });

  it("numbers rows as the panel shows them, not by id", () => {
    const two = edit(base, (s) => s.supports.push(newSupport(5)));
    expect(
      describeStressChange(
        two,
        edit(two, (s) => (s.supports[1]!.type = "slider")),
      ).label,
    ).toBe("Support 2 type");
    expect(
      describeStressChange(
        two,
        edit(two, (s) => s.supports.splice(1, 1)),
      ).label,
    ).toBe("Remove support 2");
  });

  it("names a spot's radius on its own, so dragging it is one step", () => {
    const a = edit(base, (s) => (s.loads[0]!.spots = [{ at: [0, 0, 0], radius: 2 }]));
    expect(
      describeStressChange(
        a,
        edit(a, (s) => (s.loads[0]!.spots![0]!.radius = 4)),
      ),
    ).toEqual({
      label: "Load 1 spot 1 radius",
      merge: true,
    });
  });

  it("names a Clear that empties faces and spots together", () => {
    const a = edit(base, (s) => {
      s.supports[0]!.faces = faces(1);
      s.supports[0]!.spots = [{ at: [0, 0, 0], radius: 2 }];
    });
    const cleared = edit(a, (s) => {
      s.supports[0]!.faces = empty();
      delete s.supports[0]!.spots;
    });
    expect(describeStressChange(a, cleared).label).toBe("Support 1 faces and spots");
  });

  it("reads a body change as Body even though it empties the rows", () => {
    const a = edit(base, (s) => (s.supports[0]!.faces = faces(1)));
    const moved = edit(a, (s) => {
      s.body = "b2";
      s.supports[0]!.faces = empty();
    });
    expect(describeStressChange(a, moved).label).toBe("Body");
  });

  it("names the first faces picked on a setup with no body by the row, though they pick the body too", () => {
    const none = newSetup(null);
    const picked = edit(none, (s) => {
      s.body = "b1";
      s.supports[0]!.faces = faces(1);
    });
    expect(describeStressChange(none, picked).label).toBe("Support 1 faces");
    expect(
      describeStressChange(
        none,
        edit(none, (s) => (s.body = "b1")),
      ).label,
    ).toBe("Body");
    const waiting = edit(none, (s) => (s.loads[0]!.faces = faces(3)));
    const chosen = edit(waiting, (s) => {
      s.body = "b2";
      s.loads[0]!.faces = empty();
    });
    expect(describeStressChange(waiting, chosen).label, "faces waiting for a body are dropped with it").toBe("Body");
  });
});

describe("StressHistory", () => {
  const start = newSetup("b1");
  const withFaces = edit(start, (s) => (s.supports[0]!.faces = faces(1)));

  it("undoes and redoes a step, naming it", () => {
    const h = new StressHistory();
    h.reset(start);
    h.note(withFaces, 0);
    expect(h.canUndo).toBe(true);
    const undone = h.undo(withFaces, 10);
    expect(undone?.label).toBe("Support 1 faces");
    expect(setupKey(undone!.setup)).toBe(setupKey(start));
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    const redone = h.redo(undone!.setup, 20);
    expect(redone?.label).toBe("Support 1 faces");
    expect(setupKey(redone!.setup)).toBe(setupKey(withFaces));
  });

  it("says nothing is left once every step is undone", () => {
    const h = new StressHistory();
    h.reset(start);
    expect(h.undo(start, 0)).toBeNull();
    expect(h.redo(start, 0)).toBeNull();
  });

  it("hands back copies, so editing the restored setup never rewrites a step", () => {
    const h = new StressHistory();
    h.reset(start);
    h.note(withFaces, 0);
    const undone = h.undo(withFaces, 10)!;
    undone.setup.body = "changed";
    expect(h.redo(undone.setup, 20)).toBeNull();
    expect(h.undo(undone.setup, 30)?.label).toBe("Body");
  });

  it("skips a change that only finds the faces again on a new build", () => {
    const h = new StressHistory();
    h.reset(withFaces);
    h.note(
      edit(withFaces, (s) => (s.supports[0]!.faces.faceIds = [12])),
      0,
    );
    expect(h.canUndo).toBe(false);
  });

  it("folds typing in one box into one step, and starts another after a pause", () => {
    const h = new StressHistory();
    h.reset(start);
    let s = start;
    for (const [force, at] of [
      [1, 0],
      [12, 200],
      [123, 400],
    ] as const) {
      s = edit(s, (x) => (x.loads[0]!.force = force));
      h.note(s, at);
    }
    s = edit(s, (x) => (x.loads[0]!.force = 1234));
    h.note(s, 400 + MERGE_MS + 1);
    const once = h.undo(s, 5000)!.setup;
    expect(once.loads[0]!.force).toBe(123);
    expect(h.undo(once, 5000)?.setup.loads[0]!.force).toBe(start.loads[0]!.force);
    expect(h.canUndo).toBe(false);
  });

  it("drops a step whose typing lands back where it began", () => {
    const h = new StressHistory();
    h.reset(start);
    h.note(
      edit(start, (x) => (x.loads[0]!.force = 5)),
      0,
    );
    h.note(start, 100);
    expect(h.canUndo).toBe(false);
  });

  it("never folds different fields together", () => {
    const h = new StressHistory();
    h.reset(start);
    const a = edit(start, (x) => (x.loads[0]!.force = 5));
    const b = edit(a, (x) => (x.loads[0]!.pressure = 2));
    h.note(a, 0);
    h.note(b, 100);
    const back = h.undo(b, 200)!;
    expect(back.label).toBe("Load 1 pressure");
    expect(h.undo(back.setup, 200)?.label).toBe("Load 1 force");
  });

  it("never folds a change into a step just undone and redone", () => {
    const h = new StressHistory();
    h.reset(start);
    const a = edit(start, (x) => (x.loads[0]!.force = 5));
    h.note(a, 0);
    const back = h.undo(a, 10)!.setup;
    const again = h.redo(back, 20)!.setup;
    const fifty = edit(again, (x) => (x.loads[0]!.force = 50));
    h.note(fifty, 30);
    expect(h.undo(fifty, 40)?.setup.loads[0]!.force).toBe(5);
  });

  it("banks a change not noted yet before undoing", () => {
    const h = new StressHistory();
    h.reset(start);
    expect(h.undo(withFaces, 0)?.label).toBe("Support 1 faces");
  });

  it("clears redo once a new change is made", () => {
    const h = new StressHistory();
    h.reset(start);
    h.note(withFaces, 0);
    const back = h.undo(withFaces, 10)!.setup;
    const other = edit(back, (x) => (x.gravity.on = true));
    h.note(other, 20);
    expect(h.canRedo).toBe(false);
    expect(h.redo(other, 30)).toBeNull();
  });

  it("forgets everything on reset", () => {
    const h = new StressHistory();
    h.reset(start);
    h.note(withFaces, 0);
    h.reset(withFaces);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most a hundred steps", () => {
    const h = new StressHistory();
    h.reset(start);
    let s = start;
    for (let i = 0; i < 120; i++) {
      s = edit(s, (x) => (x.supports[0]!.type = i % 2 ? "fixed" : "pinned"));
      h.note(s, i * 10_000);
    }
    let n = 0;
    for (let r = h.undo(s, 0); r; r = h.undo(r.setup, 0)) n++;
    expect(n).toBe(100);
  });
});
