// The plugin messages a maker sees read in the chosen language: what a plugin can and cannot do, the sandbox note, the
// update line, the missing plugin warning and the retired plugin note, and they follow a live switch.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { missingPluginMessage } from "../../src/document/missingPlugins";
import { officialPlugins, originOf, RETIRED_PLUGINS, type InstalledPlugin } from "../../src/plugins";
import { describeGrants, parseManifest, sandboxNote, type PluginManifest } from "../../src/plugins/manifest";
import { updateFor } from "../../src/plugins/updates";

afterEach(() => setLanguage("system"));

function manifest(over: Record<string, unknown> = {}): PluginManifest {
  const parsed = parseManifest({
    id: "Test.Plugin",
    name: "Test",
    version: "1.0.0",
    kind: "panel",
    summary: "",
    grants: ["document.read", "network", "files.read"],
    hosts: ["example.com", "cdn.example.com"],
    geometryWasm: "",
    ...over,
  });
  if (!parsed.ok) throw new Error(parsed.why);
  return parsed.manifest;
}

describe("what a plugin asked for", () => {
  it("reads in English by default, with the hosts named", () => {
    const { can, cannot } = describeGrants(manifest());
    expect(can).toEqual([
      "Read the document you have open",
      "Read files you pick for it",
      "Connect to example.com, cdn.example.com",
    ]);
    expect(cannot).toContain("Change your document");
  });

  it("reads German, then Japanese, and follows a switch on the same call", async () => {
    const m = manifest();
    const en = describeGrants(m);
    await setLanguage("de");
    const de = describeGrants(m);
    expect(de.can).toContain("Das geöffnete Dokument lesen");
    expect(de.can).toContain("Sich mit example.com, cdn.example.com verbinden");
    expect(de.cannot).toContain("Ihr Dokument ändern");
    await setLanguage("ja");
    const ja = describeGrants(m);
    expect(ja.can).toContain("開いているドキュメントを読み取る");
    expect(ja.can).toContain("example.com, cdn.example.com に接続する");
    expect(ja.can).not.toEqual(de.can);
    expect(de.can).not.toEqual(en.can);
  });

  it("says a geometry component reads any file in the chosen language", async () => {
    const m = manifest({ grants: ["files.read"], hosts: [], geometryWasm: "g.wasm", kind: "compute" });
    expect(describeGrants(m).can).toEqual(["Read any file you can open on this computer"]);
    await setLanguage("de");
    expect(describeGrants(m).can).toEqual(["Jede Datei lesen, die Sie auf diesem Computer öffnen können"]);
  });

  it("words the sandbox note for each kind in German and Japanese", async () => {
    const kinds = ["builtin", "process", "panel", "compute"] as const;
    const english = kinds.map((kind) => sandboxNote({ kind, grants: [], geometryWasm: "" }));
    expect(english[0]).toMatch(/^Part of FundaCAD itself/);
    for (const code of ["de", "ja"]) {
      await setLanguage(code);
      const notes = kinds.map((kind) => sandboxNote({ kind, grants: [], geometryWasm: "" }));
      expect(new Set(notes).size).toBe(4);
      for (const [i, note] of notes.entries()) expect(note).not.toBe(english[i]);
    }
    await setLanguage("de");
    const files = sandboxNote({ kind: "compute", grants: ["files.read"], geometryWasm: "g.wasm" });
    expect(files).toContain("isolierte Berechnung");
  });
});

describe("the update line", () => {
  const offer = officialPlugins().find((p) => p.manifest.id === "FundaCAD.Screws")!;
  const rec = (over: Partial<InstalledPlugin>): InstalledPlugin => ({
    id: offer.manifest.id,
    version: offer.manifest.version,
    promise: "",
    source: offer.url,
    sha256: "",
    installedAt: 0,
    dir: "",
    consented: { kind: offer.manifest.kind, version: "0", grants: [...offer.manifest.grants], hosts: [] },
    official: true,
    component: true,
    ...over,
  });

  it("names the version in German", async () => {
    expect(updateFor(rec({ version: "0.0.1" }), [offer])?.reason).toBe(
      `Version ${offer.manifest.version} is available.`,
    );
    await setLanguage("de");
    expect(updateFor(rec({ version: "0.0.1" }), [offer])?.reason).toBe(
      `Version ${offer.manifest.version} ist verfügbar.`,
    );
    await setLanguage("ja");
    expect(updateFor(rec({ version: "0.0.1" }), [offer])?.reason).toContain(offer.manifest.version);
    expect(updateFor(rec({ version: "0.0.1" }), [offer])?.reason).toContain("利用できます");
  });
});

describe("the missing plugin warning", () => {
  const base = { id: "Some.Plugin", name: "Surface Texture", types: ["texture"] };

  it("counts one or many in each language and says what to do", async () => {
    const one = { ...base, installable: true, count: 1 };
    const many = { ...base, installable: false, count: 4 };
    expect(missingPluginMessage(one)).toContain("One feature in this document is");
    expect(missingPluginMessage(many)).toContain("4 features in this document are");
    await setLanguage("de");
    expect(missingPluginMessage(one)).toContain("Ein Feature in diesem Dokument wird von „Surface Texture“ erstellt");
    expect(missingPluginMessage(one)).toContain("wieder ein");
    expect(missingPluginMessage(many)).toContain("4 Features in diesem Dokument werden");
    expect(missingPluginMessage(many)).toContain("Installieren Sie „Surface Texture“");
    await setLanguage("ja");
    expect(missingPluginMessage(many)).toContain("4 個のフィーチャ");
    expect(missingPluginMessage(many)).toContain("「Surface Texture」をインストール");
    await setLanguage("fr");
    expect(missingPluginMessage(one)).toContain("Une fonction de ce document est construite");
    expect(missingPluginMessage(many)).toContain("4 fonctions de ce document sont construites");
  });
});

describe("the other plugin lines", () => {
  it("name the origin of a bundle from a file, and the retired note, in German", async () => {
    expect(originOf("/x/y.zip", "file")).toBe("a file on this computer");
    expect(RETIRED_PLUGINS[0]!.note).toMatch(/^The MCP server is part of FundaCAD now/);
    await setLanguage("de");
    expect(originOf("/x/y.zip", "file")).toBe("einer Datei auf diesem Computer");
    expect(originOf("not a url", "url")).toBe("einem unbekannten Ort");
    expect(RETIRED_PLUGINS[0]!.note).toContain("KI-Assistenten");
    expect(RETIRED_PLUGINS.map((r) => r.id)).toEqual(["FundaCAD.MCP"]);
  });
});
