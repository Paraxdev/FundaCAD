// An .exr reads the right way up and is taken however wide, and the
// document's embedded environment follows every change to the look.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHdr, toHalfRgba, type HdrImage } from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv } from "../../src/ui/environmentLibrary";
import { envSettingsOf, renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";
import { DocumentStore } from "../../src/document/store";
import {
  applyDocumentEnvironment,
  installEnvironmentSync,
  storeHdr,
  useEnvLibrary,
} from "../../src/ui/environmentImport";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

/** An uncompressed scanline OpenEXR with float B, G, R channels, rows in file
 *  order (row 0 is the top of the picture). `pixels` false stops after the header. */
function exr(w: number, h: number, value: (x: number, y: number) => number, pixels = true): Uint8Array {
  const parts: number[] = [];
  const u8 = (...b: number[]) => parts.push(...b);
  const i32 = (v: number) => {
    const d = new DataView(new ArrayBuffer(4));
    d.setInt32(0, v, true);
    u8(...new Uint8Array(d.buffer));
  };
  const f32 = (v: number) => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, v, true);
    u8(...new Uint8Array(d.buffer));
  };
  const str = (s: string) => u8(...new TextEncoder().encode(s), 0);
  const attr = (name: string, type: string, body: () => void) => {
    str(name);
    str(type);
    const at = parts.length;
    i32(0);
    const start = parts.length;
    body();
    const d = new DataView(new ArrayBuffer(4));
    d.setInt32(0, parts.length - start, true);
    parts.splice(at, 4, ...new Uint8Array(d.buffer));
  };
  u8(0x76, 0x2f, 0x31, 0x01);
  i32(2);
  attr("channels", "chlist", () => {
    for (const c of ["B", "G", "R"]) {
      str(c);
      i32(2);
      u8(0, 0, 0, 0);
      i32(1);
      i32(1);
    }
    u8(0);
  });
  attr("compression", "compression", () => u8(0));
  attr("dataWindow", "box2i", () => {
    i32(0);
    i32(0);
    i32(w - 1);
    i32(h - 1);
  });
  attr("displayWindow", "box2i", () => {
    i32(0);
    i32(0);
    i32(w - 1);
    i32(h - 1);
  });
  attr("lineOrder", "lineOrder", () => u8(0));
  attr("pixelAspectRatio", "float", () => f32(1));
  attr("screenWindowCenter", "v2f", () => {
    f32(0);
    f32(0);
  });
  attr("screenWindowWidth", "float", () => f32(1));
  u8(0);
  if (!pixels) return new Uint8Array(parts);
  const table = parts.length;
  const lineBytes = 8 + w * 3 * 4;
  for (let y = 0; y < h; y++) {
    const off = table + h * 8 + y * lineBytes;
    i32(off);
    i32(0);
  }
  for (let y = 0; y < h; y++) {
    i32(y);
    i32(w * 3 * 4);
    for (let c = 0; c < 3; c++) for (let x = 0; x < w; x++) f32(value(x, y));
  }
  return new Uint8Array(parts);
}

const at = (img: HdrImage, x: number, y: number) => img.data[(y * img.width + x) * 4]!;

describe("an imported .exr", () => {
  it("keeps row 0 at the top, like an .hdr", async () => {
    const img = await decodeHdr(
      exr(8, 4, (_x, y) => (y === 0 ? 10 : 0.1)),
      "sky.exr",
    );
    expect([img.width, img.height]).toEqual([8, 4]);
    expect(at(img, 0, 0)).toBeCloseTo(10, 5);
    expect(at(img, 0, 3)).toBeCloseTo(0.1, 5);
  });

  it("is taken however wide, and halved to the width asked for", async () => {
    const img = await decodeHdr(
      exr(9000, 2, () => 1),
      "wide.exr",
      2048,
    );
    expect([img.width, img.height]).toEqual([1125, 1]);
    expect(at(img, 500, 0)).toBeCloseTo(1, 3);
  });
});

