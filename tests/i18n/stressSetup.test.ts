// The Stress setup's choices and counts follow the picked language; values and saved studies stay English.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { formatMessage, parseMessage, type MessageArgs } from "../../src/i18n/format";
import de from "../../src/i18n/locales/de.json";
import fr from "../../src/i18n/locales/fr.json";
import ja from "../../src/i18n/locales/ja.json";
import {
  AXIS_LABELS,
  CUSTOM_MATERIAL,
  FORCE_DIRECTIONS,
  MESH_DETAIL_CHOICES,
  STRESS_MATERIALS,
  SUPPORT_KINDS,
  buildStressRequest,
  faceCountLabel,
  finerLabel,
  forceDragLabel,
  materialOptions,
  newLoad,
  newSetup,
  newSupport,
  pickedFacesStatus,
  studyFromSetup,
  type StressFaceSet,
} from "../../src/ui/stress";
import type { Selector, StressSpot } from "../../src/types";

type Lines = Record<string, string>;

const line = (file: Lines, key: string, locale: string, args: MessageArgs = {}) =>
  formatMessage(parseMessage(file[key]!), args, locale);

const sel = (x: number, y: number, z: number): Selector => ({
  kind: "face",
  by: "nearest",
  point: [x, y, z],
  body: "b2",
});

function set(n: number, extra: Partial<StressFaceSet> = {}): StressFaceSet {
  const selectors = [sel(12.5, -3, 7.25), sel(-4, 18, 2.5), sel(30, 6.5, -9)].slice(0, n);
  return { selectors, faceIds: selectors.map((_, i) => 40 + i), normalSum: [0.3, -0.8, 0.52], area: 61.4, ...extra };
}

const spot = (x: number): StressSpot => ({ at: [x, -7.5, 3.25], radius: 2.4, normal: [0, 0.6, 0.8] });
const spots = (k: number) => [spot(11), spot(-6.5)].slice(0, k);

// Every branch of the count, with the spots after it: none, all, some, missing and unshown.
const SETS: [StressFaceSet, number][] = [
  [set(0), 0],
  [set(0), 1],
  [set(0), 2],
  [set(1), 0],
  [set(1), 1],
  [set(1), 2],
  [set(3), 0],
  [set(3), 1],
  [set(3), 2],
  [set(1, { missing: 1, unshown: 0 }), 0],
  [set(3, { missing: 3, unshown: 0 }), 1],
  [set(3, { missing: 1, unshown: 1 }), 2],
  [set(1, { faceIds: [] }), 0],
  [set(3, { faceIds: [] }), 2],
  [set(3, { unshown: 2 }), 1],
];

const labels = () => SETS.map(([faces, k]) => faceCountLabel(faces, spots(k)));

function setup() {
  const s = newSetup("b2");
  s.supports = [newSupport(4, "pinned"), newSupport(7, "slider"), newSupport(9)];
  s.supports[0]!.faces = set(1);
  s.supports[1]!.faces = set(3);
  s.supports[2]!.spots = spots(2);
  s.loads = [newLoad(2), { ...newLoad(5), direction: "-Y" }];
  s.loads[0]!.faces = set(3);
  s.loads[1]!.spots = spots(1);
  s.gravity = { on: true, direction: "+X" };
  s.material = CUSTOM_MATERIAL;
  s.custom = { E: 1850, nu: 0.41, yield: 38.5, density: 1.12 };
  s.refine = "fine";
  return s;
}

afterEach(() => setLanguage("system"));

