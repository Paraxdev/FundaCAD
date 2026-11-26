// A sentence the app throws stays English in its message, for the log, the problem report and MCP, and reads in the
// chosen language where it is shown.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { HdrRefusal, decodeHdr } from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv, type EnvEntry } from "../../src/ui/environmentLibrary";
import { applySavedEnvironment, importEnvironmentBytes } from "../../src/ui/environmentImport";
import { measureError, readAs, refusalText } from "../../src/ui/measure";
import { plainEnglish, plainError } from "../../src/ui/plainError";
import { shownMessage, WordedError } from "../../src/ui/wordedError";
import { reasonLine } from "../../src/viewport/pathtrace/backend";
import { connectNative } from "../../src/viewport/pathtrace/nativeTracer";
import { WebGpuTracer } from "../../src/viewport/pathtrace/webgpuTracer";

afterEach(() => setLanguage("system"));

const rejection = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );
const radiance = (text: string) => new TextEncoder().encode(text);

describe("a refused panorama", () => {
  it("keeps the English message and is shown in German", async () => {
    const err = await rejection(decodeHdr(radiance("#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n"), "sky.hdr"));
    expect(err).toBeInstanceOf(HdrRefusal);
    expect((err as Error).message).toBe("sky.hdr is a Radiance file in 32-bit_rle_xyze, only RGBE is read.");
    expect(shownMessage(err)).toBe((err as Error).message);
    await setLanguage("de");
    expect((err as Error).message).toBe("sky.hdr is a Radiance file in 32-bit_rle_xyze, only RGBE is read.");
    expect(shownMessage(err)).toBe("sky.hdr ist eine Radiance-Datei im Format 32-bit_rle_xyze, gelesen wird nur RGBE.");
  });

  it("is refused in the chosen language when it is used", async () => {
    const lib = createEnvLibrary(memoryKv());
    expect(await importEnvironmentBytes(null, radiance("solid x"), "x.hdr", lib)).toBe(
      "x.hdr is not a Radiance HDR image.",
    );
    await setLanguage("de");
    expect(await importEnvironmentBytes(null, radiance("solid x"), "x.hdr", lib)).toBe(
      "x.hdr ist kein Radiance-HDR-Bild.",
    );
  });
});

describe("a saved environment", () => {
  it("asks for a name in the chosen language", async () => {
    const lib = createEnvLibrary(memoryKv());
    const err = await rejection(lib.save("   ", {} as EnvEntry["settings"], ""));
    expect(shownMessage(err)).toBe("A saved environment needs a name.");
    await setLanguage("de");
    expect(shownMessage(err)).toBe("Eine gespeicherte Umgebung braucht einen Namen.");
    expect((err as Error).message).toBe("A saved environment needs a name.");
  });

  it("says its panorama is gone in the chosen language", async () => {
    const lib = createEnvLibrary(memoryKv());
    const entry = { id: "a", name: "Dusk", settings: { environment: `hdr:${"f".repeat(16)}` } } as unknown as EnvEntry;
    const err = await rejection(applySavedEnvironment(null, entry, lib));
    expect(err).toBeInstanceOf(WordedError);
    expect((err as Error).message).toBe(t("render.savedGone", { name: "Dusk" }));
    await setLanguage("de");
    expect(shownMessage(err)).toBe("Das Panorama, mit dem Dusk beleuchtet, ist nicht mehr in der Bibliothek.");
  });
});

describe("a value box", () => {
  it("words its own refusals in English as before", () => {
    expect(measureError("1 5", null)).toBe('put an operator between "1" and "5"');
    expect(measureError("1 500", null)).toBe('write "1500" without the space, a space does not group digits');
    expect(measureError('"', null)).toBe('""" needs a number in front of it');
    expect(measureError("w", null, { w: Infinity })).toBe("that works out to nothing finite");
    expect(() => readAs("length")("5 deg")).toThrow("This takes a length, not °");
  });

  it("words them in German", async () => {
    await setLanguage("de");
    expect(measureError("1 5", null)).toBe("Setzen Sie einen Operator zwischen „1“ und „5“");
    expect(measureError("1 500", null)).toBe(
      "Schreiben Sie „1500“ ohne Leerzeichen, ein Leerzeichen gruppiert keine Ziffern",
    );
    expect(measureError("w", null, { w: Infinity })).toBe("das ergibt keinen endlichen Wert");
    let err: unknown = null;
    try {
      readAs(null)("5 mm");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe("This takes a plain number, not mm");
    expect(refusalText(err as Error)).toBe("Hier ist eine reine Zahl gefragt, nicht mm");
  });
});

describe("a path tracing fault", () => {
  it("keeps the reason English for the report and shows it in German", async () => {
    const call = async () => ({ id: 1, kind: "websocket", generation: 1, port: null, token: null, source: "gpu" });
    const err = await rejection(connectNative(8, 8, "websocket", call));
    expect((err as Error).message).toBe("the app opened no frame transport");
    await setLanguage("de");
    const line = reasonLine("render.trace.couldNotStart", err);
    expect(line.english).toBe("Path tracing could not start: the app opened no frame transport");
    expect(line.shown).toBe("Die Pfadverfolgung konnte nicht starten: die App hat keinen Bildtransport geöffnet");
    const both = reasonLine("render.trace.couldNotStart", new WordedError("render.trace.bothFaulted"));
    expect(both.shown).toBe(
      "Die Pfadverfolgung konnte nicht starten: beide Verfolger sind in dieser Sitzung ausgefallen",
    );
    expect(reasonLine("render.trace.nativeStopped", "GPU hung").shown).toBe(
      t("render.trace.nativeStopped", { reason: "GPU hung" }),
    );
  });

  it("names a picture taken before the tracer runs in the chosen language", async () => {
    const err = await rejection(new WebGpuTracer().picture({ width: 1, height: 1, samples: 1 }));
    expect(plainError(err, "")).toBe("Path tracing is not running");
    await setLanguage("de");
    expect(plainError(err, "")).toBe("Die Pfadverfolgung läuft nicht");
    expect(plainEnglish(err, "")).toBe("Path tracing is not running");
  });
});
