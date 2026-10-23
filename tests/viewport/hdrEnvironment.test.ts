// Imported HDR panoramas: decoded at any size, downscaled without losing
// the sun, kept in a named library, and carried inside the document.

import { describe, expect, it } from "vitest";
import {
  decodeHdr,
  deflateBase64,
  downscaleEquirect,
  encodeRgbe,
  HdrRefusal,
  inflateBase64,
  MAX_EXR_DECODE_BYTES,
  radianceSize,
  shrinkFactor,
  sphereThumbnailPixels,
  type HdrImage,
} from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv } from "../../src/ui/environmentLibrary";
import {
  asEnvironment,
  asEnvSettings,
  asRenderPrefs,
  DEFAULT_RENDER,
  envSettingsOf,
  type EnvSettings,
} from "../../src/ui/renderPrefs";
import { DocumentStore } from "../../src/document/store";
import { normalizeDocEnvironment } from "../../src/document/docEnvironment";
import { documentEnvironmentFor, keptSmallerNote, storeHdr } from "../../src/ui/environmentImport";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

/** A grey sky with one small, very bright sun, the case point sampling loses. */
function sky(w: number, h: number): HdrImage {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const sun = Math.abs(x - w * 0.3) < w / 512 && Math.abs(y - h * 0.25) < h / 256;
      const v = sun ? 20000 : y < h / 2 ? 0.8 : 0.2;
      data[i] = v;
      data[i + 1] = v * 0.95;
      data[i + 2] = v * 0.9;
      data[i + 3] = 1;
    }
  }
  return { width: w, height: h, data };
}

/** Light arriving from the whole sphere, rows weighted by their solid angle. */
function irradiance(img: HdrImage): number {
  let s = 0;
  for (let y = 0; y < img.height; y++) {
    const wgt = Math.sin(((y + 0.5) / img.height) * Math.PI);
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      s += wgt * (0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!);
    }
  }
  return (s / (img.width * img.height)) * Math.PI * 2;
}

/** A Radiance file in the run length form, each channel one run per 127 texels of the same value. */
function rleRadiance(w: number, h: number, at: (x: number, y: number) => number): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE
FORMAT=32-bit_rle_rgbe

