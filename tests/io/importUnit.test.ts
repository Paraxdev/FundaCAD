import { beforeEach, describe, expect, it, vi } from "vitest";

const choose = vi.fn();
vi.mock("../../src/ui/choice", () => ({ choose: (...a: unknown[]) => choose(...a) }));
vi.stubGlobal("window", globalThis);

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { importFileBytes, importPath } from "../../src/io/files";
import { askImportUnit, asksForUnit, lastImportUnit, unitChoices } from "../../src/io/importUnit";

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
});

beforeEach(() => {
  saved.clear();
  choose.mockReset();
});

describe("the import unit picker", () => {
  it("asks for the four formats that leave the unit open", () => {
    for (const f of ["glb", "gltf", "vrml", "x3d"] as const) expect(asksForUnit(f)).toBe(true);
    for (const f of ["step", "stl", "obj", "amf", "3mf", "fbx", "3ds"] as const) expect(asksForUnit(f)).toBe(false);
  });

  it("starts at metres and offers the last choice first", () => {
    expect(lastImportUnit()).toBe("m");
    expect(unitChoices("m").map((c) => c.value)).toEqual(["m", "mm", "cm", "inch"]);
    expect(unitChoices("inch")[0]).toMatchObject({ value: "inch", hint: "last used" });
  });

  it("remembers the answer for the next import", async () => {
    choose.mockResolvedValueOnce("cm");
    expect(await askImportUnit("glb")).toBe("cm");
    expect(lastImportUnit()).toBe("cm");
    choose.mockResolvedValueOnce(null);
    expect(await askImportUnit("x3d")).toBeNull();
    expect(lastImportUnit()).toBe("cm");
    expect(choose.mock.calls[1]![1][0].value).toBe("cm");
  });

  it("ignores a stored value it does not know", () => {
    saved.set("fundacad.importUnit", "furlong");
    expect(lastImportUnit()).toBe("m");
  });
});

describe("importPath with a unit", () => {
  function backend() {
    const calls: unknown[][] = [];
    const be = {
      async rebuild() { return new Promise<never>(() => {}); },
      async init() {},
      onStatus() { return () => {}; },
      onProgress() { return () => {}; },
      async cancel() { return true; },
      async importGeometry(...args: unknown[]) {
        calls.push(args);
        return { ok: true, geom: "h", name: "cube", solid: true, faces: 6, ...(args[3] ? { unit: args[3] } : {}) };
      },
    } as unknown as GeometryBackend;
    return { be, calls };
  }

  it("sends the chosen unit to the engine and keeps it on the feature", async () => {
    choose.mockResolvedValueOnce("inch");
    const { be, calls } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importPath(store, be, "C:/m/part.glb");
    expect(calls[0]![3]).toBe("inch");
    expect(store.document.features[0]).toMatchObject({ type: "import", format: "glb", unit: "inch" });
  });

  it("adds nothing when the picker is dismissed", async () => {
    choose.mockResolvedValueOnce(null);
    const { be, calls } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importPath(store, be, "C:/m/scene.wrl");
    expect(calls).toHaveLength(0);
    expect(store.document.features).toHaveLength(0);
  });

  it("does not ask for a STEP file", async () => {
    const { be, calls } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importPath(store, be, "C:/m/part.step");
    expect(choose).not.toHaveBeenCalled();
    expect(calls[0]![3]).toBeUndefined();
    expect(store.document.features[0]).not.toHaveProperty("unit");
  });

  it("records the source a downloader names instead of its temp file", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importPath(store, be, "C:/data/downloads/Bracket.step");
    expect(store.document.features[0]).toHaveProperty("source", "C:/data/downloads/Bracket.step");
    await importPath(store, be, "C:/data/downloads/Bracket.step", undefined, { source: "https://cad.onshape.com/documents/x" });
    expect(store.document.features[1]).toHaveProperty("source", "https://cad.onshape.com/documents/x");
  });
});

describe("importFileBytes with a unit", () => {
  function backend() {
    const calls: unknown[][] = [];
    const be = {
      async rebuild() { return new Promise<never>(() => {}); },
      async init() {},
      onStatus() { return () => {}; },
      onProgress() { return () => {}; },
      async cancel() { return true; },
      async importGeometry() { throw new Error("a dropped file has no path"); },
      async importBytes(...args: unknown[]) {
        calls.push(args);
        return { ok: true, geom: "h", name: "scene", solid: true, faces: 6, ...(args[4] ? { unit: args[4] } : {}) };
      },
    } as unknown as GeometryBackend;
    return { be, calls };
  }

  it("asks like a path import does and sends the unit with the bytes", async () => {
    choose.mockResolvedValueOnce("cm");
    const { be, calls } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importFileBytes(store, be, new File([new Uint8Array([1, 2, 3])], "scene.glb"));
    expect(calls[0]![0]).toBe("scene.glb");
    expect(calls[0]![2]).toBe("AQID");
    expect(calls[0]![4]).toBe("cm");
    expect(store.document.features[0]).toMatchObject({ type: "import", format: "glb", unit: "cm", source: "scene.glb" });
  });

  it("reads nothing when the picker is dismissed", async () => {
    choose.mockResolvedValueOnce(null);
    const { be, calls } = backend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    await importFileBytes(store, be, new File([new Uint8Array([1])], "scene.x3d"));
    expect(calls).toHaveLength(0);
    expect(store.document.features).toHaveLength(0);
  });
});