describe("a bright sun under high exposure", () => {
  it("stays a finite half float", () => {
    const img: HdrImage = { width: 1, height: 1, data: new Float32Array([20000, 1, 0, 1]) };
    const half = toHalfRgba(img, 2 ** 4);
    // 0x7bff is 65504, the largest finite half; 0x7c00 is Infinity.
    expect(half[0]).toBe(0x7bff);
    expect(half[1]).toBe(0x4c00);
  });
});

function stubBackend(): GeometryBackend {
  return {
    async rebuild() {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}
const blank = (): string => JSON.stringify({ parameters: {}, features: [] } satisfies CadDocument);

function sky(): HdrImage {
  const w = 64,
    h = 32,
    data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i < (w * h) / 2 ? 2 : 0.3;
    data.set([v, v, v, 1], i * 4);
  }
  return { width: w, height: h, data };
}

describe("the document's environment", () => {
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
    useEnvLibrary(null);
    setRenderPref("environment", "studio");
  });

  it("follows brightness, bloom, shadows, ground and key aim, so a reopen keeps them", async () => {
    const lib = createEnvLibrary(memoryKv());
    useEnvLibrary(lib);
    const store = new DocumentStore(stubBackend(), { parameters: {}, features: [] });
    offs.push(installEnvironmentSync(store));
    const rec = await storeHdr(sky(), "sky.hdr", lib);
    setRenderPref("environment", `hdr:${rec.hash}`);
    await vi.waitFor(() => expect(store.documentEnvironment?.hdr?.sha256).toBe(rec.hash));

    setRenderPref("brightness", 1.7);
    setRenderPref("bloom", 0.8);
    setRenderPref("shadows", !renderPrefs().shadows);
    setRenderPref("background", "grey");
    setRenderPref("keyAzimuth", 123);
    setRenderPref("keyElevation", 22);
    const look = envSettingsOf(renderPrefs());
    await vi.waitFor(() => expect(store.documentEnvironment?.settings).toEqual(look));

    const saved = store.toJSON();
    for (const off of offs.splice(0)) off();
    setRenderPref("brightness", 1);
    setRenderPref("bloom", 0);
    setRenderPref("keyAzimuth", 10);
    const again = new DocumentStore(stubBackend(), { parameters: {}, features: [] });
    again.load(saved);
    await applyDocumentEnvironment(again.documentEnvironment, lib);
    expect(envSettingsOf(renderPrefs())).toEqual(look);
  });

  it("carries the panorama into a document opened without one, without dirtying it", async () => {
    const lib = createEnvLibrary(memoryKv());
    useEnvLibrary(lib);
    const rec = await storeHdr(sky(), "sky.hdr", lib);
    setRenderPref("environment", `hdr:${rec.hash}`);
    const store = new DocumentStore(stubBackend(), { parameters: {}, features: [] });
    offs.push(installEnvironmentSync(store));
    store.load(blank());
    store.markSaved("plain.funda");
    await vi.waitFor(() => expect(store.documentEnvironment?.hdr?.sha256).toBe(rec.hash));
    expect(store.dirty).toBe(false);
    expect(JSON.parse(store.toJSON()).environment.hdr.sha256).toBe(rec.hash);
  });

  it("falls back to the default room when the stored panorama is unreadable", async () => {
    const lib = createEnvLibrary(memoryKv());
    useEnvLibrary(lib);
    const hash = "c".repeat(64);
    await lib.putHdr({ hash, name: "bad", width: 2, height: 1, rgbe: new Uint8Array([1, 2, 3]) });
    setRenderPref("environment", `hdr:${hash}`);
    const store = new DocumentStore(stubBackend(), { parameters: {}, features: [] });
    offs.push(installEnvironmentSync(store));
    await vi.waitFor(() => expect(renderPrefs().environment).toBe("studio"));
  });
});
