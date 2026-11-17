import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as THREE from "three";
import { setLanguage } from "../../src/i18n";
import { ViewCube } from "../../src/viewport/viewCube";

// happy-dom draws nothing, so a context records what the cube writes on its plates and at what size.
const written: { text: string; px: number }[] = [];
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => {
    let font = "";
    return new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === "measureText") return (s: string) => ({ width: s.length * 34 });
          if (k === "fillText") return (s: string) => written.push({ text: s, px: Number(/(\d+)px/.exec(font)?.[1]) });
          if (k === "font") return font;
          return () => {};
        },
        set: (_t, k, v) => {
          if (k === "font") font = v;
          return true;
        },
      },
    );
  }) as never;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});
afterEach(async () => {
  await setLanguage("system");
});

const hooks = { getOverrides: () => ({}), applySide: () => {}, applyDir: () => {} };
const cube = () => new ViewCube(document.createElement("canvas"), {} as THREE.WebGLRenderer, hooks as never);
const plates = () => written.splice(0).map((w) => w.text);

describe("the view cube's plates", () => {
  it("carry the side names in the chosen language and change with it", async () => {
    written.length = 0;
    cube();
    expect(plates()).toEqual(["FRONT", "BACK", "RIGHT", "LEFT", "TOP", "BOTTOM"]);
    await setLanguage("de");
    expect(plates()).toEqual(expect.arrayContaining(["VORNE", "HINTEN", "RECHTS", "LINKS", "OBEN", "UNTEN"]));
    await setLanguage("ja");
    expect(plates()).toEqual(expect.arrayContaining(["前", "後", "右", "左", "上", "下"]));
  });

  it("shrink a word too wide for its plate and keep a short one at full size", async () => {
    await setLanguage("es");
    written.length = 0;
    cube();
    const size = Object.fromEntries(written.splice(0).map((w) => [w.text, w.px]));
    expect(size.IZQUIERDA).toBeLessThan(size.DERECHA!);
    expect(size.DERECHA).toBeLessThan(56);
    await setLanguage("system");
    expect(written.find((w) => w.text === "TOP")?.px).toBe(56);
  });
});
