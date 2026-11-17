import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../../src/ui/announce");

let m: Mod;
let polite: { textContent: string | null };
let assertive: { textContent: string | null };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  m = await import("../../src/ui/announce");
  polite = { textContent: "" };
  assertive = { textContent: "" };
});
afterEach(() => {
  vi.useRealTimers();
});

const attach = () => m.attachAnnouncer({ polite, assertive });
const frame = () => vi.advanceTimersByTime(20);

describe("announce", () => {
  it("clears the region at once and sets the text a frame later", () => {
    attach();
    polite.textContent = "Old";
    m.announce("Built, 2 bodies");
    expect(polite.textContent).toBe("");
    frame();
    expect(polite.textContent).toBe("Built, 2 bodies");
    expect(assertive.textContent).toBe("");
  });

  it("empties a region once its sentence has been heard, so browsing never meets a stale prompt", () => {
    attach();
    m.announce("Extrude, click to apply");
    frame();
    vi.advanceTimersByTime(7000);
    expect(polite.textContent).toBe("Extrude, click to apply");
    vi.advanceTimersByTime(1500);
    expect(polite.textContent).toBe("");
  });

  it("keeps a newer sentence for its own full time", () => {
    attach();
    m.announce("First");
    frame();
    vi.advanceTimersByTime(6000);
    m.announce("Second");
    frame();
    vi.advanceTimersByTime(6000);
    expect(polite.textContent).toBe("Second");
  });

  it("speaks errors in the assertive region", () => {
    attach();
    m.announce("Build failed at Extrude 2", "assertive");
    frame();
    expect(assertive.textContent).toBe("Build failed at Extrude 2");
    expect(polite.textContent).toBe("");
  });

  it("joins a burst from one frame into one sentence, in order, without duplicates", () => {
    attach();
    m.announce("Opened plate.funda");
    m.announce("Built, 1 body");
    m.announce("Built, 1 body");
    frame();
    expect(polite.textContent).toBe("Opened plate.funda. Built, 1 body");
  });

  it("joins after a full width stop with no extra stop or space, as Japanese and Chinese write", () => {
    attach();
    m.announce("plate.funda を開きました。");
    m.announce("構築しました");
    frame();
    expect(polite.textContent).toBe("plate.funda を開きました。構築しました");
  });

  it("joins Japanese lines with no stop by the full width stop, after a colon by nothing, after a half width stop by a space", async () => {
    const { setLanguage } = await import("../../src/i18n");
    await setLanguage("ja");
    attach();
    m.announce("plate.funda を開きました");
    m.announce("面を選択：");
    m.announce("押し出し 1");
    frame();
    expect(polite.textContent).toBe("plate.funda を開きました。面を選択：押し出し 1");
    vi.advanceTimersByTime(5000);
    m.announce("Ready?");
    m.announce("構築しました");
    frame();
    expect(polite.textContent).toBe("Ready? 構築しました");
    await setLanguage("system");
  });

  it("keeps only the newest few of a flood", () => {
    attach();
    for (let i = 1; i <= 6; i++) m.announce(`Step ${i}`);
    frame();
    expect(polite.textContent).toBe("Step 4. Step 5. Step 6");
  });

  it("makes a repeat differ from the last text, so VoiceOver speaks it again", () => {
    attach();
    m.announce("Sketch mode");
    frame();
    const first = polite.textContent;
    m.announce("Sketch mode");
    frame();
    const second = polite.textContent;
    m.announce("Sketch mode");
    frame();
    expect(first).toBe("Sketch mode");
    expect(second).not.toBe(first);
    expect(second?.trim()).toBe("Sketch mode");
    expect(polite.textContent).toBe(first);
    expect(m.recentAnnouncements().map((a) => a.text)).toEqual(["Sketch mode", "Sketch mode", "Sketch mode"]);
  });

  it("a keyed message replaces the one with its key still waiting in the frame", () => {
    attach();
    m.announce("Pick a face", "polite", { key: "prompt" });
    m.announce("Pick a second face", "polite", { key: "prompt" });
    frame();
    expect(polite.textContent).toBe("Pick a second face");
  });

  it("debounces a keyed source, speaking only its last text after the pause", () => {
    attach();
    m.announce("Endpoint", "polite", { key: "snap", delay: 300 });
    vi.advanceTimersByTime(200);
    m.announce("Midpoint", "polite", { key: "snap", delay: 300 });
    vi.advanceTimersByTime(200);
    frame();
    expect(polite.textContent).toBe("");
    vi.advanceTimersByTime(120);
    frame();
    expect(polite.textContent).toBe("Midpoint");
  });

  it("drops a debounced message whose pause ran out but whose frame has not come, once the next of its key arrives", () => {
    attach();
    m.announce("Cursor at 0, 0, snapped to the origin", "polite", { key: "sketch-cursor", delay: 150 });
    vi.advanceTimersByTime(150);
    m.announce("No snap, cursor at 10, minus 3", "polite", { key: "sketch-cursor", delay: 150 });
    frame();
    expect(polite.textContent).toBe("");
    vi.advanceTimersByTime(150);
    frame();
    expect(polite.textContent).toBe("No snap, cursor at 10, minus 3");
    expect(m.recentAnnouncements().map((a) => a.text)).toEqual(["No snap, cursor at 10, minus 3"]);
  });

  it("cancelAnnouncement drops a debounced message before it speaks", () => {
    attach();
    m.announce("Face Center", "polite", { key: "snap", delay: 300 });
    m.cancelAnnouncement("snap");
    vi.advanceTimersByTime(400);
    expect(polite.textContent).toBe("");
    expect(m.recentAnnouncements()).toEqual([]);
  });

  it("cancelAnnouncement with a text drops only a waiting message saying it, under a shared key", () => {
    attach();
    m.announce("Face 3", "polite", { key: "sel", delay: 300 });
    m.cancelAnnouncement("sel", "Edge 2");
    vi.advanceTimersByTime(400);
    frame();
    expect(m.recentAnnouncements().map((a) => a.text)).toEqual(["Face 3"]);

    m.announce("Edge 2", "polite", { key: "sel", delay: 300 });
    m.cancelAnnouncement("sel", "Edge 2");
    vi.advanceTimersByTime(400);
    frame();
    expect(m.recentAnnouncements().map((a) => a.text)).toEqual(["Face 3"]);
  });

  it("holds what is said before the regions mount and speaks it once they do", () => {
    m.announce("Opened plate.funda");
    vi.advanceTimersByTime(200);
    expect(m.recentAnnouncements()).toEqual([]);
    attach();
    frame();
    expect(polite.textContent).toBe("Opened plate.funda");
  });

  it("stops writing to regions once detached", () => {
    const detach = attach();
    detach();
    m.announce("Built, 1 body");
    frame();
    expect(polite.textContent).toBe("");
  });

  it("reads verbosity through the source a5 plugs in, Normal by default", () => {
    attach();
    expect(m.verbosity()).toBe("normal");
    m.announce("Nothing selected", "polite", { verbose: true });
    frame();
    expect(polite.textContent).toBe("");

    let level: import("../../src/ui/announce").Verbosity = "verbose";
    m.setVerbositySource(() => level);
    m.announce("Nothing selected", "polite", { verbose: true });
    frame();
    expect(polite.textContent).toBe("Nothing selected");

    level = "errors";
    m.announce("Built, 1 body");
    m.announce("Build failed", "assertive");
    frame();
    expect(polite.textContent).toBe("Nothing selected");
    expect(assertive.textContent).toBe("Build failed");

    level = "off";
    m.announce("Build failed again", "assertive");
    frame();
    expect(assertive.textContent).toBe("Build failed");
  });

  it("falls back to Normal when the verbosity source throws", () => {
    m.setVerbositySource(() => {
      throw new Error("prefs not loaded");
    });
    expect(m.verbosity()).toBe("normal");
  });

  it("ignores empty text", () => {
    attach();
    m.announce("   ");
    frame();
    expect(m.recentAnnouncements()).toEqual([]);
  });

  it("interrupts once for an error that keeps repeating, and again after a quiet second", () => {
    attach();
    const heard = () => m.recentAnnouncements().map((a) => [a.text, a.priority]);
    m.announce("Handler failed", "assertive");
    frame();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(300);
      m.announce("Handler failed", "assertive");
      frame();
    }
    expect(assertive.textContent).toBe("Handler failed");
    expect(heard()).toEqual([["Handler failed", "assertive"]]);
    vi.advanceTimersByTime(1100);
    m.announce("Handler failed", "assertive");
    frame();
    expect(assertive.textContent?.trim()).toBe("Handler failed");
    expect(heard()).toEqual([
      ["Handler failed", "assertive"],
      ["Handler failed", "assertive"],
    ]);
  });

  it("still speaks a different error, and a polite repeat, within that second", () => {
    attach();
    m.announce("Could not save", "assertive");
    m.announce("Sketch mode");
    frame();
    vi.advanceTimersByTime(200);
    m.announce("Could not export", "assertive");
    m.announce("Sketch mode");
    frame();
    const said = (p: string) => m.recentAnnouncements().flatMap((a) => (a.priority === p ? [a.text] : []));
    expect(said("assertive")).toEqual(["Could not save", "Could not export"]);
    expect(said("polite")).toEqual(["Sketch mode", "Sketch mode"]);
  });
});

