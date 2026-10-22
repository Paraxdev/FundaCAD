// Closing the window with Don't save gives the work up, so the next start must not offer its snapshot back; Save,
// Cancel and a clean close leave the slots alone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  pick: "discard" as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
  },
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => host.pick }));
vi.mock("../../src/io/files", () => ({ saveDocument: async (s: DocumentStore) => s.markSaved("D:/parts/s.funda") }));

const { confirmClose } = await import("../../src/app/unsavedGuard");
const { slotFor } = await import("../../src/io/recovery");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function close(pick: string | null, dirty: boolean) {
  host.pick = pick;
  host.invoked = [];
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  store.markSaved("D:/parts/a.funda");
  if (dirty) store.addFeature(box("a-plate", 40));
  let prevented = false;
  await confirmClose({ store }, { preventDefault: () => (prevented = true) });
  await flush();
  return { prevented, clears: host.invoked.filter((c) => c.cmd === "recovery_clear").map((c) => c.args.slot) };
}

describe("closing the window and the recovery slot", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  it("Don't save clears the document's slot, Save, Cancel and a clean close do not", async () => {
    expect({
      discard: await close("discard", true),
      save: await close("save", true),
      cancel: await close("cancel", true),
      clean: await close("discard", false),
    }).toEqual({
      discard: { prevented: false, clears: [slotFor("D:/parts/a.funda"), slotFor(null)] },
      save: { prevented: false, clears: [] },
      cancel: { prevented: true, clears: [] },
      clean: { prevented: false, clears: [] },
    });
  });
});
