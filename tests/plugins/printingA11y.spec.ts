// The Printing plugin's panels for a screen reader: the filament mapping dialog names every toolhead pick and start
// flag, the camera panel calls an offline camera an error alert and names its retry, and the progress pill is a quiet
// status region with a real button to open the camera. The printer client is stubbed, no device or network is reached.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const printer = vi.hoisted(() => {
  const state = {
    frame: null as null | ((e: { id: string; data_url: string }) => void),
    offline: null as null | ((id: string) => void),
  };
  return {
    state,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
  };
});
vi.mock("../../plugins/FundaCAD.Printing/printerClient", () => ({
  printerCameraStart: printer.start,
  printerCameraStop: printer.stop,
  onPrinterCameraFrame: (fn: never) => {
    printer.state.frame = fn;
    return () => {};
  },
  onPrinterCameraOffline: (fn: never) => {
    printer.state.offline = fn;
    return () => {};
  },
}));

import CameraPanel from "../../plugins/FundaCAD.Printing/CameraPanel.vue";
import FilamentMappingDialog from "../../plugins/FundaCAD.Printing/FilamentMappingDialog.vue";
import PrintStatusPill from "../../plugins/FundaCAD.Printing/PrintStatusPill.vue";
import { usePrintStatusStore } from "../../plugins/FundaCAD.Printing/printStatus";
import { cameraPanel, type FilamentReq } from "../../plugins/FundaCAD.Printing/state";
import { byName, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
  printer.start.mockClear();
  printer.stop.mockClear();
  cameraPanel.value = null;
});
afterEach(() => vi.unstubAllGlobals());

// The frame's own close button is the app's, named Close.
const raw = (root: Element) => rawControls(root).filter((r) => r !== "button.modal-close");

function request(): FilamentReq {
  return {
    slots: [
      { index: 0, name: "Polymaker PLA", color: "#d23b30", material: "PLA" },
      { index: 1, name: "", color: "#2255cc" },
    ],
    toolheads: [
      { index: 0, vendor: "Polymaker", material: "PLA", sub_type: "", color: "#d23b30", present: true },
      { index: 1, vendor: "", material: "", sub_type: "", color: "#2255cc", present: true },
      { index: 2, vendor: "Generic", material: "PETG", sub_type: "", color: "#ffffff", present: false },
    ],
    resolve: vi.fn(),
  };
}

async function mapping(req = request()) {
  mount(FilamentMappingDialog, { props: { req }, attachTo: document.body });
  await flushPromises();
  return { root: document.body, req };
}

describe("the filament mapping dialog, for a screen reader", () => {
  it("is a named dialog with no unnamed or raw control", async () => {
    const { root } = await mapping();
    const dialog = root.querySelector("[role=dialog]")!;
    expect(nameOf(dialog)).toBe("Send to printer, filament mapping");
    expect(raw(root)).toEqual([]);
    expect(unnamed(dialog)).toEqual([]);
  });

  it("names each toolhead pick after its slot, with the filament it is on", async () => {
    const { root } = await mapping();
    const picks = [...root.querySelectorAll<HTMLElement>("[role=combobox]")];
    expect(picks.map((el) => nameOf(el))).toEqual([
      "Toolhead for Polymaker PLA, 1: Polymaker PLA",
      "Toolhead for Filament 2, 2: Toolhead 2",
    ]);
  });

  it("keeps the slots in a named list of items and the start flags in a named group", async () => {
    const { root } = await mapping();
    const list = root.querySelector("ul")!;
    expect(nameOf(list)).toBe("Filament slots");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    const group = root.querySelector("[role=group]")!;
    expect(nameOf(group)).toBe("Start options");
    expect([...group.querySelectorAll("input[type=checkbox]")].map(nameOf)).toEqual([
      "Auto bed leveling",
      "Flow calibrate",
      "Timelapse",
    ]);
  });

  it("answers with the picked toolhead and the ticked flags", async () => {
    const { root, req } = await mapping();
    root.querySelectorAll<HTMLElement>("[role=combobox]")[1]!.click();
    await flushPromises();
    const empty = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) =>
      /\(empty\)/.test(o.textContent ?? ""),
    )!;
    empty.click();
    await flushPromises();
    byName<HTMLInputElement>(root, "input[type=checkbox]", "Timelapse")!.click();
    await flushPromises();
    byName<HTMLButtonElement>(root, "button", /Upload/)!.click();
    expect(req.resolve).toHaveBeenCalledWith({
      mapTable: [
        [0, 0],
        [1, 2],
      ],
      opts: { bedLevel: false, flowCalibrate: false, timeLapseCamera: true },
    });
  });

  it("cancels from the Cancel button", async () => {
    const { root, req } = await mapping();
    byName<HTMLButtonElement>(root, "button", "Cancel")!.click();
    expect(req.resolve).toHaveBeenCalledWith(null);
  });

  it("cancels from Escape", async () => {
    const { req } = await mapping();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(req.resolve).toHaveBeenCalledWith(null);
  });
});

describe("the printer camera panel, for a screen reader", () => {
  async function camera() {
    cameraPanel.value = "u1";
    mount(CameraPanel, { attachTo: document.body });
    await flushPromises();
    return document.body;
  }

  it("is a named region whose picture says what it shows and has no raw control", async () => {
    const root = await camera();
    const region = root.querySelector("[role=region], section, aside, [role=dialog]")!;
    expect(nameOf(region)).toBe("Camera, u1");
    const img = root.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("No camera frame yet");
    printer.state.frame!({ id: "u1", data_url: "data:image/jpeg;base64,AA==" });
    await nextTick();
    expect(img.getAttribute("alt")).toBe("Latest frame from the printer camera");
    expect(raw(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("calls an offline camera an error alert in words and names the retry", async () => {
    const root = await camera();
    expect(root.querySelector("[role=alert]")).toBeNull();
    printer.state.offline!("u1");
    await nextTick();
    expect(root.querySelector("[role=alert]")?.textContent).toBe("Error: camera unavailable");
    const before = printer.start.mock.calls.length;
    byName<HTMLButtonElement>(root, "button", "Retry")!.click();
    await flushPromises();
    expect(printer.start.mock.calls.length).toBe(before + 1);
  });
});

describe("the print progress pill, for a screen reader", () => {
  function pill(text: string | null, onClick: (() => void) | null = null) {
    const store = usePrintStatusStore();
    store.text = text;
    store.onClick = onClick;
    mount(PrintStatusPill, { attachTo: document.body });
    return document.body;
  }

  it("draws nothing without a job", () => {
    expect(pill(null).querySelector(".print-status-pill")).toBeNull();
  });

  it("is a status region that does not speak every percent, with no button when nothing opens", () => {
    const root = pill("Printing cube.gcode, 40%");
    const el = root.querySelector(".print-status-pill")!;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("off");
    expect(el.textContent).toContain("Printing cube.gcode, 40%");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers a named Show camera button that opens the camera", () => {
    const open = vi.fn();
    const root = pill("Paused cube.gcode, 40%", open);
    expect(raw(root)).toEqual([]);
    const button = byName<HTMLButtonElement>(root, "button", "Show camera")!;
    button.click();
    expect(open).toHaveBeenCalledOnce();
  });
});
