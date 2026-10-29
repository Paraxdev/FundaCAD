// Undo or redo back to the saved state drops the snapshot of the unsaved state, any other position keeps it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: [] as string[],
  gate: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const slot = args.slot as string;
    if (cmd === "recovery_write") {
      host.writes.push(slot);
      await host.gate;
      host.disk.set(slot, args.json as string);
    } else if (cmd === "recovery_clear") host.disk.delete(slot);
  },
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const { installAutosave, slotFor } = await import("../../src/io/recovery");

const A = "D:/parts/bracket-a.funda";
const B = "E:/jobs/hinge-b.funda";

let release = () => {};
const hold = () => {
  host.gate = new Promise<void>((r) => (release = r));
};
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
};
const idle = async () => {
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
};
const onDisk = () =>
  Object.fromEntries(
    [...host.disk].map(([slot, json]) => [
      slot,
      (JSON.parse(json) as { doc: { features: { id: string }[] } }).doc.features.map((f) => f.id),
    ]),
  );

function savedA() {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  installAutosave(store);
  store.addFeature(box("a-plate", 41.5, 6.25));
  store.markSaved(A);
  store.addFeature(box("a-rib", 9.75, 2.5));
  return store;
}

describe("the recovery snapshot follows undo back to the saved state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.disk.clear();
    host.writes = [];
    host.gate = null;
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });
  afterEach(() => vi.useRealTimers());

  it("drops the snapshot on undo to the save, and writes one again after redo away", async () => {
    const store = savedA();
    await idle();
    expect(onDisk()).toEqual({ [slotFor(A)]: ["a-plate", "a-rib"] });
    store.undo();
    await idle();
    expect({ dirty: store.dirty, disk: onDisk(), writes: host.writes }).toEqual({
      dirty: false,
      disk: {},
      writes: [slotFor(A)],
    });
    store.redo();
    await idle();
    expect({ dirty: store.dirty, disk: onDisk() }).toEqual({
      dirty: true,
      disk: { [slotFor(A)]: ["a-plate", "a-rib"] },
    });
  });

  it("keeps the snapshot on an undo that stops short of the save, and on one that goes past it", async () => {
    const store = savedA();
    store.addFeature(box("a-boss", 5.5, 3.75));
    await idle();
    store.undo();
    await idle();
    expect({ dirty: store.dirty, disk: onDisk() }).toEqual({
      dirty: true,
      disk: { [slotFor(A)]: ["a-plate", "a-rib"] },
    });
    store.undo();
    store.undo();
    await idle();
    expect({ dirty: store.dirty, disk: onDisk() }).toEqual({ dirty: true, disk: { [slotFor(A)]: [] } });
  });

  it("drops a snapshot whose write was still in flight when the undo reached the save", async () => {
    const store = savedA();
    hold();
    await idle();
    store.undo();
    await settle();
    release();
    await settle();
    expect({ dirty: store.dirty, disk: onDisk(), writes: host.writes }).toEqual({
      dirty: false,
      disk: {},
      writes: [slotFor(A)],
    });
  });

  it("leaves the first document's snapshot alone when the second one undoes back to its save", async () => {
    const store = savedA();
    await idle();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    store.markSaved(B);
    store.addFeature(box("b-hinge", 17.25, 3.5));
    await idle();
    expect(onDisk()).toEqual({ [slotFor(A)]: ["a-plate", "a-rib"], [slotFor(B)]: ["b-hinge"] });
    store.undo();
    await idle();
    expect({ dirty: store.dirty, disk: onDisk() }).toEqual({
      dirty: false,
      disk: { [slotFor(A)]: ["a-plate", "a-rib"] },
    });
  });
});
