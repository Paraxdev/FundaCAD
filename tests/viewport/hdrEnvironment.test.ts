// Imported HDR panoramas: decoded and refused by size, downscaled without losing
// the sun, kept in a named library, and carried inside the document.

import { describe, expect, it } from "vitest";
import {
  decodeHdr,
  deflateBase64,
  downscaleEquirect,
  encodeRgbe,
  HdrRefusal,
  inflateBase64,
  MAX_HDR_FILE_BYTES,
  radianceSize,
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
import { documentEnvironmentFor, storeHdr } from "../../src/ui/environmentImport";
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

  it("refuses an oversized panorama from its header, before reading pixels", async () => {
    const head = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4500 +X 9000\n");
    expect(radianceSize(head)).toEqual({ width: 9000, height: 4500 });
    await expect(decodeHdr(head, "big.hdr")).rejects.toThrow(/9000 x 4500.*8192/);
  });

  it("refuses a file over the size limit and names both sizes", async () => {
    const big = new Uint8Array(MAX_HDR_FILE_BYTES + 1);
    const err = await decodeHdr(big, "huge.exr").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HdrRefusal);
    expect((err as Error).message).toBe("huge.exr is 64 MB, an environment file can be 64 MB at most.");
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
