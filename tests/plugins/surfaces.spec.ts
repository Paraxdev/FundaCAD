// The app's surfaces, reading what the plugins gave them.
//
// contrib.test.ts checks that the table hands back what it was given. This
// checks the other end: that the menubar, the ribbon and the one action
// dispatcher actually READ it, in the right place, and stop reading it when a
// capability stops. Between them those are the three surfaces that used to name
// the printer and the 3D mouse outright.

import { afterEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { buildMenubar } from "../../src/app/menubarDef";
import { modelGroups, priorityOf } from "../../src/ui/ribbonDefs";
import { createActions } from "../../src/app/actions";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { setPluginEnabled } from "../../src/plugins/registry";
import type { Engine } from "../../src/app/engine";

afterEach(() => resetContributions());

/** Enough engine to build a menu and a dispatcher.
 *
 *  Every field the menubar touches is inside a thunk it does not call while
 *  building, and the dispatcher's own cases are not what is under test here —
 *  what is under test is what happens to an action id NONE of them match. */
function fakeEngine(): Engine {
  setActivePinia(createPinia());
  return {
    sketch: { active: false },
    store: { canUndo: false, canRedo: false },
    viewport: { getSelectedFaceIds: () => [] },
    starters: { startFillet: () => {} },
    selectedFeature: null,
    lastAction: null,
    ui: {},
  } as unknown as Engine;
}

const labels = (menus: { label: string }[]) => menus.map((m) => m.label);

describe("the menubar", () => {
  it("has no View menu of its own", () => {
    // Every row of View belonged to one capability. With nothing contributed the
    // menu is not empty, it is absent — and the app arrives there by having
    // nothing to put in it rather than by knowing whose it was.
    expect(labels(buildMenubar(fakeEngine()))).toEqual(["File", "Edit", "Help"]);
  });

  it("appends rows to a menu that already exists", () => {
    contribute("A.One", {
      menus: [{ menu: "File", items: [{ separator: true, label: "" }, { label: "Send it" }] }],
    });
    const file = buildMenubar(fakeEngine()).find((m) => m.label === "File")!;
    expect(file.items.at(-1)!.label).toBe("Send it");
    // ...after the app's own rows, not instead of them
    expect(file.items.some((i) => i.label === "Export…")).toBe(true);
  });

  it("creates a menu that does not exist, where it asked to be", () => {
    contribute("A.One", { menus: [{ menu: "View", before: "Help", items: [{ label: "Tumble" }] }] });
    expect(labels(buildMenubar(fakeEngine()))).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("puts an unplaced menu at the end rather than refusing it", () => {
    contribute("A.One", { menus: [{ menu: "Extras", items: [{ label: "Thing" }] }] });
    expect(labels(buildMenubar(fakeEngine())).at(-1)).toBe("Extras");
  });

  it("forgets the rows when the plugin stops", () => {
    // The control. A menubar built once and cached, or a merge that pushed into
    // the plugin's own item array, would both pass the cases above and leave a
    // switched-off capability's rows in File forever.
    const off = contribute("A.One", { menus: [{ menu: "View", items: [{ label: "Tumble" }] }] });
    expect(labels(buildMenubar(fakeEngine()))).toContain("View");
    off();
    expect(labels(buildMenubar(fakeEngine()))).not.toContain("View");
  });

  it("changes nothing when a capability is merely switched on", () => {
    // The trap, written down because it was fallen into and only a rendered app
    // caught it. Turning a capability on and it HAVING something to add are
    // different moments: the switch flips, and some milliseconds later the
    // module is fetched and its activate() runs. A surface that rebuilds on the
    // switch rebuilds while the rows it wants are still loading, and is left
    // showing the state from before — permanently, because nothing else is
    // coming.
    //
    // So this asserts the useless half directly: the registry moving is not the
    // signal, the contribution landing is.
    setPluginEnabled("Some.Capability", true);
    expect(labels(buildMenubar(fakeEngine()))).toEqual(["File", "Edit", "Help"]);
    contribute("Some.Capability", { menus: [{ menu: "View", before: "Help", items: [{ label: "Tumble" }] }] });
    expect(labels(buildMenubar(fakeEngine()))).toContain("View");
  });

  it("does not grow the contribution's own item list on every render", () => {
    // The specific mistake the merge is written to avoid: appending into the
    // arrays it was handed. Nothing would look wrong until a menu had been
    // opened four times.
    const items = [{ label: "Send it" }];
    contribute("A.One", { menus: [{ menu: "File", items }] });
    buildMenubar(fakeEngine());
    buildMenubar(fakeEngine());
    expect(items).toHaveLength(1);
    const file = buildMenubar(fakeEngine()).find((m) => m.label === "File")!;
    expect(file.items.filter((i) => i.label === "Send it")).toHaveLength(1);
  });
});

describe("the ribbon", () => {
  it("has no PRINT group of its own", () => {
    expect(modelGroups().map((g) => g.label)).not.toContain("PRINT");
  });

  it("draws a contributed group, and drops it again", () => {
    const off = contribute("A.One", {
      ribbon: [{ group: "PRINT", items: [{ action: "print-send", label: "Send", iconName: "print" }] }],
    });
    const print = modelGroups().find((g) => g.label === "PRINT");
    expect(print?.items.map((i) => "action" in i && i.action)).toEqual(["print-send"]);
    off();
    expect(modelGroups().map((g) => g.label)).not.toContain("PRINT");
  });

  it("leaves the app's own groups alone", () => {
    const before = modelGroups().map((g) => g.label);
    contribute("A.One", {
      ribbon: [{ group: "PRINT", items: [{ action: "go", label: "Go", iconName: "print" }] }],
    });
    expect(modelGroups().map((g) => g.label)).toEqual([...before, "PRINT"]);
  });

  it("merges two plugins that name the same heading", () => {
    // Rather than drawing the word twice with one button under each.
    contribute("A.One", { ribbon: [{ group: "PRINT", items: [{ action: "a", label: "A", iconName: "print" }] }] });
    contribute("B.Two", { ribbon: [{ group: "PRINT", items: [{ action: "b", label: "B", iconName: "print" }] }] });
    const groups = modelGroups().filter((g) => g.label === "PRINT");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("honours the collapse priority a group asked for, and has one for a group that did not", () => {
    contribute("A.One", {
      ribbon: [
        { group: "PRINT", priority: 50, items: [{ action: "a", label: "A", iconName: "print" }] },
        { group: "QUIET", items: [{ action: "b", label: "B", iconName: "print" }] },
      ],
    });
    expect(priorityOf("PRINT")).toBe(50);
    // Below every group the app defines, so it folds into the overflow first.
    expect(priorityOf("QUIET")).toBeLessThan(priorityOf("INSERT"));
    // ...and the app's own headings still answer for themselves.
    expect(priorityOf("CREATE")).toBe(100);
  });
});

describe("the action dispatcher", () => {
  it("hands an id it does not know to whoever claimed it", () => {
    let ran = 0;
    contribute("A.One", { actions: { "print-send": () => { ran++; } } });
    createActions(fakeEngine())("print-send");
    expect(ran).toBe(1);
  });

  it("does nothing at all for an id nobody claimed", () => {
    // Rather than throwing out of a click handler, which is what a `default:`
    // that assumed a handler would do.
    expect(() => createActions(fakeEngine())("nonsense-action")).not.toThrow();
  });

  it("will not let a plugin take over an action the app already has", () => {
    // The order of the code, not a check: the app's own switch runs first, so a
    // contribution naming "welcome" is inert rather than a way to replace what
    // Ctrl+S does. If this ever reversed, a plugin could quietly redefine Save.
    let stolen = 0;
    let opened = 0;
    const e = fakeEngine();
    (e as unknown as { ui: { welcome: { open: () => void } } }).ui = {
      welcome: { open: () => { opened++; } },
    };
    contribute("A.One", { actions: { welcome: () => { stolen++; } } });
    createActions(e)("welcome");
    expect(opened).toBe(1);
    expect(stolen).toBe(0);
  });

  it("does not offer a contributed action to Repeat", () => {
    // The core cannot tell whether re-running somebody else's action is safe,
    // and a "Repeat last command" that quietly uploads a second job to a printer
    // is worse than one that is missing an entry.
    const e = fakeEngine();
    contribute("A.One", { actions: { "print-send": () => {} } });
    createActions(e)("print-send");
    expect(e.lastAction).toBeNull();
  });

  it("still records the app's own actions for Repeat", () => {
    // The control for the case above: a guard that swallowed everything would
    // pass it and break the feature.
    const e = fakeEngine();
    createActions(e)("fillet");
    expect(e.lastAction).toBe("fillet");
  });
});
