// A problem the app returns as an English line, rather than throws, stays English for MCP, the log and the problem
// report, and reads in the chosen language where it is shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../src/i18n";
import { exprProblem } from "../../src/document/numFields";
import { Geometry } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";
import { classifyExprInput, deleteBlockers, recompute, validateExpr, validateName } from "../../src/params/engine";
import { candidateFrom } from "../../src/plugins/index";
import { parseManifest } from "../../src/plugins/manifest";
import { SketchMode } from "../../src/sketch/sketchMode";
import type { CadDocument, ParamDef } from "../../src/types";
import { plainError } from "../../src/ui/plainError";
import { WordedError, shownMessage } from "../../src/ui/wordedError";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

afterEach(async () => {
  await setLanguage("system");
});

const docOf = (defs: Record<string, ParamDef>): CadDocument =>
  ({
    parameters: Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, d.value])),
    paramDefs: defs,
    features: [],
  }) as unknown as CadDocument;

/** How `line` reads where it is shown, in English and in German. */
async function shown(line: string): Promise<[string | null, string | null]> {
  const english = exprProblem(line);
  await setLanguage("de");
  const german = exprProblem(line);
  await setLanguage("system");
  return [english, german];
}

describe("the parameter engine's refusals", () => {
  const doc = docOf({
    a: { expr: "10", value: 10, unit: "mm" },
    b: { expr: "a * 2", value: 20, unit: "mm" },
  });

  it.each([
    [null, "a + missing", undefined, 'unknown parameter "missing"', "„missing“ ist keine Zahl und kein Parameter"],
    ["a", "a + 1", undefined, '"a" cannot reference itself', "„a“ kann nicht auf sich selbst verweisen"],
    ["a", "b / 2", undefined, "circular reference: a → b → a", "Zirkelbezug: a → b → a"],
    [
      null,
      "3 mm",
      "count",
      "this field is unitless, write a plain number",
      "dieses Feld hat keine Einheit, schreiben Sie eine reine Zahl",
    ],
    [null, "a / 0", undefined, "does not evaluate to a finite number", "ergibt keine endliche Zahl"],
  ] as const)("%s = %s stays English and reads in German", async (name, expr, kind, english, german) => {
    const v = validateExpr(doc, name, expr, kind);
    expect(v).toEqual({ ok: false, error: english });
    expect(await shown(english)).toEqual([english, german]);
  });

  it("words the issues of a table it cannot evaluate", async () => {
    const { issues } = recompute(
      docOf({
        p: { expr: "q + 1", value: 1, unit: "mm" },
        q: { expr: "p + 1", value: 1, unit: "mm" },
        r: { expr: "1 / 0", value: 1, unit: "mm" },
        s: { expr: "2 +", value: 1, unit: "mm" },
      }),
    );
    expect([issues.p, issues.q, issues.r, issues.s]).toEqual([
      "circular reference",
      "circular reference",
      "does not evaluate to a finite number",
      "invalid expression",
    ]);
    expect(await shown("circular reference")).toEqual(["circular reference", "Zirkelbezug"]);
    expect(await shown("invalid expression")).toEqual(["invalid expression", "ungültiger Ausdruck"]);
    expect(await shown("its dimension or feature no longer exists")).toEqual([
      "its dimension or feature no longer exists",
      "die zugehörige Bemaßung oder der zugehörige Schritt existiert nicht mehr",
    ]);
  });

  it.each([
    [
      "1a",
      "names are letters, digits and _ (not starting with a digit)",
      "Namen bestehen aus Buchstaben, Ziffern und _ und beginnen nicht mit einer Ziffer",
    ],
    ["sin", '"sin" is a reserved name', "„sin“ ist ein reservierter Name"],
    ["constructor", '"constructor" is a reserved name', "„constructor“ ist ein reservierter Name"],
    ["a", '"a" already exists', "„a“ gibt es bereits"],
    ["d3", "dN names are reserved for model parameters", "Namen der Form dN sind für Modellparameter reserviert"],
  ])("refuses the name %s in English and reads it in German", async (name, english, german) => {
    expect(validateName(doc.paramDefs!, name)).toBe(english);
    expect(await shown(english)).toEqual([english, german]);
  });

  it("refuses a new name typed into a value box as the name check does", () => {
    expect(classifyExprInput(doc, "a = 5", "length", null)).toEqual({ ok: false, error: '"a" already exists' });
  });

  it("names what holds a parameter it will not delete, in English and in German", async () => {
    const english = '"a" is referenced by: b';
    expect(deleteBlockers(doc, "a")).toBe(english);
    expect(await shown(english)).toEqual([english, "„a“ wird verwendet von: b"]);
  });
});

