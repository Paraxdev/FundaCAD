// What a feature is applied to, read and written without a scene.
//
// The failures this catches are all the same shape and all silent: a target that
// reads empty when the document has geometry in it. The row then says "nothing
// selected" over a fillet that is visibly rounding four edges, and the editor
// that opens from that row starts from an empty set — so pressing Done would
// wipe the selection the row failed to see.

import { describe, it, expect } from "vitest";
import {
  FEATURE_TARGETS,
  describeTarget,
  pointOf,
  readTarget,
  sameEntry,
  targetsOf,
  writeTarget,
  type TargetField,
} from "../../src/features/selectionTargets";
import { FEATURE_META } from "../../src/ui/featureMeta";
import type { Feature, Selector } from "../../src/types";

const at = (x: number, y: number, z: number): Selector =>
  ({ kind: "edge", by: "nearest", point: [x, y, z] });
const faceAt = (x: number, y: number, z: number): Selector =>
  ({ kind: "face", by: "nearest", point: [x, y, z] });

const field = (type: string, name: string): TargetField =>
  targetsOf(type).find((t) => t.field === name)!;

const feat = (f: Record<string, unknown>) => f as unknown as Feature;

describe("the inventory", () => {
  it("names only feature types that exist", () => {
    // A typo'd key is a target that silently never appears, on a feature that
    // silently keeps no editable selection.
    for (const type of Object.keys(FEATURE_TARGETS)) {
      expect(FEATURE_META, type).toHaveProperty(type);
    }
  });

  it("gives every target a label, and no feature two rows with the same one", () => {
    for (const [type, targets] of Object.entries(FEATURE_TARGETS)) {
      const labels = (targets ?? []).map((t) => t.label);
      for (const l of labels) expect(l, type).toBeTruthy();
      // The boolean has two body targets, and two rows both reading "Bodies"
      // would be two controls nobody can tell apart — over the one decision
      // (which body survives a Subtract) that the labels exist to state.
      expect(new Set(labels).size, type).toBe(labels.length);
    }
  });

  it("answers with an empty list for a feature that has no selection", () => {
    // Not undefined: every caller iterates this, and a primitive is a legitimate
    // feature with nothing to be applied to.
    expect(targetsOf("box")).toEqual([]);
    expect(targetsOf("datumPlane")).toEqual([]);
    expect(targetsOf("nonsense")).toEqual([]);
  });
});

describe("reading a target the document actually contains", () => {
  it("reads an array field", () => {
    const f = feat({ id: "a", type: "fillet", edges: [at(0, 0, 0), at(1, 0, 0)], radius: 2 });
    expect(readTarget(f, field("fillet", "edges"))).toHaveLength(2);
  });

  it("reads a bare selector where an array is declared", () => {
    // `faces` is typed `Selector | Selector[]` on every feature that has it, and
    // documents in the wild carry both. A reader that trusted the declared arity
    // would report a real one-face shell as acting on nothing.
    const f = feat({ id: "a", type: "shell", faces: faceAt(0, 0, 5), thickness: 2 });
    expect(readTarget(f, field("shell", "faces"))).toHaveLength(1);
  });

  it("reads an array where a bare selector is declared", () => {
    const f = feat({ id: "a", type: "press-pull", face: [faceAt(0, 0, 5)], distance: 3 });
    expect(readTarget(f, field("press-pull", "face"))).toHaveLength(1);
  });

  it("falls back to the singular field a feature also spells", () => {
    // Split says its target as `bodies` OR as `body`, and the builder prefers
    // `bodies`. Both are live, so both have to be read.
    const t = field("split", "bodies");
    expect(readTarget(feat({ id: "s", type: "split", keep: "both", body: "body2" }), t))
      .toEqual(["body2"]);
    expect(readTarget(feat({ id: "s", type: "split", keep: "both", bodies: ["body1", "body3"] }), t))
      .toEqual(["body1", "body3"]);
    // CONTROL on the precedence: with both present the plural wins, which is
    // what the builder does. Reading the singular here would show a row that
    // disagrees with the model on screen.
    expect(readTarget(
      feat({ id: "s", type: "split", keep: "both", body: "body2", bodies: ["body1"] }), t,
    )).toEqual(["body1"]);
  });

  it("reads an absent target as empty rather than as a hole", () => {
    for (const [type, targets] of Object.entries(FEATURE_TARGETS)) {
      for (const t of targets ?? []) {
        expect(readTarget(feat({ id: "x", type }), t), `${type}.${t.field}`).toEqual([]);
      }
    }
  });
});

