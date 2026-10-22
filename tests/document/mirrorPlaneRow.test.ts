import { describe, expect, it } from "vitest";
import { datumChoiceRow } from "../../src/document/optionFields";
import type { Feature } from "../../src/types";

const BASE = [
  { value: "XY", label: "XY" },
  { value: "XZ", label: "XZ" },
  { value: "YZ", label: "YZ" },
];

function docWith(plane: unknown, datums: { above: string[]; below: string[] }): { m: Feature; feats: Feature[] } {
  const m = { id: "mir1", type: "mirror", plane, bodies: ["body2"] } as unknown as Feature;
  const dp = (id: string) => ({ id, type: "datumPlane", plane: "XZ", offset: 7.5, name: `Tilted ${id}` });
  const feats = [
    { id: "sk1", type: "sketch", plane: "XY", entities: [] },
    ...datums.above.map(dp),
    m,
    ...datums.below.map(dp),
  ] as unknown as Feature[];
  return { m, feats };
}

describe("the Mirror Plane row", () => {
  it("lists the datum planes above the mirror and shows the one it names", () => {
    const { m, feats } = docWith({ name: "dp1" }, { above: ["dp1", "dp3"], below: ["dp2"] });
    expect(datumChoiceRow(m, "plane", feats)).toEqual({
      options: [...BASE, { value: "dp1", label: "Tilted dp1" }, { value: "dp3", label: "Tilted dp3" }],
      current: "dp1",
    });
  });

  it("marks a datum plane that is gone as missing", () => {
    const { m, feats } = docWith({ name: "dp9" }, { above: ["dp1"], below: [] });
    expect(datumChoiceRow(m, "plane", feats)).toEqual({
      options: [...BASE, { value: "dp1", label: "Tilted dp1" }, { value: "dp9", label: "dp9 (missing)" }],
      current: "dp9",
    });
  });

  it("does not offer a datum plane made below the mirror", () => {
    const { m, feats } = docWith({ name: "dp2" }, { above: [], below: ["dp2"] });
    expect(datumChoiceRow(m, "plane", feats)?.options.map((o) => o.value)).toEqual(["XY", "XZ", "YZ", "dp2"]);
    expect(datumChoiceRow(m, "plane", feats)?.options.at(-1)).toEqual({ value: "dp2", label: "dp2 (missing)" });
  });

  it("reads a base plane both bare and wrapped", () => {
    const bare = docWith("YZ", { above: [], below: [] });
    expect(datumChoiceRow(bare.m, "plane", bare.feats)).toEqual({ options: BASE, current: "YZ" });
    const wrapped = docWith({ name: "XZ" }, { above: [], below: [] });
    expect(datumChoiceRow(wrapped.m, "plane", wrapped.feats)).toEqual({ options: BASE, current: "XZ" });
  });

  it("leaves a plane field of another feature type alone", () => {
    const other = { id: "x1", type: "patternLinear", plane: "XY" } as unknown as Feature;
    expect(datumChoiceRow(other, "plane", [other])).toBeNull();
  });

  it("sees only its own document's datum planes when a second one is read", () => {
    const first = docWith({ name: "dp1" }, { above: ["dp1"], below: [] });
    expect(datumChoiceRow(first.m, "plane", first.feats)?.current).toBe("dp1");
    const second = docWith({ name: "dp4" }, { above: ["dp4"], below: [] });
    expect(datumChoiceRow(second.m, "plane", second.feats)).toEqual({
      options: [...BASE, { value: "dp4", label: "Tilted dp4" }],
      current: "dp4",
    });
  });
});