describe("spoken", () => {
  it("turns the middle dot separator into commas", async () => {
    const { spoken } = await import("../../src/ui/announce");
    expect(spoken("Click an edge · Ctrl-click a chain · Esc")).toBe("Click an edge, Ctrl-click a chain, Esc");
  });

  it("says glyphs a voice would skip or spell out", async () => {
    const { spoken } = await import("../../src/ui/announce");
    expect(spoken("1 face · ⌀50 mm · 340 mm²")).toBe("1 face, diameter 50 mm, 340 mm squared");
    expect(spoken("⌘-click adds more, ⌥ drag copies, ⌘+Z")).toBe(
      "Command-click adds more, Option drag copies, Command+Z",
    );
    expect(spoken("Analysing…")).toBe("Analysing");
  });

  it("frames a squared or cubed unit in the language, with the French plural following the value", async () => {
    const { spoken } = await import("../../src/ui/announce");
    const { setLanguage } = await import("../../src/i18n");
    expect(spoken("12 cm³ · mm²")).toBe("12 cm cubed, mm squared");
    await setLanguage("fr");
    expect(spoken("1 mm² · 340 mm² · 1,5 cm³ · 2,5 cm³")).toBe("1 mm carré, 340 mm carrés, 1,5 cm cube, 2,5 cm cubes");
    await setLanguage("ja");
    expect(spoken("340 mm² · 12 cm³")).toBe("340 平方mm, 12 立方cm");
    await setLanguage("system");
  });
});
