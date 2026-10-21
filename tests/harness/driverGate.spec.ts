import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";
import { createBridge, createMethods, harnessWanted, HARNESS_API, installHarness, startScreen, type HarnessHost } from "../../src/harness/driver";
import { HarnessError } from "../../src/harness/locate";
import { mountApp, rect } from "./fixture";

const host = {} as HarnessHost;

function fakeWindow(search: string) {
  return { location: { search }, document } as unknown as Window & { __harness?: { api: number } };
}

describe("harness gate", () => {
  it("installs only with ?harness=1 in a dev build", () => {
    expect(harnessWanted("?harness=1", true)).toBe(true);
    expect(harnessWanted("?harness=1", false)).toBe(false);
    expect(harnessWanted("?token=x", true)).toBe(false);
    expect(harnessWanted("?harness=yes", true)).toBe(false);
    expect(harnessWanted("?harness=10", true)).toBe(false);
  });

  it("publishes the bridge with its api number", () => {
    const off = fakeWindow("?token=t");
    expect(installHarness(host, off)).toBe(false);
    expect(off.__harness).toBeUndefined();
    const on = fakeWindow("?token=t&harness=1");
    expect(installHarness(host, on)).toBe(true);
    expect(on.__harness!.api).toBe(HARNESS_API);
  });
});

describe("bridge", () => {
  const bridge = createBridge({
    echo: (a) => a.x,
    later: async () => 5,
    refuse: () => { throw new HarnessError("nope", "NotFound", ["a"]); },
    crash: () => { throw new TypeError("boom"); },
  });

  it("wraps values and errors as plain JSON", async () => {
    expect(await bridge.call("echo", { x: 3 })).toEqual({ ok: true, value: 3 });
    expect(await bridge.call("later")).toEqual({ ok: true, value: 5 });
    expect(await bridge.call("refuse")).toEqual({ ok: false, error: { kind: "NotFound", message: "nope", candidates: ["a"] } });
    expect(await bridge.call("crash")).toEqual({ ok: false, error: { kind: "Internal", message: "boom", candidates: [] } });
    expect((await bridge.call("missing")).ok).toBe(false);
  });
});

describe("startScreen", () => {
  it("tells Home from the older welcome modal", () => {
    document.body.innerHTML = `<div class="home" role="dialog"><button class="modal-close"></button></div>`;
    expect(startScreen()).toBe("home");
    document.body.innerHTML = `<div class="modal-overlay"><div class="modal-panel welcome-panel"></div></div>`;
    expect(startScreen()).toBe("welcome");
    document.body.innerHTML = "";
    expect(startScreen()).toBe("none");
  });
});

describe("opens", () => {
  it("counts the documents the store opened", () => {
    let open = () => {};
    const m = createMethods({ store: { onOpen: (fn: () => void) => ((open = fn), () => {}) } } as unknown as HarnessHost, document);
    expect(m.opens!({})).toBe(0);
    open();
    expect(m.opens!({})).toBe(1);
  });
});

describe("screen", () => {
  it("names the regions when asked for one that does not exist", () => {
    const m = createMethods(host, document);
    expect(() => m.screen!({ region: "foo" })).toThrow(/regions are titlebar, menu, toolrail/);
  });

  it("leaves out the labels that were there when the last action began, when asked for fresh ones", () => {
    document.body.innerHTML = `<button id="docname">plate.json</button>`;
    const m = createMethods(host, document, { rect });
    m.seq!({});
    document.body.insertAdjacentHTML("beforeend", `<button>plate saved</button>`);
    const labels = (a: Record<string, unknown>) => (m.screen!(a) as { lines: unknown[][] }).lines.map((l) => l[3]);
    expect(labels({ fresh: true })).toEqual(["plate saved"]);
    expect(labels({}).filter(Boolean)).toEqual(["plate.json", "plate saved"]);
    document.body.innerHTML = "";
  });
});

describe("locate", () => {
  it("says which region the control it found is in", () => {
    document.body.innerHTML = `<div id="toolrail"><button>Sketch</button></div>`;
    const m = createMethods(host, document, { rect });
    expect(m.locate!({ target: "Sketch" })).toMatchObject({ label: "Sketch", region: "toolrail" });
    document.body.innerHTML = "";
  });

  it("refuses to type into a control that is not a value field and names the fields", () => {
    mountApp();
    const m = createMethods(host, document, { rect });
    expect(() => m.fieldValue!({ target: "sketch" })).toThrow(/^action:sketch "Sketch \(S\)" is not a value field, the value fields are field:angle$/);
    document.querySelectorAll(".dim-input").forEach((e) => e.remove());
    expect(() => m.fieldValue!({ target: "sketch" })).toThrow(/is not a value field, no value box is open/);
    document.body.innerHTML = "";
  });
});

const SOURCES = import.meta.glob(["../../src/main.ts", "../../src/viewport/viewport.ts"], {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;
const source = (path: string) => SOURCES[`../../${path}`]!;

describe("what the harness relies on outside src/harness", () => {
  it("main.ts loads the driver only behind import.meta.env.DEV, so a production build drops it", () => {
    const main = source("src/main.ts");
    const at = main.indexOf('import("./harness/driver")');
    expect(at).toBeGreaterThan(0);
    expect(main.slice(0, at)).toMatch(/if \(import\.meta\.env\.DEV && harnessWanted\([^)]*\)\) \{\s*void $/);
    expect(main).not.toMatch(/^import .*harness\/driver/m);
  });

  it("the picture is not idle on a frame the camera moved", () => {
    const idle = Object.getOwnPropertyDescriptor(Viewport.prototype, "renderIdle")!.get!;
    const still = { pending: false };
    expect(idle.call({ needsRender: false, lingerFrames: 0, frameMoved: false, edgeBlend: still })).toBe(true);
    expect(idle.call({ needsRender: false, lingerFrames: 0, frameMoved: true, edgeBlend: still })).toBe(false);
    // The full edges are still fading back in after a move.
    expect(idle.call({ needsRender: false, lingerFrames: 0, frameMoved: false, edgeBlend: { pending: true } })).toBe(false);
    const src = source("src/viewport/viewport.ts");
    expect(src).toMatch(/const moved = this\.rig\.update\(dt\);\s*this\.frameMoved = moved;/);
  });
});
