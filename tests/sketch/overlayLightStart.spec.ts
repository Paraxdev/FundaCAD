// main.ts imports the sketch overlay (through app/engine) before it calls initTheme, so a stored light theme must
// still reach the viewport ground and the overlay's shared materials.
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as THREE from "three";

function storage(init: Record<string, string>) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

async function start(stored: Record<string, string>) {
  vi.resetModules();
  vi.stubGlobal("localStorage", storage(stored));
  const colors = await import("../../src/viewport/themeColors");
  const overlay = await import("../../src/sketch/overlay");
  const theme = await import("../../src/ui/theme");
  theme.initTheme();
  const o = new overlay.SketchOverlay();
  const snap = (o as unknown as { snapMarker: THREE.Mesh }).snapMarker.material as THREE.MeshBasicMaterial;
  return {
    ground: colors.themeColor("--viewport-bg", 0x123456),
    accent: colors.themeColor("--accent", 0x123456),
    snap: snap.color.getHex(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of Array.from(document.documentElement.style)) document.documentElement.style.removeProperty(p);
  document.documentElement.classList.remove("theme-light");
});

describe("a theme stored before the overlay loads", () => {
  it("gives the light ground, accent and snap colour, not Noir's", async () => {
    expect(await start({ "fundacad.theme": "fundacad-light" })).toEqual({
      ground: 0xe8e5ef,
      accent: 0x4a4fb5,
      snap: 0x9a4d00,
    });
  });

  it("leaves nothing of the light theme in a second start with no theme stored", async () => {
    await start({ "fundacad.theme": "fundacad-light" });
    for (const p of Array.from(document.documentElement.style)) document.documentElement.style.removeProperty(p);
    // happy-dom has no stylesheet, so Noir sets no token and the caller's fallback comes back.
    expect(await start({})).toEqual({ ground: 0x123456, accent: 0x123456, snap: 0xffaa33 });
  });
});
