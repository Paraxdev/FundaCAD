// A sentence the app throws stays English in its message, for the log, the problem report and MCP, and reads in the
// chosen language where it is shown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../src/i18n";
import { UnreadableDocumentError } from "../../src/document/documentShape";
import { exprProblem } from "../../src/document/numFields";
import { DocumentStore } from "../../src/document/store";
import { createBranch, emptyRepo, snapshotOf, switchBranch } from "../../src/document/versions";
import { Geometry, type GeometryBackend } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";
import { evalExpr } from "../../src/params/eval";
import { ExprRefusal, parseExpr } from "../../src/params/parse";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { candidateFrom } from "../../src/plugins/index";
import { evaluatePlugin } from "../../src/plugins/loader";
import { definePluginSettings } from "../../src/plugins/settings";
import { measureError } from "../../src/ui/measure";
import { plainError } from "../../src/ui/plainError";
import { WordedError, shownMessage } from "../../src/ui/wordedError";
import { reasonLine, TracerRefused } from "../../src/viewport/pathtrace/backend";
import { selfCheckArgs, selfCheckReason } from "../../src/viewport/pathtrace/selfCheck";

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
};

describe("an expression the engine refuses", () => {
  const cases: [string, string, string][] = [
    ["", "empty expression", "leerer Ausdruck"],
    ["2 +", "unexpected end of expression", "unerwartetes Ende des Ausdrucks"],
    [
      "max(1, 2)",
      'unexpected character ",", separate arguments with ";"',
      "unerwartetes Zeichen „,“, trennen Sie Argumente mit „;“",
    ],
    ["2 $ 3", 'unexpected character "$"', "unerwartetes Zeichen „$“"],
    [
      "1 < 2 < 3",
      "comparisons do not chain, join them with &&",
      "Vergleiche lassen sich nicht verketten, verbinden Sie sie mit &&",
    ],
    ["max(1; 2", 'missing ")" in max(…)', "„)“ fehlt in max(…)"],
    ["a.b", "qualified names ('.') are not supported", "qualifizierte Namen („.“) werden nicht unterstützt"],
    ["2 3", 'unexpected "3"', "unerwartetes „3“"],
    ["nope(1)", 'unknown function "nope"', "unbekannte Funktion „nope“"],
    ["sqrt(1; 2)", "sqrt() takes 1 argument", "sqrt() nimmt 1 Argument"],
    ["max(1)", "max() takes at least 2 arguments", "max() nimmt mindestens 2 Argumente"],
    ["width * 2", 'unknown parameter "width"', "„width“ ist keine Zahl und kein Parameter"],
  ];

  it.each(cases)("%j keeps its English message and is shown in German", async (src, english, german) => {
    const err = thrown(() => evalExpr(src, {}));
    expect(err).toBeInstanceOf(ExprRefusal);
    expect((err as Error).message).toBe(english);
    expect(exprProblem(english)).toBe(english);
    await setLanguage("de");
    expect((err as Error).message).toBe(english);
    expect(exprProblem(english)).toBe(german);
    expect(plainError(err, "")).toBe(german);
  });

  it("words the length limit with its number, and a value box's refusal", async () => {
    const err = thrown(() => parseExpr("1+".repeat(600) + "1"));
    expect((err as Error).message).toBe("expression is longer than 1024 characters");
    expect(measureError("2 +", null)).toBe("unexpected end of expression");
    await setLanguage("de");
    expect(exprProblem((err as Error).message)).toBe("der Ausdruck ist länger als 1024 Zeichen");
    expect(measureError("2 +", null)).toBe("unerwartetes Ende des Ausdrucks");
    expect(shownMessage(new Error("circular reference: a → b"))).toBe("circular reference: a → b");
  });
});

/** What `fn` threw, its message, and how it reads where it is shown in English and in German. */
async function both(fn: () => unknown): Promise<[unknown, string, string, string]> {
  const err = thrown(fn);
  const english = shownMessage(err);
  await setLanguage("de");
  const german = shownMessage(err);
  await setLanguage("system");
  return [err, (err as Error).message, english, german];
}

describe("a refusal from the version history", () => {
  it.each([
    [() => switchBranch(emptyRepo(), "lean"), "no branch called lean", "kein Zweig namens lean"],
    [() => createBranch(emptyRepo(), " ", "v1"), "a branch needs a name", "ein Zweig braucht einen Namen"],
    [() => snapshotOf(emptyRepo(), "v9"), "no version v9", "keine Version v9"],
  ])("%# keeps English in its message and is shown in German", async (fn, english, german) => {
    const [err, message, shownEn, shownDe] = await both(fn);
    expect(err).toBeInstanceOf(WordedError);
    expect([message, shownEn, shownDe]).toEqual([english, english, german]);
    await setLanguage("de");
    expect(plainError(err, "")).toBe(german);
  });
});

