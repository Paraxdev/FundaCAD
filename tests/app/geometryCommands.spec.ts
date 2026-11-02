// Next and Previous Face and Edge, through the one action dispatcher over the real Geometry
// list controller and store. Only the engine and the viewport behind the controller are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import type { Engine } from "../../src/app/engine";
import { buildMenubar } from "../../src/app/menubarDef";
import {
  keyHint,
  resetUserShortcuts,
  resolveShortcut,
  setUserShortcut,
  shortcutHudGroups,
  shortcutRows,
} from "../../src/input/shortcuts";
import { announce } from "../../src/ui/announce";
import { allCommands } from "../../src/ui/commands";
import { describePick } from "../../src/ui/describePick";
import { awaitTreePick, resetTreePicks, treePickWaiting } from "../../src/ui/treePick";
import { edge, land, result, rig, settle, topology } from "./geometryBrowserRig";

vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));
vi.mock("../../src/ui/announce", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/announce")>()),
  announce: vi.fn(),
}));

const STEPS = ["next-face", "previous-face", "next-edge", "previous-edge"];

const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);
const face = (faceId: number) => ({ kind: "face", faceId });

function commands(r: ReturnType<typeof rig>) {
  const finish = vi.fn();
  const e = {
    ...r.host,
    sketch: { ...r.host.sketch, finish },
    geometryBrowser: r.browser,
    lastAction: "extrude",
  } as unknown as Engine;
  return { run: createActions(e), e, finish };
}

// faceStart 40, so a row's number and its face id differ.
async function opened(faces = 3) {
  const r = rig(result([{ id: "body1", etag: "e1", faceCount: faces, faceStart: 40 }]));
  await r.build();
  r.browser.startStepping();
  await land(r.asks[0]!, topology("body1", faces));
  return { r, ...commands(r) };
}

const picks = (r: ReturnType<typeof rig>) => r.viewport.applyPicks.mock.calls.map((c) => c[0]);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
  resetTreePicks();
  resetUserShortcuts();
});

describe("where the commands are listed", () => {
  it("the palette has all five, no key on any, and none repeats as the last command", () => {
    const rows = allCommands().filter((c) => STEPS.includes(c.id));
    expect(rows.map((c) => [c.id, c.label, c.group, c.context, c.key])).toEqual([
      ["next-face", "Next Face", "Edit", "global", undefined],
      ["previous-face", "Previous Face", "Edit", "global", undefined],
      ["next-edge", "Next Edge", "Edit", "global", undefined],
      ["previous-edge", "Previous Edge", "Edit", "global", undefined],
    ]);
    expect(STEPS.filter((id) => !NON_REPEATABLE.has(id))).toEqual([]);
    expect(STEPS.map(keyHint)).toEqual(STEPS.map(() => undefined));
  });

  it("the Edit menu runs them through the dispatcher", () => {
    const handleAction = vi.fn();
    const edit = buildMenubar({ handleAction } as unknown as Engine).find((m) => m.label === "Edit")!;
    const items = edit.items.filter((i) => allCommands().find((c) => STEPS.includes(c.id) && c.label === i.label));
    expect(items.map((i) => [i.label, i.shortcut])).toEqual([
      ["Next Face", undefined],
      ["Previous Face", undefined],
      ["Next Edge", undefined],
      ["Previous Edge", undefined],
    ]);
    for (const i of items) i.onClick!();
    expect(handleAction.mock.calls.map((c) => c[0])).toEqual(STEPS);
  });

  it("an empty key fires nothing, a chosen key fires the command and shows in the palette and the menu", () => {
    expect(resolveShortcut("", false, "model")).toBeNull();
    const row = shortcutRows().find((s) => s.action === "next-edge")!;
    expect(row.key).toBe("");
    expect(setUserShortcut(row.id, { key: "F9", shift: true })).toBeNull();
    expect(resolveShortcut("F9", true, "model")).toBe("next-edge");
    expect(resolveShortcut("F9", true, "sketch")).toBe("next-edge");
    expect(allCommands().find((c) => c.id === "next-edge")?.key).toBe("Shift+F9");
    const edit = buildMenubar({} as Engine).find((m) => m.label === "Edit")!;
    expect(edit.items.find((i) => i.label === "Next Edge")?.shortcut).toBe("Shift+F9");
    expect(edit.items.find((i) => i.label === "Next Face")?.shortcut).toBeUndefined();
  });

  it("the ? dialog lets them be bound, and keeps the canvas keys a fixed group", () => {
    const groups = shortcutHudGroups();
    const rows = groups.find((g) => g.name === "Global")!.rows.filter((x) => /face|edge/.test(x.label));
    expect(rows.map((x) => x.key)).toEqual(["", "", "", ""]);
    expect(rows.every((x) => x.id !== undefined)).toBe(true);
    const canvas = groups.find((g) => g.name === "3D view focused")!.rows;
    expect(canvas.map((x) => x.key)).toEqual(["] / [", "Shift+] / Shift+[", "Enter", "Space", "Esc"]);
    expect(canvas.filter((x) => x.id !== undefined)).toEqual([]);
  });
});

