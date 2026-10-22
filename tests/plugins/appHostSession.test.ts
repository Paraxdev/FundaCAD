// A plugin edit is for the document the plugin last worked on: one that arrives after the user closed it is refused
// and changes nothing, and the plugin's next call works on the document open now.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { appHost } from "../../src/plugins/broker/appHost";
import { stubBackend } from "../document/storeKit";

const plate = (id: string) => ({ feature: { id, type: "box", length: 10, width: 10, height: 2 } });
const outcome = (p: Promise<unknown>) => p.then(() => "ok").catch((e: Error) => e.message);

describe("plugin edits and the document they were meant for", () => {
  it("an edit after New is refused once, a read or the plugin's own doc_new makes the next one land", async () => {
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const host = appHost({ store });
    await host.perform("doc_get", {});
    const inA = await outcome(host.perform("feature_add", plate("a1")));
    const featuresA = store.document.features.map((f) => f.id);

    store.newDocument();
    const late = await outcome(host.perform("feature_add", plate("late")));
    const afterLate = store.document.features.map((f) => f.id);
    const retried = await outcome(host.perform("feature_add", plate("b1")));

    store.newDocument();
    await host.perform("doc_get", {});
    const afterRead = await outcome(host.perform("feature_add", plate("c1")));
    const featuresC = store.document.features.map((f) => f.id);

    await host.perform("doc_new", {});
    const afterOwnNew = await outcome(host.perform("feature_add", plate("d1")));
    expect({ inA, featuresA, late, afterLate, retried, afterRead, featuresC, afterOwnNew }).toEqual({
      inA: "ok",
      featuresA: ["a1"],
      late: "feature_add: the document closed before this edit arrived, nothing was applied, read the open one",
      afterLate: [],
      retried: "ok",
      afterRead: "ok",
      featuresC: ["c1"],
      afterOwnNew: "ok",
    });
  });
});