describe("writing one back", () => {
  it("keeps an array field an array and a scalar field a scalar", () => {
    const many = writeTarget(field("fillet", "edges"), [at(0, 0, 0), at(1, 0, 0)]);
    expect(Array.isArray((many as Record<string, unknown>)["edges"])).toBe(true);

    const one = writeTarget(field("press-pull", "face"), [faceAt(0, 0, 5)]);
    expect(Array.isArray((one as Record<string, unknown>)["face"])).toBe(false);
  });

  it("drops the extras a scalar field cannot hold", () => {
    // Rather than storing an array the builder would misread as one selector
    // with a strange shape.
    const one = writeTarget(field("press-pull", "face"), [faceAt(0, 0, 5), faceAt(0, 0, 9)]);
    expect((one as Record<string, unknown>)["face"]).toEqual(faceAt(0, 0, 5));
  });

  it("deletes an emptied field instead of writing an empty array", () => {
    // Several of these mean something specific when ABSENT — a shell with no
    // faces is a sealed hollow — and every writer in the document keeps the
    // omit-when-empty discipline that makes two identical models compare byte
    // for byte.
    const patch = writeTarget(field("shell", "faces"), []) as Record<string, unknown>;
    expect("faces" in patch).toBe(true);
    expect(patch["faces"]).toBeUndefined();
  });

  it("clears the singular twin so a split cannot disagree with itself", () => {
    const patch = writeTarget(field("split", "bodies"), ["body3"]) as Record<string, unknown>;
    expect(patch["bodies"]).toEqual(["body3"]);
    // Left behind, `body` would be a stale second answer sitting in the file
    // waiting for a reader that prefers it.
    expect(patch["body"]).toBeUndefined();
  });

  it("round-trips", () => {
    const t = field("fillet", "edges");
    const entries = [at(0, 0, 0), at(1, 2, 3)];
    const f = feat({ id: "a", type: "fillet", radius: 2, ...writeTarget(t, entries) });
    expect(readTarget(f, t)).toEqual(entries);
  });
});

describe("identity", () => {
  it("matches two picks of the same edge, and separates two edges", () => {
    expect(sameEntry(at(1, 2, 3), at(1, 2, 3))).toBe(true);
    expect(sameEntry(at(1, 2, 3), at(1, 2, 4))).toBe(false);
  });

  it("tolerates the rounding a point survives a round trip through the sidecar with", () => {
    // Points come back rounded to six decimals; the document keeps full
    // precision. Compared exactly, every entry would fail to match itself after
    // one rebuild and the remove button would remove nothing.
    expect(sameEntry(at(1.0000001, 2, 3), at(1, 2, 3))).toBe(true);
    // CONTROL: the tolerance is far below any modelling distance, so it cannot
    // start merging genuinely different edges.
    expect(sameEntry(at(1.01, 2, 3), at(1, 2, 3))).toBe(false);
  });

  it("compares body ids by value", () => {
    expect(sameEntry("body1", "body1")).toBe(true);
    expect(sameEntry("body1", "body2")).toBe(false);
    // A body id and a selector are never the same thing, whatever they contain.
    expect(sameEntry("body1", at(0, 0, 0))).toBe(false);
  });

  it("compares pointless selectors whole", () => {
    const all: Selector = { kind: "edge", by: "all" };
    const axis: Selector = { kind: "edge", by: "axis", axis: "Z" };
    expect(sameEntry(all, { kind: "edge", by: "all" })).toBe(true);
    expect(sameEntry(all, axis)).toBe(false);
    // And never equal to a picked one, which is the case that would let a
    // remove silently take out "every edge" while claiming to take out one.
    expect(sameEntry(all, at(0, 0, 0))).toBe(false);
    expect(pointOf(all)).toBeNull();
    expect(pointOf(at(1, 2, 3))).toEqual([1, 2, 3]);
  });
});

