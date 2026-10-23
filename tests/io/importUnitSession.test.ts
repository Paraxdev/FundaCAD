// The unit question of an import goes away with its document, so it never stays up over the next one.
import { describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { importPath } from "../../src/io/files";
import { useModalStore } from "../../src/stores/modals";

// Note: with two imports dropped at once vitest hands one of them the real toast module, which listens on window.
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("an import's unit question when its document ends", () => {
  it("is dismissed, the queued one behind it too, and the gate opens again", async () => {
    setActivePinia(createPinia());
    const modals = useModalStore();
    const read = vi.fn();
    const geo = {
      importGeometry: read,
      rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
    } as unknown as GeometryBackend;
    const store = new DocumentStore(geo, { parameters: {}, features: [] });
    const first = importPath(store, geo, "C:/m/chair.glb");
    const second = importPath(store, geo, "C:/m/lamp.gltf");
    await flush();
    const asked = { title: modals.current?.title, depth: modals.depth };
    store.newDocument();
    const ends = await Promise.all([first, second]);
    await flush();
    expect({ asked, current: modals.current, depth: modals.depth, ends, read: read.mock.calls.length }).toEqual({
      asked: { title: "What unit is this GLB file in?", depth: 2 },
      current: null,
      depth: 0,
      ends: ["dropped", "dropped"],
      read: 0,
    });
  });
});