describe("a document the store will not take", () => {
  const backend = {
    async rebuild() {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  const store = () => new DocumentStore(backend, { parameters: {}, features: [] });

  it("words a garbled file's reason where it is read, and asks for a saved version in German", async () => {
    const garbled = thrown(() => store().load("{ nope"));
    expect(garbled).toBeInstanceOf(UnreadableDocumentError);
    expect((garbled as UnreadableDocumentError).reason).toBe("its contents are garbled or cut short");
    const [, message, , german] = await both(() => store().branchFromVersion("v1", "alt"));
    expect([message, german]).toEqual(["save a version first", "speichern Sie zuerst eine Version"]);
    await setLanguage("de");
    expect((garbled as UnreadableDocumentError).reason).toBe("der Inhalt ist verstümmelt oder abgeschnitten");
  });
});

describe("a plugin the app refuses", () => {
  const settings = { version: 1, props: [{ key: "speed", type: "number", label: "Speed", default: 2 }] } as never;

  it.each([
    [
      () => contribute("A.One", { menus: [{ menu: "Edit", items: [{ label: " " }] }] }),
      "A.One gives a row of the Edit menu an empty label, a screen reader could not name it",
      "A.One gibt einer Zeile des Menüs Edit eine leere Beschriftung, ein Bildschirmleser könnte es nicht benennen",
    ],
    [
      () => definePluginSettings("A.X", settings).set("nope", 1),
      'A.X has no setting "nope"',
      "A.X hat keine Einstellung „nope“",
    ],
    [
      () => evaluatePlugin("A.Y", "var x = 1;", {} as never),
      "A.Y: its code defined no __fundacadPlugin. It was probably not built by scripts/build-plugin-code.mjs.",
      "A.Y: der Code definiert kein __fundacadPlugin. Er wurde wohl nicht mit scripts/build-plugin-code.mjs erstellt.",
    ],
  ])("%# keeps English in its message and is shown in German", async (fn, english, german) => {
    const [err, message, shownEn, shownDe] = await both(fn);
    expect(err).toBeInstanceOf(WordedError);
    expect([message, shownEn, shownDe]).toEqual([english, english, german]);
  });

  it("names a remap without its grant, code that throws, and a bundle it cannot install", async () => {
    const [, remap, , remapDe] = await both(() => contribute("Test.Plain", { keymap: [] }));
    expect(remap).toMatch(/^Test\.Plain contributes .* without the input\.remap grant$/);
    expect(remapDe).toMatch(/^Test\.Plain liefert .* ohne die Berechtigung input\.remap$/);
    const [, threw, , threwDe] = await both(() => evaluatePlugin("A.Z", 'throw new Error("boom");', {} as never));
    expect([threw, threwDe]).toEqual([
      "A.Z: its code threw while loading: boom",
      "A.Z: der Code hat beim Laden einen Fehler ausgelöst: boom",
    ]);
    const raw = { manifest: null, sha256: "a".repeat(64), source: "https://example.com/w.zip", official: false };
    const [, bundle, , bundleDe] = await both(() => candidateFrom(raw as never, "url"));
    expect(bundle).toMatch(/^That bundle is not installable: /);
    expect(bundleDe).toMatch(/^Dieses Paket lässt sich nicht installieren: /);
  });
});

describe("the engine and the path tracer", () => {
  it("keeps a blob the engine did not store English in its message and German on screen", async () => {
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
    for (const m of sent) sink.message(JSON.stringify({ id: m.id, ok: true, result: { stored: false } }));
    const err = await put;
    vi.unstubAllGlobals();
    expect(err).toBeInstanceOf(WordedError);
    expect((err as Error).message).toBe("the engine did not store the bytes");
    await setLanguage("de");
    expect(plainError(err, "")).toBe("die Engine hat die Daten nicht gespeichert");
  });

  it("keeps a failed self check English for the report and shows it in German", async () => {
    const answer = { diff: 9, threshold: 4, noise: 0, ms: 10, path: "dx12", passed: false };
    const english = "the native tracer drew its test scene wrong on dx12 (diff 9.00 over 4.00 of 255)";
    const refused = new TracerRefused("render.trace.selfCheckWrong", selfCheckArgs(answer));
    expect([selfCheckReason(answer), refused.message]).toEqual([english, english]);
    await setLanguage("de");
    expect(selfCheckReason(answer)).toBe(english);
    expect(reasonLine("render.trace.couldNotStart", refused)).toEqual({
      shown:
        "Die Pfadverfolgung konnte nicht starten: der native Tracer hat seine Testszene auf dx12 falsch gezeichnet (Abweichung 9.00 über 4.00 von 255)",
      english: `Path tracing could not start: ${english}`,
    });
  });
});
