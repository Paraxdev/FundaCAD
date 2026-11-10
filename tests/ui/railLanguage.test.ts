import { afterEach, describe, expect, it } from "vitest";
import { contribute } from "../../src/plugins/contrib";
import { setLanguage } from "../../src/i18n";
import { groupEnglish, groupName, leavesOf, MODEL, modelGroups, toolEnglish, toolLabel } from "../../src/ui/ribbonDefs";
import { modelRail, type RailEntry } from "../../src/ui/railDefs";
import { runningTool } from "../../src/ui/runningTool";
import type { EngineTools } from "../../src/app/engine";

afterEach(async () => {
  await setLanguage("system");
});

const TOOLS: Record<string, [english: string, de: string, fr: string]> = {
  sketch: ["Sketch", "Skizze", "Esquisse"],
  extrude: ["Extrude", "Extrusion", "Extruder"],
  primitive: ["Primitive", "Grundkörper", "Primitive"],
  revolve: ["Revolve", "Rotation", "Révolution"],
  loft: ["Loft", "Ausformung", "Lissage"],
  sweep: ["Sweep", "Austragung", "Balayage"],
  presspull: ["Press/Pull", "Drücken/Ziehen", "Pousser/Tirer"],
  fillet: ["Fillet", "Verrundung", "Congé"],
  chamfer: ["Chamfer", "Fase", "Chanfrein"],
  hole: ["Hole", "Bohrung", "Perçage"],
  move: ["Move", "Verschieben", "Déplacer"],
  scale: ["Scale", "Skalieren", "Mettre à l'échelle"],
  mirror: ["Mirror", "Spiegeln", "Miroir"],
  joint: ["Joint", "Gelenk", "Liaison"],
  mechanism: ["Mechanism", "Mechanismus", "Mécanisme"],
  "pattern-linear": ["Linear Pattern", "Lineares Muster", "Réseau linéaire"],
  "pattern-circular": ["Circular Pattern", "Kreismuster", "Réseau circulaire"],
  "pattern-rect": ["Rect Pattern", "Rechteckmuster", "Réseau rectangulaire"],
  split: ["Split Body", "Körper teilen", "Diviser le corps"],
  separate: ["Separate", "Trennen", "Séparer"],
  shell: ["Shell", "Wandung", "Coque"],
  draft: ["Draft", "Formschräge", "Dépouille"],
  thread: ["Thread", "Gewinde", "Filetage"],
  "text-on-face": ["Text on Face", "Text auf Fläche", "Texte sur face"],
  "offset-face": ["Offset Face", "Fläche versetzen", "Décaler la face"],
  thicken: ["Thicken", "Verdicken", "Épaissir"],
  "change-parameters": ["Parameters", "Parameter", "Paramètres"],
  "offset-plane": ["Offset Plane", "Versetzte Ebene", "Plan décalé"],
  "datum-plane": ["Datum Plane", "Bezugsebene", "Plan de référence"],
  midplane: ["Midplane", "Mittelebene", "Plan médian"],
  "plane-points": ["Plane, 3 Pts", "Ebene, 3 Pkt.", "Plan, 3 pts"],
  "plane-normal-edge": ["Normal to Edge", "Senkrecht zu Kante", "Normal à l'arête"],
  "plane-two-edges": ["Plane, 2 Edges", "Ebene, 2 Kanten", "Plan, 2 arêtes"],
  "plane-angle": ["Plane at Angle", "Ebene im Winkel", "Plan incliné"],
  "datum-point": ["Datum Point", "Bezugspunkt", "Point de référence"],
  "datum-axis": ["Datum Axis", "Bezugsachse", "Axe de référence"],
  "datum-axis-edge": ["Axis on Edge", "Achse auf Kante", "Axe sur arête"],
  "axis-cylinder": ["Axis of Cylinder", "Zylinderachse", "Axe du cylindre"],
  "axis-planes": ["Axis, 2 Planes", "Achse, 2 Ebenen", "Axe, 2 plans"],
  measure: ["Measure", "Messen", "Mesurer"],
  section: ["Section", "Schnitt", "Coupe"],
  properties: ["Properties", "Eigenschaften", "Propriétés"],
  interference: ["Interference", "Kollision", "Interférence"],
  stress: ["Stress", "Spannung", "Contraintes"],
  "draft-analysis": ["Overhang", "Überhang", "Porte-à-faux"],
  zebra: ["Zebra", "Zebra", "Zébrure"],
  curvature: ["Curvature", "Krümmung", "Courbure"],
  "component-colors": ["Body Colors", "Körperfarben", "Couleurs des corps"],
  materials: ["Materials", "Materialien", "Matériaux"],
  import: ["Import Mesh", "Netz importieren", "Importer un maillage"],
  "insert-document": ["Insert Document", "Dokument einfügen", "Insérer un document"],
  "simplify-mesh": ["Simplify Mesh", "Netz vereinfachen", "Simplifier le maillage"],
  "clean-up": ["Clean Up", "Bereinigen", "Nettoyer"],
  "compute-all": ["Compute All", "Alles berechnen", "Tout calculer"],
  "boolean-union": ["Union", "Vereinigen", "Union"],
  "boolean-subtract": ["Subtract", "Subtrahieren", "Soustraire"],
  "boolean-intersect": ["Intersect", "Schneiden", "Intersection"],
};

