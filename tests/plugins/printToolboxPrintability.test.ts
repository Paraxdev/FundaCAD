import { describe, expect, it } from "vitest";
import {
  KIND_COLORS,
  buildPrintabilityRequest,
  findingMarks,
  findingPlace,
  findingText,
  findingView,
  formatPrintabilityResult,
  newPrintabilitySetup,
  printabilitySummary,
  problemCount,
} from "../../plugins/FundaCAD.PrintToolbox/printability";
import type { PrintabilityFinding, PrintabilityReply } from "fundacad";

// The pure half of the toolbox's Printability panel: what it sends, how it
// words the reply, and the faces it tints.

function finding(over: Partial<PrintabilityFinding>): PrintabilityFinding {
  return {
    kind: "overhang",
    body: "body1",
    face: 3,
    other: null,
    value: 90,
    limit: 0,
    area: 132.4,
    low: 5,
    at: [10, 0, 5],
    extent: 4,
    note: "",
    ...over,
  };
}

describe("buildPrintabilityRequest", () => {
  it("sends every setting, +Z up and no checks list by default", () => {
    const r = buildPrintabilityRequest(newPrintabilitySetup(), ["body1", "body2"]);
    expect(r).toEqual({
      ok: true,
      options: {
        bodies: ["body1", "body2"],
        nozzle: 0.4,
        layer: 0.2,
        overhang: 45,
        minGap: 0.2,
        maxBridge: 10,
        up: "+Z",
      },
    });
  });

  it("sends layFlat in place of up, never both", () => {
    const s = newPrintabilitySetup();
    s.up = "-Y";
    s.layFlat = true;
    const r = buildPrintabilityRequest(s, ["body1"]);
    expect(r.ok && r.options.layFlat).toBe(true);
    expect(r.ok && "up" in r.options).toBe(false);
    s.layFlat = false;
    const again = buildPrintabilityRequest(s, ["body1"]);
    expect(again.ok && again.options.up).toBe("-Y");
    expect(again.ok && "layFlat" in again.options).toBe(false);
  });

  it("lists the checks only when some are off, in a fixed order", () => {
    const s = newPrintabilitySetup();
    s.checks.wall = false;
    s.checks.open = false;
    const r = buildPrintabilityRequest(s, ["body1"]);
    expect(r.ok && r.options.checks).toEqual(["overhang", "gap", "bridge"]);
  });

  it('says what is in the way, including a cleared field, which a number input reads as ""', () => {
    const msg = (edit: (s: ReturnType<typeof newPrintabilitySetup>) => void, bodies = ["body1"]) => {
      const s = newPrintabilitySetup();
      edit(s);
      const r = buildPrintabilityRequest(s, bodies);
      return r.ok ? "ok" : r.message;
    };
    const blank = "" as unknown as number;
    expect(msg(() => {}, [])).toBe("ok");
    expect(
      msg((s) => {
        s.nozzle = blank;
      }),
    ).toMatch(/nozzle/);
    expect(
      msg((s) => {
        s.layer = 0;
      }),
    ).toMatch(/layer/);
    expect(
      msg((s) => {
        s.overhang = 90;
      }),
    ).toMatch(/overhang/);
    expect(
      msg((s) => {
        s.minGap = -1;
      }),
    ).toMatch(/gap/);
    expect(
      msg((s) => {
        s.maxBridge = blank;
      }),
    ).toMatch(/bridge/);
    expect(
      msg((s) => {
        for (const k of Object.keys(s.checks) as (keyof typeof s.checks)[]) s.checks[k] = false;
      }),
    ).toMatch(/at least one/);
  });
});

