// The Camera tab's traced picture: a constant button name, a progress bar for the samples, a spoken reason while
// the picture is being saved, and what is announced at its start, quarters, finish, cancel and failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderCamera from "../../../src/components/shell/RenderCamera.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { escapeClaimed } from "../../../src/ui/escapeClaim";
import { setRenderPref } from "../../../src/ui/renderPrefs";
import type { Engine } from "../../../src/app/engine";

const saveRenderedImage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/io/files", () => ({ saveRenderedImage }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../../src/ui/toast", () => ({ toast }));
const speech = vi.hoisted(() => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
vi.mock("../../../src/ui/announce", () => speech);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

interface TraceOpts {
  scale: number;
  samples: number;
  signal: AbortSignal;
  onProgress: (n: number) => void;
}

const T0 = 1_730_000_123_457;
const SAVED = "C:\\pics\\render.png";
let traces: Array<{ opts: TraceOpts; done: Deferred<string | null> }>;
let renderStill: ReturnType<typeof vi.fn>;
let renderTracedPicture: ReturnType<typeof vi.fn>;
let tracedSize: () => { width: number; height: number } | null;
let session: { alive: boolean };
let w: VueWrapper;

function mountCamera(attachTo?: HTMLElement) {
  const engine = {
    store: {
      fileName: "Untitled",
      session,
      onReferenceImagesChange: () => () => {},
    },
    viewport: { tracedPictureSize: () => tracedSize(), renderTracedPicture, renderStill },
    canvas: { getBoundingClientRect: () => ({ width: 320, height: 200 }) },
  } as unknown as Engine;
  return mount(RenderCamera, { ...(attachTo && { attachTo }), global: { provide: { [ENGINE as symbol]: engine } } });
}

const button = () => w.get("#rd-take-picture");
const bar = () => w.find("[role='progressbar']");
const buttonState = () => ({
  text: button().text(),
  ariaDisabled: button().attributes("aria-disabled"),
  describedby: button().attributes("aria-describedby"),
});
const barState = () => {
  const el = bar();
  return {
    role: el.attributes("role"),
    label: el.attributes("aria-label"),
    min: el.attributes("aria-valuemin"),
    max: el.attributes("aria-valuemax"),
    now: el.attributes("aria-valuenow"),
    text: el.attributes("aria-valuetext"),
  };
};
const barAt = (now: number, max: number, text: string) => ({
  role: "progressbar",
  label: "Render progress",
  min: "0",
  max: String(max),
  now: String(now),
  text,
});
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const idle = { text: "Save picture…", ariaDisabled: undefined, describedby: undefined };

async function press() {
  await button().trigger("click");
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
  setActivePinia(createPinia());
  traces = [];
  saveRenderedImage.mockReset();
  toast.mockReset();
  speech.announce.mockReset();
  speech.cancelAnnouncement.mockReset();
  saveRenderedImage.mockResolvedValue(SAVED);
  renderStill = vi.fn(async () => "data:still");
  renderTracedPicture = vi.fn((opts: TraceOpts) => {
    const done = deferred<string | null>();
    traces.push({ opts, done });
    return done.promise;
  });
  tracedSize = () => ({ width: 640, height: 400 });
  session = { alive: true };
  w = mountCamera();
});
afterEach(() => {
  w.unmount();
  vi.useRealTimers();
});

