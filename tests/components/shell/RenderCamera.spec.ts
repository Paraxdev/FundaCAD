// The Camera tab's traced picture: a constant button name, a progress bar for the samples, and a spoken reason
// while the picture is being saved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderCamera from "../../../src/components/shell/RenderCamera.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";

const saveRenderedImage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/io/files", () => ({ saveRenderedImage }));
vi.mock("../../../src/ui/toast", () => ({ toast: vi.fn() }));

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
let w: VueWrapper;

function mountCamera() {
  const engine = {
    store: {
      fileName: "Untitled",
      session: { alive: true },
      onReferenceImagesChange: () => () => {},
    },
    viewport: { tracedPictureSize: () => tracedSize(), renderTracedPicture, renderStill },
    canvas: { getBoundingClientRect: () => ({ width: 320, height: 200 }) },
  } as unknown as Engine;
  return mount(RenderCamera, { global: { provide: { [ENGINE as symbol]: engine } } });
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
  saveRenderedImage.mockResolvedValue(SAVED);
  renderStill = vi.fn(async () => "data:still");
  renderTracedPicture = vi.fn((opts: TraceOpts) => {
    const done = deferred<string | null>();
    traces.push({ opts, done });
    return done.promise;
  });
  tracedSize = () => ({ width: 640, height: 400 });
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
