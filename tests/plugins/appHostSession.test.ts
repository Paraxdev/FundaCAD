// A plugin run works on the document open when it started: once the user closes it, every write of that run is
// refused and changes nothing, whatever it read since; only the run's own doc_new moves it to another document.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { appHost } from "../../src/plugins/broker/appHost";
import { stubBackend } from "../document/storeKit";

const plate = (id: string, length: number | string = 10) => ({
  feature: { id, type: "box", length, width: 10, height: 2 },
});
const outcome = (p: Promise<unknown>) => p.then(() => "ok").catch((e: Error) => e.message);
const closed = (op: string) => `${op}: the document this plugin run was working on was closed, nothing was applied`;
const shape = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  params: Object.keys(store.document.parameters),
  dirty: store.dirty,
});

describe("a plugin run and the document it works on", () => {
  it("refuses every write once its document was closed, a read does not change that", async () => {
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const run = appHost({ store });
    const inA = await outcome(run.perform("feature_add", plate("a1")));
    const a = shape(store);

    store.newDocument();
    const late = {
      param: await outcome(run.perform("param_set", { name: "w", expr: 5 })),
      feature: await outcome(run.perform("feature_add", plate("a2", "w"))),
      read: await outcome(run.perform("doc_get", {})),
      afterRead: await outcome(run.perform("feature_add", plate("a3"))),
      set: await outcome(run.perform("doc_set", { document: { parameters: {}, features: [] } })),
      replaced: await outcome(run.perform("doc_new", {})),
    };
    const b = shape(store);

    // The control: a run started in the new document writes into it.
    const next = appHost({ store });
    const inB = await outcome(next.perform("feature_add", plate("b1")));
    const bAfter = shape(store);

    // And the next document after that is untouched by both runs' late writes.
    store.newDocument();
    const lateAgain = await outcome(next.perform("feature_add", plate("b2")));
    expect({ inA, a, late, b, inB, bAfter, lateAgain, c: shape(store) }).toEqual({
      inA: "ok",
      a: { features: ["a1"], params: [], dirty: true },
      late: {
        param: closed("param_set"),
        feature: closed("feature_add"),
        read: "ok",
        afterRead: closed("feature_add"),
        set: closed("doc_set"),
        replaced: closed("doc_new"),
      },
      b: { features: [], params: [], dirty: false },
      inB: "ok",
      bAfter: { features: ["b1"], params: [], dirty: true },
      lateAgain: closed("feature_add"),
      c: { features: [], params: [], dirty: false },
    });
  });

  it("goes on in the document its own doc_new started", async () => {
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const run = appHost({ store });
    await run.perform("feature_add", plate("a1"));
    const made = await outcome(run.perform("doc_new", {}));
    const inNew = await outcome(run.perform("feature_add", plate("n1")));
    const own = shape(store);
    store.newDocument();
    const late = await outcome(run.perform("feature_add", plate("n2")));
    expect({ made, inNew, own, late, next: shape(store) }).toEqual({
      made: "ok",
      inNew: "ok",
      own: { features: ["n1"], params: [], dirty: true },
      late: closed("feature_add"),
      next: { features: [], params: [], dirty: false },
    });
  });
});

describe("a plugin doc_set while an import is read into the document", () => {
  it("is refused while the import runs, edits of the same document are not, and it works once the import ends", async () => {
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const run = appHost({ store });
    let finish!: () => void;
    const reading = store.runBusy(
      "Importing sv08.step",
      (onStarted) => {
        onStarted("rq-import");
        return new Promise<void>((r) => (finish = r));
      },
      { holdHistory: true },
    );
    const unrelated = { parameters: {}, features: [plate("other").feature] };
    const during = {
      set: await outcome(run.perform("doc_set", { document: unrelated })),
      edit: await outcome(run.perform("feature_add", plate("a1"))),
    };
    const whileReading = shape(store);
    finish();
    await reading;
    const after = await outcome(run.perform("doc_set", { document: unrelated }));
    const replaced = shape(store);
    store.newDocument();
    expect({ during, whileReading, after, replaced, next: shape(store) }).toEqual({
      during: {
        set: "doc_set: an import is still being read into the open document, nothing was applied, try again once it has landed",
        edit: "ok",
      },
      whileReading: { features: ["a1"], params: [], dirty: true },
      after: "ok",
      replaced: { features: ["other"], params: [], dirty: true },
      next: { features: [], params: [], dirty: false },
    });
  });
});