describe("Camera tab traced picture", () => {
  it("is idle with a plain button and no bar", () => {
    expect(buttonState()).toEqual(idle);
    expect(bar().exists()).toBe(false);
  });

  it("keeps the name Cancel render while the bar counts the samples", async () => {
    await press();
    expect(renderTracedPicture).toHaveBeenCalledTimes(1);
    expect(buttonState().text).toBe("Cancel render");
    expect(barState()).toEqual(barAt(0, 256, "0 of 256 samples"));

    const { onProgress } = traces[0]!.opts;
    const steps: Array<[number, number, ReturnType<typeof barAt>]> = [
      [370, 12, barAt(0, 256, "0 of 256 samples")],
      [1010, 30, barAt(30, 256, "30 of 256 samples")],
      [1130, 64, barAt(64, 256, "64 of 256 samples")],
      [1650, 70, barAt(64, 256, "64 of 256 samples")],
      [2200, 200, barAt(200, 256, "200 of 256 samples")],
    ];
    for (const [ms, n, expected] of steps) {
      at(ms);
      onProgress(n);
      await flushPromises();
      expect(buttonState().text).toBe("Cancel render");
      expect(barState()).toEqual(expected);
    }
  });

  it("shows the count as hidden text equal to the value text", async () => {
    await press();
    at(1500);
    traces[0]!.opts.onProgress(100);
    await flushPromises();
    const text = w.get(".rd-progress-text");
    expect(text.attributes("aria-hidden")).toBe("true");
    expect(text.text()).toBe("100 of 256 samples");
    expect(bar().attributes("aria-valuetext")).toBe(text.text());
  });

  it("fills the track to the share of the samples shown", async () => {
    await press();
    const fill = () => (w.get(".rd-progress-track i").element as HTMLElement).style.width;
    const widths = [fill()];
    const { onProgress } = traces[0]!.opts;
    const steps: Array<[number, number]> = [
      [300, 64],
      [1500, 100],
      [1700, 192],
      [1800, 256],
    ];
    for (const [ms, n] of steps) {
      at(ms);
      onProgress(n);
      await flushPromises();
      widths.push(fill());
    }
    expect(widths).toEqual(["0%", "25%", "39.0625%", "75%", "100%"]);
  });

  it("keeps the total the trace started with when the Samples chip changes", async () => {
    await press();
    await w.get("[data-samples='1024']").trigger("click");
    at(1500);
    traces[0]!.opts.onProgress(100);
    await flushPromises();
    expect(traces[0]!.opts.samples).toBe(256);
    expect(barState()).toEqual(barAt(100, 256, "100 of 256 samples"));
  });

  it("cancels on a second press, drops the bar and reads Save picture again", async () => {
    await press();
    const { signal } = traces[0]!.opts;
    expect(signal.aborted).toBe(false);
    signal.addEventListener("abort", () =>
      traces[0]!.done.reject(Object.assign(new Error("stop"), { name: "AbortError" })),
    );
    await press();
    expect(signal.aborted).toBe(true);
    expect(bar().exists()).toBe(false);
    expect(buttonState()).toEqual(idle);
    expect(saveRenderedImage).not.toHaveBeenCalled();
  });

  it("blocks with a spoken reason while the picture is saved, then frees the button", async () => {
    const save = deferred<string | null>();
    saveRenderedImage.mockReturnValue(save.promise);
    await press();
    traces[0]!.done.resolve("data:traced");
    await flushPromises();

    const state = buttonState();
    expect(state.text).toBe("Saving picture…");
    expect(state.ariaDisabled).toBe("true");
    const reason = w.get(`[id="${state.describedby}"]`);
    expect(reason.text()).toBe("Wait for this picture to be saved");
    expect(reason.classes()).toContain("sr-only");
    expect(bar().exists()).toBe(false);

    await button().trigger("click");
    await button().trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(renderTracedPicture).toHaveBeenCalledTimes(1);
    expect(saveRenderedImage).toHaveBeenCalledTimes(1);
    expect(renderStill).not.toHaveBeenCalled();

    save.resolve(SAVED);
    await flushPromises();
    expect(buttonState()).toEqual(idle);
    expect(w.find(".sr-only").exists()).toBe(false);
  });

  it("starts a second picture at zero with nothing left from the first", async () => {
    await press();
    at(1200);
    traces[0]!.opts.onProgress(200);
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    expect(buttonState()).toEqual(idle);

    at(5000);
    await w.get("[data-samples='64']").trigger("click");
    await press();
    expect(traces).toHaveLength(2);
    expect(traces[1]!.opts.samples).toBe(64);
    expect(barState()).toEqual(barAt(0, 64, "0 of 64 samples"));
    at(5030);
    traces[1]!.opts.onProgress(16);
    await flushPromises();
    expect(barState()).toEqual(barAt(16, 64, "16 of 64 samples"));
  });

  it("takes a plain picture with no bar and never reads Cancel render", async () => {
    tracedSize = () => null;
    w.unmount();
    w = mountCamera();
    const still = deferred<string>();
    renderStill.mockReturnValue(still.promise);
    await press();
    expect(renderTracedPicture).not.toHaveBeenCalled();
    expect(renderStill).toHaveBeenCalledTimes(1);
    expect(buttonState().text).toBe("Saving picture…");
    expect(bar().exists()).toBe(false);
    still.resolve("data:still");
    await flushPromises();
    expect(saveRenderedImage).toHaveBeenCalledWith("data:still", "render.png");
  });
});

