// Narrow layouts (NV-7, PM-4, FI-9): below the stage breakpoint Items and
// History are drawers, one open at a time, and nothing done to them there may
// overwrite the wide layout's remembered choice.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useShellStore } from "../../src/stores/shell";
import { isNarrowStage, STAGE_NARROW_PX } from "../../src/ui/layoutBreakpoints";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("isNarrowStage", () => {
  it("is narrow only under the breakpoint, and never for an unmeasured stage", () => {
    expect(isNarrowStage(STAGE_NARROW_PX - 1)).toBe(true);
    expect(isNarrowStage(390)).toBe(true);
    expect(isNarrowStage(STAGE_NARROW_PX)).toBe(false);
    expect(isNarrowStage(1600)).toBe(false);
    expect(isNarrowStage(0)).toBe(false);
  });
});

describe("shell drawers", () => {
  it("wide: both cards follow the remembered choice, as before", () => {
    const shell = useShellStore();
    expect(shell.itemsShown).toBe(true);
    expect(shell.historyShown).toBe(true);
    shell.toggleHistory();
    expect(shell.historyShown).toBe(false);
    expect(localStorage.getItem("fundacad.shell.history")).toBe("0");
  });

  it("narrow: both start closed and open one at a time", () => {
    const shell = useShellStore();
    shell.setNarrow(true);
    expect(shell.itemsShown).toBe(false);
    expect(shell.historyShown).toBe(false);
    shell.toggleItems();
    expect([shell.itemsShown, shell.historyShown]).toEqual([true, false]);
    shell.toggleHistory();
    expect([shell.itemsShown, shell.historyShown]).toEqual([false, true]);
    shell.setHistory(false);
    expect([shell.itemsShown, shell.historyShown]).toEqual([false, false]);
  });

  it("narrow: closing one drawer leaves the other alone", () => {
    const shell = useShellStore();
    shell.setNarrow(true);
    shell.setItems(true);
    shell.setHistory(false);
    expect(shell.itemsShown).toBe(true);
  });

  it("narrow never writes the wide layout's choice", () => {
    const shell = useShellStore();
    shell.setItems(false);
    shell.setNarrow(true);
    shell.toggleItems();
    shell.toggleHistory();
    shell.setHistory(false);
    expect(localStorage.getItem("fundacad.shell.items")).toBe("0");
    expect(localStorage.getItem("fundacad.shell.history")).toBeNull();
    shell.setNarrow(false);
    expect(shell.itemsShown).toBe(false);
    expect(shell.historyShown).toBe(true);
  });

  it("crossing the breakpoint closes any open drawer", () => {
    const shell = useShellStore();
    shell.setNarrow(true);
    shell.toggleItems();
    shell.setNarrow(false);
    shell.setNarrow(true);
    expect(shell.itemsShown).toBe(false);
    shell.toggleHistory();
    shell.closeDrawer();
    expect(shell.historyShown).toBe(false);
  });
});
