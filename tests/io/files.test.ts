import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

// Mocked once for the file: two doMocks of one path queued together are applied
// in whichever order vitest resolves them, so a test's own could lose to beforeEach's.
type ExportAsk = { scope?: string; selected?: readonly string[]; flat?: { label: string }; format?: string };
const ui = vi.hoisted(() => ({
  reported: [] as string[],
  picked: null as string | null,
  onPick: () => {},
  save: async (_o: { defaultPath: string }): Promise<string | null> => null,
  exportDialog: async (_what: ExportAsk): Promise<unknown> => null,
  closeHome: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (o: { defaultPath: string }) => ui.save(o),
  open: async () => {
    ui.onPick();
    return ui.picked;
  },
  message: async (m: string) => void ui.reported.push(m),
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => null, listModal: async () => {} }));
vi.mock("../../src/stores/exportDialog", () => ({
  useExportDialogStore: () => ({ open: (what: ExportAsk) => ui.exportDialog(what) }),
}));
vi.mock("../../src/ui/home", () => ({ closeHome: ui.closeHome }));

import { DEFAULT_SETTINGS, FORMATS } from "../../src/io/exportSettings";
import { routeDroppedName } from "../../src/io/dropRouting";
import {
  IMPORT_EXTS,
  dialogExts,
  describeImportCapability,
  extToFormat,
  extToImportFormat,
  importedBodyCount,
  looksLikeContainer,
} from "../../src/io/files";

// Both mappers are TOTAL, an unrecognised extension silently becomes "step"
// rather than erroring. That is deliberate (the save dialog can hand back a bare
// name), but it means a format added to a dialog filter list and forgotten here
// writes a STEP file wearing the user's chosen extension, with no error anywhere.
// These tests exist to make that omission fail loudly instead.
describe("extToFormat", () => {
  it("maps every extension offered in the export dialog", () => {
    expect(extToFormat("/tmp/part.step")).toBe("step");
    expect(extToFormat("/tmp/part.stp")).toBe("step");
    expect(extToFormat("/tmp/part.stl")).toBe("stl");
    expect(extToFormat("/tmp/part.3mf")).toBe("3mf");
    expect(extToFormat("/tmp/part.glb")).toBe("glb");
    expect(extToFormat("/tmp/part.dxf")).toBe("dxf");
    expect(extToFormat("/tmp/part.svg")).toBe("svg");
  });

  it("is case-insensitive and survives dots in the path", () => {
    expect(extToFormat("/tmp/my.part.v2.GLB")).toBe("glb");
    expect(extToFormat("C:\\models\\a.b\\Part.Stl")).toBe("stl");
  });

  it("falls back to step for anything unknown", () => {
    expect(extToFormat("/tmp/part")).toBe("step");
    expect(extToFormat("/tmp/part.wat")).toBe("step");
  });
});

describe("extToImportFormat", () => {
  it("maps every extension offered in the import dialog", () => {
    expect(extToImportFormat("/tmp/a.stl")).toBe("stl");
    expect(extToImportFormat("/tmp/a.3mf")).toBe("3mf");
    expect(extToImportFormat("/tmp/a.step")).toBe("step");
    expect(extToImportFormat("/tmp/a.stp")).toBe("step");
    expect(extToImportFormat("/tmp/a.obj")).toBe("obj");
    expect(extToImportFormat("/tmp/a.brep")).toBe("brep");
    expect(extToImportFormat("/tmp/a.glb")).toBe("glb");
    expect(extToImportFormat("/tmp/a.igs")).toBe("iges");
    expect(extToImportFormat("/tmp/a.iges")).toBe("iges");
    expect(extToImportFormat("/tmp/a.fcstd")).toBe("fcstd");
    expect(extToImportFormat("/tmp/a.gltf")).toBe("gltf");
    expect(extToImportFormat("/tmp/a.ply")).toBe("ply");
    expect(extToImportFormat("/tmp/a.off")).toBe("off");
    expect(extToImportFormat("/tmp/a.amf")).toBe("amf");
    expect(extToImportFormat("/tmp/a.wrl")).toBe("vrml");
    expect(extToImportFormat("/tmp/a.x3d")).toBe("x3d");
    expect(extToImportFormat("/tmp/a.xbf")).toBe("xbf");
    expect(extToImportFormat("/tmp/a.3dm")).toBe("3dm");
    expect(extToImportFormat("/tmp/Logo.3DM")).toBe("3dm");
    expect(extToImportFormat("/tmp/house.ifc")).toBe("ifc");
    expect(extToImportFormat("/tmp/HOUSE.IFC")).toBe("ifc");
    expect(extToImportFormat("/tmp/plate.dxf")).toBe("dxf");
    expect(extToImportFormat("/tmp/logo.SVG")).toBe("svg");
    expect(extToImportFormat("/tmp/rig.FBX")).toBe("fbx");
    expect(extToImportFormat("/tmp/old.3DS")).toBe("3ds");
    expect(extToImportFormat("/tmp/PLATE.DXF")).toBe("dxf");
  });

  it("reads a gzip copy as the format inside it", () => {
    expect(extToImportFormat("/tmp/a.stpz")).toBe("step");
    expect(extToImportFormat("/tmp/a.step.gz")).toBe("step");
    expect(extToImportFormat("/tmp/a.stp.gz")).toBe("step");
    expect(extToImportFormat("/tmp/a.wrl.gz")).toBe("vrml");
    expect(extToImportFormat("/tmp/A.X3D.GZ")).toBe("x3d");
    expect(extToImportFormat("/tmp/my.part.v2.step.gz")).toBe("step");
  });

  it("is case-insensitive", () => {
    expect(extToImportFormat("/tmp/A.GLB")).toBe("glb");
    expect(extToImportFormat("/tmp/A.IGS")).toBe("iges");
    expect(extToImportFormat("/home/me/Bracket.FCStd")).toBe("fcstd");
  });
});

