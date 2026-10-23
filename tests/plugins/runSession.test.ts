// A plugin run works on the document open when the user started it, even when that document is closed while the
// runner modules still load.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { InstalledPlugin } from "../../src/plugins";
import { stubBackend } from "../document/storeKit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "export default {}" }));
vi.mock("../../src/plugins/broker/native", () => ({ tauriNative: () => ({}) }));
vi.mock("../../src/plugins/runner/spawn", () => ({
  spawnAndRun: async (opts: { host: { perform(op: string, args: unknown): Promise<unknown> } }) =>
    opts.host
      .perform("feature_add", { feature: { id: "slab", type: "box", length: 14.5, width: 6.25, height: 3.75 } })
      .then(() => "ok")
      .catch((e: Error) => e.message),
}));

const rec: InstalledPlugin = {
  id: "Acme.Slabs",
  version: "1.3.0",
  promise: "",
  source: "D:/plugins/acme-slabs.zip",
  sha256: "",
  installedAt: 1_700_000_000,
  dir: "D:/plugins/Acme.Slabs",
  consented: { kind: "compute", version: "1.3.0", grants: [], hosts: [] },
  official: false,
};

const features = (store: DocumentStore) => store.document.features.map((f) => f.id);

describe("a plugin run started on one document", () => {
  it("writes into it, and is refused once it was closed while the runner loaded", async () => {
    const { runComputePlugin } = await import("../../src/plugins");
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const stayed = await runComputePlugin(rec, store);
    const first = features(store);

    store.newDocument();
    const late = runComputePlugin(rec, store);
    store.newDocument();
    const closed = await late;
    const second = features(store);

    expect({ stayed, first, closed, second }).toEqual({
      stayed: "ok",
      first: ["slab"],
      closed: "feature_add: the document this plugin run was working on was closed, nothing was applied",
      second: [],
    });
  });
});