describe("Next and Previous Face", () => {
  it("select the row in place of the selection, speak it, and leave the last command alone", async () => {
    const { r, run, e, finish } = await opened();
    run("next-face");
    expect(r.viewport.applyPicks.mock.calls).toEqual([[[face(40)], { additive: false }]]);
    const row = r.list.filtered[0]!;
    expect(r.list.cursor).toBe(row.key);
    expect(vi.mocked(announce).mock.calls).toEqual([
      [describePick(row.facts).spoken, "polite", { key: "selection", delay: 250 }],
    ]);
    expect(e.lastAction).toBe("extrude");
    expect(finish).not.toHaveBeenCalled();
    expect(r.host.dropBodyGizmo).toHaveBeenCalledTimes(1);
  });

  it("walk on from the last row they picked and wrap at both ends", async () => {
    const { r, run } = await opened(3);
    for (const a of ["next-face", "next-face", "next-face", "next-face", "previous-face", "previous-face"]) run(a);
    expect(picks(r)).toEqual([40, 41, 42, 40, 42, 41].map((id) => [face(id)]));
  });

  it("Previous from no place starts at the last row", async () => {
    const { r, run } = await opened(4);
    run("previous-face");
    expect(picks(r)).toEqual([[face(43)]]);
  });

  it("one row says itself again, since the selection does not change and the readout stays quiet", async () => {
    const { r, run } = await opened(1);
    run("next-face");
    run("next-face");
    expect(picks(r)).toEqual([[face(40)], [face(40)]]);
    expect(said()).toHaveLength(2);
    expect(said()[1]).toBe(said()[0]);
  });

  it("a body with no faces, and no body at all, say so and pick nothing", async () => {
    const { r, run } = await opened(0);
    run("next-face");
    expect(said()).toEqual(["No faces on this body"]);
    expect(picks(r)).toEqual([]);

    setActivePinia(createPinia());
    const bare = rig(result([]));
    await bare.build();
    commands(bare).run("next-edge");
    expect(said()).toEqual(["No faces on this body", "No body to step through"]);
    expect(picks(bare)).toEqual([]);
  });

  it("go on from a lone selected face, not from the cursor", async () => {
    const { r, run } = await opened(5);
    run("next-face");
    r.selection.faces = [43];
    r.browser.selectionChanged();
    run("next-face");
    expect(picks(r).at(-1)).toEqual([face(44)]);
  });

  it("keep to the cursor with two faces selected, and with a row lit", async () => {
    const { r, run } = await opened(6);
    run("next-face");
    r.selection.faces = [42, 44];
    r.browser.selectionChanged();
    run("next-face");
    expect(picks(r).at(-1)).toEqual([face(41)]);

    r.selection.faces = [44];
    r.browser.selectionChanged();
    r.list.setLit(true);
    run("next-face");
    expect(picks(r).at(-1)).toEqual([face(42)]);
    expect(r.list.litRow?.key).toBe("f:body1:2");
  });

  it("step only the rows a filter leaves", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceCount: 4, faceStart: 40 }]));
    const { run } = commands(r);
    await r.build();
    r.browser.startStepping();
    await land(r.asks[0]!, topology("body1", 4));
    r.list.setFilters({ minSize: 42.5 });
    run("next-face");
    run("next-face");
    run("next-face");
    expect(picks(r)).toEqual([[face(43)], [face(43)], [face(43)]]);
  });

  it("turn a Bodies policy to Faces first, so the toolbar does not keep showing it", async () => {
    const { r, run } = await opened();
    r.viewport.policy = "bodies";
    run("next-face");
    expect(r.host.handleAction.mock.calls).toEqual([["selmode-faces"]]);
    expect(picks(r)).toEqual([[face(40)]]);
  });
});

describe("Next and Previous Edge", () => {
  it("set the kind, say the list is coming, and select the edge once its faces are known", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceCount: 3, faceStart: 40 }]));
    const { run } = commands(r);
    await r.build();
    const e0 = edge("body1", 0, 2);
    const e1 = edge("body1", 1, 2);
    r.wires.set("body1", [e0, e1]);
    run("previous-edge");
    expect(r.list.kind).toBe("edges");
    expect(said()).toEqual(["Listing edges"]);
    expect(picks(r)).toEqual([]);
    await land(
      r.asks[0]!,
      topology("body1", 3, [
        [0, 1],
        [1, 2],
      ]),
    );
    expect(picks(r)).toEqual([[{ kind: "edge", edge: e1 }]]);
    const row = r.list.filtered[1]!;
    expect(row.facts).toMatchObject({ kind: "edge", number: 2 });
    expect(said()).toEqual(["Listing edges", describePick(row.facts).spoken]);
  });

  it("need no second reply once the faces have been listed", async () => {
    const { r, run } = await opened();
    const e0 = edge("body1", 0, 1);
    r.wires.set("body1", [e0]);
    const asked = r.asks.length;
    run("next-edge");
    expect(r.asks).toHaveLength(asked);
    expect(picks(r)).toEqual([[{ kind: "edge", edge: e0 }]]);
  });

  it("clear a filter of the other kind, and a Face command takes the kind back", async () => {
    const { r, run } = await opened();
    r.list.setFilters({ type: "flat" });
    const e0 = edge("body1", 0, 1);
    r.wires.set("body1", [e0]);
    run("next-edge");
    expect(r.list.filters.type).toBeNull();
    run("next-face");
    expect(r.list.kind).toBe("faces");
    expect(picks(r)).toEqual([[{ kind: "edge", edge: e0 }], [face(40)]]);
  });

  it("from Planes, select a face or an edge and leave the plane list", async () => {
    const { r, run } = await opened();
    r.browser.setKind("planes");
    run("next-face");
    expect(r.list.kind).toBe("faces");
    expect(picks(r)).toEqual([[face(40)]]);
  });
});

