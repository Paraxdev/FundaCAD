import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { importPath } from "../../src/io/files";

vi.stubGlobal("window", globalThis);
const toasts: string[] = [];
vi.mock("../../src/ui/toast", () => ({
  toast: (m: string) => {
    toasts.push(m);
  },
}));

const box = (id: string) => ({ id, type: "box", length: 1, width: 1, height: 1 }) as unknown as Feature;

/** importGeometry and every rebuild of a document holding an import wait until
 *  released or cancelled, as a big STEP does. Both real transports take a soft
 *  cancel, so this one does too. */
function slowBackend(color?: string) {
  let read: ((v: "ok" | "cancel") => void) | null = null;
  let build: ((v: "ok" | "cancel") => void) | null = null;
  let n = 0;
  const be = {
    softCancel: true,
    async rebuild(doc: CadDocument, _t: unknown, onId?: (id: string) => void) {
      const own = doc.features.find((f) => f.type === "import");
      onId?.(own ? `imp-build-${++n}` : "build");
      if (own && (await new Promise((r) => (build = r))) === "cancel") {
        return { ok: false as const, cancelled: true, error: { message: "cancelled" } };
      }
      const bodies = [
        { id: "body1", name: "Box", faceStart: 0, faceCount: 1, faceOwners: ["a"] },
        ...(own ? [{ id: "body9", name: "Part", faceStart: 1, faceCount: 1, faceOwners: [own.id] }] : []),
      ];
      const result: RebuildResult = {
        mesh: { positions: [], indices: [], faceIds: [] },
        edges: [],
        bbox: { min: [0, 0, 0], max: [0, 0, 0] },
        bodies,
      };
      return { ok: true as const, result };
    },
    async importGeometry(_p: string, _f: string, onStarted?: (id: string) => void) {
      onStarted?.("imp-read");
      if ((await new Promise((r) => (read = r))) === "cancel")
        return { ok: false, cancelled: true, message: "import cancelled" };
      return { ok: true, geom: "h", name: "part", solid: true, faces: 6, ...(color ? { color } : {}) };
    },
    async cancel(id?: string) {
      if (id === "imp-read" && read) {
        read("cancel");
        read = null;
        return true;
      }
      if (id?.startsWith("imp-build") && build) {
        build("cancel");
        build = null;
        return true;
      }
      return false;
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
  } as unknown as GeometryBackend;
  return {
    be,
    finishRead: () => {
      read?.("ok");
      read = null;
    },
    finishBuild: () => {
      build?.("ok");
      build = null;
    },
    reading: () => !!read,
    building: () => !!build,
  };
}

const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);
const bodies = (s: DocumentStore) => (s.buildState.result?.bodies ?? []).map((b) => b.id);

async function boxThenImport(color?: string) {
  const f = slowBackend(color);
  const store = new DocumentStore(f.be, { parameters: {}, features: [] });
  store.addFeature(box("a"));
  await store.rebuildNow();
  const importing = importPath(store, f.be, "C:/m/part.step");
  await vi.waitFor(() => expect(f.reading()).toBe(true));
  return { f, store, importing };
}

beforeEach(() => {
  toasts.length = 0;
});

