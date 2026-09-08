// The tool inventory, now that it is the application's half of one.
//
// Two things are worth testing separately and this file keeps them apart, which
// is the same split the module itself is written in:
//
//   the RULES, what a selection can feed, how a minimum is applied, which kind
//   a tool would take, are pure functions over a table they are handed, so they
//   are tested against tables written here, with no plugin registered and
//   nothing to reset.
//
//   the MERGE, the application's tools, then whatever is contributed, is the
//   impure part, and the only questions about it are about precedence and
//   lifetime.

import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_CAPABILITIES,
  TOOL_IDS,
  applicableTools,
  applicableToolsIn,
  canConsume,
  capabilities,
  capabilityOf,
  consumedKindOf,
  consumedKinds,
  coreCapabilities,
  minimumCount,
  toolsConsuming,
  toolsConsumingIn,
  type Capabilities,
  type ToolCapability,
} from "../../src/features/toolCapabilities";
import { contribute, resetContributions } from "../../src/plugins/contrib";

afterEach(() => resetContributions());

/** A table written here, so the rules below are measured against something this
 *  file controls rather than against whatever the application currently has. */
const TABLE: Capabilities = new Map<string, ToolCapability>([
  ["one-face", { label: "One Face", consumes: ["face"], source: "selection" }],
  ["two-bodies", { label: "Two Bodies", consumes: ["body"], source: "selection", min: 2 }],
  ["profile-then-face", { label: "Both", consumes: ["sketch-region", "face"], source: "selection" }],
  ["picks-its-own", { label: "Picks", consumes: ["face"], source: "pick" }],
]);

describe("the rules, over a table they are handed", () => {
  it("offers a tool whose kind is selected", () => {
    expect(applicableToolsIn(TABLE, { face: 1 })).toContain("one-face");
  });

  it("applies each tool's own minimum", () => {
    expect(applicableToolsIn(TABLE, { body: 1 })).not.toContain("two-bodies");
    expect(applicableToolsIn(TABLE, { body: 2 })).toContain("two-bodies");
  });

  // The distinction the whole `source` field exists for. A tool that runs its
  // own modal pick would IGNORE the selection, so offering it off one is an
  // offer that cannot be taken.
  it("never offers a tool that runs its own pick, however much is selected", () => {
    expect(applicableToolsIn(TABLE, { face: 9 })).not.toContain("picks-its-own");
    // ...and it is still in the honest full answer to "what acts on faces".
    expect(toolsConsumingIn(TABLE, "face")).toContain("picks-its-own");
    expect(toolsConsumingIn(TABLE, "face", "selection")).not.toContain("picks-its-own");
  });

  it("offers nothing for an empty selection", () => {
    expect(applicableToolsIn(TABLE, {})).toEqual([]);
  });

  it("keeps the table's own order, which is the order an affordance offers", () => {
    expect(applicableToolsIn(TABLE, { face: 2, body: 2, "sketch-region": 2 }))
      .toEqual(["one-face", "two-bodies", "profile-then-face"]);
  });
});

describe("the application's own inventory", () => {
  it("is what coreCapabilities hands back, entire", () => {
    const core = coreCapabilities();
    expect(core.size).toBe(TOOL_IDS.length);
    for (const id of TOOL_IDS) expect(core.get(id)).toBe(TOOL_CAPABILITIES[id]);
  });

  // Texture used to be a row here. Its absence is the measurement: the
  // application no longer knows a texture is a thing a face can feed.
  it("does not know the tool that became a plugin", () => {
    expect(coreCapabilities().has("texture")).toBe(false);
    expect(applicableTools({ face: 1 })).not.toContain("texture");
  });
});

describe("the merge", () => {
  const texture = {
    id: "texture",
    label: "Texture",
    iconName: "texture",
    consumes: ["face", "body"] as const,
    source: "selection" as const,
  };

  it("makes a contributed tool a peer: a face offers it", () => {
    contribute("T", { tools: [texture] });
    expect(applicableTools({ face: 1 })).toContain("texture");
    expect(toolsConsuming("body", "selection")).toContain("texture");
    expect(consumedKinds("texture")).toEqual(["face", "body"]);
    expect(canConsume("texture", "body")).toBe(true);
    expect(canConsume("texture", "edge")).toBe(false);
  });

  it("carries the icon name through, which is where a contributed mark comes from", () => {
    contribute("T", { tools: [texture] });
    expect(capabilityOf("texture")?.icon).toBe("texture");
  });

  it("puts the application's own tools first, so a plugin cannot lead the offer", () => {
    contribute("T", { tools: [texture] });
    const offered = applicableTools({ face: 1 });
    expect(offered.indexOf("texture")).toBe(offered.length - 1);
    expect(offered[0]).toBe("fillet");
  });

  // A plugin claiming an id the application already has keeps the application's
  // row. The worst a colliding plugin then achieves is a button of its own that
  // runs the application's tool, rather than a Fillet that quietly does
  // something else.
  it("refuses to let a plugin redefine one of the application's tools", () => {
    contribute("T", {
      tools: [{
        id: "fillet",
        label: "Not Fillet",
        iconName: "x",
        consumes: ["body"],
        source: "selection",
        min: 7,
      }],
    });
    expect(capabilityOf("fillet")?.label).toBe("Fillet");
    expect(minimumCount("fillet")).toBe(1);
    expect(canConsume("fillet", "edge")).toBe(true);
  });

  it("takes the tool out of the inventory when the plugin stops", () => {
    const off = contribute("T", { tools: [texture] });
    expect(capabilities().has("texture")).toBe(true);
    off();
    expect(capabilities().has("texture")).toBe(false);
    expect(applicableTools({ face: 1 })).not.toContain("texture");
  });

  // Every reader has to survive being asked about a tool that was there a moment
  // ago. A throw here lands inside a context menu or a render.
  it("answers about a tool nothing has, rather than throwing", () => {
    expect(capabilityOf("gone")).toBeNull();
    expect(consumedKinds("gone")).toEqual([]);
    expect(canConsume("gone", "face")).toBe(false);
    expect(minimumCount("gone")).toBe(1);
    expect(consumedKindOf("gone", { face: 1 })).toBeNull();
  });

  it("honours a contributed minimum", () => {
    contribute("T", {
      tools: [{ ...texture, id: "pair", consumes: ["body"], min: 2 }],
    });
    expect(minimumCount("pair")).toBe(2);
    expect(applicableTools({ body: 1 })).not.toContain("pair");
    expect(applicableTools({ body: 2 })).toContain("pair");
  });

  it("gives a contributed tool the kind it prefers when a selection holds both", () => {
    contribute("T", { tools: [texture] });
    expect(consumedKindOf("texture", { face: 1, body: 1 })).toBe("face");
    expect(consumedKindOf("texture", { body: 1 })).toBe("body");
  });
});