describe("findingText", () => {
  const nameOf = (id: string) => ({ body2: "Lid" })[id] ?? id;
  it("words each kind in mm with its limit", () => {
    expect(findingText(finding({}), nameOf)).toBe("Overhang, 132 mm² leaning 90°");
    expect(findingText(finding({ kind: "wall", value: 0.6, limit: 0.8 }), nameOf)).toBe("Thin wall 0.6 mm (under 0.8)");
    expect(findingText(finding({ kind: "floor", value: 0.3, limit: 0.6 }), nameOf)).toBe(
      "Thin floor 0.3 mm (under 0.6)",
    );
    expect(findingText(finding({ kind: "gap", value: 0.1, limit: 0.2 }), nameOf)).toBe("Gap 0.1 mm will fuse");
    expect(findingText(finding({ kind: "bridge", value: 14, limit: 10 }), nameOf)).toBe("Bridge 14 mm span (over 10)");
    expect(findingText(finding({ kind: "meshHole", value: 1 }), nameOf)).toBe("Mesh has 1 open edge");
    expect(findingText(finding({ kind: "flatTriangle", value: 2 }), nameOf)).toBe("Mesh has 2 triangles without area");
  });

  it("names the other body of a fused pair, touching or close", () => {
    const fused = finding({ kind: "fused", value: 0, other: { body: "body2", face: 9 } });
    expect(findingText(fused, nameOf)).toBe("Touches Lid, prints fused");
    expect(findingText({ ...fused, value: 0.05 }, nameOf)).toBe("0.05 mm from Lid, prints fused");
  });

  it("adds the engine's note after a comma", () => {
    expect(findingText(finding({ area: 4.25, value: 60.4, note: "partly bridged" }), nameOf)).toBe(
      "Overhang, 4.25 mm² leaning 60°, partly bridged",
    );
  });

  it("uses no dash as a sentence break", () => {
    for (const kind of ["overhang", "bridge", "wall", "floor", "gap", "fused", "meshHole", "flatTriangle"] as const) {
      expect(findingText(finding({ kind }), nameOf)).not.toMatch(/ - |\u2014/);
    }
  });
});

describe("findingPlace", () => {
  const nameOf = (id: string) => ({ body2: "Lid" })[id] ?? id;
  const body = (over: Partial<PrintabilityReply["bodies"][number]>): PrintabilityReply["bodies"][number] => ({
    id: "body1",
    name: "Bracket",
    up: [0, 0, 1],
    bed: 3,
    bedFace: 1,
    openEdges: 0,
    solids: 1,
    insideOut: false,
    ...over,
  });

  it("places an overhang by its lowest point, not its middle", () => {
    // A slanted underside: its middle is 16 mm above the bed of 3, its low edge 11.25.
    const f = finding({ face: 7, at: [37.5, -12, 19], low: 11.25 });
    expect(findingPlace(f, [body({})], nameOf)).toEqual({
      hint: "Face 8, from 11.25 mm above the bed",
      spoken: "face 8, from 11.25 mm above the bed",
    });
  });

  it("places any other finding by its middle, along a slanted up from the body's own bed", () => {
    // dot(at, up) = 7.2 + 15.2 = 22.4 with up (0, -0.6, 0.8), less the bed of 14.9
    const f = finding({ kind: "bridge", face: 0, at: [41, -12, 19], low: 0 });
    expect(findingPlace(f, [body({ up: [0, -0.6, 0.8], bed: 14.9 })], nameOf).spoken).toBe(
      "face 1, centred 7.5 mm above the bed",
    );
    expect(findingPlace(f, [body({ id: "body9" }), body({ up: [0, -0.6, 0.8], bed: 20 })], nameOf).spoken).toBe(
      "face 1, centred 2.4 mm above the bed",
    );
  });

  it("reads on the bed under a thousandth, and the height from there up", () => {
    const at = (h: number) => finding({ kind: "floor", face: 2, at: [5, 6, 3 + h], low: 0 });
    expect(findingPlace(at(0.0004), [body({})], nameOf).spoken).toBe("face 3, on the bed");
    expect(findingPlace(at(0), [body({})], nameOf).spoken).toBe("face 3, on the bed");
    expect(findingPlace(at(-0.002), [body({})], nameOf).spoken).toBe("face 3, on the bed");
    expect(findingPlace(at(0.06), [body({})], nameOf).spoken).toBe("face 3, centred 0.06 mm above the bed");
    expect(findingPlace(at(0.002), [body({})], nameOf).spoken).toBe("face 3, centred 0.002 mm above the bed");
    const low = (h: number) => finding({ face: 2, at: [5, 6, 9.5], low: h });
    expect(findingPlace(low(0.0004), [body({})], nameOf).spoken).toBe("face 3, from the bed up");
    expect(findingPlace(low(0), [body({})], nameOf).spoken).toBe("face 3, from the bed up");
    expect(findingPlace(low(0.06), [body({})], nameOf).spoken).toBe("face 3, from 0.06 mm above the bed");
    expect(findingPlace(low(0.002), [body({})], nameOf).spoken).toBe("face 3, from 0.002 mm above the bed");
  });

  it("gives no height for a body the reply does not list or a zero up", () => {
    const f = finding({ face: 4, at: [5, 6, 9] });
    expect(findingPlace(f, [], nameOf)).toEqual({ hint: "Face 5", spoken: "face 5" });
    expect(findingPlace(f, [body({ id: "body7" })], nameOf).spoken).toBe("face 5");
    expect(findingPlace(f, [body({ up: [0, 0, 0] })], nameOf).spoken).toBe("face 5");
    const wall = finding({ kind: "wall", face: 4, at: [5, 6, 9], low: 0 });
    expect(findingPlace(wall, [body({ id: "body7" })], nameOf).spoken).toBe("face 5");
    expect(findingPlace(wall, [body({ up: [0, 0, 0] })], nameOf).spoken).toBe("face 5");
  });

  it("names both faces of a pair, on one body or across two", () => {
    const wall = finding({ kind: "wall", face: 2, other: { body: "body1", face: 4 }, at: [1, 2, 8] });
    expect(findingPlace(wall, [body({})], nameOf)).toEqual({
      hint: "Faces 3 and 5, centred 5 mm above the bed",
      spoken: "faces 3 and 5, centred 5 mm above the bed",
    });
    const fused = finding({ kind: "fused", face: 2, other: { body: "body2", face: 8 }, at: [1, 2, 8] });
    expect(findingPlace(fused, [body({})], nameOf).spoken).toBe("face 3 and face 9 of Lid, centred 5 mm above the bed");
  });

  it("uses no dash as a sentence break", () => {
    const fused = finding({ kind: "fused", other: { body: "body2", face: 8 } });
    const p = findingPlace(fused, [body({})], nameOf);
    expect(p.hint + p.spoken).not.toMatch(/ - |\u2014/);
  });
});

