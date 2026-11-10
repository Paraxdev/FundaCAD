// What a traced picture says through the real announcer at each Announcements level.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderCamera from "../../../src/components/shell/RenderCamera.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { attachAnnouncer, recentAnnouncements, setVerbositySource, type Verbosity } from "../../../src/ui/announce";

const saveRenderedImage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/io/files", () => ({ saveRenderedImage }));

interface Trace {
  onProgress: (n: number) => void;
  signal: AbortSignal;
  done: { resolve: (v: string | null) => void; reject: (e: unknown) => void };
}

const BASE = 1_730_000_123_457;
const SAVED = "D:/pics/render.png";
const START = "polite:Render started, 256 samples";
const FINISHED = "polite:Render finished";
const CANCELLED = "polite:Render cancelled";
const SAVED_LINE = `polite:Saved ${SAVED}`;
const FAILED = expect.stringMatching(/^assertive:The traced picture failed\..*GPU lost/) as unknown as string;
const q = (n: number) => `polite:Rendered ${n} of 256 samples`;
// The start is said at the first report, so a line that report also brings joins it in the same frame.
const joined = (a: string, b: string) => `${a}. ${b.replace(/^polite:/, "")}`;

let trace: Trace;
let w: VueWrapper;
let detach: () => void;
let level: Verbosity;
let startedAt: number;
let runs = 0;
let session: { alive: boolean };

function mountCamera() {
  const engine = {
    store: { fileName: "Untitled", session, onReferenceImagesChange: () => () => {} },
    viewport: {
      tracedPictureSize: () => ({ width: 640, height: 400 }),
      renderStill: vi.fn(),
      renderTracedPicture: vi.fn((o: { onProgress: Trace["onProgress"]; signal: AbortSignal }) => {
        let resolve!: Trace["done"]["resolve"];
        let reject!: Trace["done"]["reject"];
        const p = new Promise<string | null>((a, b) => {
          resolve = a;
          reject = b;
        });
        trace = { onProgress: o.onProgress, signal: o.signal, done: { resolve, reject } };
        o.signal.addEventListener("abort", () => reject(Object.assign(new Error("stop"), { name: "AbortError" })));
        return p;
      }),
    },
    canvas: { getBoundingClientRect: () => ({ width: 320, height: 200 }) },
  } as unknown as Engine;
  return mount(RenderCamera, { global: { provide: { [ENGINE as symbol]: engine } } });
}

const heard = () =>
  recentAnnouncements()
    .filter((a) => a.at >= startedAt)
    .map((a) => `${a.priority}:${a.text}`);
const step = (ms = 200) => vi.advanceTimersByTimeAsync(ms);
const press = async () => {
  await w.get("#rd-take-picture").trigger("click");
  await step();
};
const report = async (n: number) => {
  trace.onProgress(n);
  await step();
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE + ++runs * 100_000);
  startedAt = Date.now();
  setActivePinia(createPinia());
  saveRenderedImage.mockReset();
  // The save dialog is open for a while, so its line is heard apart from the finish.
  saveRenderedImage.mockImplementation(() => new Promise((done) => setTimeout(() => done(SAVED), 300)));
  detach = attachAnnouncer({ polite: { textContent: "" }, assertive: { textContent: "" } });
  session = { alive: true };
  w = mountCamera();
  setVerbositySource(() => level);
});
afterEach(() => {
  w.unmount();
  detach();
  setVerbositySource(() => "normal");
  vi.useRealTimers();
});

async function finishedRun() {
  await press();
  await report(12);
  await report(64);
  await vi.advanceTimersByTimeAsync(1000);
  await report(140);
  await report(256);
  trace.done.resolve("data:traced");
  await step(600);
}
async function cancelledRun() {
  await press();
  await report(70);
  await press();
}
async function failedRun() {
  await press();
  await report(70);
  trace.done.reject(new Error("GPU lost"));
  await step();
}

const LEVELS: Array<[Verbosity, string[], string[], string[]]> = [
  ["off", [], [], []],
  ["errors", [], [], [FAILED]],
  ["normal", [START, FINISHED, SAVED_LINE], [START, CANCELLED], [START, FAILED]],
  [
    "verbose",
    [START, q(64), q(140), FINISHED, SAVED_LINE],
    [joined(START, q(70)), CANCELLED],
    [joined(START, q(70)), FAILED],
  ],
];

describe.each(LEVELS)("a traced picture at Announcements %s", (lvl, finished, cancelled, failed) => {
  beforeEach(() => {
    level = lvl;
  });

  it("speaks a finished run", async () => {
    await finishedRun();
    expect(saveRenderedImage).toHaveBeenCalledTimes(1);
    expect(heard()).toEqual(finished);
  });

  it("speaks a cancelled run", async () => {
    await cancelledRun();
    expect(trace.signal.aborted).toBe(true);
    expect(heard()).toEqual(cancelled);
  });

  it("speaks a failed run", async () => {
    await failedRun();
    expect(heard()).toEqual(failed);
  });
});

describe("a traced picture that ends before its line is spoken", () => {
  beforeEach(() => {
    level = "verbose";
  });

  it("drops a quarter still waiting when the trace fails", async () => {
    await press();
    trace.onProgress(70);
    trace.done.reject(new Error("GPU lost"));
    await step();
    expect(heard()).toEqual([START, FAILED]);
  });

  it("says the finish in place of a quarter still waiting", async () => {
    await press();
    await step(1000);
    trace.onProgress(200);
    trace.done.resolve("data:traced");
    await step(600);
    expect(heard()).toEqual([joined(START, FINISHED), SAVED_LINE]);
  });

  it("says no finish and drops a quarter still waiting when the document closed mid trace", async () => {
    await press();
    await report(12);
    await step(1000);
    trace.onProgress(200);
    session.alive = false;
    trace.done.resolve("data:traced");
    await step(600);
    expect(heard()).toEqual([START]);
    expect(saveRenderedImage).not.toHaveBeenCalled();
  });

  it("says a second picture in full after a finished one", async () => {
    await finishedRun();
    const first = heard().length;
    await finishedRun();
    expect(heard().slice(first)).toEqual([START, q(64), q(140), FINISHED, SAVED_LINE]);
  });
});
