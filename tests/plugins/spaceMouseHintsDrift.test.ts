// The native side words what a maker can do about a blocked 3D mouse in English, so the plugin maps each hint to a
// line of its own. A new or reworded hint fails here by name instead of reaching a translated message in English.
import { afterEach, describe, expect, it } from "vitest";
import spnavRs from "../../src-tauri/spnav/src/lib.rs?raw";
import spacemouseRs from "../../src-tauri/src/spacemouse.rs?raw";
import { setLanguage } from "../../src/i18n";
import { ENGINE_HINT_TEXTS, hintText } from "../../plugins/FundaCAD.SpaceMouse/spacemouse";
import en from "../../plugins/FundaCAD.SpaceMouse/locales/en.json";

afterEach(async () => {
  await setLanguage("system");
});

function engineHints(): string[] {
  const daemon = [...spnavRs.matchAll(/NoDaemon::(?:Absent|Refused)\s*=>\s*\{?\s*"([^"]+)"/g)].map((m) => m[1]!);
  const flatpak = [...spacemouseRs.matchAll(/const FLATPAK_HINT: &str =\s*"([^"]+)";/g)].map((m) => m[1]!);
  return [...daemon, ...flatpak];
}

describe("the engine's 3D mouse hints", () => {
  it("are all known to the plugin", () => {
    const found = engineHints();
    expect(found.length).toBe(3);
    for (const hint of found) expect(ENGINE_HINT_TEXTS, `a hint the plugin has no line for: ${hint}`).toContain(hint);
  });

  it("are all still worded that way in the engine", () => {
    const found = engineHints();
    for (const hint of ENGINE_HINT_TEXTS) expect(found, `the engine no longer sends: ${hint}`).toContain(hint);
  });

  it("read as the engine words them in English and keep their command in every language", async () => {
    const commands = ["sudo systemctl enable --now spacenavd", "sudo systemctl restart spacenavd", "flatpak override"];
    for (const hint of ENGINE_HINT_TEXTS) {
      await setLanguage("en");
      expect(hintText(hint)).toBe(hint);
      const command = commands.find((c) => hint.includes(c))!;
      for (const code of ["de", "fr", "es", "ja", "zh-CN"]) {
        await setLanguage(code);
        expect(hintText(hint), `${code}: ${hint}`).toContain(command);
        expect(hintText(hint)).not.toBe(hint);
      }
    }
    expect(Object.keys(en).filter((k) => k.startsWith("hint."))).toHaveLength(ENGINE_HINT_TEXTS.length);
  });
});
