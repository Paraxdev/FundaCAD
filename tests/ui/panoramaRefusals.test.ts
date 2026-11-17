// The desktop app refuses a dropped panorama in English, from panorama_read.rs and the doc_paths.rs checks it runs.
// Every sentence those refusals are built from is read from the Rust source, so a new or reworded one with no key
// fails here, not as an English sentence in a German panel.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { PANORAMA_PASSED_ON, PANORAMA_REFUSALS, panoramaRefusalText } from "../../src/ui/panoramaRefusals";
import panoramaReadRs from "../../src-tauri/src/panorama_read.rs?raw";
import docPathsRs from "../../src-tauri/src/doc_paths.rs?raw";

afterEach(() => setLanguage("system"));

const rust = (source: string) => source.replace(/\r\n/g, "\n");

/** `pub fn name` up to the brace that closes it at its own indent. */
function fnBody(source: string, name: string): string {
  const src = rust(source);
  const m = new RegExp(`\\n( *)pub (?:async )?fn ${name}\\(`).exec(src);
  if (!m) throw new Error(`no fn ${name}`);
  const end = src.indexOf(`\n${m[1]}}\n`, m.index + 1);
  return src.slice(m.index, end);
}

/** The format strings a refusal is built from. */
const worded = (code: string): string[] =>
  [...code.matchAll(/(?:format!\(|Err\()\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);

const readPanorama = fnBody(panoramaReadRs, "read_panorama");
const vouched = fnBody(docPathsRs, "check_read_vouched");
const checkRead = fnBody(docPathsRs, "check_read");
const requireFile = fnBody(docPathsRs, "require_file");

describe("the Rust source", () => {
  it("still reaches only the checks this map reads", () => {
    expect(readPanorama).toContain("held.check_read_vouched(raw)?");
    expect(vouched).toContain("self.check_read(raw)");
    expect(checkRead).toContain("require_file(raw)");
  });

  it("words no refusal this map has no key for, and still words every one it has", () => {
    const sent = new Set([
      ...worded(rust(panoramaReadRs)),
      ...worded(vouched),
      ...worded(checkRead),
      ...worded(requireFile),
    ]);
    const known = new Set([...PANORAMA_REFUSALS.map((f) => f.rust), ...PANORAMA_PASSED_ON]);
    expect([...sent].sort()).toEqual([...known].sort());
  });
});

const sent = (form: string, path: string, mb = 512) => form.replace("{raw}", path).replace("{}", String(mb));

describe("panoramaRefusalText", () => {
  it("reads every refusal back word for word in English", () => {
    for (const { rust: form } of PANORAMA_REFUSALS) {
      const line = sent(form, "C:\\in\\sky 2.hdr");
      expect(panoramaRefusalText(line)).toBe(line);
    }
  });

  it("words each refusal in German with the path and the size carried over", async () => {
    await setLanguage("de");
    const too = PANORAMA_REFUSALS.find((f) => f.key === "render.hdr.fileTooLarge")!;
    expect(panoramaRefusalText(sent(too.rust, "/in/sky.hdr"))).toBe(
      "/in/sky.hdr ist größer als 512 MB und damit zu groß für eine Umgebung.",
    );
    for (const { rust: form, key } of PANORAMA_REFUSALS) {
      const shown = panoramaRefusalText(sent(form, "/in/sky.hdr"));
      expect(shown, key).toBe(t(key, { path: "/in/sky.hdr", mb: 512 }));
      expect(shown, key).not.toBe(sent(form, "/in/sky.hdr"));
    }
  });

  it("passes an OS error on as the app wrote it", async () => {
    await setLanguage("de");
    expect(panoramaRefusalText("/in/sky.hdr: Access is denied. (os error 5)")).toBe(
      "/in/sky.hdr: Access is denied. (os error 5)",
    );
  });
});
