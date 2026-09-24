// A parameter bound to a value inside a list of a plugin feature's entries,
// `nodes.n2.sx`, addressed by the entry's id so it follows the entry.

import { afterEach, describe, expect, it } from "vitest";
import { featureNumFields, fieldHolder, readField, resolveTarget, writeTarget } from "../../src/document/numFields";
import { contribute } from "../../src/plugins/contrib";
import { referencesTo } from "../../src/params/engine";
import type { CadDocument } from "../../src/types";

function doc(): CadDocument {
  return {
    version: 5,
    features: [
      {
        id: "o1",
        type: "someNodes",
        blend: 1,
        nodes: [
          { id: "n1", x: 0, sx: 5 },
          { id: "n2", x: 10, sx: 3 },
        ],
        chains: [["n1", "n2"]],
      },
    ],
    parameters: {},
  } as unknown as CadDocument;
}

const target = { kind: "feature", feature: "o1", field: "nodes.n2.sx" } as const;

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

describe("nested field paths", () => {
  it("finds an entry by its id, not its place", () => {
    const d = doc();
    const f = d.features[0] as unknown as Record<string, unknown>;
    expect(readField(f, "nodes.n2.sx")).toBe(3);
    expect(readField(f, "blend")).toBe(1);
    expect(fieldHolder(f, "nodes.n9.sx")).toBeNull();
    expect(fieldHolder(f, "nodes.n2")).toBeNull();
    expect(fieldHolder(f, "blend.x")).toBeNull();
  });

  it("keeps resolving with nobody describing the type", () => {
    const rows = featureNumFields("someNodes", doc().features[0] as unknown as Record<string, unknown>);
    expect(rows.map(([f]) => f)).toEqual(["blend", "nodes.n1.x", "nodes.n1.sx", "nodes.n2.x", "nodes.n2.sx"]);
    const rt = resolveTarget(doc(), target);
    expect(rt?.field).toBe("sx");
    expect(rt?.holder["id"]).toBe("n2");
  });

  it("writes into the entry it names after the list is reordered", () => {
    const d = doc();
    const f = d.features[0] as unknown as { nodes: { id: string; sx: number }[] };
    f.nodes.reverse();
    const before = d.features[0];
    expect(writeTarget(d, target, 7)).toEqual({});
    expect(d.features[0]).not.toBe(before);
    const after = d.features[0] as unknown as { nodes: { id: string; sx: number }[] };
    expect(after.nodes.find((n) => n.id === "n2")?.sx).toBe(7);
    expect(after.nodes.find((n) => n.id === "n1")?.sx).toBe(5);
    expect(writeTarget(d, { ...target, field: "nodes.gone.sx" }, 7)).toBeNull();
  });

  it("asks a plugin that lists its rows from the feature's values", () => {
    off = contribute("Test.Nodes", {
      features: [{
        type: "someNodes",
        numFields: (values) => [
          ["blend", "Blend", "length"],
          ...((values["nodes"] as { id: string }[] | undefined) ?? []).map(
            (n) => [`nodes.${n.id}.sx`, `${n.id} size`, "length"] as [string, string, "length"],
          ),
        ],
      }],
    });
    const rows = featureNumFields("someNodes", doc().features[0] as unknown as Record<string, unknown>);
    expect(rows).toEqual([["blend", "Blend", "length"], ["nodes.n1.sx", "n1 size", "length"], ["nodes.n2.sx", "n2 size", "length"]]);
    expect(resolveTarget(doc(), target)?.kind).toBe("length");
    expect(resolveTarget(doc(), { ...target, field: "nodes.n2.x" })).toBeNull();
  });

  it("finds a bare parameter name inside an entry", () => {
    const d = doc();
    (d.features[0] as unknown as { nodes: Record<string, unknown>[] }).nodes[1]!["sx"] = "size";
    expect(referencesTo(d, "size")).toEqual(["someNodes o1 · nodes.n2.sx"]);
  });
});