// A v5 document is a ZIP; builds that predate it must SAY so rather than
// showing a JSON syntax error, and must NOT drop the file from Recent while
// telling the user to upgrade. `openDocumentAtPath` and the Home screen
// wiring need Tauri + a DOM, neither of which this suite has (see
// vitest.config.ts: "no DOM/Tauri APIs mocked yet"), so the DECISION is
// unit-tested here and the wiring is left to the browser harness.
// Home keeping the card on "newerFormat" and "unreadable" is pinned in
// tests/components/home/HomeScreen.spec.ts.
describe("IMPORT_EXTS", () => {
  it("offers only extensions the import reads as themselves", () => {
    for (const ext of IMPORT_EXTS) {
      const fmt = extToImportFormat(`/tmp/a.${ext}`);
      const spellings: Record<string, string[]> = {
        step: ["step", "stp", "stpz", "gz"],
        iges: ["iges", "igs"],
        vrml: ["wrl", "wrz"],
        x3d: ["x3d", "x3dz"],
      };
      expect(spellings[fmt] ?? [fmt]).toContain(ext.toLowerCase());
    }
  });
});

describe("looksLikeContainer", () => {
  // 0x50 0x4b 0x03 0x04 = "PK\x03\x04", a ZIP local-file header, followed by
  // bytes that are invalid UTF-8 (0xff 0xfe ...), i.e. a realistic prefix.
  const zipBytes = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0x08, 0x00, 0xff, 0xfe, 0x9c, 0x8d, 0xe2, 0x28, 0x00, 0x00,
  ]);

  // The whole diagnosis rests on one premise: plugin-fs decodes with a
  // NON-FATAL TextDecoder, so reading a zip as text SUCCEEDS (mangled) rather
  // than throwing, which is why JSON.parse is what fails and why we still have
  // the text to inspect. If that ever became fatal the read would throw first
  // and the friendly message would be unreachable, so pin the premise itself.
  it("decoding zip bytes as UTF-8 does not throw (the premise)", () => {
    expect(() => new TextDecoder().decode(zipBytes)).not.toThrow();
  });

  it("recognises a zip through that lossy decode", () => {
    expect(looksLikeContainer(new TextDecoder().decode(zipBytes))).toBe(true);
  });

  it("recognises a format 2 file by its magic", () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("FUNDACAD"), 0x02, 0x00, 0xff, 0xfe]);
    expect(looksLikeContainer(new TextDecoder().decode(bytes))).toBe(true);
  });

  it("does not fire on a real document, or on ordinary corruption", () => {
    expect(looksLikeContainer('{ "version": 4, "features": [] }')).toBe(false);
    expect(looksLikeContainer("")).toBe(false);
    expect(looksLikeContainer("<!DOCTYPE html>")).toBe(false);
    expect(looksLikeContainer(" PK")).toBe(false); // leading space: not a header
  });
});

