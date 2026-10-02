import { describe, expect, it } from "vitest";
import {
  KIND_COLORS, buildPrintabilityRequest, findingMarks, findingText, findingView, formatPrintabilityResult,
  newPrintabilitySetup, problemCount,
} from "../../src/ui/printability";
import type { PrintabilityFinding, PrintabilityReply } from "../../src/geometry/client";

// The pure half of the Printability panel: what it sends, how it words the
// reply, and the faces it tints.

function finding(over: Partial<PrintabilityFinding>): PrintabilityFinding {
  return {
    kind: "overhang", body: "body1", face: 3, other: null, value: 90, limit: 0, area: 132.4, low: 5,
    at: [10, 0, 5], extent: 4, note: "", ...over,
  };
}

describe("buildPrintabilityRequest", () => {
  it("sends every setting, +Z up and no checks list by default", () => {
    const r = buildPrintabilityRequest(newPrintabilitySetup(), ["body1", "body2"]);
    expect(r).toEqual({
      ok: true,
      options: { bodies: ["body1", "body2"], nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z" },
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

  it("says what is in the way, including a cleared field, which a number input reads as \"\"", () => {
    const msg = (edit: (s: ReturnType<typeof newPrintabilitySetup>) => void, bodies = ["body1"]) => {
      const s = newPrintabilitySetup();
      edit(s);
      const r = buildPrintabilityRequest(s, bodies);
      return r.ok ? "ok" : r.message;
    };
    const blank = "" as unknown as number;
    expect(msg(() => {}, [])).toBe("ok");
    expect(msg((s) => { s.nozzle = blank; })).toMatch(/nozzle/);
    expect(msg((s) => { s.layer = 0; })).toMatch(/layer/);
    expect(msg((s) => { s.overhang = 90; })).toMatch(/overhang/);
    expect(msg((s) => { s.minGap = -1; })).toMatch(/gap/);
    expect(msg((s) => { s.maxBridge = blank; })).toMatch(/bridge/);
    expect(msg((s) => { for (const k of Object.keys(s.checks) as (keyof typeof s.checks)[]) s.checks[k] = false; })).toMatch(/at least one/);
  });
});

describe("findingText", () => {
  const nameOf = (id: string) => ({ body2: "Lid" })[id] ?? id;
  it("words each kind in mm with its limit", () => {
    expect(findingText(finding({}), nameOf)).toBe("Overhang, 132 mm² leaning 90°");
    expect(findingText(finding({ kind: "wall", value: 0.6, limit: 0.8 }), nameOf)).toBe("Thin wall 0.6 mm (under 0.8)");
    expect(findingText(finding({ kind: "floor", value: 0.3, limit: 0.6 }), nameOf)).toBe("Thin floor 0.3 mm (under 0.6)");
    expect(findingText(finding({ kind: "gap", value: 0.1, limit: 0.2 }), nameOf)).toBe("Gap 0.1 mm will fuse");
    expect(findingText(finding({ kind: "bridge", value: 14, limit: 10 }), nameOf)).toBe("Bridge 14 mm span (over 10)");
    expect(findingText(finding({ kind: "meshHole", value: 1 }), nameOf)).toBe("Mesh has 1 open edge");
  });

  it("names the other body of a fused pair, touching or close", () => {
    const fused = finding({ kind: "fused", value: 0, other: { body: "body2", face: 9 } });
    expect(findingText(fused, nameOf)).toBe("Touches Lid, prints fused");
    expect(findingText({ ...fused, value: 0.05 }, nameOf)).toBe("0.05 mm from Lid, prints fused");
  });

  it("adds the engine's note after a comma", () => {
    expect(findingText(finding({ area: 4.25, value: 60.4, note: "partly bridged" }), nameOf)).toBe("Overhang, 4.25 mm² leaning 60°, partly bridged");
  });

  it("uses no dash as a sentence break", () => {
    for (const kind of ["overhang", "bridge", "wall", "floor", "gap", "fused", "meshHole"] as const) {
      expect(findingText(finding({ kind }), nameOf)).not.toMatch(/ - |\u2014/);
    }
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
    finding({ face: 3 }),
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
      ["Bracket", [], [[0, "Overhang, 132 mm² leaning 90°"], [1, "Thin wall 0.6 mm (under 0.8)"], [2, "Touches Lid, prints fused"]]],
      ["Lid", ["Open shell, 6 open edges", "2 separate pieces"], []],
      ["Pin", ["Inside out, may print hollow or not at all"], []],
    ]);
    expect(problemCount(v)).toBe(6);
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
    const marks = findingMarks(reply.findings, 2, 0xffd089, (body, face) => (body in start ? start[body]! + face : null));
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
