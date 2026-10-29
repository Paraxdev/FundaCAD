import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { useShellStore } from "../../src/stores/shell";
import type { Engine } from "../../src/app/engine";

const finish = vi.fn();
const e = { sketch: { active: true, finish }, lastAction: "extrude" } as unknown as Engine;

beforeEach(() => {
  setActivePinia(createPinia());
  finish.mockClear();
  document.body.innerHTML = `
    <header id="titlebar"><nav id="menubar"><button id="file">File</button></nav></header>
    <div id="toolrail"><button id="sketch">Sketch</button></div>`;
});

describe("the region actions", () => {
  it("step focus between regions and leave the sketch open and the last command alone", () => {
    document.querySelector<HTMLElement>("#file")!.focus();
    createActions(e)("region-next");
    expect(document.activeElement?.id).toBe("sketch");
    createActions(e)("region-prev");
    expect(document.activeElement?.id).toBe("file");
    expect(finish).not.toHaveBeenCalled();
    expect(e.lastAction).toBe("extrude");
  });
});

describe("the palette's Go to commands", () => {
  afterEach(() => vi.useRealTimers());

  it("are listed under Go, without a key, and none repeats as the last command", () => {
    const go = allCommands().filter((c) => c.group === "Go");
    expect(go.map((c) => [c.id, c.label, c.key])).toEqual([
      ["go-menubar", "Go to Menu Bar", undefined],
      ["go-tools", "Go to Tools", undefined],
      ["go-items", "Go to Items", undefined],
      ["go-model", "Go to Model", undefined],
      ["go-panels", "Go to Panels", undefined],
      ["go-history", "Go to History", undefined],
    ]);
    expect(go.filter((c) => !NON_REPEATABLE.has(c.id))).toEqual([]);
  });

  it("move focus once the palette has handed it back, and leave the sketch open", () => {
    vi.useFakeTimers();
    document.querySelector<HTMLElement>("#file")!.focus();
    createActions(e)("go-tools");
    expect(document.activeElement?.id).toBe("file");
    vi.runAllTimers();
    expect(document.activeElement?.id).toBe("sketch");
    expect(finish).not.toHaveBeenCalled();
    expect(e.lastAction).toBe("extrude");
  });

  it("show Items and History first when they are hidden", () => {
    vi.useFakeTimers();
    const shell = useShellStore();
    shell.setItems(false);
    shell.setHistory(false);
    createActions(e)("go-items");
    expect(shell.itemsShown).toBe(true);
    createActions(e)("go-history");
    expect(shell.historyShown).toBe(true);
    vi.runAllTimers();
  });
});
