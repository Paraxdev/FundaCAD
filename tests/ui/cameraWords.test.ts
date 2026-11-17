// What a camera step says: a standard view by name, any other view as the side it is nearest, how far it is turned
// toward the next side and how far it is tilted, in each language's own order.

import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { cameraWords } from "../../src/ui/cameraWords";

/** The eye of a view turned `az` degrees from the front toward the right, and tilted `tilt` degrees up. */
function eye(az: number, tilt: number): [number, number, number] {
  const a = (az * Math.PI) / 180;
  const t = (tilt * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(t), -Math.cos(a) * Math.cos(t), Math.sin(t)];
}

afterEach(() => setLanguage("system"));

describe("cameraWords", () => {
  it("names a standard view and its projection", () => {
    expect(cameraWords([0, -1, 0], true)).toBe("Front view, orthographic");
    expect(cameraWords([0, 0, -1], false)).toBe("Bottom view, perspective");
    expect(cameraWords([1, -1, 0.8], false)).toBe("Isometric view, perspective");
    expect(cameraWords(eye(1.5, 1), true)).toBe("Front view, orthographic");
  });

  it("says a turned view from its nearest side, toward the side it leans to", () => {
    expect(cameraWords(eye(30, 0), false)).toBe("Front, 30° toward right, perspective");
    expect(cameraWords(eye(-30, 0), false)).toBe("Front, 30° toward left, perspective");
    expect(cameraWords(eye(170, 0), true)).toBe("Back, 10° toward right, orthographic");
    expect(cameraWords(eye(-170, 0), true)).toBe("Back, 10° toward left, orthographic");
    expect(cameraWords(eye(255, 0), false)).toBe("Left, 15° toward back, perspective");
  });

  it("says a tilted view from above or below, and both when it is turned and tilted", () => {
    expect(cameraWords(eye(90, 20), true)).toBe("Right, 20° from above, orthographic");
    expect(cameraWords(eye(0, -45), false)).toBe("Front, 45° from below, perspective");
    expect(cameraWords(eye(105, 30), false)).toBe("Right, 15° toward back, 30° from above, perspective");
    expect(cameraWords(eye(0, 85), true)).toBe("Front, 85° from above, orthographic");
  });

  it("orders the words each language's own way", async () => {
    const said = async (lang: string) => {
      await setLanguage(lang);
      return [cameraWords([0, 1, 0], true), cameraWords(eye(105, 30), false), cameraWords(eye(-30, -10), true)];
    };
    expect(await said("de")).toEqual([
      "Rückansicht, orthografisch",
      "Rechts, 15° Richtung hinten, 30° von oben, perspektivisch",
      "Vorne, 30° Richtung links, 10° von unten, orthografisch",
    ]);
    expect(await said("fr")).toEqual([
      "Vue arrière, orthographique",
      "Droite, 15° vers l’arrière, 30° au-dessus, en perspective",
      "Avant, 30° vers la gauche, 10° en dessous, orthographique",
    ]);
    expect(await said("ja")).toEqual([
      "背面図、平行投影",
      "右、背面へ 15°、上から 30°、透視投影",
      "正面、左へ 30°、下から 10°、平行投影",
    ]);
    expect(await said("zh-CN")).toEqual([
      "后视图，正交投影",
      "右侧，向后偏 15°，俯角 30°，透视投影",
      "前方，向左偏 30°，仰角 10°，正交投影",
    ]);
  });
});
