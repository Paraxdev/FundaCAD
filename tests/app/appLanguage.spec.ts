// The app's own lines read in the chosen language: sketch hints, refusals, engine toasts, the start notice, the canvas
// name and the selection prompts, and lines built by a function follow a live switch.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { sketchPrompt } from "../../src/app/actionTables";
import { busyToolHint } from "../../src/app/planePick";
import { deathMessage } from "../../src/app/engineWatch";
import { startChoiceNotice } from "../../src/app/startChoice";
import { emptyStepWords, installCanvasStop } from "../../src/app/canvasPick";

afterEach(() => setLanguage("system"));

type StepList = Parameters<typeof emptyStepWords>[0];
const list = (over: Partial<StepList>) =>
  ({ state: "ready", error: null, rows: [], kind: "edges", bodyId: "body1", ...over }) as unknown as StepList;

describe("app lines in German and Japanese", () => {
  it("sketch hints follow a switch when read again", async () => {
    expect(sketchPrompt("line")).toBe("Click points · length Tab angle · Enter · Esc");
    expect(sketchPrompt("nope")).toBeNull();
    await setLanguage("de");
    expect(sketchPrompt("line")).toBe("Punkte anklicken · Länge Tab Winkel · Enter · Esc");
    expect(sketchPrompt("circle3")).toBe("Drei Punkte auf dem Kreis anklicken · Esc");
    await setLanguage("ja");
    expect(sketchPrompt("line")).toBe("点をクリック · 長さ Tab 角度 · Enter · Esc");
  });

  it("keep the prompt separators every hint is split on", async () => {
    const tools = ["select", "line", "rectangle", "circle", "trim", "fix"];
    const parts = tools.map((x) => sketchPrompt(x)!.split(" · ").length);
    for (const code of ["de", "fr", "es", "ja", "zh-CN"]) {
      await setLanguage(code);
      expect(tools.map((x) => sketchPrompt(x)!.split(" · ").length)).toEqual(parts);
    }
  });

  it("refusals and step words", async () => {
    await setLanguage("de");
    expect(busyToolHint()).toBe("Beenden Sie zuerst das aktive Werkzeug oder drücken Sie Esc");
    expect(emptyStepWords(list({}))).toBe("Keine Kanten an diesem Körper");
    expect(emptyStepWords(list({ bodyId: null }))).toBe("Kein Körper zum Durchgehen");
    await setLanguage("ja");
    expect(busyToolHint()).toBe("先に使用中のツールを終了するか、Esc を押してください");
    expect(emptyStepWords(list({ kind: "faces", rows: [{}] as unknown as StepList["rows"] }))).toBe(
      "フィルターに一致する面がありません",
    );
  });

  it("the engine toast keeps the cause it names", async () => {
    const p = { kind: "restarted", cause: "signal 11" };
    expect(deathMessage(p)).toBe(
      "The geometry engine crashed (signal 11) and was restarted. The last operation did not finish.",
    );
    expect(deathMessage({ kind: "start_failed" })).toBe(
      "FundaCAD could not start its geometry engine. It keeps trying, and restarting FundaCAD may help.",
    );
    await setLanguage("de");
    expect(deathMessage(p)).toBe(
      "Die Geometrie-Engine ist abgestürzt (signal 11) und wurde neu gestartet. Der letzte Vorgang wurde nicht abgeschlossen.",
    );
    await setLanguage("ja");
    expect(deathMessage(null)).toBe(
      "ジオメトリエンジンがクラッシュしました。作業を保存してから FundaCAD を再起動してください。",
    );
  });

  it("the start notice names the backup in every language", async () => {
    const out = { kind: "reset", backup: "C:/b/settings.json", plugins: "kept" } as const;
    expect(startChoiceNotice(out).text).toBe("Settings were reset. The old settings are saved in C:/b/settings.json.");
    await setLanguage("de");
    expect(startChoiceNotice(out)).toEqual({
      text: "Die Einstellungen wurden zurückgesetzt. Die alten Einstellungen sind in C:/b/settings.json gesichert.",
      kind: "info",
    });
    await setLanguage("ja");
    expect(startChoiceNotice({ kind: "backupFailed", error: "disk full" }).text).toBe(
      "設定のバックアップを書き込めなかったため、設定はリセットされませんでした: disk full",
    );
  });

  it("the canvas renames itself on a switch", async () => {
    const canvas = document.createElement("canvas");
    installCanvasStop(canvas);
    expect(canvas.getAttribute("aria-label")).toBe("Model");
    await setLanguage("de");
    expect(canvas.getAttribute("aria-label")).toBe("Modell");
    expect(canvas.getAttribute("aria-roledescription")).toBe("3D-Ansicht");
    await setLanguage("ja");
    expect(canvas.getAttribute("aria-roledescription")).toBe("3Dビュー");
  });

  it("plurals in the selection prompt and the import question", async () => {
    expect(t("nudge.faces", { n: 1 })).toMatch(/^1 face selected, /);
    expect(t("nudge.faces", { n: 3 })).toMatch(/^3 faces selected, /);
    expect(t("document.import.ask", { first: "a.stl", more: 0, doc: "Part" })).toBe(
      "Add a.stl to Part, or start a new document with it?",
    );
    expect(t("document.import.ask", { first: "a.stl", more: 2, doc: "Part" })).toBe(
      "Add a.stl and 2 more to Part, or start a new document with them?",
    );
    await setLanguage("de");
    expect(t("nudge.edges", { n: 1 })).toMatch(/^1 Kante ausgewählt, /);
    expect(t("nudge.edges", { n: 2 })).toMatch(/^2 Kanten ausgewählt, /);
    await setLanguage("ja");
    expect(t("nudge.edges", { n: 4 })).toMatch(/^4 本のエッジを選択中、/);
    expect(t("rebuild.faceMaterialsLost", { n: 1 })).toMatch(/^面の材料が 1 つ、/);
  });
});
