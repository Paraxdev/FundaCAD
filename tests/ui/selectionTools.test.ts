// The selection-driven offer, proved without a viewport.
//
// Every failure here is a version of "the app knows perfectly well that Fillet
// works on this, and still isn't offering it", the complaint
// features/toolCapabilities.ts was written to end, now one layer further up
// where the buttons are.

import { describe, it, expect } from "vitest";
import { TOOL_CAPABILITIES, TOOL_IDS } from "../../src/features/toolCapabilities";
import { allCommands } from "../../src/ui/commands";
import { iconPaths } from "../../src/ui/icons";
import {
  appearanceOffers,
  primaryKind,
  selectionOffers,
  toolbarOffers,
  type ToolOffer,
} from "../../src/ui/selectionTools";
import { applicableTools } from "../../src/features/toolCapabilities";

const labels = (offers: ToolOffer[]) => offers.map((o) => o.tool);

describe("the offer's shape", () => {
  it("names an icon that ui/icons.ts actually draws", () => {
    // The icon table is a Record over every ToolId, so a MISSING tool is a
    // compile error already. What the compiler cannot see is a name that no
    // pack defines: resolveIconPaths deliberately returns "" for an unknown
    // name rather than throwing, so a typo here ships as an invisible button
    // that still takes clicks.
    const seen = new Set<string>();
    for (const sel of [{ edge: 2 }, { face: 2 }, { body: 2 }, { "sketch-region": 2 }] as const) {
      for (const o of selectionOffers(sel)) {
        seen.add(o.tool);
        expect(iconPaths(o.iconName), `${o.tool} -> ${o.iconName}`).not.toBe("");
      }
    }
    // ...and between them those four selections reach every tool that consumes
    // a selection at all, so nothing in the table went unchecked.
    const consumesSelection = TOOL_IDS.filter((id) => TOOL_CAPABILITIES[id].source === "selection");
    expect([...seen].sort()).toEqual([...consumesSelection].sort());
  });

  it("only ever hands out action ids the app actually dispatches", () => {
    // A button whose click dispatches an id nothing handles is indistinguishable
    // from a broken tool. The single exception is declared as `action: null`,
    // never as a plausible-looking string.
    const known = new Set(allCommands().map((c) => c.id));
    for (const sel of [{ edge: 1 }, { face: 1 }, { body: 2 }, { "sketch-region": 2 }]) {
      for (const o of selectionOffers(sel)) {
        if (o.action !== null) expect(known.has(o.action)).toBe(true);
      }
    }
  });

  it("marks face delete as having no action id", () => {
    // It is dispatched through engine.deleteSelectedFace, not through the
    // action table; a caller that forgot would run nothing at all.
    const del = selectionOffers({ face: 1 }).find((o) => o.tool === "delete-face");
    expect(del?.action).toBeNull();
  });
});

describe("what a selection offers", () => {
  it("offers an edge the two blends and nothing else", () => {
    // Press/Pull consumes faces. Offering it beside a selected edge would be an
    // offer that cannot be taken.
    expect(labels(selectionOffers({ edge: 3 }))).toEqual(["fillet", "chamfer"]);
  });

  it("offers a face the blends too, not just Press/Pull", () => {
    // The headline of the capability table: a face is shorthand for all of its
    // edges. Before it, selecting a face and wanting a fillet meant going back
    // and picking twelve edges by hand.
    expect(labels(selectionOffers({ face: 1 }))).toContain("fillet");
    expect(labels(selectionOffers({ face: 1 }))).toContain("presspull");
  });

  it("never offers a tool that runs its own pick", () => {
    // Shell can act on a face, but a selected face does not make Shell runnable,
    // it would ignore the selection and ask for another click, which reads as
    // the button having done nothing.
    for (const sel of [{ face: 4 }, { edge: 2 }, { body: 1 }]) {
      expect(labels(selectionOffers(sel))).not.toContain("shell");
      expect(labels(selectionOffers(sel))).not.toContain("measure");
    }
  });

  it("ranks an edge over a face when both are selected", () => {
    // Must agree with app/viewportWiring.ts, which ranks the drag handle the
    // same way. Two affordances on one selection that disagreed about what is
    // selected is worse than either one being wrong alone.
    expect(primaryKind({ edge: 1, face: 2 })).toBe("edge");
    expect(primaryKind({ face: 2, "sketch-region": 1 })).toBe("sketch-region");
    expect(labels(selectionOffers({ edge: 1, face: 2 }))).toEqual(["fillet", "chamfer"]);
  });

  it("offers nothing at all for an empty selection", () => {
    // The toolbar's whole disappearing act rests on this being empty rather
    // than on the component remembering to check.
    expect(selectionOffers({})).toEqual([]);
    expect(toolbarOffers({})).toEqual([]);
  });
});

