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

  it("cancelAnnouncement drops a debounced message before it speaks", () => {
    attach();
    m.announce("Face Center", "polite", { key: "snap", delay: 300 });
    m.cancelAnnouncement("snap");
    vi.advanceTimersByTime(400);
    expect(polite.textContent).toBe("");
    expect(m.recentAnnouncements()).toEqual([]);
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
});
