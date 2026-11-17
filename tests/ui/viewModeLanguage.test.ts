// The view mode names, why Path traced is greyed, the realtime quality refusal, the denoiser line and the screen
// reader view summary read in the chosen language and follow a live switch.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { VIEW_MODES, pathTracedBlock, requestPathTraced, resetPathTracedOverride } from "../../src/ui/viewMode";
import { viewSummary, type SummaryFacts } from "../../src/ui/viewSummary";
import { highRefusal } from "../../src/viewport/realtimePipeline";
import { describeDenoiser } from "../../src/viewport/pathtrace/denoiser";

beforeEach(() => resetPathTracedOverride());
afterEach(() => setLanguage("system"));

const weak = { lowPower: true, auto: true, webgpu: true };
const cpu = { lowPower: false, auto: false, webgpu: false, native: { available: false, class: "cpu" } };
const labels = () => VIEW_MODES.map((m) => m.label);

const facts: SummaryFacts = {
  bodies: 2,
  hidden: 1,
  features: 5,
  failed: 0,
  view: { view: "front", ortho: false, section: false },
  selection: { bodies: [], faces: 1, edges: 3 },
};

const filter = { active: "filter" as const, version: "", offered: true, bytes: 40_000_000 };
const MAC_NOTE = "the high quality denoise is not offered on macOS yet, the edge aware filter cleans the picture";

describe("view modes and path tracing in German and Japanese", () => {
  it("names the view modes in the language and follows a switch", async () => {
    expect(labels()).toEqual(["Matcap", "Realtime", "Path traced"]);
    await setLanguage("de");
    expect(labels()).toEqual(["Matcap", "Echtzeit", "Pfadverfolgung"]);
    await setLanguage("ja");
    expect(labels()).toEqual(["Matcap", "リアルタイム", "パストレース"]);
  });

  it("says why Path traced is greyed and how to lift it", async () => {
    await setLanguage("de");
    expect(pathTracedBlock(weak)!.tooltip).toBe(
      "Um Abstürze oder unbeabsichtigtes Einfrieren zu vermeiden, wurde die Pfadverfolgung ausgeschaltet. " +
        "Schalten Sie den Leistungsmodus aus, um sie wieder einzuschalten. " +
        "Dieser Computer wurde als leistungsschwach erkannt, daher hebt das Ausschalten des Leistungsmodus die Sperre womöglich nicht auf.",
    );
    expect(pathTracedBlock(cpu)!.tooltip).toBe(
      "Dieser Computer bietet nur Softwaregrafik, die für die Pfadverfolgung zu langsam ist",
    );
    expect(requestPathTraced({ ...weak, auto: false }, 0).message).toContain("Klicken Sie erneut");
    resetPathTracedOverride();
    await setLanguage("ja");
    expect(pathTracedBlock(cpu)!.tooltip).toBe(
      "このコンピューターはソフトウェア描画のみに対応しており、パストレースには遅すぎます",
    );
    expect(requestPathTraced({ ...weak, auto: false }, 0).message).toMatch(
      /^クラッシュや意図しないフリーズを避けるため.*もう一度クリックすると/,
    );
  });

  it("says why High realtime quality is off", async () => {
    await setLanguage("de");
    expect(highRefusal({ lowPower: true, auto: false, software: false })).toBe(
      "„Hoch“ ist aus, solange der Leistungsmodus oder der Kartoffelmodus an ist.",
    );
    await setLanguage("ja");
    expect(highRefusal({ lowPower: false, auto: false, software: true })).toBe(
      "このコンピューターはソフトウェア描画を使っているため、「高」には遅すぎます。",
    );
  });
});

describe("the denoiser line in German and Japanese", () => {
  it("names the denoiser and reads the app's own note in the language", async () => {
    const state = (note: string | null, error = "") => ({ info: { ...filter, note }, downloading: false, error });
    expect(describeDenoiser(state(MAC_NOTE))).toBe(`Native tracer: the edge aware filter, ${MAC_NOTE}.`);
    await setLanguage("de");
    expect(describeDenoiser(state("not downloaded"))).toBe("Nativer Verfolger: der kantenerhaltende Filter.");
    expect(describeDenoiser(state(MAC_NOTE))).toContain("gibt es für macOS noch nicht");
    expect(describeDenoiser(state(null, "the download failed, the edge aware filter stays (timed out)"))).toBe(
      "Nativer Verfolger: der kantenerhaltende Filter, der Download ist fehlgeschlagen, der kantenerhaltende Filter bleibt (timed out).",
    );
    expect(describeDenoiser({ info: null, downloading: true, error: "" })).toBe(
      "Open Image Denoise wird heruntergeladen…",
    );
    await setLanguage("ja");
    expect(
      describeDenoiser({ info: { ...filter, active: "oidn", version: "2.3.0" }, downloading: false, error: "" }),
    ).toBe("ネイティブトレーサー: Open Image Denoise 2.3.0。");
  });
});

describe("the view summary in German and Japanese", () => {
  it("counts, names the view and the selection in the language", async () => {
    expect(viewSummary(facts)).toBe(
      "2 bodies (1 hidden), 5 features. Front view, perspective. Section off. Selected: 1 face, 3 edges.",
    );
    await setLanguage("de");
    expect(viewSummary(facts)).toBe(
      "2 Körper (1 ausgeblendet), 5 Features. Vorderansicht, perspektivisch. Schnitt aus. Ausgewählt: 1 Fläche, 3 Kanten.",
    );
    expect(
      viewSummary({ ...facts, bodies: 0, hidden: 0, features: 0, view: { view: null, ortho: true, section: true } }),
    ).toBe(
      "Keine Körper, keine Features. Benutzerdefinierte Ansicht, orthografisch. Schnitt an. Ausgewählt: 1 Fläche, 3 Kanten.",
    );
    await setLanguage("ja");
    expect(viewSummary(facts)).toBe(
      "2 ボディ（1 個は非表示）、5 フィーチャ。正面図、透視投影。断面: オフ。選択中: 1 面、3 エッジ。",
    );
  });
});