const reply: PrintabilityReply = {
  header: "+Z up as modelled, bed at z = 0",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [
    { id: "body1", name: "Bracket", up: [0, 0, 1], bed: 0, bedFace: 2, openEdges: 0, solids: 1, insideOut: false },
    { id: "body2", name: "Lid", up: [0, 0, 1], bed: 0, bedFace: null, openEdges: 6, solids: 2, insideOut: false },
    { id: "body3", name: "Pin", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: true },
  ],
  findings: [
    finding({ face: 3, low: 2.5 }),
    finding({ kind: "wall", face: 4, value: 0.6, limit: 0.8, other: { body: "body1", face: 5 } }),
    finding({ kind: "fused", face: 6, value: 0, other: { body: "body2", face: 9 } }),
  ],
  errors: [{ feature_id: "f3", message: "fillet failed" }, { message: "a sketch is open" }],
};

describe("formatPrintabilityResult", () => {
  it("groups the findings by body in the reply's order, with body-level notes", () => {
    const v = formatPrintabilityResult(reply);
    expect(v.header).toBe(reply.header);
    expect(v.groups.map((g) => [g.name, g.notes, g.rows.map((r) => [r.index, r.text])])).toEqual([
      [
        "Bracket",
        [],
        [
          [0, "Overhang, 132 mm² leaning 90°"],
          [1, "Thin wall 0.6 mm (under 0.8)"],
          [2, "Touches Lid, prints fused"],
        ],
      ],
      ["Lid", ["Open shell, 6 open edges", "2 separate pieces"], []],
      ["Pin", ["Inside out, may print hollow or not at all"], []],
    ]);
    expect(problemCount(v)).toBe(6);
  });

  it("gives each row its place as a hint and in its spoken name", () => {
    const rows = formatPrintabilityResult(reply).groups[0]!.rows;
    expect(rows).toEqual([
      {
        index: 0,
        kind: "overhang",
        text: "Overhang, 132 mm² leaning 90°",
        hint: "Face 4, from 2.5 mm above the bed",
        spoken: "Overhang, 132 mm² leaning 90°, face 4, from 2.5 mm above the bed",
      },
      {
        index: 1,
        kind: "wall",
        text: "Thin wall 0.6 mm (under 0.8)",
        hint: "Faces 5 and 6, centred 5 mm above the bed",
        spoken: "Thin wall 0.6 mm (under 0.8), faces 5 and 6, centred 5 mm above the bed",
      },
      {
        index: 2,
        kind: "fused",
        text: "Touches Lid, prints fused",
        hint: "Face 7 and face 10 of Lid, centred 5 mm above the bed",
        spoken: "Touches Lid, prints fused, face 7 and face 10 of Lid, centred 5 mm above the bed",
      },
    ]);
  });

  it("lists the kinds found in legend order and the feature failures", () => {
    const v = formatPrintabilityResult(reply);
    expect(v.kinds).toEqual(["overhang", "wall", "fused"]);
    expect(v.errors).toEqual(["f3: fillet failed", "a sketch is open"]);
  });

  it("reads a reply where nothing built", () => {
    const v = formatPrintabilityResult({ ...reply, bodies: [], findings: [], errors: [{ message: "nothing built" }] });
    expect(v.groups).toEqual([]);
    expect(problemCount(v)).toBe(0);
    expect(v.errors).toEqual(["nothing built"]);
  });
});