const GROUPS: Record<string, [english: string, de: string, fr: string]> = {
  CREATE: ["Create", "Erstellen", "Créer"],
  MODIFY: ["Modify", "Ändern", "Modifier"],
  CONSTRUCT: ["Construct", "Konstruieren", "Construire"],
  INSPECT: ["Inspect", "Prüfen", "Inspecter"],
  INSERT: ["Insert", "Einfügen", "Insérer"],
};

const FAMILIES: [english: string, de: string][] = [
  ["Revolve", "Rotation"],
  ["Move", "Verschieben"],
  ["Boolean", "Boolesch"],
  ["Shell", "Wandung"],
  ["Plane", "Ebene"],
  ["Datum", "Bezug"],
  ["Analyze", "Analysieren"],
];

type Lang = 0 | 1 | 2;
const IDS = Object.keys(TOOLS);
const view = (entries: RailEntry[]) =>
  entries.map((e) =>
    e.kind === "tool"
      ? { id: e.action, label: e.label, english: e.english }
      : {
          id: e.id,
          label: e.label,
          english: e.english,
          items: e.items.map((i) => ({ id: i.action, label: i.label, english: i.english })),
        },
  );

/** What modelRail() gives for the built in tools in language index n (0 English, 1 German, 2 French). */
function expected(n: Lang) {
  return MODEL.map((g) => {
    const tools = g.items.flatMap(leavesOf).map((t) => ({
      id: t.action,
      label: TOOLS[t.action]![n],
      english: TOOLS[t.action]![0],
    }));
    const sketch = tools.find((t) => t.id === "sketch");
    const items = tools.filter((t) => t !== sketch);
    return { sketch, cat: { id: `cat:${g.label}`, label: GROUPS[g.label]![n], english: GROUPS[g.label]![0], items } };
  }).flatMap((x) => (x.sketch ? [x.sketch, x.cat] : [x.cat]));
}

