import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

const announce = vi.fn();
vi.mock("../../src/ui/announce", () => ({ announce: (...a: unknown[]) => announce(...a) }));

import { BUSY_SPEAK_MS, installAnnouncements } from "../../src/app/announcements";
import { failureKey } from "../../src/ui/buildAnnouncement";
import { useUiStore } from "../../src/stores/ui";
import { setWorkspace } from "../../src/ui/workspace";

type BuildFn = (s: Record<string, unknown>) => void;
type BusyFn = (b: Record<string, unknown>) => void;

let buildFns: BuildFn[];
let busyFns: BusyFn[];
let off: () => void;

const store = () => ({
  document: { features: [{ id: "f1", type: "extrude", name: "Extrude 1" }] },
  onBuild: (fn: BuildFn) => {
    buildFns.push(fn);
    return () => (buildFns = buildFns.filter((f) => f !== fn));
  },
  onBusy: (fn: BusyFn) => {
    busyFns.push(fn);
    return () => (busyFns = busyFns.filter((f) => f !== fn));
  },
});
const build = (s: Record<string, unknown>) =>
  buildFns.forEach((f) =>
    f({ building: false, errorFeatureId: null, errorMessage: null, result: { bodies: [{}] }, ...s }),
  );
const busy = (b: Record<string, unknown>) =>
  busyFns.forEach((f) => f({ active: true, label: "Rebuilding", pct: null, stage: null, waiting: null, ...b }));
const said = () => announce.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  announce.mockClear();
  buildFns = [];
  busyFns = [];
  off = installAnnouncements({ store: store() as never });
});
afterEach(() => {
  off();
  setWorkspace("model");
  vi.useRealTimers();
});

describe("installAnnouncements", () => {
  it("says a build result only once a build has run, not on the replay", () => {
    build({});
    expect(announce).not.toHaveBeenCalled();
    build({ building: true });
    build({});
    expect(announce).toHaveBeenCalledWith("Built, 1 body", "polite", { key: "build" });
  });

  it("names the failing step assertively, keyed like that step's error notice so it is said once", () => {
    build({ building: true });
    build({ errorFeatureId: "f1", errorMessage: "Profile is open" });
    expect(announce).toHaveBeenCalledWith("Build failed at Extrude 1: Profile is open", "assertive", {
      key: failureKey("f1"),
    });
  });

  it("keeps a tool's preview out of the last settled build, so a lasting failure stays polite", () => {
    const fail = { errorFeatureId: "f1", errorMessage: "Profile is open" };
    build({ building: true });
    build(fail);
    build({ building: true });
    build({ previewBuilt: [] });
    build({ building: true });
    build(fail);
    expect(announce).toHaveBeenLastCalledWith("Built, 1 body, Extrude 1 still fails", "polite", { key: "build" });
  });

  it("says busy work only once it outlasts the threshold, and once however often it ticks", () => {
    busy({});
    vi.advanceTimersByTime(BUSY_SPEAK_MS - 1);
    busy({ pct: 40 });
    expect(announce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    busy({ pct: 80 });
    vi.advanceTimersByTime(BUSY_SPEAK_MS * 2);
    expect(said()).toEqual(["Rebuilding"]);
  });

  it("drops busy work that ends before the threshold", () => {
    busy({});
    busy({ active: false });
    vi.advanceTimersByTime(BUSY_SPEAK_MS * 2);
    expect(announce).not.toHaveBeenCalled();
  });

  it("says the sketch and solid modes as they switch", async () => {
    const ui = useUiStore();
    ui.sketchActive = true;
    await nextTick();
    ui.sketchActive = false;
    await nextTick();
    expect(said()).toEqual(["Sketch mode", "Solid mode"]);
  });

  it("says a workspace switch made from elsewhere, but not from the switch the reader is on", () => {
    setWorkspace("render");
    expect(said()).toEqual(["Render workspace"]);
    const host = document.createElement("div");
    host.id = "workspace-toggle";
    const radio = document.createElement("button");
    host.appendChild(radio);
    document.body.appendChild(host);
    radio.focus();
    setWorkspace("model");
    expect(said()).toEqual(["Render workspace"]);
    host.remove();
  });

  it("stops listening when uninstalled", () => {
    off();
    build({ building: true });
    build({});
    setWorkspace("render");
    expect(announce).not.toHaveBeenCalled();
    off = () => {};
  });
});