describe("findingMarks", () => {
  const all = (_body: string, face: number) => face;
  it("tints each finding's faces, both sides of a pair, in its kind's colour, once per face", () => {
    const marks = findingMarks([...reply.findings, finding({ face: 3 })], null, 0xffffff, all);
    expect(marks).toEqual([
      { faceIds: [3], color: KIND_COLORS.overhang },
      { faceIds: [4, 5], color: KIND_COLORS.wall },
      { faceIds: [6, 9], color: KIND_COLORS.fused },
    ]);
  });

  it("puts one finding forward with its facing face, out of its kind's tint", () => {
    const marks = findingMarks(reply.findings, 1, 0xffd089, all);
    expect(marks).toEqual([
      { faceIds: [3], color: KIND_COLORS.overhang },
      { faceIds: [6, 9], color: KIND_COLORS.fused },
      { faceIds: [4, 5], color: 0xffd089 },
    ]);
  });

  it("numbers the faces as the viewport does, and leaves out what cannot be shown", () => {
    const start: Record<string, number> = { body1: 100 };
    const marks = findingMarks(reply.findings, 2, 0xffd089, (body, face) =>
      body in start ? start[body]! + face : null,
    );
    expect(marks).toEqual([
      { faceIds: [103], color: KIND_COLORS.overhang },
      { faceIds: [104, 105], color: KIND_COLORS.wall },
      { faceIds: [106], color: 0xffd089 },
    ]);
  });
});

describe("findingView", () => {
  it("looks about twice the finding's size across, at least 5 mm", () => {
    expect(findingView(finding({ extent: 12 }))).toEqual({ at: [10, 0, 5], size: 24 });
    expect(findingView(finding({ extent: 0.5 }))).toEqual({ at: [10, 0, 5], size: 5 });
    expect(findingView(finding({ extent: NaN })).size).toBe(5);
  });
});

describe("printabilitySummary", () => {
  const one: PrintabilityReply["bodies"][number] = {
    id: "body1",
    name: "Bracket",
    up: [0, 0, 1],
    bed: 0,
    bedFace: 2,
    openEdges: 0,
    solids: 1,
    insideOut: false,
  };
  const summary = (r: Partial<PrintabilityReply>) => printabilitySummary(formatPrintabilityResult({ ...reply, ...r }));

  it("says nothing was found, and still counts feature failures", () => {
    expect(summary({ bodies: [one], findings: [], errors: [] })).toBe("Printability: nothing found.");
    expect(summary({ bodies: [], findings: [], errors: [{ message: "nothing built" }] })).toBe(
      "Printability: nothing found. 1 error.",
    );
  });

  it("names the one overhang's area and face, singular, without a body name on a lone body", () => {
    expect(summary({ bodies: [one], findings: [finding({ face: 3 })], errors: [] })).toBe(
      "Printability: 1 thing to look at. 1 overhang. The overhang is 132 mm² on face 4.",
    );
  });

  it("counts each kind, the body notes and the errors, and names the largest overhang's body", () => {
    expect(summary({})).toBe(
      "Printability: 6 things to look at. 1 overhang, 1 thin wall, 1 fused spot, 3 body notes, 2 errors. " +
        "The overhang is 132 mm² on face 4 of Bracket.",
    );
  });

  it("picks the largest of three overhangs, on a later body, and the first of a tie", () => {
    const f = [
      finding({ face: 1, area: 80.2, body: "body1" }),
      finding({ face: 8, area: 540.6, body: "body2" }),
      finding({ face: 4, area: 540.6, body: "body1" }),
      finding({ kind: "wall", face: 2, area: 9000 }),
    ];
    expect(summary({ findings: f, errors: [], bodies: reply.bodies.slice(0, 2) })).toBe(
      "Printability: 6 things to look at. 3 overhangs, 1 thin wall, 2 body notes. Largest overhang 541 mm² on face 9 of Lid.",
    );
    const tie = [f[2]!, f[1]!];
    expect(summary({ findings: tie, errors: [], bodies: reply.bodies.slice(0, 2) })).toContain("on face 5 of Bracket");
  });

  it("reads a small area to the hundredth, and a wall alone has no overhang sentence", () => {
    expect(summary({ bodies: [one], findings: [finding({ area: 3.46, face: 0 })], errors: [] })).toContain(
      "is 3.46 mm² on face 1",
    );
    expect(summary({ bodies: [one], findings: [finding({ kind: "gap", face: 0 })], errors: [] })).toBe(
      "Printability: 1 thing to look at. 1 gap.",
    );
  });

  it("uses no dash as a sentence break", () => {
    expect(summary({})).not.toMatch(/ - |\u2014|\u2013/);
  });
});
