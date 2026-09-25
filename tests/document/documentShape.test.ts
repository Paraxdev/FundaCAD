// FI-8: a file that is not a document, or a damaged one, is refused before the
// store is touched, with a reason in words and the technical detail kept apart.
import { describe, expect, it } from "vitest";
import { documentShapeProblem, UnreadableDocumentError } from "../../src/document/documentShape";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {},
  onStatus() { return () => {}; },
  connected: true,
} as unknown as GeometryBackend;

const doc = (): CadDocument => ({
  parameters: {},
  features: [{ id: "s1", type: "sketch", plane: "XY", entities: [] }] as Feature[],
});

describe("documentShapeProblem", () => {
  it("accepts a document", () => {
    expect(documentShapeProblem(doc())).toBeNull();
    expect(documentShapeProblem({ features: [] })).toBeNull();
  });

  it("names what is wrong, in words and in detail", () => {
    expect(documentShapeProblem({ features: "not-an-array", bodyIds: null })).toEqual({
      reason: "its list of modelling steps is damaged",
      detail: `"features" is a string, expected an array`,
    });
    expect(documentShapeProblem([1, 2])?.reason).toBe("it holds no document");
    expect(documentShapeProblem({ name: "package" })?.reason).toBe("it has no modelling steps in it");
    expect(documentShapeProblem({ features: [{ id: "a" }] })?.reason).toBe("step 1 of its modelling steps is damaged");
    expect(documentShapeProblem({ features: [], parameters: [] })?.reason).toBe("its parameters are damaged");
    expect(documentShapeProblem({ features: [], version: "9" })?.reason).toBe("its format version is damaged");
  });
});

describe("DocumentStore.load of a file that is not a document", () => {
  it.each([
    ["garbled text", "{ nope"],
    ["the wrong shape", JSON.stringify({ features: "not-an-array", bodyIds: null })],
  ])("refuses %s and leaves the open document alone", (_, text) => {
    const store = new DocumentStore(backend, doc());
    const before = store.toJSON();
    let thrown: unknown;
    try {
      store.load(text);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnreadableDocumentError);
    expect((thrown as UnreadableDocumentError).reason).not.toMatch(/flatMap|JSON|position/);
    expect(store.toJSON()).toBe(before);
    expect(store.canUndo).toBe(false);
  });
});
