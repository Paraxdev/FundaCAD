import { describe, expect, it } from "vitest";

import { hashShapedStrings } from "../../src/document/geometryRefs";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

describe("hash shaped strings in a document", () => {
  it("finds one inside a feature this version does not know and inside an unknown top level key", () => {
    const doc = {
      version: 99,
      features: [{ id: "w1", type: "futureWidget", blob: A, params: { nested: [B] } }],
      futureKey: { ref: B },
    };
    expect([...hashShapedStrings(doc)].sort()).toEqual([A, B]);
  });

  it("leaves out a string one short, one too long or in uppercase", () => {
    expect(hashShapedStrings({ a: A.slice(1), b: A + "0", c: A.toUpperCase(), d: 12 }).size).toBe(0);
  });
});