describe("the Stress setup choices", () => {
  it("read the picked language's lines and keep their values, then the next language leaves none behind", async () => {
    const choices = () => ({
      supports: SUPPORT_KINDS.map((k) => ({ ...k })),
      axes: { ...AXIS_LABELS },
      forces: FORCE_DIRECTIONS.map((d) => ({ ...d })),
      mesh: MESH_DETAIL_CHOICES.map((c) => ({ ...c })),
    });
    const expected = (l: Lines) => ({
      supports: [
        { value: "fixed", label: l["stress.support.fixed"], hint: l["stress.support.fixedHint"] },
        { value: "pinned", label: l["stress.support.pinned"], hint: l["stress.support.pinnedHint"] },
        { value: "slider", label: l["stress.support.slider"], hint: l["stress.support.sliderHint"] },
      ],
      axes: {
        "-Z": l["stress.dir.down"],
        "+Z": l["stress.dir.up"],
        "+X": l["stress.dir.right"],
        "-X": l["stress.dir.left"],
        "+Y": l["stress.dir.back"],
        "-Y": l["stress.dir.front"],
      },
      forces: [
        { value: "into", label: l["stress.dir.into"] },
        { value: "-Z", label: l["stress.dir.down"] },
        { value: "+Z", label: l["stress.dir.up"] },
        { value: "+X", label: l["stress.dir.right"] },
        { value: "-X", label: l["stress.dir.left"] },
        { value: "+Y", label: l["stress.dir.back"] },
        { value: "-Y", label: l["stress.dir.front"] },
        { value: "custom", label: l["stress.dir.custom"] },
      ],
      mesh: [
        { value: "off", label: l["stress.mesh.coarse"] },
        { value: "standard", label: l["stress.mesh.standard"] },
        { value: "fine", label: l["stress.mesh.fine"] },
      ],
    });
    const english = choices();
    await setLanguage("de");
    const german = choices();
    await setLanguage("fr");
    const french = choices();

    expect(english.supports.map((k) => k.label)).toEqual(["Fixed", "Pinned", "Slider"]);
    expect(english.axes["-Y"]).toBe("Front (-Y)");
    expect([german, french]).toEqual([expected(de), expected(fr)]);
    expect(german.supports[0]!.label).not.toBe("Fixed");
  });

  it("name the material presets as they are in every language, only the Custom label follows it", async () => {
    const presets = STRESS_MATERIALS.map((m) => ({ value: m.name, label: m.name }));
    const english = materialOptions();
    await setLanguage("de");
    const german = materialOptions();
    await setLanguage("ja");

    expect([english, german, materialOptions()]).toEqual([
      [...presets, { value: "Custom", label: "Custom" }],
      [...presets, { value: "Custom", label: de["stress.material.custom"] }],
      [...presets, { value: "Custom", label: ja["stress.material.custom"] }],
    ]);
  });
});