-Y ${h} +X ${w}
`);
  const chunks: Uint8Array[] = [head];
  const px = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      const e = Math.floor(Math.log2(v)) + 1;
      const m = Math.min(255, Math.floor((v * 256) / 2 ** e));
      px.set([m, m, m, e + 128], x * 4);
    }
    const out: number[] = [2, 2, w >> 8, w & 255];
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        let n = 1;
        while (x + n < w && n < 127 && px[(x + n) * 4 + c] === px[x * 4 + c]) n++;
        out.push(128 + n, px[x * 4 + c]!);
        x += n;
      }
    }
    chunks.push(Uint8Array.from(out));
  }
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const file = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    file.set(c, o);
    o += c.length;
  }
  return file;
}

/** An OpenEXR header naming a `w` x `h` data window and nothing after it. */
function exrHeader(w: number, h: number): Uint8Array {
  const enc = new TextEncoder();
  const box = new DataView(new ArrayBuffer(20));
  box.setInt32(0, 16, true);
  box.setInt32(12, w - 1, true);
  box.setInt32(16, h - 1, true);
  return new Uint8Array([
    0x76,
    0x2f,
    0x31,
    0x01,
    2,
    0,
    0,
    0,
    ...enc.encode("dataWindow\0box2i\0"),
    ...new Uint8Array(box.buffer),
    0,
  ]);
}

describe("the tile picture of a panorama", () => {
  it("is a chrome ball showing the sky above and the ground below", () => {
    const w = 64,
      h = 32;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data.set(y < h / 2 ? [0.2, 0.3, 1.2, 1] : [0.1, 0.6, 0.05, 1], (y * w + x) * 4);
    const size = 64;
    const px = sphereThumbnailPixels({ width: w, height: h, data }, size);
    expect(px.length).toBe(size * size * 4);
    const at = (x: number, y: number) => Array.from(px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
    const top = at(size / 2, Math.round(size * 0.2));
    const bottom = at(size / 2, Math.round(size * 0.8));
    expect(top[2]!).toBeGreaterThan(top[1]!);
    expect(bottom[1]!).toBeGreaterThan(bottom[2]!);
    expect(top[3]).toBe(255);
  });

  it("is exposed for the panorama, so a dim one is not black", () => {
    const data = new Float32Array(8 * 4 * 4).fill(0.001);
    const px = sphereThumbnailPixels({ width: 8, height: 4, data }, 16);
    expect(px[(8 * 16 + 8) * 4]!).toBeGreaterThan(60);
  });
});

const settings = (over: Partial<EnvSettings> = {}): EnvSettings => ({ ...envSettingsOf(DEFAULT_RENDER), ...over });

describe("decoding an HDR", () => {
  it("reads a Radiance file back to the floats it was written from", async () => {
    const img = sky(64, 32);
    const got = await decodeHdr(encodeRgbe(img), "sky.hdr");
    expect([got.width, got.height]).toEqual([64, 32]);
    const at = (32 * 8 + 5) * 4;
    expect(got.data[at]).toBeCloseTo(img.data[at]!, 1);
    expect(irradiance(got) / irradiance(img)).toBeCloseTo(1, 2);
  });

  it("reads a 16k run length encoded panorama straight to the stored width, its sun's light kept", async () => {
    const w = 16384,
      h = 8192;
    const file = rleRadiance(w, h, (x, y) =>
      Math.abs(x - w * 0.3) < 8 && Math.abs(y - h * 0.25) < 8 ? 20000 : y < h / 2 ? 0.8 : 0.2,
    );
    expect(radianceSize(file)).toEqual({ width: w, height: h });
    const got = await decodeHdr(file, "huge.hdr", 2048);
    expect([got.width, got.height]).toEqual([2048, 1024]);
    expect(got.data.length).toBe(2048 * 1024 * 4);
    const sunTexels = 16 * 16;
    const want = (0.8 + 0.2) / 2 + ((20000 - 0.8) * sunTexels) / (w * h);
    let mean = 0;
    for (let i = 0; i < got.data.length; i += 4) mean += got.data[i]!;
    mean /= got.width * got.height;
    // RGBE keeps 8 bits of mantissa, which is all the difference left.
    expect(Math.abs(mean / want - 1)).toBeLessThan(0.01);
  }, 60000);

  it("reads the old run length form and a flat file alike", async () => {
    const img = sky(16, 4);
    const flat = encodeRgbe(img);
    const head = flat.subarray(0, flat.length - 16 * 4 * 4);
    // Row 0 as one pixel and a repeat of it fifteen times.
    const first = flat.subarray(head.length, head.length + 4);
    const rest = flat.subarray(head.length + 16 * 4);
    const old = new Uint8Array([...head, ...first, 1, 1, 1, 15, ...rest]);
    const a = await decodeHdr(old, "old.hdr");
    const b = await decodeHdr(flat, "flat.hdr");
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("round trips the Radiance mantissa, so storing a stored file again keeps its bytes", async () => {
    const once = encodeRgbe(await decodeHdr(encodeRgbe(sky(64, 32)), "a.hdr"));
    const twice = encodeRgbe(await decodeHdr(once, "b.hdr"));
    expect(twice).toEqual(once);
  });

  it("halves in powers of two, as downscaleEquirect does", () => {
    expect(shrinkFactor(16384, 2048)).toBe(8);
    expect(shrinkFactor(2048, 2048)).toBe(1);
    expect(shrinkFactor(3000, 2048)).toBe(2);
  });

  it("refuses an OpenEXR too big to unpack whole and says how to bring it in", async () => {
    const side = Math.ceil(Math.sqrt(MAX_EXR_DECODE_BYTES / 8)) + 2;
    const err = await decodeHdr(exrHeader(side, side), "giant.exr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HdrRefusal);
    expect((err as Error).message).toMatch(/giant\.exr is \d+ x \d+.*\.hdr/);
  });

  it("says when a panorama is kept smaller than its file, and nothing when it is not", () => {
    expect(keptSmallerNote("a.hdr", { width: 16384, height: 8192 }, { width: 2048, height: 1024 })).toBe(
      "a.hdr is 16384 x 8192. It lights the scene from a 2048 x 1024 copy, the size kept for lighting and saved documents (Preferences, Experimental).",
    );
    expect(keptSmallerNote("a.hdr", { width: 2048, height: 1024 }, { width: 2048, height: 1024 })).toBeNull();
  });

  it("refuses something that is not an HDR with a readable message", async () => {
    await expect(decodeHdr(new TextEncoder().encode("solid x"), "x.hdr")).rejects.toThrow(/not a Radiance HDR/);
  });
});

describe("downscaling", () => {
  it("keeps the light of a small bright sun within 1%", () => {
    const big = sky(4096, 2048);
    const small = downscaleEquirect(big, 2048);
    expect([small.width, small.height]).toEqual([2048, 1024]);
    expect(irradiance(downscaleEquirect(big, 1024)) / irradiance(big)).toBeCloseTo(1, 2);
    expect(Math.abs(irradiance(small) / irradiance(big) - 1)).toBeLessThan(0.01);
  });

  it("leaves a small panorama as it is", () => {
    const img = sky(512, 256);
    expect(downscaleEquirect(img, 2048)).toBe(img);
  });
});

describe("render settings", () => {
  it("keep an imported panorama by hash and drop a malformed one", () => {
    const id = `hdr:${"a".repeat(64)}`;
    expect(asEnvironment(id)).toBe(id);
    expect(asRenderPrefs({ environment: id }).environment).toBe(id);
    expect(asEnvironment("hdr:../../x")).toBeNull();
    expect(asRenderPrefs({ environment: "hdr:" }).environment).toBe("studio");
  });

  it("clamp rotation and exposure", () => {
    const p = asRenderPrefs({ envRotation: 270, envExposure: 9, envBackground: true });
    expect([p.envRotation, p.envExposure, p.envBackground]).toEqual([-90, 4, true]);
  });

  it("narrow a saved look field by field", () => {
    const s = asEnvSettings({ environment: "dusk", brightness: "loud", shadows: true });
    expect(s.environment).toBe("dusk");
    expect(s.brightness).toBe(DEFAULT_RENDER.brightness);
    expect(s.shadows).toBe(true);
    expect(Object.keys(s)).not.toContain("fov");
  });
});

describe("the environment library", () => {
  const make = () => {
    let id = 0,
      t = 0;
    return createEnvLibrary(memoryKv(), { newId: () => `e${++id}`, now: () => ++t });
  };

  it("saves, lists, renames and deletes named environments", async () => {
    const lib = make();
    const a = await lib.save("  Desk   sun ", settings({ environment: "warm" }), "thumb-a");
    expect(a.name).toBe("Desk sun");
    const b = await lib.save("desk sun", settings(), "thumb-b");
    expect(b.name).toBe("desk sun 2");
    await expect(lib.save("   ", settings(), "")).rejects.toThrow(/needs a name/);
    expect((await lib.list()).map((e) => e.name)).toEqual(["Desk sun", "desk sun 2"]);
    const renamed = await lib.rename(b.id, "Desk sun");
    expect(renamed?.name).toBe("Desk sun 2");
    expect(renamed?.thumb).toBe("thumb-b");
    await lib.remove(a.id);
    expect((await lib.list()).map((e) => e.id)).toEqual([b.id]);
  });

  it("keeps a panorama while a saved look or the viewport still uses it", async () => {
    const lib = make();
    const rec = await storeHdr(sky(256, 128), "sky.hdr", lib);
    expect(rec.width).toBe(256);
    const env = `hdr:${rec.hash}` as const;
    const a = await lib.save("A", settings({ environment: env }), "");
    const b = await lib.save("B", settings({ environment: env }), "");
    await lib.remove(a.id);
    expect(await lib.getHdr(rec.hash)).not.toBeNull();
    await lib.remove(b.id, rec.hash);
    expect(await lib.getHdr(rec.hash)).not.toBeNull();
    const c = await lib.save("C", settings({ environment: env }), "");
    await lib.remove(c.id, null);
    expect(await lib.getHdr(rec.hash)).toBeNull();
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
const base = (): CadDocument => ({ parameters: {}, features: [] });

describe("the document carries its environment", () => {
  it("embeds an imported panorama that survives a save byte for byte", async () => {
    const lib = createEnvLibrary(memoryKv());
    const rec = await storeHdr(sky(4096, 2048), "sky.hdr", lib);
    expect([rec.width, rec.height]).toEqual([2048, 1024]);
    const env = await documentEnvironmentFor(settings({ environment: `hdr:${rec.hash}`, envRotation: 30 }), null, lib);
    const store = new DocumentStore(stubBackend(), base());
    store.setDocumentEnvironment(env);
    expect(store.dirty).toBe(true);
    const again = new DocumentStore(stubBackend(), base());
    again.load(store.toJSON());
    const got = again.documentEnvironment!;
    expect(got.settings["envRotation"]).toBe(30);
    expect(got.hdr!.sha256).toBe(rec.hash);
    // Compared by hand: toEqual on 8 MB of bytes takes vitest many seconds.
    const back = inflateBase64(got.hdr!.data);
    expect(back.length).toBe(rec.rgbe.length);
    expect(back.every((v, i) => v === rec.rgbe[i])).toBe(true);
    expect(again.toJSON()).toBe(store.toJSON());
  });

  it("keeps the embedded panorama off the undo stack", async () => {
    const store = new DocumentStore(stubBackend(), base());
    store.setDocumentEnvironment({
      settings: { environment: "warm" },
      hdr: {
        name: "x.hdr",
        width: 2,
        height: 1,
        encoding: "rgbe-deflate-base64",
        sha256: "b".repeat(64),
        data: deflateBase64(new Uint8Array(8)),
      },
    });
    (store as unknown as { pushUndo(): void }).pushUndo();
    const stack = (store as unknown as { undoStack: { doc?: CadDocument }[] }).undoStack;
    expect(stack.length).toBe(1);
    expect(stack[0]!.doc?.environment).toBeUndefined();
  });

  it("writes nothing for a built in room, so old files stay byte identical", async () => {
    const store = new DocumentStore(stubBackend(), base());
    const before = store.toJSON();
    store.setDocumentEnvironment(
      await documentEnvironmentFor(settings({ environment: "dusk" }), null, createEnvLibrary(memoryKv())),
    );
    expect(store.toJSON()).toBe(before);
    expect(store.dirty).toBe(false);
  });

  it("names a saved environment, and drops a malformed one on load", () => {
    expect(normalizeDocEnvironment({ name: " Desk ", settings: { environment: "warm" } })).toEqual({
      name: "Desk",
      settings: { environment: "warm" },
    });
    expect(normalizeDocEnvironment({ settings: "warm" })).toBeNull();
    const bad = normalizeDocEnvironment({
      settings: {},
      hdr: { encoding: "png", width: 1, height: 1, sha256: "x", data: "" },
    });
    expect(bad).toEqual({ settings: {} });
  });
});
