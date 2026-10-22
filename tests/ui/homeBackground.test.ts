import { afterEach, describe, expect, it, vi } from "vitest";

function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    map: m,
  };
}

async function load(seed?: Record<string, string>) {
  vi.resetModules();
  const ls = fakeStorage(seed);
  vi.stubGlobal("localStorage", ls);
  return { mod: await import("../../src/ui/homeBackground"), ls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Home background preference", () => {
  it("starts on the paper, also when the stored value means nothing", async () => {
    expect((await load()).mod.getHomeBackground()).toBe("paper");
    expect((await load({ "fundacad.homeBackground": "marble" })).mod.getHomeBackground()).toBe("paper");
  });

  it("keeps a choice across a restart and tells its listeners once", async () => {
    const { mod, ls } = await load();
    let calls = 0;
    const stop = mod.onHomeBackgroundChange(() => calls++);
    mod.setHomeBackground("workspace");
    mod.setHomeBackground("workspace");
    stop();
    expect(calls).toBe(1);
    const again = await load(Object.fromEntries(ls.map));
    expect(again.mod.getHomeBackground()).toBe("workspace");
  });

  it("gives each option its class and only a picture a style", async () => {
    const { mod } = await load();
    expect(mod.homeBackgroundClass("paper", null)).toBeUndefined();
    expect(mod.homeBackgroundClass("workspace", null)).toBe("bg-workspace");
    expect(mod.homeBackgroundClass("image", "blob:x")).toBe("bg-image");
    expect(mod.homeBackgroundClass("image", null)).toBeUndefined();
    expect(mod.homeBackgroundStyle("paper", "blob:x")).toBeUndefined();
    expect(mod.homeBackgroundStyle("image", "blob:x")).toEqual({ "--home-image": 'url("blob:x")' });
  });

  it("stores a PNG or JPEG and refuses anything else", async () => {
    const { mod } = await load();
    mod.useHomeImageStore(mod.memoryImageStore());
    let calls = 0;
    mod.onHomeBackgroundChange(() => calls++);
    expect(await mod.storeHomeImage(new Blob(["x"], { type: "image/gif" }))).toMatchObject({ ok: false });
    const big = { type: "image/png", size: mod.MAX_HOME_IMAGE_BYTES + 1 } as Blob;
    expect(await mod.storeHomeImage(big)).toMatchObject({ ok: false });
    expect(await mod.loadHomeImage()).toBeUndefined();
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    expect(await mod.storeHomeImage(png)).toEqual({ ok: true });
    expect(await mod.loadHomeImage()).toBe(png);
    expect(calls).toBe(1);
  });
});
