// A plugin's doc_get then doc_set, or an assistant's live edit, puts another state of the open file in place.
// A round trip loses nothing, and no replacement touches the versions, which are that file's history.
import { describe, expect, it, vi } from "vitest";
import { appHost } from "../../src/plugins/broker/appHost";
import { createBroker } from "../../src/plugins/broker/broker";
import { allOpGrants } from "../../src/plugins/broker/ops";
import type { DocumentStore } from "../../src/document/store";
import type { CadDocument } from "../../src/types";
import { box, env, opened, saved, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

const SECTIONS = ["versions", "stress", "environment", "palette", "bodyColors", "elements", "materials", "futureKey"];

function workedOn() {
  // bodyIds as a build leaves it, since doc_set numbers a document without one as a new one.
  const s = opened({ parameters: { w: 7.5 }, features: [box("f1", 10.5)], bodyIds: {}, futureKey: { kept: 1 } });
  s.saveVersion("one");
  s.addFeature(box("f2", 4.25, 2));
  s.setStressStudy(study);
  s.setDocumentEnvironment(env(2.25));
  s.setPaletteSlot(0, { color: "#2a7f3c" });
  s.setBodyColorSlot("body2", 3);
  s.addElement("Hinges");
  s.addMaterial({ name: "Oak", color: "#a0522d" });
  s.saveVersion("two");
  return s;
}

const plugin = (s: DocumentStore) =>
  createBroker({ plugin: "under-test", grants: allOpGrants(), host: appHost({ store: s }) });

async function roundTrip(s: DocumentStore, edit: (d: CadDocument) => void = () => {}) {
  const b = plugin(s);
  const got = await b.callOrThrow<CadDocument>("doc_get");
  edit(got);
  await b.callOrThrow("doc_set", { document: got });
}

const messages = (s: DocumentStore) => s.versionRepo?.versions.map((v) => v.message) ?? null;
const sections = (s: DocumentStore) => SECTIONS.filter((k) => saved(s)[k] !== undefined);
const lengthOf = (s: DocumentStore, id: string) =>
  (s.document.features.find((f) => f.id === id) as unknown as { length: number }).length;

describe("a plugin's doc_get then doc_set", () => {
  it("keeps the versions and every project section", async () => {
    const s = workedOn();
    const before = saved(s);
    await roundTrip(s);
    expect(messages(s)).toEqual(["one", "two"]);
    expect(saved(s)).toEqual(before);
  });

  it("keeps them through undo and redo of an edit it made", async () => {
    const s = workedOn();
    const before = saved(s);
    await roundTrip(s, (d) => void ((d.features[1] as unknown as { length: number }).length = 6.5));
    expect(lengthOf(s, "f2")).toBe(6.5);
    s.undo();
    expect(saved(s)).toEqual(before);
    s.redo();
    expect(lengthOf(s, "f2")).toBe(6.5);
    expect(messages(s)).toEqual(["one", "two"]);
    expect(sections(s)).toEqual(SECTIONS);
  });

  it("keeps a version saved after it when it is undone", async () => {
    const s = workedOn();
    await roundTrip(s, (d) => void ((d.features[1] as unknown as { length: number }).length = 6.5));
    s.saveVersion("three");
    s.undo();
    expect(messages(s)).toEqual(["one", "two", "three"]);
  });

  it("leaves a polygon's angle alone, since the copy says which format it is in", async () => {
    const s = opened({ version: 10, parameters: {}, features: [{ id: "f1", type: "sketch", plane: "XY", entities: [
      { type: "polygon", id: "e1", x: 12.5, y: -4.25, radius: 10, sides: 6, angle: 30 }] }] });
    await roundTrip(s);
    await roundTrip(s);
    expect((s.document.features[0] as unknown as { entities: { angle: number }[] }).entities[0]!.angle).toBe(30);
  });

  it("keeps versions this build cannot read, through undo too", async () => {
    const s = opened({ parameters: {}, features: [box("f1", 3)], versions: "from-a-newer-build" });
    await roundTrip(s);
    expect(s.hasUnreadVersions()).toBe(true);
    expect(saved(s).versions).toBe("from-a-newer-build");
    s.undo();
    expect(saved(s).versions).toBe("from-a-newer-build");
    await plugin(s).callOrThrow("doc_set", { document: { parameters: {}, features: [box("f1", 4.75, 2.5)] } });
    expect([s.hasUnreadVersions(), saved(s).versions]).toEqual([true, "from-a-newer-build"]);
  });

  it("keeps the open file's versions when it sends an unrelated document, and undo brings back the rest", async () => {
    const s = workedOn();
    const before = saved(s);
    await plugin(s).callOrThrow("doc_set", { document: { parameters: {}, features: [box("zz", 1)] } });
    expect(messages(s)).toEqual(["one", "two"]);
    expect(sections(s)).toEqual(["versions"]);
    s.undo();
    expect(saved(s)).toEqual(before);
  });

  it("keeps the open file's versions when it sends a file with versions of its own", async () => {
    const s = workedOn();
    const other = opened({ parameters: {}, features: [box("o1", 2)] });
    other.saveVersion("the other file's");
    await plugin(s).callOrThrow("doc_set", { document: JSON.parse(other.toJSON()) });
    expect(messages(s)).toEqual(["one", "two"]);
    s.undo();
    expect(messages(s)).toEqual(["one", "two"]);
  });

  it("leaves nothing of the first document in a second one opened after", async () => {
    const unread = opened({ parameters: {}, features: [box("f1", 3)], versions: "from-a-newer-build" });
    for (const s of [workedOn(), unread]) {
      await roundTrip(s);
      s.load(JSON.stringify({ parameters: {}, features: [box("g1", 2)] }));
      expect(s.versionRepo).toBeNull();
      expect(s.hasUnreadVersions()).toBe(false);
      expect(sections(s)).toEqual([]);
    }
  });
});

describe("an assistant's live edit", () => {
  it("does not take away a version saved while it was on its way", () => {
    const s = workedOn();
    const proposal = JSON.parse(JSON.stringify(s.toObject())) as CadDocument;
    s.addFeature(box("f3", 1));
    s.saveVersion("three");
    s.loadDocument(proposal, { replace: true });
    expect(messages(s)).toEqual(["one", "two", "three"]);
  });

  it("keeps the versions when the assistant's doc_set left them out", () => {
    const s = workedOn();
    const d = s.document;
    s.loadDocument({ parameters: d.parameters, paramDefs: d.paramDefs, features: d.features, bodyIds: d.bodyIds } as CadDocument, { replace: true });
    expect(messages(s)).toEqual(["one", "two"]);
  });
});
