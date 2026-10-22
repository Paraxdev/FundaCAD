// migrateDocument at the edges of its steps: the count of parameters, the
// version each rewrite stops at, and ids it must not repeat.
import { describe, expect, it, vi } from "vitest";
import { migrateDocument } from "../../src/document/migrate";
import type { CadDocument } from "../../src/types";
import { opened, saved } from "./storeKit";

vi.stubGlobal("window", globalThis);

const doc = (d: Record<string, unknown>) => ({ parameters: {}, features: [], ...d }) as unknown as CadDocument;
type Raw = Record<string, any>;

describe("paramDefs rows for user parameters", () => {
  it("seeds a row for none, one and many parameters", () => {
    const rows = (parameters: Record<string, number>) => {
      const d = doc({ version: 10, parameters });
      migrateDocument(d);
      return d.paramDefs;
    };
    expect(rows({})).toBeUndefined();
    expect(rows({ w: 4.5 })).toEqual({ w: { expr: "4.5", value: 4.5, unit: "mm" } });
    expect(rows({ w: 4.5, h: -2.25, n: 6 })).toEqual({
      w: { expr: "4.5", value: 4.5, unit: "mm" },
      h: { expr: "-2.25", value: -2.25, unit: "mm" },
      n: { expr: "6", value: 6, unit: "mm" },
    });
  });

  it("keeps the one row of a single parameter through open and save", () => {
    expect(saved(opened({ parameters: { w: 4.5 } })).paramDefs).toEqual({ w: { expr: "4.5", value: 4.5, unit: "mm" } });
  });

  it("removes an empty table and keeps one that has rows", () => {
    const empty = doc({ version: 10, paramDefs: {} });
    migrateDocument(empty);
    expect("paramDefs" in empty).toBe(false);
    const kept = doc({ version: 10, paramDefs: { t: { expr: "3", value: 3, unit: "deg" } } });
    migrateDocument(kept);
    expect(kept.paramDefs).toEqual({ t: { expr: "3", value: 3, unit: "deg" } });
  });

  it("rebinds the first of two rows that target one field", () => {
    const target = { kind: "feature", feature: "bx", field: "length" };
    const d = doc({ version: 10, parameters: { b: 20.5 }, paramDefs: {
      d1: { expr: "a", value: 1, unit: "mm", target }, d2: { expr: "a", value: 1, unit: "mm", target } },
      features: [{ id: "bx", type: "box", length: "b", width: 5, height: 5 }] }) as Raw;
    migrateDocument(d as CadDocument);
    expect(d.paramDefs.d1).toEqual({ expr: "b", value: 20.5, unit: "mm", target });
    expect(d.paramDefs.d2).toEqual({ expr: "a", value: 1, unit: "mm", target });
    expect(d.features[0].length).toBe(20.5);
  });
});

describe("the v8 combine rewrite", () => {
  const combine = () => ({ id: "c", type: "combine", operation: "cut", target: "body1", tools: ["body2"], keepTools: true });
  it("runs on a version 8 file and stops at version 9", () => {
    const v8 = doc({ version: 8, features: [combine()] }) as Raw;
    migrateDocument(v8 as CadDocument);
    expect(v8.features).toEqual([{ id: "c", type: "boolean", operation: "subtract", target: "body1", tools: ["body2"], keepOriginals: true }]);
    for (const version of [9, 10]) {
      const later = doc({ version, features: [combine()] }) as Raw;
      migrateDocument(later as CadDocument);
      expect(later.features, String(version)).toEqual([combine()]);
    }
  });
});

describe("the v1 polygon angle", () => {
  const polygon = (angle: unknown) => ({ type: "polygon", id: "e1", x: 3.5, y: -1.25, radius: 5, sides: 6, angle });
  const sketch = (angle: unknown, version?: unknown) =>
    doc({ ...(version === undefined ? {} : { version }), parameters: { tw: Math.PI / 2 },
      features: [{ id: "s", type: "sketch", plane: "XY", entities: [polygon(angle)] }] }) as Raw;

  it("turns radians into degrees in an unstamped, a null-stamped and a v1 file, not in a v2 one", () => {
    for (const version of [undefined, null, 1]) {
      const d = sketch(Math.PI / 3, version);
      migrateDocument(d as CadDocument);
      expect(d.features[0].entities[0].angle, String(version)).toBeCloseTo(60, 9);
    }
    const v2 = sketch(Math.PI / 3, 2);
    migrateDocument(v2 as CadDocument);
    expect(v2.features[0].entities[0].angle).toBe(Math.PI / 3);
  });

  it("binds an angle given as a parameter name to that parameter, as a number", () => {
    const d = sketch("tw");
    migrateDocument(d as CadDocument);
    const angle = d.features[0].entities[0].angle;
    expect(typeof angle).toBe("number");
    expect(Number.isFinite(angle)).toBe(true);
    const bound = Object.values(d.paramDefs as Record<string, Raw>).filter((r) => r.target);
    expect(bound.map((r) => [r.expr, r.unit, r.target])).toEqual([
      ["tw", "deg", { kind: "entity", sketch: "s", entity: "e1", field: "angle" }],
    ]);
  });
});

describe("dimension constraint ids", () => {
  it("stamps ids above the highest loaded one, never repeating one", () => {
    const d = doc({ version: 10, features: [{ id: "s", type: "sketch", plane: "XY", entities: [], constraints: [
      { type: "distance", id: "c900", line: "e1", value: 1.5 },
      { type: "radius", e: "e2", value: 2.25 },
      { type: "distance", id: "c12", line: "e3", value: 4 },
      { type: "radius", e: "e4", value: 0.75 },
    ] }] }) as Raw;
    migrateDocument(d as CadDocument);
    const got: string[] = d.features[0].constraints.map((c: Raw) => c.id);
    expect([got[0], got[2]]).toEqual(["c900", "c12"]);
    for (const id of [got[1]!, got[3]!]) {
      expect(id).toMatch(/^c\d+$/);
      expect(Number(id.slice(1))).toBeGreaterThan(900);
    }
    expect(new Set(got).size).toBe(4);
  });
});