// --- export busy/cancel wiring (Wave 1.3) ------------------------------------
//
// Both export paths used to just `await` the backend. On a large document an
// export replays the whole feature history, so it runs as long as an import
// does, with nothing on screen to show it, and nothing for Cancel to attach
// to. These pin the two halves of the fix: the op is wrapped in runBusy, and it
// hands back its request id so a cancel targets THIS export rather than
// whatever ran most recently (the document stays editable meanwhile).
describe("export runs as a cancellable busy op", () => {
  const savePath = "/tmp/part.step";

  beforeEach(() => {
    ui.reported = [];
    ui.picked = null;
    ui.save = async () => savePath;
    // The Export dialog answers STEP, whole document.
    ui.exportDialog = async () => ({ settings: { ...DEFAULT_SETTINGS, format: "step" }, scope: "all" });
    // No jsdom in this project on purpose (see vitest.config.ts), so stand up
    // the one property exportModel's isTauri() probe reads, nothing more.
    // diagnostics/breadcrumbs.ts registers global handlers at MODULE scope
    // whenever `window` exists, so the stub needs those no-ops too.
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  function storeWith(exportImpl: GeometryBackend["export"]) {
    const backend = {
      async rebuild() {
        return { ok: false, error: { message: "stub" } };
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      connected: true,
      export: exportImpl,
    } as unknown as GeometryBackend;
    return { backend, store: new DocumentStore(backend, { parameters: {}, features: [] }) };
  }

  it("is busy while exporting, and hands back an id a cancel can target", async () => {
    let busyDuring: { active: boolean; id: string | null } | null = null;
    const { backend, store } = storeWith(async (_d, _f, _p, _o, onStarted) => {
      onStarted?.("req-42");
      busyDuring = { active: store.busyState.active, id: store.busyState.id };
      return { ok: true, path: savePath };
    });
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend);

    expect(busyDuring).not.toBeNull();
    expect(busyDuring!.active).toBe(true);
    // the id is what makes Cancel target THIS op, without it cancelBusy is a no-op
    expect(busyDuring!.id).toBe("req-42");
    expect(store.busyState.active).toBe(false); // always cleared
  });

  it("says nothing when the user cancels, that is not an error", async () => {
    const { backend, store } = storeWith(async () => ({
      ok: false,
      cancelled: true,
      message: "export cancelled",
    }));
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend);

    expect(ui.reported).toEqual([]); // no "Export failed: cancelled" dialog
    expect(store.busyState.active).toBe(false);
  });

  it("still reports a genuine failure", async () => {
    const { backend, store } = storeWith(async () => ({ ok: false, message: "disk full" }));
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend);

    expect(ui.reported.join(" ")).toContain("disk full");
    expect(store.busyState.active).toBe(false);
  });

  it("a document closed while its Export or Save dialog was open exports nothing, the next one exports itself", async () => {
    for (const closedIn of ["export", "save"] as const) {
      const exported: unknown[] = [];
      const { backend, store } = storeWith(async (d) => {
        exported.push(d.parameters);
        return { ok: true, path: savePath };
      });
      store.setParam("closed", 1);
      const answer = { settings: { ...DEFAULT_SETTINGS, format: "step" }, scope: "all" };
      ui.exportDialog = async () => {
        if (closedIn === "export") store.newDocument();
        return answer;
      };
      ui.save = async () => {
        if (closedIn === "save") store.newDocument();
        return savePath;
      };
      const { exportModel } = await import("../../src/io/files");
      await exportModel(store, backend);
      const during = [...exported];
      ui.exportDialog = async () => answer;
      ui.save = async () => savePath;
      store.setParam("next", 2);
      await exportModel(store, backend);
      expect({ closedIn, during, after: exported, busy: store.busyState.active, reported: ui.reported }).toEqual({
        closedIn,
        during: [],
        after: [{ next: 2 }],
        busy: false,
        reported: [],
      });
    }
  });

  it("cancelling the Export dialog exports nothing", async () => {
    ui.exportDialog = async () => null;
    let called = false;
    const { backend, store } = storeWith(async () => {
      called = true;
      return { ok: true, path: savePath };
    });
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend);
    expect(called).toBe(false);
  });

  it("sends the faceting and units with a mesh format", async () => {
    ui.exportDialog = async () => ({
      settings: {
        ...DEFAULT_SETTINGS,
        format: "stl",
        unit: "in",
        faceting: { surfaceDeviation: 0.01, normalDeviation: 8, maxEdgeLength: 3 },
      },
      scope: "all",
    });
    let sent: { format?: string; mesh?: unknown } = {};
    const { backend, store } = storeWith(async (_d, format, _p, opts) => {
      sent = { format, mesh: opts?.mesh };
      return { ok: true, path: savePath };
    });
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend);
    expect(sent).toEqual({
      format: "stl",
      mesh: { unit: "in", binary: true, surfaceDeviation: 0.01, normalDeviation: 8, maxEdgeLength: 3 },
    });
  });

  it("starts from the selected bodies and exports only those", async () => {
    let asked: { scope?: string; selected?: readonly string[] } = {};
    ui.exportDialog = async (what) => {
      asked = what;
      return { settings: { ...DEFAULT_SETTINGS, format: "stl" }, scope: what.scope };
    };
    let sent: { body?: string | undefined; bodies?: string[] | undefined; separate?: boolean | undefined } = {};
    let path = "";
    const { backend, store } = storeWith(async (_d, _f, p, opts) => {
      sent = { body: opts?.body, bodies: opts?.bodies, separate: opts?.separate };
      path = p;
      return { ok: true, path: p };
    });
    (store as unknown as { build: { result: unknown } }).build.result = {
      mesh: { positions: [] },
      bodies: ["body1", "body2", "body3"].map((id) => ({ id, name: id })),
    };
    const saved: string[] = [];
    ui.save = async (o) => {
      saved.push(o.defaultPath);
      return savePath;
    };
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend, ["body3", "body1", "body9"]);
    expect(asked.scope).toBe("selected");
    expect(asked.selected).toEqual(["body1", "body3"]);
    expect(sent).toEqual({ body: undefined, bodies: ["body1", "body3"], separate: undefined });
    expect(path).toBe(savePath);
    expect(saved[0]).toMatch(/^parts_\d{14}\.stl$/);
  });

  it("draws a sketch as DXF with its id and tolerance, and no body options", async () => {
    let asked: { flat?: { label: string }; format?: string } = {};
    ui.exportDialog = async (what) => {
      asked = what;
      return { settings: { ...DEFAULT_SETTINGS, format: what.format, tolerance: 5 }, scope: "all" };
    };
    let sent: Record<string, unknown> = {};
    let format = "";
    const { backend, store } = storeWith(async (_d, f, p, opts) => {
      format = f;
      sent = { ...opts };
      return { ok: true, path: p };
    });
    const saved: string[] = [];
    ui.save = async (o) => {
      saved.push(o.defaultPath);
      return "/tmp/plate.dxf";
    };
    const kept = new Map([["fundacad.exportSettings", JSON.stringify({ format: "3mf" })]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    });
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend, ["body1"], { sketch: "sk1", label: "Plate" }, "dxf");
    const { loadExportSettings } = await import("../../src/io/exportSettings");
    expect(loadExportSettings()).toMatchObject({ format: "3mf", tolerance: 1 });
    expect(asked).toMatchObject({ flat: { label: "Plate" }, format: "dxf" });
    expect(format).toBe("dxf");
    expect(sent).toMatchObject({ sketch: "sk1", tolerance: 1 });
    expect(sent.body).toBeUndefined();
    expect(sent.bodies).toBeUndefined();
    expect(sent.separate).toBeUndefined();
    expect(saved[0]).toMatch(/^Plate_\d{14}\.dxf$/);
  });

  it("draws a flat face as SVG with its selector and plane", async () => {
    ui.exportDialog = async () => ({ settings: { ...DEFAULT_SETTINGS, format: "svg" }, scope: "all" });
    let sent: Record<string, unknown> = {};
    const { backend, store } = storeWith(async (_d, _f, p, opts) => {
      sent = { ...opts };
      return { ok: true, path: p };
    });
    const selector = { body: "body1", kind: "face", index: 3 };
    const plane = { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] };
    const { exportModel } = await import("../../src/io/files");
    await exportModel(store, backend, [], { face: selector, plane: plane as never, label: "Box face" });
    expect(sent).toMatchObject({ face: selector, plane, tolerance: 0.01 });
    expect(sent.sketch).toBeUndefined();
  });

  it("takes the selected sketch first, else the selected flat face", async () => {
    const { backend } = storeWith(async () => ({ ok: true, path: "" }));
    const store = new DocumentStore(backend, {
      parameters: {},
      features: [
        { id: "sk1", type: "sketch", name: "Plate", entities: [], constraints: [] },
        { id: "sk2", type: "sketch", entities: [], constraints: [] },
        { id: "ex1", type: "extrude" },
      ] as never,
    });
    const selector = { body: "body1", index: 3 };
    const plane = { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] };
    const viewport = (face: boolean) => ({
      selectionBodyIds: () => [],
      selectedFaceSketchPlane: () => (face ? { plane: plane as never, faceId: 7, anchor: { selector } } : null),
    });
    const { flatSourceOf } = await import("../../src/io/files");
    expect(flatSourceOf(store, viewport(true), "sk1")).toEqual({ sketch: "sk1", label: "Plate" });
    expect(flatSourceOf(store, viewport(false), "sk2")).toEqual({ sketch: "sk2", label: "Sketch2" });
    expect(flatSourceOf(store, viewport(true), "ex1")).toMatchObject({ face: selector, plane });
    expect(flatSourceOf(store, viewport(false), "ex1")).toBeNull();
    expect(flatSourceOf(store, viewport(false), null)).toBeNull();
  });

  it("File, Export offers DXF and SVG for one picked sketch and not while several rows are picked", async () => {
    const { createPinia, setActivePinia } = await import("pinia");
    setActivePinia(createPinia());
    const { useSelectionStore } = await import("../../src/stores/selection");
    const { backend, store } = storeWith(async () => ({ ok: true, path: "" }));
    store.load(
      JSON.stringify({
        parameters: {},
        features: [
          { id: "sk1", type: "sketch", entities: [], constraints: [] },
          { id: "sk2", type: "sketch", entities: [], constraints: [] },
        ],
      }),
    );
    const asked: ExportAsk[] = [];
    ui.exportDialog = async (what) => void asked.push(what);
    const viewport = { selectionBodyIds: () => [], selectedFaceSketchPlane: () => null };
    const sel = useSelectionStore();
    const { exportSelection } = await import("../../src/io/files");
    sel.featureId = "sk2";
    sel.rows = { keys: ["sk2"], anchor: "sk2" };
    await exportSelection(store, backend, viewport);
    sel.rows = { keys: ["sk1", "sk2"], anchor: "sk1" };
    await exportSelection(store, backend, viewport);
    expect(asked.map((a) => a.flat?.label ?? null)).toEqual(["Sketch2", null]);
  });

  it("clears busy even when the backend throws", async () => {
    const { backend, store } = storeWith(async () => {
      throw new Error("socket died");
    });
    const { exportModel } = await import("../../src/io/files");
    await expect(exportModel(store, backend)).rejects.toThrow("socket died");
    expect(store.busyState.active).toBe(false);
  });
});

