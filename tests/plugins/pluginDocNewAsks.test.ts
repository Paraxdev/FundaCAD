// A plugin's doc_new ends the open document the way the user's New does: unsaved work is only thrown away after the
// user says Discard, and a Cancel refuses the doc_new and leaves the document, its path and its run as they were.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const ui = vi.hoisted(() => ({ pick: "discard" as string | null, asked: [] as string[] }));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    ui.asked.push(question);
    return ui.pick;
  },
}));

const { appHost } = await import("../../src/plugins/broker/appHost");

const outcome = (p: Promise<unknown>) => p.then(() => "ok").catch((e: Error) => e.message);
const shape = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  path: store.filePath,
  dirty: store.dirty,
});
const plate = (id: string) => ({ feature: { id, type: "box", length: 23.5, width: 11.25, height: 3.5 } });

function edited(path: string, ...ids: string[]) {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  store.markSaved(path);
  ids.forEach((id, i) => store.addFeature(box(id, 17.5 + i * 4.25)));
  return store;
}

describe("a plugin's doc_new over unsaved work", () => {
  beforeEach(() => {
    ui.pick = "discard";
    ui.asked = [];
  });

  it("is refused on Cancel, and the run goes on writing into the kept document", async () => {
    ui.pick = "cancel";
    const store = edited("D:/parts/bracket.funda", "a-plate", "a-rib");
    const session = store.session;
    const run = appHost({ store });
    const refused = await outcome(run.perform("doc_new", {}));
    const kept = shape(store);
    const write = await outcome(run.perform("feature_add", plate("a-boss")));
    expect({
      refused: refused.startsWith("doc_new:"),
      asked: ui.asked.length,
      kept,
      sameSession: store.session === session && session.alive,
      write,
      after: shape(store).features,
    }).toEqual({
      refused: true,
      asked: 1,
      kept: { features: ["a-plate", "a-rib"], path: "D:/parts/bracket.funda", dirty: true },
      sameSession: true,
      write: "ok",
      after: ["a-plate", "a-rib", "a-boss"],
    });
  });

  it("starts the new document on Discard, a dismissed question counts as Cancel", async () => {
    const store = edited("D:/parts/bracket.funda", "a-plate");
    const discarded = await outcome(appHost({ store }).perform("doc_new", {}));
    const fresh = shape(store);

    // The second document: a dismissed question keeps it, nothing of the first leaks back.
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    store.markSaved("E:/other/hinge.funda");
    store.addFeature(box("b-hinge", 9.75));
    ui.pick = null;
    const dismissed = await outcome(appHost({ store }).perform("doc_new", {}));
    expect({
      discarded,
      fresh,
      dismissed: dismissed.startsWith("doc_new:"),
      kept: shape(store),
      asked: ui.asked.length,
    }).toEqual({
      discarded: "ok",
      fresh: { features: [], path: null, dirty: false },
      dismissed: true,
      kept: { features: ["b-hinge"], path: "E:/other/hinge.funda", dirty: true },
      asked: 2,
    });
  });

  it("asks nothing over a saved document, nor over an empty one", async () => {
    ui.pick = "cancel";
    const store = edited("D:/parts/bracket.funda", "a-plate");
    store.markSaved("D:/parts/bracket.funda");
    const saved = await outcome(appHost({ store }).perform("doc_new", {}));
    const again = await outcome(appHost({ store }).perform("doc_new", {}));
    expect({ saved, again, asked: ui.asked, last: shape(store) }).toEqual({
      saved: "ok",
      again: "ok",
      asked: [],
      last: { features: [], path: null, dirty: false },
    });
  });

  it("uses the question the caller passes", async () => {
    const store = edited("D:/parts/bracket.funda", "a-plate", "a-rib", "a-boss");
    const questions: string[] = [];
    const run = appHost({ store, mayDiscard: async (q) => (questions.push(q), false) });
    const refused = await outcome(run.perform("doc_new", {}));
    expect({
      refused: refused.startsWith("doc_new:"),
      asked: questions.length,
      ui: ui.asked,
      kept: shape(store),
    }).toEqual({
      refused: true,
      asked: 1,
      ui: [],
      kept: { features: ["a-plate", "a-rib", "a-boss"], path: "D:/parts/bracket.funda", dirty: true },
    });
  });
});
