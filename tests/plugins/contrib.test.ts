// The table between the app's surfaces and the plugins that fill them.
//
// Everything here is about one of two things: that a contribution ARRIVES at
// the surface that reads it, and that it LEAVES when the plugin stops. The
// second is the half that decays quietly — a menu row that outlives its
// capability is a button that throws, and a paint map that outlives one is a
// model wearing colours from a feature that is switched off — so nearly every
// case below has an "and then it stopped" half.

import { afterEach, describe, expect, it } from "vitest";

import {
  announceImportedBody,
  contribute,
  contributedAction,
  contributedActionIds,
  contributedBodyMenu,
  contributedBrowserSections,
  contributedMenus,
  contributedOverlays,
  contributedPaint,
  contributedPalette,
  contributedRibbon,
  contributors,
  onContribChange,
  resetContributions,
  service,
} from "../../src/plugins/contrib";

afterEach(() => resetContributions());

/** A stand-in for a Vue component. Nothing here looks inside one. */
const Fake = { name: "Fake" } as unknown as never;

describe("what a plugin adds, and what it takes away again", () => {
  it("hands each surface what was contributed to it", () => {
    contribute("A.One", {
      menus: [{ menu: "File", items: [{ label: "Do it" }] }],
      ribbon: [{ group: "PRINT", items: [{ action: "go", label: "Go", iconName: "print" }] }],
      actions: { go: () => {} },
      overlays: [Fake],
      bodyMenu: (id) => [{ label: `about ${id}` }],
      browserSections: [{ key: "panel", component: Fake }],
      paint: () => ({ bodies: { b1: "#ff0000" }, faces: { 3: "#00ff00" } }),
      palette: () => [{ name: "Red", color: "#ff0000" }],
    });

    expect(contributedMenus().map((m) => m.menu)).toEqual(["File"]);
    expect(contributedRibbon().map((r) => r.group)).toEqual(["PRINT"]);
    expect(contributedActionIds()).toEqual(["go"]);
    expect(contributedOverlays()).toHaveLength(1);
    expect(contributedBodyMenu("b1").map((i) => i.label)).toEqual(["about b1"]);
    expect(contributedBrowserSections()).toHaveLength(1);
    expect(contributedPaint()).toEqual({ bodies: { b1: "#ff0000" }, faces: { 3: "#00ff00" } });
    expect(contributedPalette()).toEqual([{ name: "Red", color: "#ff0000" }]);
    expect(contributors()).toEqual(["A.One"]);
  });

  it("takes every one of them away when the plugin stops", () => {
    // The control for the case above, and the one that actually matters: a
    // registry that only ever accumulates would pass every arrival test in this
    // file and would leave a switched-off capability's menu rows, overlays and
    // paint on screen until the window was reloaded.
    const off = contribute("A.One", {
      menus: [{ menu: "File", items: [{ label: "Do it" }] }],
      ribbon: [{ group: "PRINT", items: [{ action: "go", label: "Go", iconName: "print" }] }],
      actions: { go: () => {} },
      overlays: [Fake],
      bodyMenu: () => [{ label: "x" }],
      browserSections: [{ key: "panel", component: Fake }],
      paint: () => ({ bodies: { b1: "#ff0000" }, faces: {} }),
      palette: () => [{ name: "Red", color: "#ff0000" }],
      provides: { thing: 1 },
    });
    off();

    expect(contributedMenus()).toEqual([]);
    expect(contributedRibbon()).toEqual([]);
    expect(contributedActionIds()).toEqual([]);
    expect(contributedAction("go")).toBeNull();
    expect(contributedOverlays()).toEqual([]);
    expect(contributedBodyMenu("b1")).toEqual([]);
    expect(contributedBrowserSections()).toEqual([]);
    expect(contributedPaint()).toEqual({ bodies: {}, faces: {} });
    expect(contributedPalette()).toEqual([]);
    expect(service("thing")).toBeNull();
    expect(contributors()).toEqual([]);
  });

  it("removes only the one that stopped", () => {
    const off = contribute("A.One", { palette: () => [{ name: "Red", color: "#f00000" }] });
    contribute("B.Two", { palette: () => [{ name: "Blue", color: "#0000f0" }] });
    off();
    expect(contributedPalette().map((p) => p.name)).toEqual(["Blue"]);
  });

  it("does not mind being stopped twice", () => {
    const off = contribute("A.One", { palette: () => [{ name: "Red", color: "#f00000" }] });
    contribute("B.Two", { palette: () => [{ name: "Blue", color: "#0000f0" }] });
    off();
    off();
    expect(contributedPalette().map((p) => p.name)).toEqual(["Blue"]);
  });
});