// --- import capability warning (Wave 1.5) ------------------------------------
//
// The counts are known at import time, before the viewport is built. Saying
// nothing means the user discovers a 3,000-body document as a freeze and
// concludes the app is broken. The thresholds are MEASURED post-Phase-A on real
// WebKitGTK, 60 fps at 1,000 bodies, 27-37 at 3,060, not guessed, so a test
// that pins them is pinning a measurement.
describe("describeImportCapability", () => {
  it("says nothing about a document that will be fine", () => {
    for (const n of [1, 7, 500, 999, 1000]) {
      expect(describeImportCapability(n)).toBeNull();
    }
  });

  it("warns gently just past the smooth limit", () => {
    const msg = describeImportCapability(1500);
    expect(msg).not.toBeNull();
    // toLocaleString(), not a hard-coded "1,500": the message groups the count
    // for whoever is reading it, so the separator is the RUNTIME's, and pinning
    // the en-US spelling fails on any machine with a different locale (de-DE
    // renders 1.500) while telling us nothing about the behaviour.
    expect(msg!).toContain((1500).toLocaleString());
    expect(msg!).toMatch(/still works/i); // reassures: not a refusal
    expect(msg!).not.toMatch(/27-37/); // the harsher figure is for later
  });

  it("is blunt about a document past the slow limit, and says what still works", () => {
    const msg = describeImportCapability(3060);
    expect(msg).not.toBeNull();
    expect(msg!).toContain((3060).toLocaleString());
    expect(msg!).toContain("27-37 fps"); // the measured number, not a vague "slow"
    // The user needs to know this is a VIEWPORT limit, not a broken import,
    // otherwise the natural conclusion is that the file failed to load.
    expect(msg!).toMatch(/export/i);
  });

  it("never warns on a nonsense count", () => {
    expect(describeImportCapability(NaN)).toBeNull();
    expect(describeImportCapability(0)).toBeNull();
    expect(describeImportCapability(-5)).toBeNull();
  });
});