describe("the sketch dimension editor's refusals", () => {
  const doc = docOf({ width: { expr: "40", value: 40, unit: "mm" } });

  function evalDim(raw: string, withStore: boolean) {
    const mode = Object.create(SketchMode.prototype) as {
      evalDimInput(raw: string, kind: "length", key: string | null): unknown;
    };
    Object.assign(mode, {
      pendingBindings: new Map(),
      store: withStore
        ? {
            classifyTargetExpr: (b: string | null, p: string | null, r: string, k: "length") =>
              classifyExprInput(doc, r, k, b, p),
          }
        : null,
    });
    return mode.evalDimInput(raw, "length", null);
  }

  it.each([
    ["-5", true, "invalid value", "ungültiger Wert"],
    ["width - 50", true, "must evaluate to a positive value", "muss einen positiven Wert ergeben"],
    ["width / 2", false, "no document", "kein Dokument"],
    [
      "d7 = 12",
      true,
      "dN names are reserved for model parameters",
      "Namen der Form dN sind für Modellparameter reserviert",
    ],
  ] as const)("%s stays English for the console and reads in German on screen", async (raw, store, english, german) => {
    await setLanguage("de");
    expect(evalDim(raw, store)).toEqual({ error: english });
    expect(plainError(english, "")).toBe(german);
    await setLanguage("system");
    expect(await shown(english)).toEqual([english, german]);
  });
});

describe("a plugin manifest the app cannot install", () => {
  const base = { id: "A.Widgets", name: "Widgets", version: "1.0.0", kind: "compute", grants: [] as string[] };
  const raw = (manifest: unknown) => ({
    manifest,
    sha256: "a".repeat(64),
    source: "https://example.com/w.zip",
    official: false,
  });

  it.each([
    [null, "not an object", "kein Objekt"],
    [{ ...base, id: 7 }, "not a plugin id: 7", "keine Plug-in-ID: 7"],
    [{ ...base, kind: undefined }, "not a plugin kind: undefined", "keine Plug-in-Art: undefined"],
    [{ ...base, grants: "all" }, "grants must be a list", "grants muss eine Liste sein"],
    [
      { ...base, grants: ["network"] },
      "network was asked for without naming any hosts",
      "die Berechtigung network wurde ohne Hosts angefragt",
    ],
    [{ ...base, featureTypes: ["a", "a"] }, 'featureTypes repeats "a"', 'featureTypes wiederholt "a"'],
  ])("%# keeps its reason English and words it in German", async (manifest, english, german) => {
    const parsed = parseManifest(manifest);
    expect(parsed.ok === false && parsed.why).toBe(english);
    let err: unknown;
    try {
      candidateFrom(raw(manifest) as never, "url");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WordedError);
    expect([(err as Error).message, shownMessage(err)]).toEqual([
      `That bundle is not installable: ${english}`,
      `That bundle is not installable: ${english}`,
    ]);
    await setLanguage("de");
    expect((err as Error).message).toBe(`That bundle is not installable: ${english}`);
    expect(plainError(err, "")).toBe(`Dieses Paket lässt sich nicht installieren: ${german}`);
  });
});

describe("bytes the engine refuses", () => {
  async function refused(error: unknown): Promise<unknown> {
    vi.stubGlobal("window", globalThis);
    let sink!: TransportSink;
    const sent: { id: string }[] = [];
    const g = new Geometry({
      open: true,
      async start(s: TransportSink) {
        sink = s;
      },
      send(raw: string) {
        sent.push(JSON.parse(raw) as { id: string });
      },
    });
    void g.init();
    const put = g.blobPut(new Uint8Array([1, 2, 3])).catch((e: unknown) => e);
    for (let i = 0; i < 20 && !sent.length; i++) await new Promise((r) => setTimeout(r, 0));
    for (const m of sent) sink.message(JSON.stringify({ id: m.id, ok: false, error }));
    const err = await put;
    vi.unstubAllGlobals();
    return err;
  }

  it("keeps the engine's own reason as sent, and its own fallback English in the message and German on screen", async () => {
    const own = await refused({ message: "hash mismatch" });
    expect(own).not.toBeInstanceOf(WordedError);
    expect((own as Error).message).toBe("hash mismatch");
    const err = await refused({});
    expect(err).toBeInstanceOf(WordedError);
    expect((err as Error).message).toBe("the engine refused the bytes");
    await setLanguage("de");
    expect((err as Error).message).toBe("the engine refused the bytes");
    expect([shownMessage(err), shownMessage(own)]).toEqual(["die Engine hat die Daten abgelehnt", "hash mismatch"]);
  });
});
