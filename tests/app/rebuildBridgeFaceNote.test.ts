// The note a committed rebuild gives when it takes away the face a face material
// was on: once per material, never for a preview or a rolled back timeline.
import { describe, it, expect, vi } from "vitest";
import { installRebuildBridge } from "../../src/app/rebuildBridge";
import type { Engine } from "../../src/app/engine";
import type { RebuildState } from "../../src/document/store";

const { toasts } = vi.hoisted(() => ({ toasts: [] as { count: string; kind: unknown }[] }));
vi.mock("../../src/ui/toast", () => ({
  toast: (m: string, o: { kind?: string }) => {
    if (/face material/.test(m)) toasts.push({ count: /^(\d+) /.exec(m)?.[1] ?? "1", kind: o.kind });
    return 1;
  },
}));

function bridge() {
  const builds = new Set<(s: RebuildState) => void>();
  const store = {
    document: { features: [{ id: "a" }, { id: "b" }] as unknown[] },
    buildState: { result: null },
    hasPreview: false,
    previewError: null,
    rollbackIndex: 2,
    hidden: [] as string[],
    onBuild: (fn: (s: RebuildState) => void) => builds.add(fn),
    onBuildChunk: () => {},
    onBuildAbort: () => {},
    onOpen: () => {},
    materialPaint: () => ({}),
    materialFinishes: () => ({}),
    faceMaterialEntries: () => [],
    hiddenFaceMaterials: () => store.hidden,
    materialLibrary: [],
    importColorSource: () => undefined,
    isBodyVisible: () => true,
  };
  const e = {
    store,
    viewport: new Proxy({}, { get: () => () => {} }),
    ui: { panels: { refreshStressMarks: () => {} } },
    sketch: { active: false },
    toolBusy: () => false,
    overlay: { regions: [] },
    syncDatumPlanes: () => {},
  } as unknown as Engine;
  installRebuildBridge(e);
  return (hidden: string[], o: { preview?: boolean; rollback?: number } = {}) => {
    store.hidden = hidden;
    store.hasPreview = !!o.preview;
    store.rollbackIndex = o.rollback ?? 2;
    const result = { mesh: { positions: [0, 0, 0], indices: [], faceIds: [] }, edges: [], bodies: [] };
    for (const fn of builds) fn({ building: false, result } as unknown as RebuildState);
  };
}

describe("the note for a face material whose face a rebuild took", () => {
  it("names each newly hidden one once, and again after its face came back and went", () => {
    toasts.length = 0;
    const build = bridge();
    build([]);
    expect(toasts).toEqual([]);
    build(["fr1"]);
    build(["fr1"]);
    expect(toasts).toEqual([{ count: "1", kind: "warning" }]);
    build(["fr1", "fr2", "fr3"]);
    expect(toasts).toEqual([
      { count: "1", kind: "warning" },
      { count: "2", kind: "warning" },
    ]);
    build([]);
    build(["fr2"]);
    expect(toasts).toEqual([
      { count: "1", kind: "warning" },
      { count: "2", kind: "warning" },
      { count: "1", kind: "warning" },
    ]);
  });

  it("says nothing for a preview or a timeline rolled back by one feature, and nothing once it is rolled forward", () => {
    toasts.length = 0;
    const build = bridge();
    build([]);
    build(["fr1"], { preview: true });
    build(["fr1", "fr2"], { rollback: 1 });
    build(["fr1", "fr2"]);
    expect(toasts).toEqual([]);
    build(["fr1", "fr2", "fr4"], { rollback: 2 });
    expect(toasts).toEqual([{ count: "1", kind: "warning" }]);
  });
});