describe("importedBodyCount", () => {
  it("counts assembly leaves", () => {
    expect(
      importedBodyCount({
        parts: [
          { node: 0, faces: 6 },
          { node: 1, faces: 8 },
        ],
      }),
    ).toBe(2);
  });

  it("treats a file with no tree as one body", () => {
    // A plain STL/STEP carries no `parts`, and it still produces a body, a
    // count of 0 here would silently disable the warning for single-body files
    // and, worse, misreport the document.
    expect(importedBodyCount({})).toBe(1);
  });
});

describe("extensions in any case", () => {
  it("every import extension maps the same in upper, lower and mixed case", () => {
    for (const ext of IMPORT_EXTS) {
      const want = extToImportFormat(`/tmp/a.${ext}`);
      expect(extToImportFormat(`/tmp/A.${ext.toUpperCase()}`)).toBe(want);
      expect(extToImportFormat(`/tmp/A.${ext[0]!.toUpperCase()}${ext.slice(1)}`)).toBe(want);
      expect(routeDroppedName(`/tmp/A.${ext.toUpperCase()}`)).toBe("import");
    }
    expect(extToImportFormat("C:\in\PART.STP")).toBe("step");
    expect(extToImportFormat("C:\in\Part.Stp.GZ")).toBe("step");
    expect(extToImportFormat("part.STEP.GZ")).toBe("step");
    expect(extToImportFormat("PART.FCSTD")).toBe("fcstd");
  });

  it("lists import extensions once, in lower case", () => {
    expect(IMPORT_EXTS.filter((e) => e !== e.toLowerCase())).toEqual([]);
  });

  it("offers dialogs every extension in lower and upper case, and FreeCAD's own spelling", () => {
    const exts = dialogExts(IMPORT_EXTS);
    for (const e of ["stp", "STP", "step", "STEP", "STL", "3DM", "IFC", "FCSTD", "FCStd", "fcstd"])
      expect(exts).toContain(e);
    expect(new Set(exts).size).toBe(exts.length);
  });

  it("the STEP export dialog offers .step and .stp in both cases and keeps .step as the default name", () => {
    const step = FORMATS.find((f) => f.value === "step")!;
    expect(step.ext).toBe("step");
    expect(dialogExts(step.exts)).toEqual(["step", "STEP", "stp", "STP"]);
    expect(step.label).toContain("*.stp");
    expect(extToFormat("C:\out\Bracket.STP")).toBe("step");
  });
});