describe("the Stress setup counts", () => {
  it("read as before in English, for none, one and many faces and spots, missing and unshown", () => {
    expect(labels()).toEqual([
      "No faces yet",
      "1 spot",
      "2 spots",
      "1 face",
      "1 face, 1 spot",
      "1 face, 2 spots",
      "3 faces",
      "3 faces, 1 spot",
      "3 faces, 2 spots",
      "1 face, not found on the current model",
      "3 faces, none found on the current model, 1 spot",
      "3 faces, 1 not found on the current model, 2 spots",
      "1 face (not shown in the view)",
      "3 faces (none shown in the view), 2 spots",
      "3 faces (2 not shown in the view), 1 spot",
    ]);
  });

  it("read the French lines, where 0 would take the singular but no count of 0 is shown", async () => {
    await setLanguage("fr");
    const f = (key: string, args: MessageArgs = {}) => line(fr, key, "fr", args);
    const both = (faces: string, k: number) =>
      f("stress.places.both", { faces, spots: f("stress.spots.count", { k }) });

    expect(f("stress.faces.count", { n: 0 })).toBe(f("stress.faces.count", { n: 1 }).replace("1", "0"));
    expect(labels()).toEqual([
      f("stress.faces.none"),
      f("stress.spots.count", { k: 1 }),
      f("stress.spots.count", { k: 2 }),
      f("stress.faces.count", { n: 1 }),
      both(f("stress.faces.count", { n: 1 }), 1),
      both(f("stress.faces.count", { n: 1 }), 2),
      f("stress.faces.count", { n: 3 }),
      both(f("stress.faces.count", { n: 3 }), 1),
      both(f("stress.faces.count", { n: 3 }), 2),
      f("stress.faces.missingAll", { n: 1 }),
      both(f("stress.faces.missingAll", { n: 3 }), 1),
      both(f("stress.faces.missingSome", { n: 3, missing: 1 }), 2),
      f("stress.faces.unshownAll", { n: 1 }),
      both(f("stress.faces.unshownAll", { n: 3 }), 2),
      both(f("stress.faces.unshownSome", { n: 3, unshown: 2 }), 1),
    ]);
    expect(labels().filter((l) => /\b0\b/.test(l))).toEqual([]);
  });

  it("time a finer run in seconds below 90 and in minutes from 90, in English and German", async () => {
    const times = [4, 12, 85, 89, 90, 100, 151];
    const english = times.map(finerLabel);
    await setLanguage("de");
    const s = (n: number) => line(de, "stress.finer.seconds", "de", { s: n });
    const m = (n: number) => line(de, "stress.finer.minutes", "de", { m: n });

    expect(english).toEqual([
      "Run with finer detail (about 10 seconds)",
      "Run with finer detail (about 10 seconds)",
      "Run with finer detail (about 85 seconds)",
      "Run with finer detail (about 90 seconds)",
      "Run with finer detail (about 2 min)",
      "Run with finer detail (about 2 min)",
      "Run with finer detail (about 3 min)",
    ]);
    expect(times.map(finerLabel)).toEqual([s(10), s(10), s(85), s(90), m(2), m(2), m(3)]);
  });

  it("name the row that took the faces in one status line, in English and German", async () => {
    const rows = () => [
      pickedFacesStatus("fixed", 1, 1),
      pickedFacesStatus("pinned", 12, 3),
      pickedFacesStatus("slider", 2, 1),
      pickedFacesStatus("load", 3, 7),
    ];
    const english = rows();
    await setLanguage("de");
    const d = (row: string, i: number, n: number) => line(de, "stress.status.picked", "de", { row, i, n });

    expect(english).toEqual([
      "Stress: Support 1 (fixed): 1 face",
      "Stress: Support 12 (pinned): 3 faces",
      "Stress: Support 2 (slider): 1 face",
      "Stress: Load 3: 7 faces",
    ]);
    expect(rows()).toEqual([d("fixed", 1, 1), d("pinned", 12, 3), d("slider", 2, 1), d("load", 3, 7)]);
    expect(rows()[3]).not.toContain("Support");
  });

  it("label a dragged force with the picked language's direction, as one message", async () => {
    const all = ["into", "-Z", "+Z", "+X", "-X", "+Y", "-Y", "custom"] as const;
    const labels = () => all.map((direction, i) => forceDragLabel({ direction, force: 37.5 + i }));
    const english = labels();
    await setLanguage("de");
    expect([english, labels()]).toEqual([
      [
        "37.5 N, into the face",
        "38.5 N, down (-Z)",
        "39.5 N, up (+Z)",
        "40.5 N, right (+X)",
        "41.5 N, left (-X)",
        "42.5 N, back (+Y)",
        "43.5 N, front (-Y)",
        "44.5 N",
      ],
      [
        "37.5 N, in die Fläche hinein",
        "38.5 N, nach unten (-Z)",
        "39.5 N, nach oben (+Z)",
        "40.5 N, nach rechts (+X)",
        "41.5 N, nach links (-X)",
        "42.5 N, nach hinten (+Y)",
        "43.5 N, nach vorne (-Y)",
        "44.5 N",
      ],
    ]);
  });
});

describe("a German session", () => {
  it("saves and sends the same study as an English one", async () => {
    const english = { study: studyFromSetup(setup()), request: buildStressRequest(setup()) };
    await setLanguage("de");
    const german = { study: studyFromSetup(setup()), request: buildStressRequest(setup()) };

    expect(german).toEqual(english);
    expect(english.study.material).toBe("Custom");
  });
});
