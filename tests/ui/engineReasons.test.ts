// The engine words why a body has no inside after the body's name (crates/fundacad-geom/src/soundness.rs), and the
// app words why the denoiser fell back (src-tauri). The fixed pieces each form is built from are read from the Rust
// source, so a reworded line fails here, not as an English sentence in a German panel.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { bodyReason, knownBodyReason } from "../../src/ui/engineReasons";
import { describeDenoiser } from "../../src/viewport/pathtrace/denoiser";
import soundnessRs from "../../crates/fundacad-geom/src/soundness.rs?raw";
import framesDenoiserRs from "../../src-tauri/src/frames/denoiser.rs?raw";
import oidnRs from "../../src-tauri/tracer/src/oidn.rs?raw";

afterEach(() => setLanguage("system"));

const rust = (source: string) => source.replace(/\r\n/g, "\n");

const SURFACE = "is a surface, not a solid, so it has no inside";
const OPEN = "is not a closed solid, # {} only one face, so it has no inside";
const CROWDED = "is not one clean solid, # {shared} shared by more than two faces, so it has no single inside";
const FLIPPED = "has faces that point the wrong way, at # the two faces disagree about which side is inside";
const INSIDE_OUT = "is inside out, its faces point into the material";
const STUCK = ", and it could not be turned over";

// The Rust soundness.rs fault() and material() put together from those pieces.
const PIECES: Record<string, string> = {
  surface: `"${SURFACE}"`,
  open: `"${OPEN}", pick(n, "bounds", "bound")`,
  crowded: `"${CROWDED}"`,
  crowdedWord: `let shared = pick(n, "is", "are");`,
  flipped: `"${FLIPPED}"`,
  count: `why.replace('#', &format!("{n} of its edges"))`,
  pick: `fn pick<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {\n    if n == 1 {\n        one\n    } else {\n        many`,
  insideOut: `pub const INSIDE_OUT: &str = "${INSIDE_OUT}";`,
  stuck: `format!("{INSIDE_OUT}${STUCK}")`,
};

const counted = (form: string, word: string, n: number) =>
  form.replace(/\{\w*\}/, word).replace("#", `${n} of its edges`);

const ENGINE = {
  surface: SURFACE,
  openOne: counted(OPEN, "bounds", 1),
  open: counted(OPEN, "bound", 12),
  crowdedOne: counted(CROWDED, "is", 1),
  crowded: counted(CROWDED, "are", 4),
  flipped: counted(FLIPPED, "", 3),
  insideOutStuck: INSIDE_OUT + STUCK,
  insideOut: INSIDE_OUT,
};

const MAC = "the high quality denoise is not offered on macOS yet, the edge aware filter cleans the picture";
const OFFLINE = "the download failed, the edge aware filter stays ({e})";

describe("the Rust source", () => {
  it.each(Object.entries(PIECES))("still words the body reason piece %s that way", (_name, piece) => {
    expect(rust(soundnessRs)).toContain(piece);
  });

  it("still words the denoiser notes the panel reads back that way", () => {
    expect(rust(oidnRs)).toContain(`"${MAC}".into()`);
    expect(rust(framesDenoiserRs)).toContain(`format!("${OFFLINE}")`);
  });
});

describe("the denoiser notes", () => {
  const filter = { active: "filter" as const, version: "", offered: true, bytes: 40_000_000 };
  const note = (s: string) => describeDenoiser({ info: { ...filter, note: s }, downloading: false, error: "" });
  const failed = (s: string) => describeDenoiser({ info: { ...filter, note: null }, downloading: false, error: s });

  it("read in German as the app words them", async () => {
    await setLanguage("de");
    expect(note(MAC)).toBe(t("render.denoiser.filterWhy", { why: t("render.denoiser.notOnMac") }));
    expect(failed(OFFLINE.replace("{e}", "timed out"))).toBe(
      t("render.denoiser.filterWhy", { why: t("render.denoiser.offline", { detail: "timed out" }) }),
    );
    expect(note(MAC)).not.toContain("macOS yet");
  });
});

describe("engine reasons", () => {
  it("read back word for word in English for every form the engine sends", () => {
    for (const reason of Object.values(ENGINE)) {
      expect(knownBodyReason("Rod", reason)).toBe(`Rod ${reason}`);
    }
  });

  it("put an unknown reason after the name as the engine wrote it", () => {
    expect(knownBodyReason("Rod", "open shell")).toBeNull();
    expect(bodyReason("Rod", "open shell")).toBe("Rod open shell");
    expect(bodyReason("Rod", "is a surface, not a solid, so it has no inside yet")).toBe(
      "Rod is a surface, not a solid, so it has no inside yet",
    );
  });

  it("read as whole German and Japanese sentences with the count carried over", async () => {
    await setLanguage("de");
    expect(bodyReason("Stab", ENGINE.surface)).toBe(
      "Stab ist ein Flächenkörper, kein Volumenkörper, und hat daher kein Inneres",
    );
    expect(bodyReason("Stab", ENGINE.openOne)).toContain("1 Kante grenzt nur an eine Fläche");
    expect(bodyReason("Stab", ENGINE.open)).toContain("12 Kanten grenzen nur an eine Fläche");
    expect(bodyReason("Stab", ENGINE.crowded)).toContain("4 Kanten werden von mehr als zwei Flächen geteilt");
    expect(bodyReason("Stab", ENGINE.flipped)).toContain("An 3 Kanten");
    expect(bodyReason("Stab", ENGINE.insideOutStuck)).toContain("das Umkehren ist nicht gelungen");
    expect(bodyReason("Stab", ENGINE.insideOut)).toBe("Stab ist umgestülpt: Die Flächen zeigen ins Material");
    expect(bodyReason("Stab", "open shell")).toBe("Stab open shell");

    await setLanguage("ja");
    expect(bodyReason("ロッド", ENGINE.open)).toBe(
      "ロッド は閉じたソリッドではありません。12 本のエッジが 1 つの面にしか接していないため、内側がありません",
    );
    expect(bodyReason("ロッド", ENGINE.insideOut)).toBe("ロッド は裏返しです。面が材料の内側を向いています");
  });
});
