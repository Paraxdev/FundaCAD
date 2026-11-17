// The lines the build state keeps in English for the MCP tools read in the chosen language where they show, and the
// data that carries them stays English.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t, tEnglish } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import { tooLargeToSend } from "../../src/geometry/client";
import { shownLine } from "../../src/ui/englishLines";
import { failedEnglish, failedText, plainEnglish, plainError } from "../../src/ui/plainError";
import { featureFailures } from "../../src/ui/featureNotes";
import { previewVerdict } from "../../src/features/previewVerdict";
import { onPreviewError, setPreviewError } from "../../src/ui/previewError";

afterEach(async () => {
  setPreviewError(null);
  await setLanguage("system");
});

const MiB = 1024 * 1024;
const FACELESS_FAR = tEnglish("document.faceless", { far: "yes" });
const FACELESS = tEnglish("document.faceless", { far: "no" });
const REFUSED = tEnglish("engine.tooLargeRefused");

describe("shownLine", () => {
  it("gives each English line back unchanged in English", () => {
    const big = tooLargeToSend(234 * MiB)!;
    for (const line of [FACELESS_FAR, FACELESS, REFUSED, big]) expect(shownLine(line)).toBe(line);
  });

  it("words each line in German, with the sizes the English line names", async () => {
    await setLanguage("de");
    const big = tooLargeToSend(234 * MiB)!;
    expect(big).toBe(tEnglish("engine.tooLarge", { size: 234, limit: 128 }));
    expect(shownLine(big)).toBe(t("engine.tooLarge", { size: 234, limit: 128 }));
    expect(shownLine(big)).toContain("234 MiB, die Grenze liegt bei 128 MiB");
    expect(shownLine(FACELESS_FAR)).toBe(de["document.faceless"].match(/yes \{(.*?)\} other/)![1]);
    expect(shownLine(FACELESS)).toBe("Der Körper hat keine Flächen, es gibt also nichts anzuzeigen.");
    expect(shownLine(REFUSED)).toBe(de["engine.tooLargeRefused"]);
  });

  it("reads a size of four digits", async () => {
    const english = tEnglish("engine.tooLarge", { size: 1536, limit: 128 });
    await setLanguage("de");
    expect(shownLine(english)).toBe(t("engine.tooLarge", { size: 1536, limit: 128 }));
  });

  it("passes any other line through as sent", async () => {
    await setLanguage("de");
    for (const line of ["Profile is open", `${FACELESS} More.`, "", REFUSED.slice(1)]) {
      expect(shownLine(line)).toBe(line);
    }
  });
});

describe("where a build failure shows", () => {
  it("words the toast in German and keeps the problem report English", async () => {
    await setLanguage("de");
    expect(plainEnglish(new Error(FACELESS), "")).toBe(FACELESS);
    expect(plainError(new Error(FACELESS), "")).toBe(t("document.faceless", { far: "no" }));
    expect(failedText("Extrusion", FACELESS, "Extrude")).toBe(
      `Extrusion fehlgeschlagen: ${t("document.faceless", { far: "no" })}`,
    );
    expect(failedEnglish("Extrude", FACELESS)).toBe(`Extrude failed: ${FACELESS}`);
    expect(failedText("Extrusion", "", "Extrude")).toBe(
      "Extrusion fehlgeschlagen: Der Geometriekern konnte den Schritt nicht aufbauen. Die Details stehen in der Konsole.",
    );
    expect(failedEnglish("Extrude", "")).toBe(
      "Extrude failed: the engine could not build it. The details are in the console.",
    );
  });

  it("matches the engine's own naming of the step by the English name", async () => {
    await setLanguage("de");
    const said = "Fillet failed on Box: try a smaller value";
    expect(failedText("Verrundung", said, "Fillet")).toBe(said);
    expect(failedText("Verrundung", "radius 7.5 is too large", "Fillet")).toBe(
      "Verrundung fehlgeschlagen: radius 7.5 is too large",
    );
  });

  it("words the History chips, a tool's refusal and the value box in German", async () => {
    await setLanguage("de");
    const shown = t("engine.tooLargeRefused");
    const failed = featureFailures({
      featureErrors: [{ feature_id: "e1", message: FACELESS }],
      errorFeatureId: "i1",
      errorMessage: REFUSED,
    });
    expect([...failed]).toEqual([
      ["e1", t("document.faceless", { far: "no" })],
      ["i1", shown],
    ]);
    expect(previewVerdict({ hasPreview: true, previewError: REFUSED, buildState: { building: false } })).toEqual({
      kind: "refused",
      reason: shown,
    });
    const seen: (string | null)[] = [];
    const stop = onPreviewError((m) => seen.push(m));
    setPreviewError(REFUSED);
    stop();
    expect(seen).toEqual([null, shown]);
  });
});