describe("shown versus live", () => {
  it("keeps Loft in the offer with one profile, and marks it not runnable", () => {
    // The offer is what CAN act on this kind of thing, which is the honest
    // answer for a menu: "Loft is here and it is grey because you have picked
    // one profile" beats silence. The bar filters on `enabled` itself.
    const one = selectionOffers({ "sketch-region": 1 });
    const loft = one.find((o) => o.tool === "loft");
    expect(loft).toBeDefined();
    expect(loft!.enabled).toBe(false);
    expect(one.find((o) => o.tool === "extrude")!.enabled).toBe(true);

    const two = selectionOffers({ "sketch-region": 2 });
    expect(two.map((o) => o.tool)).toEqual(one.map((o) => o.tool)); // same list...
    expect(two.find((o) => o.tool === "loft")!.enabled).toBe(true); // ...just live now
  });

  it("does not change the offer as the count changes", () => {
    const a = selectionOffers({ face: 1 });
    const b = selectionOffers({ face: 9 });
    expect(a.map((o) => o.tool)).toEqual(b.map((o) => o.tool));
  });
});

describe("the toolbar's cut", () => {
  it("shows only what can run", () => {
    const bar = toolbarOffers({ "sketch-region": 1 });
    expect(bar.every((o) => o.enabled)).toBe(true);
    expect(labels(bar)).not.toContain("loft");
  });

  it("carries every other live offer, uncapped", () => {
    // CONTROL on the line above: the cut has to be `enabled`, not a count. A
    // face feeds more tools than the bar's old five-button cap allowed, and
    // every one of them but the excluded verb has to be on it now that no pie
    // holds the overflow.
    const live = selectionOffers({ face: 2 }).filter((o) => o.enabled && o.tool !== "delete-face");
    // Four, not five: Texture used to be in this count and is a plugin now, so
    // a headless suite with nothing contributed sees one fewer. The number is
    // still a floor rather than an equality, because what the line is defending
    // is "the bar is not capped", not the size of the inventory.
    expect(live.length).toBeGreaterThan(3);
    expect(labels(toolbarOffers({ face: 2 }))).toEqual(labels(live));
  });

  it("does not carry the destructive verb", () => {
    // A hover bar is a button-sized piece of the part you are looking at, so a
    // stray click lands on geometry. "Remove this face and heal the solid" is
    // not something to keep there, it stays on Del and in the right-click
    // menu. It is still in the OFFER, which is what a menu ranks from.
    expect(labels(toolbarOffers({ face: 1 }))).not.toContain("delete-face");
    expect(labels(selectionOffers({ face: 1 }))).toContain("delete-face");
  });
});

describe("what a picked body is offered", () => {
  it("offers both patterns, which used to be ribbon-only", () => {
    // The gap this closed: Move and the three booleans consume the body
    // selection and were on the bar, Pattern consumes it in exactly the same
    // way (featureStarters.startPattern) and was not, so a picked part was one
    // click from Subtract and a menu hunt from a repeat.
    const one = labels(toolbarOffers({ body: 1 }));
    expect(one).toContain("pattern-linear");
    expect(one).toContain("pattern-circular");
    expect(one).toContain("move");
  });

  it("keeps the patterns live on ONE body, unlike the booleans", () => {
    // CONTROL, and the reason the rows carry no `min`: a pattern of one body is
    // the ordinary case, a boolean of one is not. If these ever grew a minimum
    // of two by being copied from the row above, this is the line that catches
    // it.
    const one = labels(toolbarOffers({ body: 1 }));
    expect(one).not.toContain("boolean-union");
    expect(labels(toolbarOffers({ body: 2 }))).toContain("boolean-union");
  });
});

describe("the appearance half", () => {
  it("offers a body its material and its visibility", () => {
    expect(appearanceOffers({ body: 1 }).map((o) => o.id)).toEqual(["material", "hide", "isolate"]);
  });

  it("says how many bodies it is about, once there is more than one", () => {
    // The bar has no room for a count of its own, so the verb carries it. A
    // "Hide" that silently took four parts with it is the kind of thing you
    // only notice two operations later.
    const many = appearanceOffers({ body: 4 });
    expect(many.map((o) => o.label)).toEqual(["Material for 4 bodies", "Hide 4 bodies", "Isolate 4 bodies"]);
    expect(appearanceOffers({ body: 1 }).map((o) => o.label)).toEqual(["Material", "Hide body", "Isolate body"]);
  });

  it("offers nothing for a selection a body does not win", () => {
    // "Hide" beside a picked face would be ambiguous about which of the two it
    // meant, and there is no such thing as hiding one face.
    for (const sel of [{}, { face: 3 }, { edge: 1 }, { "sketch-region": 2 }, { face: 2, body: 1 }]) {
      expect(appearanceOffers(sel)).toEqual([]);
    }
  });

  it("names marks ui/icons.ts actually draws", () => {
    for (const o of appearanceOffers({ body: 1 })) {
      expect(iconPaths(o.iconName), `${o.id} -> ${o.iconName}`).not.toBe("");
    }
  });

  it("stays OUT of the capability table", () => {
    // The line the split is on. features/toolCapabilities.ts answers "which
    // tools would this selection feed", and every answer it gives adds a
    // feature to the timeline. Material, Hide and Isolate write display-only
    // overlays, so a caller acting on applicableTools() must never be handed
    // one, and neither must the modelling half of the bar.
    const ids = new Set<string>(applicableTools({ body: 2 }));
    for (const o of appearanceOffers({ body: 2 })) expect(ids.has(o.id)).toBe(false);
    expect(labels(toolbarOffers({ body: 2 }))).not.toContain("material");
  });
});