describe("Open with a mesh or CAD file", () => {
  beforeEach(() => {
    ui.closeHome.mockReset();
    ui.reported = [];
    ui.picked = null;
    ui.onPick = () => {};
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  it("a file picked after its document was closed is not imported into the next one, a later pick is", async () => {
    for (const via of ["open", "import"] as const) {
      const imported: string[] = [];
      const backend = {
        async rebuild() {
          return { ok: false, error: { message: "stub" } };
        },
        async init() {},
        onStatus() {
          return () => {};
        },
        connected: true,
        async importGeometry(p: string) {
          imported.push(p);
          return { ok: false, cancelled: true };
        },
      } as unknown as GeometryBackend;
      const store = new DocumentStore(backend, { parameters: {}, features: [] });
      const { openDocument, importModel } = await import("../../src/io/files");
      const pick = () =>
        via === "open" ? openDocument(store, backend, async () => true) : importModel(store, backend);
      ui.picked = "/tmp/late.step";
      ui.onPick = () => store.newDocument();
      await pick();
      const during = [...imported];
      ui.picked = "/tmp/next.step";
      ui.onPick = () => {};
      await pick();
      expect({ via, during, after: imported, reported: ui.reported }).toEqual({
        via,
        during: [],
        after: ["/tmp/next.step"],
        reported: [],
      });
    }
  });

  it("closes Home, as the file goes into the open document", async () => {
    const imported: string[] = [];
    const backend = {
      async rebuild() {
        return { ok: false, error: { message: "stub" } };
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      connected: true,
      async importGeometry(p: string) {
        imported.push(p);
        return { ok: false, cancelled: true };
      },
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    const { openDocument } = await import("../../src/io/files");
    ui.picked = "/tmp/part.step";
    await openDocument(store, backend, async () => true);
    expect(ui.reported).toEqual([]);
    expect(imported).toEqual(["/tmp/part.step"]);
    expect(ui.closeHome).toHaveBeenCalledTimes(1);
  });
});
