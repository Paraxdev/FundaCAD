// The disk below lands a write only when its gate opens, like a slow recovery_write that is still in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: [] as string[],
  gate: null as Promise<void> | null,
  pick: "discard" as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const slot = args.slot as string;
    if (cmd === "recovery_write") {
      host.writes.push(slot);
      const gate = host.gate;
      await gate;
      host.disk.set(slot, args.json as string);
    } else if (cmd === "recovery_clear") host.disk.delete(slot);
  },
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => host.pick }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

await import("@tauri-apps/api/core");
const { installAutosave, slotFor } = await import("../../src/io/recovery");
const { mayDiscard } = await import("../../src/app/documentActions");
const { appHost } = await import("../../src/plugins/broker/appHost");

const A = "D:/parts/bracket-a.funda";
const B = "E:/jobs/hinge-b.funda";
const noSketch = { hasUncommittedEdits: false } as never;

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

function editedA() {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  installAutosave(store);
  store.markSaved(A);
  store.addFeature(box("a-plate", 41.5, 6.25));
  return store;
}

function loadB(store: DocumentStore) {
  store.load(JSON.stringify({ parameters: {}, features: [] }));
  store.markSaved(B);
  store.addFeature(box("b-hinge", 17.25, 3.5));
}

describe("autosave around the end of a document", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.disk.clear();
    host.writes = [];
    host.gate = null;
    host.pick = "discard";
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });
  afterEach(() => vi.useRealTimers());

  it("never brings back a discarded document whose write was still in flight", async () => {
    const store = editedA();
    hold();
    await idle();
    if (await mayDiscard({ store, sketch: noSketch }, "Discard?")) store.newDocument();
    await settle();
    release();
    await settle();
    host.gate = null;
    loadB(store);
    await idle();
    expect({ disk: onDisk(), writes: host.writes }).toEqual({
      disk: { [slotFor(B)]: ["b-hinge"] },
      writes: [slotFor(A), slotFor(B)],
    });
  });

  it("writes the next document's first snapshot even while the last one's write is in flight", async () => {
    const store = editedA();
    hold();
    await idle();
    loadB(store);
    await idle();
    release();
    await settle();
    expect({ disk: onDisk(), writes: host.writes }).toEqual({
      disk: { [slotFor(A)]: ["a-plate"], [slotFor(B)]: ["b-hinge"] },
      writes: [slotFor(A), slotFor(B)],
    });
  });

  it("writes the edits since the last snapshot when a plugin's doc_new ends the document, and none when there are none", async () => {
    const store = editedA();
    await idle();
    store.addFeature(box("a-rib", 9.75, 2.5));
    await vi.advanceTimersByTimeAsync(12_000);
    await appHost({ store, mayDiscard: async () => true }).perform("doc_new", {});
    await settle();
    const afterEdits = onDisk();
    loadB(store);
    await idle();
    await appHost({ store, mayDiscard: async () => true }).perform("doc_new", {});
    await idle();
    expect({ afterEdits, disk: onDisk(), writes: host.writes }).toEqual({
      afterEdits: { [slotFor(A)]: ["a-plate", "a-rib"] },
      disk: { [slotFor(A)]: ["a-plate", "a-rib"], [slotFor(B)]: ["b-hinge"] },
      writes: [slotFor(A), slotFor(A), slotFor(B)],
    });
  });
});