describe("a command waiting for the list", () => {
  async function waiting() {
    const r = rig(result([{ id: "body1", etag: "e1", faceCount: 3, faceStart: 40 }]));
    const c = commands(r);
    await r.build();
    c.run("next-face");
    expect(said()).toEqual(["Listing faces"]);
    expect(r.list.state).toBe("loading");
    return { r, ...c };
  }

  it("selects when the reply lands", async () => {
    const { r } = await waiting();
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([[face(40)]]);
  });

  it("only the newest command acts", async () => {
    const { r, run } = await waiting();
    run("previous-face");
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([[face(42)]]);
  });

  it("Escape drops it", async () => {
    const { r } = await waiting();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("another key does not", async () => {
    const { r } = await waiting();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([[face(40)]]);
  });

  it("a pick made meanwhile wins", async () => {
    const { r } = await waiting();
    r.selection.faces = [42];
    r.browser.selectionChanged();
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([]);
  });

  it("a tool started meanwhile wins, and nothing is said over it", async () => {
    const { r } = await waiting();
    r.host.toolOwnsScreen.mockReturnValue(true);
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([]);
    expect(said()).toEqual(["Listing faces"]);
    expect(r.host.setStatus).not.toHaveBeenCalled();
  });

  it("another kind chosen meanwhile wins", async () => {
    const { r } = await waiting();
    r.browser.setKind("edges");
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([]);
  });

  it("a failed list says the engine's words", async () => {
    const { r } = await waiting();
    await land(r.asks[0]!, null);
    expect(picks(r)).toEqual([]);
    expect(said().at(-1)).toBe("The engine could not list this body's faces.");
  });

  it("a second document never hears the first one's command, and starts at its own first row", async () => {
    const { r, run } = await waiting();
    r.state.result = result([{ id: "other", etag: "o1", faceCount: 2, faceStart: 7 }]);
    r.store.newDocument();
    await settle();
    await land(r.asks[0]!, topology("body1", 3));
    expect(picks(r)).toEqual([]);
    expect(r.list.cursor).toBeNull();
    await r.build();
    run("next-face");
    await land(r.asks.at(-1)!, topology("other", 2));
    expect(picks(r)).toEqual([[face(7)]]);
  });
});

describe("what a command refuses", () => {
  it("an open sketch stays open, is refused in words, and nothing changes", async () => {
    const { r } = await opened();
    r.host.sketch.active = true;
    const { run, finish } = commands(r);
    run("next-edge");
    expect(r.host.setStatus.mock.calls).toEqual([["Finish the sketch first", ""]]);
    expect(said()).toEqual(["Finish the sketch first"]);
    expect(finish).not.toHaveBeenCalled();
    expect(r.list.kind).toBe("faces");
    expect(picks(r)).toEqual([]);
  });

  it("a waiting pick survives every one of them, refused or not", async () => {
    const { r, run } = await opened();
    r.host.toolOwnsScreen.mockReturnValue(true);
    const end = vi.fn();
    awaitTreePick(() => true, end);
    expect(treePickWaiting()).toBe(true);
    vi.useFakeTimers();
    for (const a of STEPS) run(a);
    vi.runAllTimers();
    expect(treePickWaiting()).toBe(true);
    expect(end).not.toHaveBeenCalled();
    expect(r.host.setStatus.mock.calls.map((c) => c[0])).toEqual(STEPS.map(() => "Finish the tool first"));
    expect(picks(r)).toEqual([]);
  });

  it("a build under way refuses, and the same command works once it has landed", async () => {
    const { r, run } = await opened();
    r.viewport.picksSuspended = true;
    run("next-face");
    expect(r.host.setStatus.mock.calls).toEqual([["The model is still building", ""]]);
    expect(said()).toEqual(["The model is still building"]);
    expect(picks(r)).toEqual([]);
    r.viewport.picksSuspended = false;
    run("next-face");
    expect(picks(r)).toEqual([[face(40)]]);
  });

  it("a lit row stays lit through a refusal", async () => {
    const { r, run } = await opened();
    r.browser.step(1);
    r.list.setLit(true);
    r.host.toolOwnsScreen.mockReturnValue(true);
    run("next-face");
    expect(r.list.litRow?.key).toBe("f:body1:0");
  });
});
