// History lists each running op with its own Cancel: an import under a rebuild is stopped by its row alone, and a
// New leaves the next document with no rows.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

function heldBackend() {
  const cancels: string[] = [];
  let n = 0;
  const be = {
    rebuild(_doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      onId?.(`r${++n}`);
      return new Promise<RebuildReply>(() => {});
    },
    async cancel(target?: string) {
      cancels.push(String(target));
      return true;
    },
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  return { be, cancels };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const rows = (s: DocumentStore) => s.runningOps.map((o) => `${o.label}:${o.rebuild}`);

describe("running ops as History rows", () => {
  it("lists an import and a rebuild oldest first, a row's Cancel stops that op only, New keeps none of them", async () => {
    const { be, cancels } = heldBackend();
    const store = new DocumentStore(be, { parameters: {}, features: [box("fillet", 40.5)] });
    void store.rebuildNow();
    await flush();
    void store.runBusy("Importing sv08.step", (onStarted) => {
      onStarted("rq-import");
      return new Promise<void>(() => {});
    });
    const listed = rows(store);
    const imp = store.runningOps.find((o) => !o.rebuild)!;
    const stopped = await store.cancelRunningOp(imp.key);
    const missing = await store.cancelRunningOp(9999);
    const afterCancel = [...cancels];
    store.newDocument();
    const fresh = rows(store);
    store.load(JSON.stringify({ parameters: {}, features: [box("c1", 7.25)] }));
    await flush();
    expect({ listed, stopped, missing, afterCancel, fresh, second: rows(store) }).toEqual({
      listed: ["Rebuilding:true", "Importing sv08.step:false"],
      stopped: true,
      missing: false,
      afterCancel: ["rq-import"],
      // The empty document's own build, sent at once.
      fresh: ["Rebuilding:true"],
      second: ["Rebuilding:true"],
    });
  });
});