describe("what the row says", () => {
  it("counts, and agrees with itself about the plural", () => {
    expect(describeTarget(field("fillet", "edges"), 1)).toBe("1 edge");
    expect(describeTarget(field("fillet", "edges"), 4)).toBe("4 edges");
    expect(describeTarget(field("boolean", "tools"), 2)).toBe("2 bodies");
  });

  it("says what empty MEANS where empty means something", () => {
    // "0 faces" and "sealed hollow" are opposite answers, and a count alone
    // cannot tell them apart — which is the whole reason whenEmpty exists.
    expect(describeTarget(field("shell", "faces"), 0)).toBe("sealed hollow");
    expect(describeTarget(field("thicken", "faces"), 0)).toBe("the whole body");
    expect(describeTarget(field("move", "bodies"), 0)).toBe("the active body");
    // ...and says so plainly where it does not.
    expect(describeTarget(field("fillet", "edges"), 0)).toBe("nothing selected");
  });
});

describe("profile targets", () => {
  it("gives an extrude the row for the half that was never shown", () => {
    const t = targetsOf("extrude")[0]!;
    expect(t.label).toBe("Profile");
    expect(t.shape).toBe("regionPoint");
  });

  it("counts profile areas in the word the picker uses", () => {
    const t = targetsOf("extrude")[0]!;
    expect(describeTarget(t, 1)).toBe("1 area");
    expect(describeTarget(t, 3)).toBe("3 areas");
  });

  it("says what an extrude with no areas actually does", () => {
    // Not "0 areas": an extrude that names none takes the WHOLE sketch, which
    // is the opposite statement.
    expect(describeTarget(targetsOf("extrude")[0]!, 0)).toBe("the whole sketch");
  });

  it("reads the plural field, and falls back to the legacy singular", () => {
    const t = targetsOf("extrude")[0]!;
    const many = { id: "e", type: "extrude", sketch: "s", distance: 5, operation: "new",
      regions: [[0, 0, 0], [10, 0, 0]] } as unknown as Feature;
    const one = { id: "e", type: "extrude", sketch: "s", distance: 5, operation: "new",
      region: [4, 4, 0] } as unknown as Feature;
    expect(readTarget(many, t)).toHaveLength(2);
    expect(readTarget(one, t)).toEqual([[4, 4, 0]]);
  });

  it("does not read one profile point as three areas", () => {
    // A point IS an array, so the obvious `Array.isArray(val) ? val : [val]`
    // spreads the legacy singular into its coordinates and reports "3 areas"
    // over an extrude that uses one.
    const t = targetsOf("extrude")[0]!;
    const one = { id: "e", type: "extrude", sketch: "s", distance: 5, operation: "new",
      region: [4, 4, 0] } as unknown as Feature;
    expect(readTarget(one, t)).toHaveLength(1);
    expect(describeTarget(t, readTarget(one, t).length)).toBe("1 area");
  });

  it("compares profile points by position, like a picked selector", () => {
    expect(sameEntry([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameEntry([1, 2, 3], [1, 2, 3.00001])).toBe(true);
    expect(sameEntry([1, 2, 3], [1, 2, 9])).toBe(false);
  });

  it("never confuses a profile point with a body id or a selector", () => {
    expect(sameEntry([0, 0, 0], "body1")).toBe(false);
    expect(sameEntry([0, 0, 0], { kind: "edge", by: "nearest", point: [0, 0, 0] })).toBe(false);
  });

  it("leaves loft out, because its profiles are pairs and not points", () => {
    // A row reporting "3 areas" while dropping which sketch each came from is a
    // row that cannot be written back.
    expect(targetsOf("loft")).toHaveLength(0);
  });
});
