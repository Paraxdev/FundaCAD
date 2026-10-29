// An assistant's doc_open or doc_new is another document put in place as one undoable edit. It must not keep the
// user's file path, or a later Save writes the assistant's document over the user's file.
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import { LiveSessionHost } from "../../src/live/liveSession";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

class StubBackend {
  reply: Record<string, unknown> = { ok: true, guests: [], proposals: [] };
  async session(): Promise<Record<string, unknown>> {
    return this.reply;
  }
  async rebuild() {
    return { ok: true, result: { bodies: [], errors: [] } } as never;
  }
  async init() {}
  onStatus() {
    return () => {};
  }
  get connected() {
    return true;
  }
}

function plates(...ids: string[]): CadDocument {
  return {
    parameters: {},
    features: ids.map((id, i) => ({ id, type: "box", width: 12.5 + i, depth: 7.25, height: 3 + i })),
  } as unknown as CadDocument;
}

const meta = (store: DocumentStore) => ({
  path: store.filePath,
  name: store.fileName,
  features: store.document.features.map((f) => f.id),
});

describe("an assistant's whole other document", () => {
  let geo: StubBackend;
  let store: DocumentStore;
  let host: LiveSessionHost;
  let n = 0;

  const propose = async (note: string | null, document: CadDocument, replaces: boolean) => {
    geo.reply = {
      ok: true,
      guests: ["an assistant"],
      proposals: [{ id: `p${++n}`, name: "an assistant", note, document, ...(replaces ? { replaces: true } : {}) }],
    };
    await host.tick();
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [] };
  };

  beforeEach(async () => {
    geo = new StubBackend();
    store = new DocumentStore(geo as unknown as GeometryBackend, EMPTY_DOCUMENT);
    store.loadDocument(plates("bracket-a", "bracket-b"));
    store.markSaved("D:/parts/bracket.funda");
    host = new LiveSessionHost(store, geo as unknown as GeometryBackend, () => true);
    host.start();
    await host.tick();
  });

  it("drops the file path on doc_open and doc_new, and an undo puts it back", async () => {
    await propose("doc_open", plates("lid-x"), true);
    const opened = meta(store);
    const dirtyAfterOpen = store.dirty;
    store.undo();
    const undone = meta(store);
    store.redo();
    const redone = meta(store);
    await propose("doc_new", plates(), true);
    const fresh = meta(store);
    store.undo();
    store.undo();
    const back = meta(store);
    await host.stop();
    expect({ opened, dirtyAfterOpen, undone, redone, fresh, back }).toEqual({
      opened: { path: null, name: "Untitled", features: ["lid-x"] },
      dirtyAfterOpen: true,
      undone: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["bracket-a", "bracket-b"] },
      redone: { path: null, name: "Untitled", features: ["lid-x"] },
      fresh: { path: null, name: "Untitled", features: [] },
      back: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["bracket-a", "bracket-b"] },
    });
  });

  it("keeps the file path on doc_set, an edit, or a note that only starts like doc_open", async () => {
    await propose("doc_set", plates("bracket-a", "rib-c"), true);
    const set = meta(store);
    await propose("feature_add: box", plates("bracket-a", "rib-c", "boss-d"), false);
    const edited = meta(store);
    await propose("doc_opener", plates("hinge-e"), true);
    const lookalike = meta(store);
    // Only a whole other document drops the path, an edit that happens to carry that note does not.
    await propose("doc_open", plates("hinge-e", "pin-f"), false);
    const notReplacing = meta(store);
    await host.stop();
    expect({ set, edited, lookalike, notReplacing }).toEqual({
      set: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["bracket-a", "rib-c"] },
      edited: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["bracket-a", "rib-c", "boss-d"] },
      lookalike: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["hinge-e"] },
      notReplacing: { path: "D:/parts/bracket.funda", name: "bracket.funda", features: ["hinge-e", "pin-f"] },
    });
  });

  it("drops a name taken without a path too, and the next opened file keeps its own path", async () => {
    store.markOpenedWithoutPath("shared.funda");
    await propose("doc_open", plates("lid-x"), true);
    const opened = meta(store);
    store.undo();
    const undone = meta(store);

    store.load(JSON.stringify(plates("gear-g")));
    store.markSaved("E:/other/gear.funda");
    await propose("doc_set", plates("gear-g", "hub-h"), true);
    const nextSet = meta(store);
    await propose("doc_new", plates(), true);
    store.undo();
    store.undo();
    const nextBack = meta(store);
    store.undo();
    const pastOpen = meta(store);
    await host.stop();
    expect({ opened, undone, nextSet, nextBack, pastOpen }).toEqual({
      opened: { path: null, name: "Untitled", features: ["lid-x"] },
      undone: { path: null, name: "shared.funda", features: ["bracket-a", "bracket-b"] },
      nextSet: { path: "E:/other/gear.funda", name: "gear.funda", features: ["gear-g", "hub-h"] },
      nextBack: { path: "E:/other/gear.funda", name: "gear.funda", features: ["gear-g"] },
      pastOpen: { path: "E:/other/gear.funda", name: "gear.funda", features: ["gear-g"] },
    });
  });
});
