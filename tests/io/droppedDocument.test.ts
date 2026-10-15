// A document dropped on the desktop app as bytes, with no path: macOS and Linux
// always, Windows when WebView2 does not name the path. It has to open the way
// File > Open does, through Rust, or embedded geometry is lost and a .fundab is
// read as text.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

const DROPPED = JSON.stringify({ version: 9, parameters: { dropped: 10 }, features: [] });

describe("a document dropped as bytes in the desktop app", () => {
  let invoked: { cmd: string; args: unknown }[];
  let reported: string[];
  let reply: () => unknown;

  beforeEach(() => {
    invoked = [];
    reported = [];
    reply = () => ({ document: DROPPED, repairedShards: 0, usedBackupIndex: false, wasContainer: true });
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: async (cmd: string, args: unknown) => {
        invoked.push({ cmd, args });
        return reply();
      },
    }));
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      message: async (m: string) => void reported.push(m),
    }));
    vi.doMock("../../src/app/documentActions", () => ({ mayDiscard: async () => true }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.doUnmock("../../src/app/documentActions");
    vi.resetModules();
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  function setup() {
    const importBytes = vi.fn(async () => ({ ok: false, message: "stub" }));
    const geometry = {
      async rebuild() { return { ok: false, error: { message: "stub" } }; },
      async init() {}, onStatus() { return () => {}; }, connected: true,
      async migrateGeometry() { return []; },
      importBytes,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(geometry, { parameters: {}, features: [] });
    store.markSaved("D:/work/previous.funda");
    return { store, geometry, importBytes, engine: { store, geometry, sketch: { hasUncommittedEdits: false } } as never };
  }

  const binary = () => new Uint8Array([0x46, 0x55, 0x4e, 0x44, 0x41, 0xff, 0xfe, 0x00, 0x80]);

  it("is read by Rust from its raw bytes, not decoded as text", async () => {
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine } = setup();
    await takeDroppedFiles(engine, [{ name: "part.fundab", path: null, file: new File([binary()], "part.fundab") }]);

    expect(invoked.map((c) => c.cmd)).toEqual(["container_open_bytes"]);
    expect(Array.from(invoked[0]!.args as Uint8Array)).toEqual(Array.from(binary()));
    expect(reported).toEqual([]);
    expect(store.document.parameters).toEqual({ dropped: 10 });
  });

  it("shows its name, stays clean and never saves to the bare name or the previous file", async () => {
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine } = setup();
    await takeDroppedFiles(engine, [{ name: "part.fundab", path: null, file: new File([binary()], "part.fundab") }]);

    expect(store.filePath).toBeNull();
    expect(store.fileName).toBe("part.fundab");
    expect(store.dirty).toBe(false);
    store.newDocument();
    expect(store.fileName).toBe("Untitled");
  });

  it("keeps the open document and imports nothing when Rust refuses it", async () => {
    reply = () => { throw "This document is damaged and cannot be opened."; };
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine, importBytes } = setup();
    await takeDroppedFiles(engine, [
      { name: "bad.funda", path: null, file: new File(["junk"], "bad.funda") },
      { name: "b.stl", path: null, file: new File(["solid x\nendsolid x\n"], "b.stl") },
    ]);

    expect(reported).toEqual(["Couldn't open bad.funda: This document is damaged and cannot be opened."]);
    expect(importBytes).not.toHaveBeenCalled();
    expect(store.filePath).toBe("D:/work/previous.funda");
    expect(store.document.parameters).toEqual({});
  });
});
