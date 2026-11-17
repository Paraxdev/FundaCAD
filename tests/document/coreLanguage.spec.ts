// The store's own warnings, its undo labels and the engine's size refusal read in the chosen language.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", globalThis);

import { setLanguage, t } from "../../src/i18n";
import { tooLargeToSend } from "../../src/geometry/client";
import { freshStore } from "./storeKit";
import type { Feature } from "../../src/types";

afterEach(async () => {
  await setLanguage("system");
});

const MiB = 1024 * 1024;

describe("the engine's size refusal", () => {
  it("names the size and the limit in the chosen language", async () => {
    expect(tooLargeToSend(234 * MiB)).toContain("234 MiB, and the limit is 128 MiB");
    await setLanguage("de");
    expect(tooLargeToSend(234 * MiB)).toContain("234 MiB, die Grenze liegt bei 128 MiB");
    await setLanguage("ja");
    expect(tooLargeToSend(234 * MiB)).toContain("(上限は 128 MiB)");
    expect(t("engine.tooLargeRefused")).toContain("ジオメトリ エンジン");
  });
});

describe("a body with no faces", () => {
  it("adds the move hint only for a sketch far out", async () => {
    await setLanguage("de");
    const near = t("document.faceless", { far: "no" });
    expect(near).toBe("Der Körper hat keine Flächen, es gibt also nichts anzuzeigen.");
    expect(t("document.faceless", { far: "yes" })).toBe(
      near + " Rücken Sie die Skizze auf weniger als 1 km an den Ursprung heran.",
    );
  });
});

describe("the store's undo labels", () => {
  it("name a hidden sketch in the language of the moment", async () => {
    await setLanguage("de");
    const s = freshStore();
    s.addFeature({ id: "s", type: "sketch", plane: "XY", entities: [] } as unknown as Feature);
    s.setSketchVisibility("s", false);
    expect(s.undoLabel).toBe("Skizze 1 ausblenden");
    await setLanguage("ja");
    expect(s.undoLabel).toBe("スケッチ 1の非表示");
    await setLanguage("en");
    expect(s.undoLabel).toBe("Hide Sketch 1");
  });
});
