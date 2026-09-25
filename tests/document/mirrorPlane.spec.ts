// A mirror that names bodies is stored with its plane as { name }, so a build
// from before targeted mirrors refuses it instead of reflecting the active body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { mirrorPlaneName } from "../../src/document/mirrorPlane";
import { choiceFieldsFor, choiceValue } from "../../src/document/optionFields";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const backend = (rebuilds: CadDocument[]) => ({
  async rebuild(doc: CadDocument): Promise<RebuildReply> {
    rebuilds.push(doc);
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() { return () => {}; },
  connected: true,
}) as unknown as GeometryBackend;

const box = { id: "b1", type: "box", length: 1, width: 1, height: 1 } as Feature;

let store: DocumentStore;
let rebuilds: CadDocument[];
const mirror = (id: string) => store.document.features.find((f) => f.id === id) as Extract<Feature, { type: "mirror" }>;

describe("mirror plane form", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
    store = new DocumentStore(backend(rebuilds), { parameters: {}, features: [box] });
  });
  afterEach(() => void vi.useRealTimers());

  it("writes { name } once the mirror names bodies, and every build sees that form", async () => {
    store.addFeature({ id: "m1", type: "mirror", plane: "YZ", bodies: ["body1"] } as Feature);
    expect(mirror("m1").plane).toEqual({ name: "YZ" });
    await vi.runAllTimersAsync();
    const sent = rebuilds[rebuilds.length - 1]!.features.find((f) => f.id === "m1") as { plane: unknown };
    expect(sent.plane).toEqual({ name: "YZ" });
  });

  it("keeps a bare plane without bodies, and converts it when bodies are added later", () => {
    store.addFeature({ id: "m1", type: "mirror", plane: "XZ" } as Feature);
    expect(mirror("m1").plane).toBe("XZ");
    store.updateFeature("m1", { bodies: ["body1"] } as Partial<Feature>);
    expect(mirror("m1").plane).toEqual({ name: "XZ" });
    store.updateFeature("m1", { plane: "XY" } as Partial<Feature>);
    expect(mirror("m1").plane).toEqual({ name: "XY" });
  });

  it("opens a file with the bare form and bodies in the { name } form", () => {
    store.load(JSON.stringify({ version: 9, parameters: {}, features: [box, { id: "m1", type: "mirror", plane: "YZ", bodies: ["body1"] }] }));
    expect(mirror("m1").plane).toEqual({ name: "YZ" });
  });

  it("shows the plane a { name } holds in the Plane row", () => {
    const m = { id: "m1", type: "mirror", plane: { name: "YZ" }, bodies: ["body1"] } as Feature;
    const row = choiceFieldsFor("mirror").find((f) => f.field === "plane")!;
    expect(choiceValue(m, row)).toBe("YZ");
    expect(mirrorPlaneName("XZ")).toBe("XZ");
  });
});
