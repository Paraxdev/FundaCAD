// Which store actions begin a new document session: another document taking this one's place does, another state of
// the same document does not.
import { describe, expect, it, vi } from "vitest";
import { box, freshStore, opened } from "./storeKit";

vi.stubGlobal("window", globalThis);

const doc = (id: string, length: number) => JSON.stringify({ parameters: {}, features: [box(id, length)] });

describe("document session lifecycle", () => {
  it("New, Open and a template begin a session and end the one before", () => {
    const s = freshStore();
    const first = s.session;
    s.newDocument();
    const second = s.session;
    s.load(doc("t1", 4.5));
    const third = s.session;
    s.load(doc("o1", 6.25));
    const fourth = s.session;
    expect({
      alive: [first, second, third, fourth].map((x) => x.alive),
      endedBy: [first, second, third].map((x) => x.endedBy),
      distinct: new Set([first, second, third, fourth]).size,
    }).toEqual({ alive: [false, false, false, true], endedBy: ["new", "open", "open"], distinct: 4 });
  });

  it("undo, redo, a version restore, a replace load and a replacing loadDocument keep the session", () => {
    const s = opened({ features: [box("f1", 10.5)] });
    const kept = s.session;
    s.addFeature(box("f2", 3.25));
    const v1 = s.saveVersion("v1")!;
    s.addFeature(box("f3", 2.5));
    s.undo();
    s.redo();
    s.restoreVersion(v1.id);
    s.load(doc("f1", 7.75), { replace: true });
    s.loadDocument({ parameters: {}, features: [box("f1", 8.5)] }, { replace: true });
    const stillKept = s.session === kept && kept.alive;
    s.load(doc("b1", 1.5));
    const second = s.session;
    s.load(doc("c1", 2.5));
    expect({ stillKept, keptAlive: kept.alive, secondAlive: second.alive, currentAlive: s.session.alive }).toEqual({
      stillKept: true,
      keptAlive: false,
      secondAlive: false,
      currentAlive: true,
    });
  });

  it("an unreadable file does not end the open document's session", () => {
    const s = opened({ features: [box("f1", 10.5)] });
    const kept = s.session;
    expect(() => s.load("{ not json")).toThrow();
    expect(() => s.load(JSON.stringify({ features: 3 }))).toThrow();
    expect({ same: s.session === kept, alive: kept.alive }).toEqual({ same: true, alive: true });
  });
});
