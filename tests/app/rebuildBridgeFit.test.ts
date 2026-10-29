import { describe, it, expect, vi } from "vitest";
import { installRebuildBridge } from "../../src/app/rebuildBridge";
import type { Engine } from "../../src/app/engine";
import type { RebuildState } from "../../src/document/store";
import { SessionHost } from "../../src/document/session";

vi.mock("../../src/ui/toast", () => ({ toast: () => {} }));

const box = { id: "a", type: "box" };
const imp = { id: "f2", type: "import" };

function bridge() {
  const builds = new Set<(s: RebuildState) => void>();
  const opens = new Set<() => void>();
  const fits: boolean[] = [];
  const resets: unknown[][] = [];
  const store = {
    document: { features: [] as unknown[] },
    buildState: { result: null },
    hasPreview: false,
    previewError: null,
    onBuild: (fn: (s: RebuildState) => void) => builds.add(fn),
    onBuildChunk: () => {},
    onBuildAbort: () => {},
    onOpen: (fn: () => void) => opens.add(fn),
    materialPaint: () => ({}),
    materialFinishes: () => ({}),
    faceMaterialEntries: () => [],
    hiddenFaceMaterials: () => [],
    materialLibrary: [],
    importColorSource: () => undefined,
    isBodyVisible: () => true,
    sessions: new SessionHost(),
  };
  const viewport = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) =>
      k === "setModel"
        ? (_r: unknown, fit: boolean) => fits.push(fit)
        : k === "resetCamera"
          ? (...a: unknown[]) => resets.push(a)
          : () => {},
  });
  const e = {
    store,
    viewport,
    ui: { panels: { refreshStressMarks: () => {} } },
    sketch: { active: false },
    toolBusy: () => false,
    overlay: { regions: [] },
    syncDatumPlanes: () => {},
  } as unknown as Engine;
  installRebuildBridge(e);
  const show = (features: unknown[], solid: boolean) => {
    store.document = { features };
    const result = { mesh: { positions: solid ? [0, 0, 0] : [], indices: [], faceIds: [] }, edges: [], bodies: [] };
    for (const fn of builds) fn({ building: false, result } as unknown as RebuildState);
  };
  // As the store's load does: the old session ends, the next begins, then the open is announced.
  const open = () => {
    store.sessions.begin("open");
    opens.forEach((fn) => fn());
  };
  return { show, open, fits, resets, e };
}

describe("the camera after an import", () => {
  it("fits an import that fills a view emptied by Undo", () => {
    const b = bridge();
    b.show([box], true);
    b.show([], false);
    b.show([imp], true);
    expect(b.fits).toEqual([true, true]);
  });

  it("fits an import into a new document", () => {
    const b = bridge();
    b.show([box], true);
    b.open();
    b.show([imp], true);
    expect(b.fits).toEqual([true, true]);
  });

  it("leaves the camera alone for an import beside a part already on screen", () => {
    const b = bridge();
    b.show([box], true);
    b.show([box, imp], true);
    expect(b.fits).toEqual([true, false]);
  });

  it("frames the next model from the home view when asked, once, even with a part on screen", () => {
    const b = bridge();
    b.show([box], true);
    b.show([box], true);
    b.open();
    b.e.frameNextModel();
    b.show([{ id: "plate", type: "extrude" }], true);
    b.show([{ id: "plate", type: "extrude" }], true);
    expect([b.fits, b.resets]).toEqual([[true, false, true, false], [[false]]]);
  });

  it("does not frame the next document's model for a template whose model never landed", () => {
    const b = bridge();
    b.show([box], true);
    b.open();
    b.e.frameNextModel();
    b.show([{ id: "sk1", type: "sketch" }], false);
    b.open();
    b.show([{ id: "plate", type: "extrude" }], true);
    b.open();
    b.e.frameNextModel();
    b.show([{ id: "rib", type: "extrude" }], true);
    expect([b.fits, b.resets]).toEqual([
      [true, false, true],
      [[false], [false]],
    ]);
  });

  it("frames the first model after launch, whichever document brings it", () => {
    const first = bridge();
    first.show([], false);
    first.open();
    first.show([{ id: "plate", type: "extrude" }], true);
    first.open();
    first.show([{ id: "rib", type: "extrude" }], true);
    const viaTemplate = bridge();
    viaTemplate.show([], false);
    viaTemplate.open();
    viaTemplate.e.frameNextModel();
    viaTemplate.show([{ id: "sk1", type: "sketch" }], false);
    viaTemplate.open();
    viaTemplate.show([{ id: "plate", type: "extrude" }], true);
    expect([first.fits, viaTemplate.fits]).toEqual([[true, false], [true]]);
  });

  it("leaves the camera alone for a part drawn into an emptied view", () => {
    const b = bridge();
    b.show([box], true);
    b.show([], false);
    b.show([box], true);
    expect(b.fits).toEqual([true, false]);
  });
});
