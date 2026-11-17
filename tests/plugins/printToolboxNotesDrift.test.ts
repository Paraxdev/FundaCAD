// A note the engine puts on a finding is worded in English there, so the panel maps each one to a line of its own.
// A new or reworded engine note fails here by name instead of reaching a translated row in English.
import { describe, expect, it } from "vitest";
import modRs from "../../crates/fundacad-geom/src/printcheck/mod.rs?raw";
import opRs from "../../crates/fundacad-geom/src/printcheck/op.rs?raw";
import { ENGINE_NOTES } from "../../plugins/FundaCAD.PrintToolbox/printability";

function engineNotes(source: string): string[] {
  const found = [
    ...source.matchAll(/\bnote\s*=\s*"([^"]+)"\.into\(\)/g),
    ...source.matchAll(/\bnote\.push_str\("([^"]+)"\)/g),
  ];
  return found.map((m) => m[1]!).filter((text) => text !== ", ");
}

describe("the engine's printability notes", () => {
  const sources = { "printcheck/mod.rs": modRs, "printcheck/op.rs": opRs };
  const all = Object.values(sources).flatMap(engineNotes);

  it("are all known to the panel", () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const [file, source] of Object.entries(sources)) {
      for (const note of engineNotes(source)) {
        expect(ENGINE_NOTES, `${file} has a note the panel has no line for: ${note}`).toContain(note);
      }
    }
  });

  it("are all still worded that way in the engine", () => {
    for (const note of ENGINE_NOTES) expect(all).toContain(note);
  });
});
