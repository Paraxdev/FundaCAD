import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bedFitMessage, parseCustomBedSize } from "../../plugins/FundaCAD.PrintToolbox/bedFit";
import { TEARDROP, PRINT_TOOLS } from "../../plugins/FundaCAD.PrintToolbox/printForm";
import {
  buildPrintabilityRequest,
  checkChoices,
  findingPlace,
  findingText,
  formatPrintabilityResult,
  newPrintabilitySetup,
  printabilitySummary,
  upChoices,
} from "../../plugins/FundaCAD.PrintToolbox/printability";
import { toolLabel } from "../../plugins/FundaCAD.PrintToolbox/lines";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import type { PrintabilityFinding, PrintabilityReply } from "fundacad";

function finding(over: Partial<PrintabilityFinding>): PrintabilityFinding {
  return {
    kind: "overhang",
    body: "body1",
    face: 3,
    other: null,
    value: 60,
    limit: 0,
    area: 132.4,
    low: 5,
    at: [10, 0, 5],
    extent: 4,
    note: "",
    ...over,
  };
}

const reply: PrintabilityReply = {
  header: "",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [{ id: "body1", name: "Block", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 3, solids: 2, insideOut: true }],
  findings: [
    finding({}),
    finding({ kind: "wall", face: 1, value: 0.3, limit: 0.8, at: [0, 0, 8] }),
    finding({ kind: "meshHole", face: 2, value: 1 }),
  ],
  errors: [],
};

beforeEach(async () => {
  localStorage.clear();
  await setLanguage("en");
});

afterEach(async () => {
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

describe("print toolbox in German", () => {
  beforeEach(() => setLanguage("de"));

  it("words findings, places and the summary in German", () => {
    const view = formatPrintabilityResult(reply, new Map([["body1", "Block"]]));
    const rows = view.groups[0]!.rows;
    expect(rows[0]!.text).toBe("Überhang, 132 mm², 60° geneigt");
    expect(rows[1]!.text).toContain("Dünne Wand mit 0,3 mm");
    expect(rows[2]!.text).toBe("Das Netz hat 1 offene Kante");
    expect(rows[0]!.hint).toBe("Fläche 4, ab 5 mm über der Bauplatte");
    expect(view.groups[0]!.notes).toEqual([
      "Offene Hülle, 3 offene Kanten",
      "2 getrennte Teile",
      "Von innen nach außen gekehrt, wird eventuell hohl oder gar nicht gedruckt",
    ]);
    const said = printabilitySummary(view);
    expect(
      said.startsWith("Druckbarkeit: 6 Punkte zu prüfen. 1 Überhang, 1 dünne Wand, 1 Netzloch, 3 Körperhinweise."),
    ).toBe(true);
    expect(said).toContain("Der Überhang misst 132 mm² an Fläche 4.");
  });

  it("refuses a bad setting in German", () => {
    const s = newPrintabilitySetup();
    s.nozzle = 0;
    const r = buildPrintabilityRequest(s, ["body1"]);
    expect(r).toEqual({ ok: false, message: "die Düsenbreite muss größer als 0 sein" });
  });

  it("reads the lists after a switch", () => {
    expect(upChoices()[0]!.label).toBe("+Z, wie modelliert");
    expect(checkChoices().map((c) => c.label)).toEqual([
      "Überhänge",
      "Dünne Wände",
      "Spalte",
      "Brücken",
      "Offene Hüllen",
    ]);
    expect(toolLabel("print-printability")).toBe("Druckbarkeit");
    expect(TEARDROP.label).toBe("Tropfenform");
    expect(TEARDROP.pickHint).toBe("wählen Sie die Innenfläche jeder seitlichen Bohrung");
    expect(TEARDROP.numFields[0]![1]).toBe("Dachwinkel");
    const roof = TEARDROP.choiceFields.find((c) => c.field === "roof")!;
    expect(roof.options.map((o) => o.label)).toEqual(["Spitz", "Flach"]);
    expect(PRINT_TOOLS.map((t) => t.label)).toContain("Dachbrücke");
  });

  it("words the bed fit and its refusal in German", () => {
    expect(bedFitMessage([100, 50, 20], [220, 220, 250])).toBe(
      "Passt auf die Bauplatte mit 220 x 220 x 250 mm (Modell: 100,0 x 50,0 x 20,0 mm)",
    );
    const refused = parseCustomBedSize(0, 100, 100);
    expect(refused).toEqual({ ok: false, message: "Breite, Tiefe und Höhe müssen alle positive Zahlen sein." });
  });
});

describe("print toolbox in Japanese", () => {
  beforeEach(() => setLanguage("ja"));

  it("words findings and places in Japanese", () => {
    const names = (id: string) => id;
    expect(findingText(finding({}), names)).toBe("オーバーハング、132 mm²、傾き 60°");
    expect(findingText(finding({ kind: "meshHole", value: 4 }), names)).toBe("メッシュに開いたエッジが 4 本あります");
    expect(findingPlace(finding({}), reply.bodies, names).hint).toBe("面 4、ベッドから 5 mm 上から");
  });

  it("joins sentences the Japanese way", () => {
    const view = formatPrintabilityResult(reply, new Map([["body1", "Block"]]));
    const said = printabilitySummary(view);
    expect(said.startsWith("印刷適性: 確認が必要な箇所が 6 件あります。")).toBe(true);
    expect(said.endsWith("。")).toBe(true);
    expect(said).not.toContain(". ");
  });

  it("switches back to English", async () => {
    await setLanguage("en");
    expect(findingText(finding({}), (id) => id)).toBe("Overhang, 132 mm² leaning 60°");
    expect(toolLabel("print-printability")).toBe("Printability");
    expect(toolLabel("print-printability", true)).toBe("Printability");
  });
});
