// File → New after a big import left the old model drawn and pickable until the
// engine answered the empty document's rebuild, most of a second at 1,000 bodies.
// The view has to let go in the same call as the replacement, in this order.
import { describe, it, expect, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { wireDocumentSwap } from "../../src/app/documentSwap";
import type { CadDocument, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { cancelActiveTools } from "../../src/app/toolBusy";
import type { EngineTools } from "../../src/app/engine";
import { createPinia, setActivePinia } from "pinia";
import { useBrowserStore } from "../../src/stores/browser";

const RESULT: RebuildResult = {
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: 1 }],
};
const DOC = {
  parameters: {},
  features: [{ id: "f1", type: "sketch", plane: "XY", entities: [] }],
} as unknown as CadDocument;

/** Lands RESULT once, then never answers again, like an engine still busy freeing the old build. */
function slowEngine() {
  let calls = 0;
  return {
    async rebuild() {
      return ++calls === 1 ? { ok: true as const, result: RESULT } : new Promise<never>(() => {});
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
    async cancel() {
      return true;
    },
  } as unknown as GeometryBackend;
}

function harness(browser?: { forgetDocumentFolders(): void }) {
  const store = new DocumentStore(slowEngine(), DOC);
  const calls: string[] = [];
  const sketch = { active: true, cancel: () => calls.push("sketch.cancel") };
  wireDocumentSwap(store, {
    cancelTools: () => calls.push("cancelTools"),
    sketch,
    dropBodyGizmo: () => calls.push("dropBodyGizmo"),
    overlay: { clearRegionSelection: () => calls.push("clearRegionSelection") },
    forgetLastCommit: () => calls.push("forgetLastCommit"),
    viewport: {
      clearSelection: () => calls.push("clearSelection"),
      setSelectedBodies: () => calls.push("setSelectedBodies"),
      clearModel: () => calls.push("clearModel"),
    },
    browser: browser ?? { forgetDocumentFolders: () => calls.push("forgetDocumentFolders") },
  });
  store.onBuild((s) => {
    if (!s.building) calls.push(`build:${s.result ? "old" : "none"}`);
  });
  return { store, calls };
}

describe("New and Open clear the view at once", () => {
  for (const how of ["New", "Open"] as const) {
    it(`clears the model in the same call as ${how}, before any build tick and without the engine`, async () => {
      const { store, calls } = harness();
      await store.rebuildNow();
      calls.length = 0;
      if (how === "New") store.newDocument();
      else store.load(JSON.stringify({ parameters: {}, features: [] }));
      expect(calls.slice(0, 8)).toEqual([
        "cancelTools",
        "sketch.cancel",
        "dropBodyGizmo",
        "clearSelection",
        "setSelectedBodies",
        "clearRegionSelection",
        "forgetLastCommit",
        "clearModel",
      ]);
      expect(calls).not.toContain("build:old");
    });
  }

  it("keeps the model for a replace, which is the same document", async () => {
    const { store, calls } = harness();
    await store.rebuildNow();
    calls.length = 0;
    store.load(JSON.stringify(DOC), { replace: true });
    expect(calls).not.toContain("clearModel");
  });
});

// Every import's top node is "n:f1/0", so the 3D printer example opened with its folders as an earlier document's
// assembly was left.
describe("New and Open start the next document's folders from their defaults", () => {
  const open = (b: ReturnType<typeof useBrowserStore>) =>
    ["n:f1/0", "e:el1", "f:Origin", "f:Bodies"].filter((k) => !b.isCollapsed(k));

  for (const how of ["New", "Open"] as const) {
    it(`closes assembly folders and forgets element ones on ${how}, section folders stay as the user left them`, () => {
      setActivePinia(createPinia());
      const browser = useBrowserStore();
      const { store } = harness(browser);
      browser.expand("n:f1/0");
      browser.toggle("e:el1");
      browser.toggle("f:Origin");
      expect(open(browser)).toEqual(["n:f1/0", "f:Bodies"]);
      if (how === "New") store.newDocument();
      else store.load(JSON.stringify({ parameters: {}, features: [] }));
      expect(open(browser)).toEqual(["e:el1", "f:Bodies"]);
    });
  }

  it("keeps every folder through a replace, which is the same document", () => {
    setActivePinia(createPinia());
    const browser = useBrowserStore();
    const { store } = harness(browser);
    browser.expand("n:f1/0");
    store.load(JSON.stringify(DOC), { replace: true });
    expect(browser.isCollapsed("n:f1/0")).toBe(false);
  });
});

// An Extrude armed on a profile kept its slab, arrows and panel over the empty
// document, and a depth drag released after New committed into it.
describe("New and Open stand every tool down", () => {
  function tools(calls: string[]) {
    const tool = (name: string, active: boolean) => ({ active, cancel: () => calls.push(`${name}.cancel`) });
    const t: Record<string, unknown> = {};
    for (const n of [
      "extrude",
      "edgeFeature",
      "targetEdit",
      "pressPull",
      "faceOffset",
      "draft",
      "thread",
      "textOnFace",
      "hole",
      "loft",
      "pattern",
      "mirror",
      "planeOffset",
      "datumPose",
      "lightAim",
      "revolvePitch",
      "joint",
      "mechanism",
    ])
      t[n] = tool(n, n === "extrude" || n === "pressPull" || n === "mirror");
    t.move = tool("move", false);
    t.measure = { active: true, stop: () => calls.push("measure.stop") };
    t.section = { picking: false, editing: false, endEdit: () => calls.push("section.endEdit") };
    return t as unknown as EngineTools;
  }

  it("cancels the armed tools and leaves idle ones alone", () => {
    const calls: string[] = [];
    cancelActiveTools(tools(calls));
    expect(calls.sort()).toEqual([
      "extrude.cancel",
      "measure.stop",
      "mirror.cancel",
      "move.cancel",
      "pressPull.cancel",
    ]);
  });

  // A cut that is on, or none, is the store's to replace with the next document's own.
  it("ends a section aiming or editing and leaves one that is on or off alone", () => {
    for (const [picking, editing, ends] of [
      [true, false, true],
      [false, true, true],
      [false, false, false],
    ] as const) {
      const calls: string[] = [];
      const t = tools(calls);
      Object.assign(t.section, { picking, editing });
      cancelActiveTools(t);
      expect(calls.includes("section.endEdit")).toBe(ends);
    }
  });

  for (const how of ["New", "Open"] as const) {
    it(`drops a tool's live preview so ${how} does not build it into the next document`, async () => {
      const sent: string[] = [];
      const engine = {
        async rebuild(doc: CadDocument) {
          sent.push(doc.features.map((f) => f.id).join(","));
          return { ok: true as const, result: RESULT };
        },
        async init() {},
        onStatus() {
          return () => {};
        },
        onProgress() {
          return () => {};
        },
        async cancel() {
          return true;
        },
      } as unknown as GeometryBackend;
      const store = new DocumentStore(engine, DOC);
      await store.rebuildNow();
      store.setPreview({ id: "pv", type: "box", width: 60, depth: 60, height: 5 } as never);
      store.beginEditPreview("f1", null);
      if (how === "New") store.newDocument();
      else store.load(JSON.stringify({ parameters: {}, features: [] }));
      expect(store.hasPreview).toBe(false);
      expect(store.editPreviewId).toBeNull();
      sent.length = 0;
      await store.rebuildNow();
      expect(sent.at(-1)).toBe("");
    });
  }

  it("keeps a tool's live preview through a replace load, where the tool stays armed", async () => {
    const engine = {
      async rebuild() {
        return { ok: true as const, result: RESULT };
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      onProgress() {
        return () => {};
      },
      async cancel() {
        return true;
      },
    } as unknown as GeometryBackend;
    const store = new DocumentStore(engine, DOC);
    await store.rebuildNow();
    store.setPreview({ id: "pv", type: "box", width: 60, depth: 60, height: 5 } as never);
    store.beginEditPreview("f1", null);
    store.load(JSON.stringify(DOC), { replace: true });
    expect(store.hasPreview).toBe(true);
    expect(store.editPreviewId).toBe("f1");
  });

  it("still clears the document when one tool's cancel throws", () => {
    const calls: string[] = [];
    const t = tools(calls);
    t.extrude.cancel = () => {
      throw new Error("boom");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => cancelActiveTools(t)).not.toThrow();
    expect(calls).toContain("pressPull.cancel");
    err.mockRestore();
  });
});