const QUARTER = { verbose: true, key: "render" };
const KEYED = { key: "render" };
const quarter = (n: number, total = 256) => [`Rendered ${n} of ${total} samples`, "polite", QUARTER];
const said = () => speech.announce.mock.calls;
const abortsWith = (i: number) =>
  traces[i]!.opts.signal.addEventListener("abort", () =>
    traces[i]!.done.reject(Object.assign(new Error("stop"), { name: "AbortError" })),
  );

describe("Camera tab traced picture announcements", () => {
  it("speaks the start, each quarter once, the finish and the save for a full run", async () => {
    await press();
    const { onProgress } = traces[0]!.opts;
    const reports: Array<[number, number]> = [
      [200, 12],
      [450, 64],
      [700, 63],
      [900, 140],
      [1100, 200],
      [1300, 256],
    ];
    for (const [ms, n] of reports) {
      at(ms);
      onProgress(n);
    }
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    expect(said()).toEqual([
      ["Render started, 256 samples"],
      quarter(64),
      quarter(140),
      quarter(200),
      ["Render finished", "polite", KEYED],
    ]);
    expect(speech.cancelAnnouncement).not.toHaveBeenCalled();
    expect(toast.mock.calls).toEqual([[`Saved ${SAVED}`]]);
  });

  it("speaks the start at the first report, so a picture with no report says only its finish", async () => {
    await press();
    expect(said()).toEqual([]);
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    expect(said()).toEqual([["Render finished", "polite", KEYED]]);

    speech.announce.mockClear();
    await w.get("[data-samples='1024']").trigger("click");
    await press();
    at(900);
    traces[1]!.opts.onProgress(1024);
    traces[1]!.done.resolve("data:traced");
    await flushPromises();
    expect(said()).toEqual([["Render started, 1024 samples"], ["Render finished", "polite", KEYED]]);
  });

  it("says nothing of a trace that returns nothing before it begins, and saves the realtime still", async () => {
    await press();
    expect(buttonState().text).toBe("Cancel render");
    traces[0]!.done.resolve(null);
    await flushPromises();
    expect(said()).toEqual([]);
    expect(speech.cancelAnnouncement).not.toHaveBeenCalled();
    expect(renderStill).toHaveBeenCalledTimes(1);
    expect(saveRenderedImage).toHaveBeenCalledWith("data:still", "render.png");
    expect(buttonState()).toEqual(idle);
  });

  it("speaks only the cancel for a trace cancelled before its first report", async () => {
    await press();
    abortsWith(0);
    await press();
    expect(said()).toEqual([["Render cancelled", "polite", KEYED]]);
  });

  it("says no finish and drops a waiting quarter when the document closed before the picture came back", async () => {
    await press();
    at(1500);
    traces[0]!.opts.onProgress(70);
    session.alive = false;
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    expect(said()).toEqual([["Render started, 256 samples"], quarter(70)]);
    expect(speech.cancelAnnouncement.mock.calls).toEqual([["render"]]);
    expect(saveRenderedImage).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(buttonState()).toEqual(idle);
  });

  it("speaks the start, the first quarter and the cancel, with no toast", async () => {
    await press();
    abortsWith(0);
    at(1500);
    traces[0]!.opts.onProgress(70);
    await press();
    expect(said()).toEqual([["Render started, 256 samples"], quarter(70), ["Render cancelled", "polite", KEYED]]);
    expect(toast).not.toHaveBeenCalled();
    expect(speech.cancelAnnouncement).not.toHaveBeenCalled();
  });

  it("cancels the trace and says so when the dock is closed mid trace", async () => {
    await press();
    abortsWith(0);
    at(1500);
    traces[0]!.opts.onProgress(70);
    w.unmount();
    await flushPromises();
    expect(traces[0]!.opts.signal.aborted).toBe(true);
    expect(said().at(-1)).toEqual(["Render cancelled", "polite", KEYED]);
    w = mountCamera();
  });

  it("drops a waiting line before the error toast on failure, with no finish or cancel line", async () => {
    await press();
    at(1500);
    traces[0]!.opts.onProgress(130);
    const order: string[] = [];
    speech.cancelAnnouncement.mockImplementation((k: string) => order.push(`cancel ${k}`));
    toast.mockImplementation((text: string) =>
      order.push(text.startsWith("The traced picture failed") ? "toast" : "other"),
    );
    traces[0]!.done.reject(new Error("GPU lost"));
    await flushPromises();
    expect(order).toEqual(["cancel render", "toast"]);
    expect(said()).toEqual([["Render started, 256 samples"], quarter(130)]);
    expect(toast.mock.calls[0]![0]).toContain("GPU lost");
    expect(toast.mock.calls[0]![1]).toMatchObject({ kind: "error" });
    expect(buttonState()).toEqual(idle);
  });

  it("says nothing for a picture that is not traced", async () => {
    tracedSize = () => null;
    w.unmount();
    w = mountCamera();
    await press();
    await flushPromises();
    expect(said()).toEqual([]);
    expect(speech.cancelAnnouncement).not.toHaveBeenCalled();
  });

  it("repeats its start and quarters for a second picture", async () => {
    await press();
    at(500);
    traces[0]!.opts.onProgress(100);
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    speech.announce.mockClear();

    at(9000);
    await w.get("[data-samples='64']").trigger("click");
    await press();
    at(9100);
    traces[1]!.opts.onProgress(20);
    traces[1]!.done.resolve("data:traced");
    await flushPromises();
    expect(said()).toEqual([["Render started, 64 samples"], quarter(20, 64), ["Render finished", "polite", KEYED]]);
  });

  it("takes no report between a cancel and the trace stopping", async () => {
    await press();
    const { onProgress, signal } = traces[0]!.opts;
    at(1500);
    onProgress(30);
    await flushPromises();
    await press();
    expect(signal.aborted).toBe(true);
    at(1620);
    onProgress(140);
    await flushPromises();
    expect(barState()).toEqual(barAt(30, 256, "30 of 256 samples"));

    traces[0]!.done.reject(Object.assign(new Error("stop"), { name: "AbortError" }));
    await flushPromises();
    expect(said()).toEqual([["Render started, 256 samples"], ["Render cancelled", "polite", KEYED]]);
  });

  it("takes no late report from a finished picture, alone or while the next one runs", async () => {
    await press();
    const first = traces[0]!.opts.onProgress;
    at(400);
    first(70);
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    at(1900);
    expect(() => first(140)).not.toThrow();
    await flushPromises();
    expect(bar().exists()).toBe(false);

    await press();
    at(3500);
    first(200);
    await flushPromises();
    expect(barState()).toEqual(barAt(0, 256, "0 of 256 samples"));
    expect(said()).toEqual([["Render started, 256 samples"], quarter(70), ["Render finished", "polite", KEYED]]);
  });
});

