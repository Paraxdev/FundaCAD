import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../src/i18n";
import { encodeRgbe } from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv } from "../../src/ui/environmentLibrary";
import { importEnvironment, keptSmallerNote, useEnvLibrary } from "../../src/ui/environmentImport";
import { setRenderPref } from "../../src/ui/renderPrefs";

const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: null as ArrayBuffer | string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (...args: unknown[]) => {
    h.calls.push(args);
    if (typeof h.answer === "string") throw h.answer;
    return h.answer;
  },
}));

// Wider than the 2048 kept, one row high so the test stays small.
function wide(): ArrayBuffer {
  const rgbe = encodeRgbe({ width: 4096, height: 2, data: new Float32Array(4096 * 2 * 4).fill(0.5) });
  return rgbe.buffer.slice(rgbe.byteOffset, rgbe.byteOffset + rgbe.byteLength) as ArrayBuffer;
}

beforeEach(() => {
  h.calls.length = 0;
  useEnvLibrary(createEnvLibrary(memoryKv()));
});
afterEach(() => {
  setLanguage("system");
  useEnvLibrary(null);
  setRenderPref("environment", "studio");
});

describe("a panorama known only by its path", () => {
  it("is read through the desktop app and lights the scene", async () => {
    h.answer = wide();
    const out = await importEnvironment(null, { name: "sky.hdr", path: "/in/sky.hdr" });
    expect(h.calls).toEqual([["read_dropped_panorama", { path: "/in/sky.hdr" }]]);
    expect(out.refused).toBeNull();
  });

  it("says the size it was kept at when the file is larger", async () => {
    h.answer = wide();
    const out = await importEnvironment(null, { name: "sky.hdr", path: "/in/sky.hdr" });
    expect(out.note).toBe(
      "sky.hdr is 4096 x 2. It lights the scene from a 2048 x 1 copy, the size kept for lighting and saved documents (Preferences, Experimental).",
    );
  });

  it("says it in the chosen language", async () => {
    await setLanguage("de");
    h.answer = wide();
    const out = await importEnvironment(null, { name: "sky.hdr", path: "/in/sky.hdr" });
    expect(out.note).toContain("sky.hdr hat 4096 x 2.");
    expect(out.note).toContain("2048 x 1");
    expect(out.note).toContain("Einstellungen, Experimentell");
  });

  it("is refused in plain words when the desktop app will not read it", async () => {
    h.answer = "/in/sky.hdr was not dropped or picked in this session, so it was not read.";
    const out = await importEnvironment(null, { name: "sky.hdr", path: "/in/sky.hdr" });
    expect(out.note).toBeNull();
    expect(out.refused).toBe(
      "Couldn't use sky.hdr as the environment: /in/sky.hdr was not dropped or picked in this session, so it was not read.",
    );
  });
});

describe("keptSmallerNote", () => {
  it("is null when nothing was dropped", () => {
    expect(keptSmallerNote("a.hdr", { width: 2048, height: 1024 }, { width: 2048, height: 1024 })).toBeNull();
    expect(keptSmallerNote("a.hdr", null, { width: 2048, height: 1024 })).toBeNull();
  });

  it("keeps the sizes as plain numbers in every language", async () => {
    for (const lang of ["en", "de", "fr", "es", "ja", "zh-CN"] as const) {
      await setLanguage(lang);
      const note = keptSmallerNote("a.hdr", { width: 8192, height: 4096 }, { width: 2048, height: 1024 });
      expect(note, lang).toContain("8192 x 4096");
      expect(note, lang).toContain("2048 x 1024");
    }
  });
});
