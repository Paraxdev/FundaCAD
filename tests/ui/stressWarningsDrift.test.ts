// A reworded engine warning fails here by name instead of silently falling through to English.
import { beforeAll, describe, expect, it } from "vitest";
import { setLanguage, t, tEnglish } from "../../src/i18n";
import { plainError, plainWarning, sentence } from "../../src/ui/stressWarnings";
import { panelMessage } from "../../src/ui/stress";
import solveRs from "../../crates/fundacad-geom/src/fem/solve.rs?raw";
import tetmeshRs from "../../crates/fundacad-geom/src/fem/tetmesh.rs?raw";
import stressRs from "../../crates/fundacad-geom/src/stress.rs?raw";
import { MESHED, REFUSAL_TEXTS, WALL_EXAMPLE, WALL_LITERAL, WARNING_TEXTS } from "./stressEngineText";

const SOURCES: Record<string, string> = {
  "crates/fundacad-geom/src/stress.rs": stressRs,
  "crates/fundacad-geom/src/fem/solve.rs": solveRs,
  "crates/fundacad-geom/src/fem/tetmesh.rs": tetmeshRs,
};
const source = (file: string) => SOURCES[file]!;

beforeAll(() => setLanguage("en"));

describe("the engine warnings the panel rewords", () => {
  it.each(WARNING_TEXTS.map((r) => [r.name, r] as const))(
    "%s is still worded that way in the Rust source",
    (_n, row) => {
      expect(source(row.file)).toContain(row.literal);
    },
  );

  it.each(WARNING_TEXTS.map((r) => [r.name, r] as const))(
    "%s reaches its own line, not the fall through",
    (_n, row) => {
      const said = plainWarning(row.example);
      expect(said).toBe(tEnglish(row.key, row.args));
      expect(said).not.toBe(sentence(panelMessage(row.example)));
    },
  );

  it("lets a reworded corner warning fall through as the engine said it", () => {
    const reworded = "the peak stress sits at a sharp inside corner, read the colour away from it";
    expect(plainWarning(reworded)).toBe(sentence(panelMessage(reworded)));
    expect(plainWarning(reworded)).toBe("The peak stress sits at a sharp inside corner, read the colour away from it.");
  });
});

describe("the engine refusals the panel rewords", () => {
  it.each(REFUSAL_TEXTS.map((r) => [r.name, r] as const))(
    "%s is still worded that way in the Rust source",
    (_n, row) => {
      expect(source(row.file)).toContain(row.literal);
    },
  );

  it.each(REFUSAL_TEXTS.map((r) => [r.name, r] as const))(
    "%s reaches its own line, not the fall through",
    async (_n, row) => {
      const said = plainError(row.example);
      expect(said).toBe(tEnglish(row.key, row.args));
      if (!row.englishAsSent) return void expect(said).not.toBe(sentence(panelMessage(row.example)));
      expect(said).toBe(sentence(panelMessage(row.example)));
      await setLanguage("de");
      const german = { said: plainError(row.example), line: t(row.key, row.args) };
      await setLanguage("en");
      expect(german.said).toBe(german.line);
      expect(german.said).not.toBe(said);
    },
  );

  it("is still followed by the thinnest wall words, which the panel moves out of the message", () => {
    expect(source("crates/fundacad-geom/src/stress.rs")).toContain(WALL_LITERAL);
    expect(source("crates/fundacad-geom/src/stress.rs")).toContain(MESHED);
    const row = REFUSAL_TEXTS[0]!;
    const said = plainError(row.example + WALL_EXAMPLE);
    expect(said).toBe(tEnglish(row.key, { ...row.args, wall: "yes", thickness: "0.45", at: "12.0, -3.5, 7.0" }));
    expect(said).toContain("0.45 mm thick, near (12.0, -3.5, 7.0) mm");
  });

  it("lets a reworded refusal fall through as the engine said it", () => {
    const reworded = "the body could not be meshed, the part is slimmer than one element of 2.250 mm";
    expect(plainError(reworded)).toBe(
      "The body could not be meshed, the part is slimmer than one element of 2.250 mm.",
    );
  });
});