for (const color of ["#ff0000", undefined]) {
  describe(`Cancel on an import${color ? " with colours" : ""}`, () => {
    it("while the file reads adds nothing and keeps the step before it", async () => {
      const { store, importing } = await boxThenImport(color);
      expect(await store.cancelBusy()).toBe(true);
      await importing;
      expect(ids(store)).toEqual(["a"]);
      expect(store.canRedo).toBe(false);
      store.undo();
      expect(ids(store)).toEqual([]);
    });

    it("while it rebuilds takes the import back as one step, says so, and Redo builds it", async () => {
      const { f, store, importing } = await boxThenImport(color);
      f.finishRead();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      expect(store.busyState.rebuild).toBe(true);
      expect(await store.cancelBusy()).toBe(true);
      await importing;
      await vi.waitFor(() => expect(store.busyState.active).toBe(false));
      expect(ids(store)).toEqual(["a"]);
      expect(bodies(store)).toEqual(["body1"]);
      expect(toasts.some((t) => /cancel/i.test(t))).toBe(true);
      expect(store.canRedo).toBe(true);

      store.redo();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      f.finishBuild();
      await vi.waitFor(() => expect(bodies(store)).toEqual(["body1", "body9"]));
      if (color) await vi.waitFor(() => expect(store.bodyMaterialId("body9")).toBeDefined());
      expect(ids(store)).toHaveLength(2);

      store.undo();
      expect(ids(store)).toEqual(["a"]);
      expect(store.bodyMaterialId("body9")).toBeUndefined();
      store.undo();
      expect(ids(store)).toEqual([]);
    });

    it("after it finished leaves the import and its model alone", async () => {
      const { f, store, importing } = await boxThenImport(color);
      f.finishRead();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      f.finishBuild();
      await importing;
      await vi.waitFor(() => expect(store.busyState.active).toBe(false));
      expect(await store.cancelBusy()).toBe(false);
      expect(ids(store)).toHaveLength(2);
      expect(bodies(store)).toEqual(["body1", "body9"]);
      expect(toasts.some((t) => /cancel/i.test(t))).toBe(false);
    });

    it("on the rebuild a Redo started takes the import back again", async () => {
      const { f, store, importing } = await boxThenImport(color);
      f.finishRead();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      await store.cancelBusy();
      await importing;
      await vi.waitFor(() => expect(store.busyState.active).toBe(false));
      store.redo();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      expect(await store.cancelBusy()).toBe(true);
      await vi.waitFor(() => expect(ids(store)).toEqual(["a"]));
      expect(toasts.filter((t) => /Redo brings it back/.test(t))).toHaveLength(2);
      expect(store.canRedo).toBe(true);
    });

    it("after an edit made during the rebuild keeps both and says how to build", async () => {
      const { f, store, importing } = await boxThenImport(color);
      f.finishRead();
      await vi.waitFor(() => expect(f.building()).toBe(true));
      store.addFeature(box("z"));
      await vi.waitFor(() => expect(store.busyState.id).toBe("imp-build-2"));
      expect(await store.cancelBusy()).toBe(true);
      await importing;
      await vi.waitFor(() => expect(store.busyState.active).toBe(false));
      expect(ids(store)).toEqual(["a", "f2", "z"]);
      expect(toasts.some((t) => /Compute All/.test(t))).toBe(true);
      store.undo();
      expect(ids(store)).toEqual(["a", "f2"]);
    });
  });
}

describe("Cancel on a rebuild an edit has superseded", () => {
  it("stops it instead of sending the newer document", async () => {
    const sent: string[] = [];
    const open = new Map<string, () => void>();
    let n = 0;
    const be = {
      softCancel: true,
      async rebuild(_doc: CadDocument, _t: unknown, onId?: (id: string) => void) {
        const id = `b${++n}`;
        sent.push(id);
        onId?.(id);
        await new Promise<void>((r) => open.set(id, r));
        return { ok: false as const, cancelled: true, error: { message: "cancelled" } };
      },
      // The soft cancel is acknowledged but the reply is still on its way when
      // the person presses Cancel.
      async cancel(id?: string, o?: { soft?: boolean }) {
        if (!o?.soft && id) open.get(id)?.();
        return true;
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      onProgress() {
        return () => {};
      },
    } as unknown as GeometryBackend;
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    store.addFeature(box("a"));
    await vi.waitFor(() => expect(store.busyState.id).toBe("b1"));
    store.addFeature(box("b"));
    expect(await store.cancelBusy()).toBe(true);
    await vi.waitFor(() => expect(store.busyState.active).toBe(false));
    expect(sent).toEqual(["b1"]);
    expect(store.buildState.cancelled).toBe(true);
  });
});
