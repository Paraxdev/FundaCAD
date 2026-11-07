// The Printability panel's own toasts go when it closes or checks again. The app does not show or say a toast again
// while its words are up, so one left on screen kept a reopen's hint, or a second Check's head, from being said.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../../src/ui/announce", () => ({ announce }));

import { createPrintabilityPanel, type PrintabilityDeps } from "../../plugins/FundaCAD.PrintToolbox/printabilityPanel";
import { dismissToastsSaying, hintToast } from "../../src/ui/toast";
import { useToastStore } from "../../src/stores/toasts";
import type { PrintabilityReply, PrintabilityResult } from "fundacad";

// the toast store times its rows with window.setTimeout
(globalThis as Record<string, unknown>).window ??= globalThis;

const OPEN_HINT = "Printability: checks the selected bodies, or every body when none is selected";
const CHECKING = "Checking printability…";

const reply: PrintabilityReply = {
  header: "+Z up as modelled, bed at z = 0",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [
    { id: "body1", name: "Block", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: false },
  ],
  findings: [
    {
      kind: "overhang",
      body: "body1",
      face: 3,
      other: null,
      value: 90,
      limit: 0,
      area: 100,
      low: 10,
      at: [5, 5, 10],
      extent: 10,
      note: "",
    },
  ],
  errors: [],
};

function rig() {
  const openListeners = new Set<() => void>();
  let settle: (r: PrintabilityResult) => void = () => {};
  const deps = {
    store: {
      builtDocument: () => ({ features: [] }),
      buildState: { result: { bodies: [{ id: "body1", name: "Block", faceStart: 0, faceCount: 6 }] }, building: false },
      onDocChange: () => () => {},
      onBuild: () => () => {},
      onOpen: (fn: () => void) => {
        openListeners.add(fn);
        return () => openListeners.delete(fn);
      },
      isBodyVisible: () => true,
      bodyName: () => undefined,
    },
    viewport: {
      getSelectedBodies: () => [],
      setFaceMarks: () => {},
      frameAround: () => {},
      stressOverlayBody: () => null,
      onStressOverlayChange: () => () => {},
    },
    geometry: {
      printability: () =>
        new Promise<PrintabilityResult>((res) => {
          settle = res;
        }),
      cancel: async () => true,
    },
    hasBody: () => true,
    // As the app's setStatus does: no class is a toast, the rest goes to the console.
    setStatus: (t: string, c: string) => {
      if (c === "") hintToast(t);
    },
    dismissStatus: dismissToastsSaying,
    announce: () => {},
  } as unknown as PrintabilityDeps;
  return {
    ui: createPrintabilityPanel(deps),
    open: () => openListeners.forEach((f) => f()),
    settle: (r: PrintabilityResult) => settle(r),
  };
}

const showing = () =>
  useToastStore()
    .items.filter((t) => !t.leaving)
    .map((t) => t.message);
const said = (text: string) => announce.mock.calls.filter(([t]) => t === text).length;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  announce.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("the Printability panel's hints", () => {
  it("are said again when another document closes the panel and it opens at once", () => {
    const r = rig();
    r.ui.show();
    void r.ui.run();
    expect(said(OPEN_HINT)).toBe(1);
    r.open();
    expect(r.ui.data.value).toBeNull();
    expect(showing()).not.toContain(OPEN_HINT);
    expect(showing()).not.toContain(CHECKING);
    r.ui.show();
    expect(said(OPEN_HINT)).toBe(2);
  });

  it("go when the panel is closed, and a reopen says its hint again", () => {
    const r = rig();
    r.ui.show();
    r.ui.close();
    expect(showing()).not.toContain(OPEN_HINT);
    r.ui.show();
    expect(said(OPEN_HINT)).toBe(2);
  });

  it("are said again for a second Check with the same answer", async () => {
    const r = rig();
    r.ui.show();
    const first = r.ui.run();
    r.settle({ ok: true, result: reply });
    await first;
    const head = announce.mock.calls.map(([t]) => t as string).find((t) => t.startsWith("Printability: 1"));
    expect(head).toBeDefined();
    const second = r.ui.run();
    r.settle({ ok: true, result: reply });
    await second;
    expect(said(head!)).toBe(2);
    expect(said(CHECKING)).toBe(2);
  });
});