describe("telling the surfaces to redraw", () => {
  it("says so when a plugin starts and when one stops", () => {
    let heard = 0;
    const unsub = onContribChange(() => { heard++; });
    const off = contribute("A.One", {});
    expect(heard).toBe(1);
    off();
    expect(heard).toBe(2);
    unsub();
    contribute("B.Two", {});
    expect(heard).toBe(2); // and stops when asked to
  });
});

describe("actions", () => {
  it("hands an id to whoever claimed it", () => {
    let ran = "";
    contribute("A.One", { actions: { go: () => { ran = "A"; } } });
    contributedAction("go")!();
    expect(ran).toBe("A");
  });

  it("is null for an id nobody claimed, rather than a function that does nothing", () => {
    // The app's dispatcher uses this answer twice: to run the action, and to
    // decide whether the action is somebody else's and therefore not repeatable.
    // A no-op function would make every unknown id look claimed.
    contribute("A.One", { actions: { go: () => {} } });
    expect(contributedAction("stop")).toBeNull();
  });

  it("gives the id to the first claim, not the last", () => {
    let ran = "";
    contribute("A.One", { actions: { go: () => { ran = "A"; } } });
    contribute("B.Two", { actions: { go: () => { ran = "B"; } } });
    contributedAction("go")!();
    expect(ran).toBe("A");
  });
});

describe("paint", () => {
  it("merges what everybody said", () => {
    contribute("A.One", { paint: () => ({ bodies: { b1: "#ff0000" }, faces: { 1: "#ff0000" } }) });
    contribute("B.Two", { paint: () => ({ bodies: { b2: "#00ff00" }, faces: { 2: "#00ff00" } }) });
    expect(contributedPaint()).toEqual({
      bodies: { b1: "#ff0000", b2: "#00ff00" },
      faces: { 1: "#ff0000", 2: "#00ff00" },
    });
  });

  it("asks again every time", () => {
    // The render bridge calls this at every rebuild and at every chunk of a
    // progressive load, and what it depends on changes underneath it. A value
    // captured once would paint the first build's colours forever.
    let colour = "#ff0000";
    contribute("A.One", { paint: () => ({ bodies: { b1: colour }, faces: {} }) });
    expect(contributedPaint().bodies.b1).toBe("#ff0000");
    colour = "#00ff00";
    expect(contributedPaint().bodies.b1).toBe("#00ff00");
  });
});

describe("one plugin's value, offered to another", () => {
  it("hands back exactly what was given, without looking inside", () => {
    const thing = { probe: () => true, nested: { deep: [1, 2, 3] } };
    contribute("A.One", { provides: { filaments: thing } });
    expect(service("filaments")).toBe(thing);
  });

  it("is null for a name nobody offers", () => {
    // This is how a plugin asks "is that capability running" without naming it:
    // the answer is the value or nothing, and nothing means draw nothing.
    contribute("A.One", { provides: { filaments: {} } });
    expect(service("cameras")).toBeNull();
  });

  it("stops being offered when its plugin stops", () => {
    const off = contribute("A.One", { provides: { filaments: {} } });
    expect(service("filaments")).not.toBeNull();
    off();
    expect(service("filaments")).toBeNull();
  });
});

describe("an imported mesh with a colour of its own", () => {
  it("reaches everyone who cares, and waits for them", async () => {
    const order: string[] = [];
    contribute("A.One", {
      importedBody: async (id, color) => {
        await Promise.resolve();
        order.push(`A ${id} ${color}`);
      },
    });
    contribute("B.Two", { importedBody: (id) => { order.push(`B ${id}`); } });
    await announceImportedBody("f1", "#ff0000");
    // Both ran, and the awaited one finished before the call returned — an
    // import that reported itself done while a listener was still rebuilding
    // would be an import that is not done.
    expect(order).toEqual(["A f1 #ff0000", "B f1"]);
  });

  it("is nobody's problem when nothing is listening", async () => {
    await expect(announceImportedBody("f1", "#ff0000")).resolves.toBeUndefined();
  });
});