describe("the model tools in the chosen language", () => {
  it("covers every built in action with its English name", () => {
    const actions = MODEL.flatMap((g) => g.items.flatMap(leavesOf)).map((t) => t.action);
    expect(actions.sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(toolEnglish(id)).toBe(TOOLS[id]![0]);
  });

  it("reads English exactly as before", () => {
    expect(view(modelRail())).toEqual(expected(0));
  });

  it("gives the whole German model rail", async () => {
    await setLanguage("de");
    expect(view(modelRail())).toEqual(expected(1));
    expect(modelRail().map((e) => (e.kind === "family" ? e.id : e.action))).toEqual([
      "sketch",
      "cat:CREATE",
      "cat:MODIFY",
      "cat:CONSTRUCT",
      "cat:INSPECT",
      "cat:INSERT",
    ]);
  });

  it("names a split button's family in German and keeps its English", async () => {
    await setLanguage("de");
    const families = MODEL.flatMap((g) => g.items).filter((i) => "children" in i);
    expect(families.map((f) => f.label)).toEqual(FAMILIES.map(([, de]) => de));
    await setLanguage("system");
    expect(families.map((f) => f.label)).toEqual(FAMILIES.map(([en]) => en));
  });

  it("follows de, fr and en for the same modelRail call", async () => {
    const rail = () => view(modelRail());
    await setLanguage("de");
    const de = rail();
    await setLanguage("fr");
    const fr = rail();
    await setLanguage("system");
    const en = rail();
    expect([en, de, fr]).toEqual([expected(0), expected(1), expected(2)]);
  });

  it("tells a plugin tool from a built in one", async () => {
    await setLanguage("de");
    expect(toolEnglish("plug-tool")).toBeUndefined();
    expect(toolLabel("plug-tool")).toBeUndefined();
    expect(toolEnglish("extrude")).toBe("Extrude");
    expect(toolLabel("extrude")).toBe("Extrusion");
    expect(groupName("PRINT")).toBeUndefined();
    expect(groupEnglish("PRINT")).toBeUndefined();
    expect(groupName("toString")).toBeUndefined();
    expect(groupName("MODIFY")).toBe("Ändern");
    expect(groupEnglish("MODIFY")).toBe("Modify");
  });

  it("merges one plugin's tool into CREATE and still reads German", async () => {
    const off = contribute("test.one", {
      ribbon: [{ group: "CREATE", items: [{ action: "plug-tool", label: "Plug Tool", iconName: "extrude" }] }],
    });
    try {
      await setLanguage("de");
      const create = view(modelRail()).find((e) => e.id === "cat:CREATE")!;
      const want = expected(1).find((e) => e.id === "cat:CREATE")! as unknown as { items: unknown[] };
      expect(create).toEqual({
        id: "cat:CREATE",
        label: "Erstellen",
        english: "Create",
        items: [...want.items, { id: "plug-tool", label: "Plug Tool", english: undefined }],
      });
    } finally {
      off();
    }
  });

  it("merges many plugin groups and keeps their own words", async () => {
    const off = [
      contribute("test.a", {
        ribbon: [
          { group: "MODIFY", items: [{ action: "plug-a", label: "Alpha", iconName: "move" }] },
          { group: "PRINT", items: [{ action: "plug-p", label: "Printen", iconName: "export" }] },
        ],
      }),
      contribute("test.b", {
        ribbon: [{ group: "PRINT", items: [{ action: "plug-q", label: "Quick", iconName: "export" }] }],
      }),
    ];
    try {
      await setLanguage("de");
      const rail = view(modelRail());
      const modify = rail.find((e) => e.id === "cat:MODIFY")! as { items: { id: string; label: string }[] };
      expect(modify.items.at(-1)).toEqual({ id: "plug-a", label: "Alpha", english: undefined });
      expect(modify.items[0]).toEqual({ id: "presspull", label: "Drücken/Ziehen", english: "Press/Pull" });
      expect(rail.find((e) => e.id === "cat:PRINT")).toEqual({
        id: "cat:PRINT",
        label: "Print",
        english: undefined,
        items: [
          { id: "plug-p", label: "Printen", english: undefined },
          { id: "plug-q", label: "Quick", english: undefined },
        ],
      });
      const groups = modelGroups();
      expect(groups.map((g) => g.label)).toEqual(["CREATE", "MODIFY", "CONSTRUCT", "INSPECT", "INSERT", "PRINT"]);
      await setLanguage("fr");
      expect(groups[0]!.items.flatMap(leavesOf).map((t) => t.label)).toContain("Extruder");
    } finally {
      off.forEach((f) => f());
    }
    expect(modelGroups()).toBe(MODEL);
  });
});

describe("the running tool's name", () => {
  const tools = (active: string, extra: object = {}) =>
    new Proxy(
      {},
      {
        get: (_, k: string) => ({ active: k === active, cancel() {}, ...(k === active ? extra : {}) }),
      },
    ) as unknown as EngineTools;
  const nameOf = (active: string, extra?: object) => runningTool(tools(active, extra))?.label;

  it("follows the language and keeps the action", async () => {
    await setLanguage("de");
    expect(nameOf("extrude")).toBe("Extrusion");
    expect(nameOf("edgeFeature")).toBe("Verrundung / Fase");
    expect(nameOf("pattern")).toBe("Muster");
    expect(nameOf("hole")).toBe("Bohrung");
    expect(nameOf("mirror")).toBe("Spiegeln");
    expect(runningTool(tools("draft"))?.action).toBe("draft");
    await setLanguage("system");
    expect(nameOf("edgeFeature")).toBe("Fillet / Chamfer");
    expect(nameOf("pattern")).toBe("Pattern");
    expect(nameOf("loft")).toBe("Loft");
  });

  it("names a face offset by its action, shell included", async () => {
    await setLanguage("de");
    const shell = { action: "shell", label: "Shell", icon: "shell" };
    expect(nameOf("faceOffset", shell)).toBe("Wandung");
    expect(nameOf("faceOffset", { ...shell, action: "offset-face" })).toBe("Fläche versetzen");
    expect(nameOf("faceOffset", { ...shell, action: "other", label: "Own" })).toBe("Own");
    expect(runningTool(tools("none"))).toBeNull();
  });
});