const escape = (el: Element) => {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
// claimEscape's release lands a task later.
const nextTask = () => new Promise((done) => setTimeout(done, 0));

describe("Camera tab Escape", () => {
  let app: ReturnType<typeof vi.fn<(e: Event) => void>>;
  let host: HTMLElement;
  beforeEach(() => {
    w.unmount();
    host = document.body.appendChild(document.createElement("div"));
    w = mountCamera(host);
    app = vi.fn<(e: Event) => void>();
    window.addEventListener("keydown", app);
  });
  afterEach(async () => {
    window.removeEventListener("keydown", app);
    w.unmount();
    host.remove();
    w = mountCamera();
    await nextTask();
  });
  const focusButton = () => (button().element as HTMLElement).focus();

  it("cancels a running trace from the tab, says so and keeps the key from the app", async () => {
    focusButton();
    await press();
    abortsWith(0);
    at(1500);
    traces[0]!.opts.onProgress(70);
    await flushPromises();
    expect(escapeClaimed()).toBe(true);

    const ev = escape(button().element);
    await flushPromises();
    expect(traces[0]!.opts.signal.aborted).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(app).not.toHaveBeenCalled();
    expect(said().at(-1)).toEqual(["Render cancelled", "polite", KEYED]);
    expect(buttonState()).toEqual(idle);
    await nextTask();
    expect(escapeClaimed()).toBe(false);
  });

  it("leaves Escape to whatever owned it before when no trace runs, before a picture and after one", async () => {
    focusButton();
    const before = escape(button().element);
    expect(before.defaultPrevented).toBe(false);
    expect(app).toHaveBeenCalledTimes(1);
    expect(escapeClaimed()).toBe(false);

    await press();
    traces[0]!.opts.onProgress(256);
    traces[0]!.done.resolve("data:traced");
    await flushPromises();
    await nextTask();
    expect(buttonState()).toEqual(idle);
    expect(escapeClaimed()).toBe(false);
    const after = escape(button().element);
    expect(after.defaultPrevented).toBe(false);
    expect(app).toHaveBeenCalledTimes(2);
    expect(said().filter(([text]) => text === "Render cancelled")).toEqual([]);
  });

  it("leaves Escape to the app while a trace runs and focus is outside the tab", async () => {
    const outside = document.body.appendChild(document.createElement("button"));
    try {
      focusButton();
      await press();
      traces[0]!.opts.onProgress(70);
      outside.focus();
      await flushPromises();
      await nextTask();
      expect(escapeClaimed()).toBe(false);

      const ev = escape(outside);
      expect(ev.defaultPrevented).toBe(false);
      expect(app).toHaveBeenCalledTimes(1);
      expect(traces[0]!.opts.signal.aborted).toBe(false);
      expect(buttonState().text).toBe("Cancel render");

      focusButton();
      await flushPromises();
      expect(escapeClaimed()).toBe(true);
    } finally {
      outside.remove();
      traces[0]?.done.resolve("data:traced");
      await flushPromises();
    }
  });

  // Focus stays on the Aperture trigger inside the tab while its list is open, so only the Popover's window capture
  // listener keeps this Escape from the tab's cancel.
  it("closes an open Aperture list on Escape while a trace runs, and keeps the trace and the tab's claim", async () => {
    setRenderPref("focusBlur", 0.4);
    try {
      focusButton();
      await press();
      // Vue skips a handler for an event stamped no later than the handler was attached, so the faked clock moves on.
      at(1500);
      traces[0]!.opts.onProgress(70);
      const aperture = w.get("#rd-aperture");
      (aperture.element as HTMLElement).focus();
      await aperture.trigger("keydown", { key: "ArrowDown" });
      await flushPromises();
      expect(document.body.querySelector("[role=listbox]")).not.toBeNull();

      escape(aperture.element);
      await flushPromises();
      await nextTask();
      expect(document.body.querySelector("[role=listbox]")).toBeNull();
      expect(traces[0]!.opts.signal.aborted).toBe(false);
      expect(app.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["ArrowDown"]);
      expect(buttonState().text).toBe("Cancel render");
      expect(escapeClaimed()).toBe(true);
    } finally {
      setRenderPref("focusBlur", 0);
      traces[0]?.done.resolve("data:traced");
      await flushPromises();
    }
  });
});
