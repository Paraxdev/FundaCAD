// The number fields of the shipped plugin panels: what a person can type into each one, and what the panel does with
// it. A native number input ignores a decimal comma, so these read a typed value through the panel's own state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref, shallowRef, watch } from "vue";
import ParametersSection from "../../plugins/FundaCAD.ExtraParameters/ParametersSection.vue";
import PrintabilityPanel from "../../plugins/FundaCAD.PrintToolbox/PrintabilityPanel.vue";
import { buildPrintabilityRequest } from "../../plugins/FundaCAD.PrintToolbox/printability";
import {
  printabilityPanel,
  type PrintabilityPanel as Controller,
} from "../../plugins/FundaCAD.PrintToolbox/printabilityPanel";
import { createPrintabilityState } from "../../plugins/FundaCAD.PrintToolbox/printabilityState";
import CustomForm from "../../plugins/FundaCAD.Screws/CustomForm.vue";
import ThreadPanel from "../../plugins/FundaCAD.Screws/ThreadPanel.vue";
import {
  KINDS,
  PARTS,
  fieldPhrase,
  type FastenerSpec,
  type Kind,
  type PartName,
} from "../../plugins/FundaCAD.Screws/spec";
import {
  threadDraft,
  threadTool,
  type StandardThreadTool,
  type ThreadDraft,
} from "../../plugins/FundaCAD.Screws/threadTool";
import { ENGINE } from "../../src/app/engineKey";
import type { Engine } from "../../src/app/engine";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, ParamControl } from "../../src/types";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  printabilityPanel.value = null;
  threadDraft.value = null;
  threadTool.value = null;
});

/** The input itself, whether the selector lands on it or on a wrapper around it. */
function inputOf(el: Element | null | undefined): HTMLInputElement {
  if (!el) throw new Error("no such field");
  const input = el.matches("input") ? el : el.querySelector("input");
  if (!input) throw new Error("no input in the field");
  return input as HTMLInputElement;
}

function type(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** Enter, as a person ends an edit. The change event is what a native input answers Enter with. */
async function enter(input: HTMLInputElement) {
  press(input, "Enter");
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushPromises();
  await nextTick();
}

async function leave(input: HTMLInputElement) {
  input.blur();
  await flushPromises();
  await nextTick();
}

describe("the Printability settings", () => {
  async function panel() {
    const state = createPrintabilityState();
    printabilityPanel.value = {
      state,
      data: state.data,
      bodies: shallowRef([]),
      run: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      hover: vi.fn(),
      pick: vi.fn(),
    } as unknown as Controller;
    state.show();
    mount(PrintabilityPanel, { attachTo: document.body });
    await flushPromises();
    const setup = state.data.value!.setup;
    const field = (sel: string) => inputOf(document.body.querySelector(sel));
    const refusal = () => {
      const r = buildPrintabilityRequest(setup, []);
      return r.ok ? null : r.message;
    };
    return { setup, field, refusal };
  }

  const FIELDS = [
    {
      sel: ".printability-nozzle",
      key: "nozzle",
      word: "Nozzle",
      unit: "mm",
      shown: "0.4",
      step: 0.05,
      refused: /nozzle/,
    },
    { sel: ".printability-layer", key: "layer", word: "Layer", unit: "mm", shown: "0.2", step: 0.05, refused: /layer/ },
    {
      sel: ".printability-overhang",
      key: "overhang",
      word: "Overhang angle",
      unit: "°",
      shown: "45",
      step: 1,
      refused: /overhang/,
    },
    {
      sel: ".printability-gap",
      key: "minGap",
      word: "Smallest gap",
      unit: "mm",
      shown: "0.2",
      step: 0.05,
      refused: /gap/,
    },
    {
      sel: ".printability-bridge",
      key: "maxBridge",
      word: "Longest bridge",
      unit: "mm",
      shown: "10",
      step: 1,
      refused: /bridge/,
    },
  ] as const;

  describe.each(FIELDS)("$word", ({ sel, key, word, unit, shown, step, refused }) => {
    it("shows its default beside its label and unit", async () => {
      const { field } = await panel();
      const input = field(sel);
      expect(input.value).toBe(shown);
      const row = input.closest(".measure-row")!;
      expect(row.querySelector(".measure-k")!.textContent).toBe(word);
      expect(row.querySelector(".measure-v")!.textContent!.trim()).toBe(unit);
    });

    it("reads a decimal comma, with one write for each keystroke's change", async () => {
      const { setup, field } = await panel();
      const writes = vi.fn();
      const stop = watch(() => setup[key], writes, { flush: "sync" });
      type(field(sel), "1,5");
      await flushPromises();
      stop();
      expect(setup[key]).toBe(1.5);
      expect(writes).toHaveBeenCalledOnce();
    });

    it("takes the value as it is typed, before any blur", async () => {
      const { setup, field } = await panel();
      type(field(sel), "2.5");
      expect(setup[key]).toBe(2.5);
    });

    it("left blank holds no number, so Check says what is in the way", async () => {
      const { setup, field, refusal } = await panel();
      const input = field(sel);
      type(input, "");
      await flushPromises();
      expect(typeof setup[key]).not.toBe("number");
      expect(refusal()).toMatch(refused);
      await leave(input);
      expect(input.value).toBe("");
    });

    it("given text that is no number holds no number either, and never checks the last value", async () => {
      const { setup, field, refusal } = await panel();
      const input = field(sel);
      type(input, "2");
      await flushPromises();
      type(input, "2x");
      await flushPromises();
      expect(typeof setup[key]).not.toBe("number");
      expect(refusal()).toMatch(refused);
    });

    it("hands a value below its minimum to Check, which judges it", async () => {
      const { setup, field, refusal } = await panel();
      type(field(sel), "-1");
      await flushPromises();
      expect(setup[key]).toBe(-1);
      expect(refusal()).toMatch(refused);
    });

    it("steps by its own step with the arrows, and the arrows stop at the minimum", async () => {
      const { setup, field } = await panel();
      const input = field(sel);
      type(input, "5");
      await flushPromises();
      press(input, "ArrowUp");
      await flushPromises();
      expect(setup[key]).toBeCloseTo(5 + step, 9);
      const floor = key === "overhang" ? 1 : 0;
      type(input, String(floor));
      await flushPromises();
      press(input, "ArrowDown");
      await flushPromises();
      expect(setup[key]).toBe(floor);
    });
  });

  it("overhang typed past its maximum: 95 reaches Check, which refuses it", async () => {
    const { setup, field, refusal } = await panel();
    const input = field(".printability-overhang");
    type(input, "95");
    await flushPromises();
    expect(setup.overhang).toBe(95);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(refusal()).toMatch(/overhang/);
  });

  it("the overhang arrows stop at 89, and a typed 89.5 or 0.5 still reaches Check, which allows them", async () => {
    const { setup, field, refusal } = await panel();
    const input = field(".printability-overhang");
    type(input, "89");
    await flushPromises();
    press(input, "ArrowUp");
    await flushPromises();
    expect(setup.overhang).toBe(89);
    type(input, "89.5");
    await flushPromises();
    expect(setup.overhang).toBe(89.5);
    expect(refusal()).toBeNull();
    type(input, "0.5");
    await flushPromises();
    expect(setup.overhang).toBe(0.5);
    expect(refusal()).toBeNull();
    type(input, "95");
    await flushPromises();
    expect(setup.overhang).toBe(95);
    expect(refusal()).toMatch(/overhang/);
  });
});

describe("the Standard Thread clearance", () => {
  const SEL = "[data-testid=thread-clearance]";

  async function panel() {
    threadDraft.value = {
      editing: null,
      face: {},
      faceDiameter: null,
      external: true,
      system: "iso",
      designation: "M6",
      faceIs: "tap",
      hand: "right",
      starts: 1,
      printFit: true,
      clearance: 0.2,
    } as unknown as ThreadDraft;
    const changed = vi.fn();
    threadTool.value = { changed, cancel: vi.fn(), apply: vi.fn() } as unknown as StandardThreadTool;
    mount(ThreadPanel, { attachTo: document.body });
    await flushPromises();
    return { changed, input: inputOf(document.body.querySelector(SEL)) };
  }

  it("shows its value, keeps its label, tooltip and test id", async () => {
    const { input } = await panel();
    expect(input.matches("input")).toBe(true);
    expect(input.value).toBe("0.2");
    const label = input.closest("label")!;
    expect(label.textContent).toContain("Clearance, mm");
    expect(label.getAttribute("title")).toMatch(/Radial clearance/);
  });

  it("reads a decimal comma and tells the tool once", async () => {
    const { changed, input } = await panel();
    type(input, "0,35");
    expect(changed).not.toHaveBeenCalled();
    await enter(input);
    await leave(input);
    expect(threadDraft.value!.clearance).toBe(0.35);
    expect(changed).toHaveBeenCalledOnce();
    expect(input.value).toBe("0.35");
  });

  it("commits on blur too, and an edit that changes nothing tells nobody", async () => {
    const { changed, input } = await panel();
    type(input, "0.2");
    await leave(input);
    expect(changed).not.toHaveBeenCalled();
    type(input, "0.3");
    await leave(input);
    expect(threadDraft.value!.clearance).toBe(0.3);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("left blank is no clearance, and shows 0", async () => {
    const { changed, input } = await panel();
    type(input, "");
    await enter(input);
    expect(threadDraft.value!.clearance).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("a negative clearance lands on 0", async () => {
    const { changed, input } = await panel();
    type(input, "-1");
    await enter(input);
    expect(threadDraft.value!.clearance).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("a negative clearance typed at 0 already reads 0 back, not its own text", async () => {
    const { input } = await panel();
    type(input, "0");
    await enter(input);
    type(input, "-1");
    await enter(input);
    await leave(input);
    expect(threadDraft.value!.clearance).toBe(0);
    expect(input.value).toBe("0");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("refuses text that is no number, with its reason, and keeps the last clearance", async () => {
    const { changed, input } = await panel();
    type(input, "abc");
    await enter(input);
    expect(threadDraft.value!.clearance).toBe(0.2);
    expect(changed).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("abc");
  });

  it("steps by 0.05 with the arrows and stops at 0", async () => {
    const { input } = await panel();
    press(input, "ArrowUp");
    await nextTick();
    await enter(input);
    expect(threadDraft.value!.clearance).toBeCloseTo(0.25, 9);
    type(input, "0");
    await enter(input);
    press(input, "ArrowDown");
    await nextTick();
    await enter(input);
    expect(threadDraft.value!.clearance).toBe(0);
  });
});

describe("the Parameters number row", () => {
  const backend = {
    async rebuild() {
      return new Promise<never>(() => {});
    },
    async init() {},
    onStatus: () => () => {},
    onProgress: () => () => {},
    async cancel() {
      return true;
    },
  } as unknown as GeometryBackend;

  async function section(control: ParamControl, expr = "0.5", unit: "mm" | "deg" = "mm") {
    const doc: CadDocument = {
      parameters: {},
      paramDefs: { gap: { expr, value: Number(expr), unit, control } },
      features: [],
    } as unknown as CadDocument;
    const store = new DocumentStore(backend, doc);
    const docVersion = ref(0);
    store.onDocChange(() => {
      docVersion.value++;
    });
    const engine = { store, bridge: { docVersion, buildVersion: ref(0), metaVersion: ref(0) } } as unknown as Engine;
    const w = mount(ParametersSection, {
      global: { provide: { [ENGINE as symbol]: engine } },
      attachTo: document.body,
    });
    await nextTick();
    const setExpr = vi.spyOn(store, "setParamExpr");
    const input = inputOf(w.find('[data-param="gap"] input').element);
    return { w, store, setExpr, input };
  }
  const NUMBER: ParamControl = { kind: "number", min: 0.3, max: 9, step: 0.1 };

  it("names itself after the parameter and shows the value and its unit", async () => {
    const { w, input } = await section(NUMBER);
    expect(input.getAttribute("aria-label")).toBe("gap");
    expect(input.value).toBe("0.5");
    expect(w.find('[data-param="gap"]').text()).toContain("mm");
  });

  it("reads a decimal comma and writes the parameter once", async () => {
    const { store, setExpr, input } = await section(NUMBER);
    type(input, "1,5");
    expect(setExpr).not.toHaveBeenCalled();
    await enter(input);
    await leave(input);
    expect(setExpr).toHaveBeenCalledOnce();
    expect(store.document.paramDefs!["gap"]!.expr).toBe("1.5");
  });

  it("an edit that changes nothing writes nothing", async () => {
    const { setExpr, input } = await section(NUMBER);
    type(input, "0.5");
    await leave(input);
    expect(setExpr).not.toHaveBeenCalled();
  });

  it("clamps a value past either limit through its control, instead of refusing it", async () => {
    const { store, input } = await section(NUMBER);
    type(input, "0,1");
    await enter(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.3");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    type(input, "40");
    await enter(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("9");
  });

  it("typed past a limit it already sits on reads the limit back, not its own text", async () => {
    const { store, input } = await section(NUMBER, "0.3");
    type(input, "0.1");
    await enter(input);
    await leave(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.3");
    expect(input.value).toBe("0.3");
    const top = await section(NUMBER, "9");
    type(top.input, "40");
    await enter(top.input);
    await leave(top.input);
    expect(top.store.document.paramDefs!["gap"]!.expr).toBe("9");
    expect(top.input.value).toBe("9");
  });

  it("left blank writes 0 through its control", async () => {
    const { store, input } = await section(NUMBER);
    type(input, "");
    await enter(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.3");
    const open = await section({ kind: "number" });
    type(open.input, "");
    await enter(open.input);
    expect(open.store.document.paramDefs!["gap"]!.expr).toBe("0");
  });

  it("refuses text that is no number, a name or an expression over one, and keeps the value", async () => {
    const { store, setExpr, input } = await section(NUMBER);
    for (const text of ["abc", "gap * 2"]) {
      type(input, text);
      await enter(input);
      expect(setExpr).not.toHaveBeenCalled();
      expect(store.document.paramDefs!["gap"]!.expr).toBe("0.5");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
  });

  it("steps by the control's step, and by 1 without one, inside its limits", async () => {
    const { store, input } = await section(NUMBER);
    press(input, "ArrowUp");
    await nextTick();
    await enter(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.6");
    type(input, "0.3");
    await enter(input);
    press(input, "ArrowDown");
    await nextTick();
    await enter(input);
    expect(store.document.paramDefs!["gap"]!.expr).toBe("0.3");

    const open = await section({ kind: "number" });
    press(open.input, "ArrowUp");
    await nextTick();
    await enter(open.input);
    expect(open.store.document.paramDefs!["gap"]!.expr).toBe("1.5");
  });
});

describe("the custom fastener form", () => {
  const screw = (over: Record<string, unknown> = {}): FastenerSpec =>
    ({
      kind: "screw",
      units: "mm",
      name: "Test screw",
      head: { type: "countersunk", diameter: 7, height: 2 },
      drive: { type: "phillips", size: 3, depth: 1.5 },
      point: { type: "chamfer" },
      thread: { type: "metric", diameter: 3, pitch: 0.5, length: 10, hand: "right", modelled: false },
      length: 12,
      ...over,
    }) as unknown as FastenerSpec;

  async function form(spec = screw()) {
    const w = mount(CustomForm, {
      props: { initial: spec, editing: true },
      global: { stubs: { FastenerPreview: true } },
      attachTo: document.body,
    });
    await flushPromises();
    const field = (sel: string) => inputOf(w.element.querySelector(sel));
    const byLabel = (text: string) => {
      const label = [...w.element.querySelectorAll("label")].find((l) => l.textContent!.includes(text));
      return inputOf(label);
    };
    const problems = () => [...w.element.querySelectorAll(".scr-problems li")].map((li) => li.textContent);
    const saved = async () => {
      const save = w.get(".scr-save");
      await save.trigger("click");
      return (w.emitted("save")?.at(-1)?.[0] ?? null) as FastenerSpec | null;
    };
    return { w, field, byLabel, problems, saved };
  }
  const INCH = {
    units: "in",
    thread: { type: "unified", diameter: 0.25, pitch: 0.05, length: 0.5, hand: "right", modelled: false },
    head: { type: "countersunk", diameter: 0.5, height: 0.1 },
    drive: { type: "phillips", size: 0.2, depth: 0.05 },
    length: 1,
  };

  it("keeps a field's label wrapping it and shows the spec's values", async () => {
    const { field, byLabel } = await form();
    expect(field(".scr-thread-diameter").value).toBe("3");
    expect(field(".scr-len-length").closest("label")!.textContent).toContain("Length");
    expect(byLabel("Countersink angle").value).toBe("90");
    expect(byLabel("Driver number").value).toBe("");
  });

  it("reads a decimal comma in a part field, as typed, and saves it", async () => {
    const { field, saved, problems } = await form();
    type(field(".scr-thread-diameter"), "3,5");
    await flushPromises();
    expect(problems()).toEqual([]);
    expect((await saved())!.thread!.diameter).toBe(3.5);
  });

  it("reads a decimal comma in a length", async () => {
    const { field, saved } = await form();
    type(field(".scr-len-length"), "12,5");
    await flushPromises();
    expect((await saved())!.length).toBe(12.5);
    type(field(".scr-len-thread-length"), "7,5");
    await flushPromises();
    expect((await saved())!.thread!.length).toBe(7.5);
  });

  it("reads a decimal comma in the countersink angle and the driver number", async () => {
    const { byLabel, saved } = await form();
    type(byLabel("Countersink angle"), "82,5");
    type(byLabel("Driver number"), "1,5");
    await flushPromises();
    const s = (await saved())!;
    expect(s.head!["angle"]).toBe(82.5);
    expect(s.drive!["number"]).toBe(1.5);
  });

  it("reads threads per inch into a pitch, with a comma too", async () => {
    const { field, saved } = await form(screw(INCH));
    const tpi = field(".scr-tpi");
    expect(tpi.value).toBe("20");
    type(tpi, "12,5");
    await flushPromises();
    expect((await saved())!.thread!.pitch).toBe(0.08);
  });

  it("a blank or zero threads per inch leaves the pitch missing", async () => {
    const { field, problems } = await form(screw(INCH));
    const tpi = field(".scr-tpi");
    type(tpi, "");
    await flushPromises();
    expect(problems()[0]).toMatch(/Missing:.*pitch/i);
    type(tpi, "0");
    await flushPromises();
    expect(problems()[0]).toMatch(/Missing:.*pitch/i);
  });

  it.each([".scr-thread-diameter", ".scr-len-length"])("%s left blank is missing, and blocks Save", async (sel) => {
    const { field, problems, saved, w } = await form();
    type(field(sel), "");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Missing:/);
    await saved();
    expect(w.emitted("save")).toBeUndefined();
  });

  it.each([".scr-thread-diameter", ".scr-len-length"])("%s given text that is no number blocks Save", async (sel) => {
    const { field, problems, saved, w } = await form();
    const input = field(sel);
    type(input, "2x");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Missing:/);
    await saved();
    expect(w.emitted("save")).toBeUndefined();
  });

  it.each(["length", "thread.length"])("the %s typed negative is a problem line that holds Save", async (path) => {
    const { field, problems, saved, w } = await form();
    const input = field(`.scr-len-${path.replace(".", "-")}`);
    type(input, "-4");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Missing:.*length/i);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    await saved();
    expect(w.emitted("save")).toBeUndefined();
  });

  it("threads per inch typed negative leaves the pitch missing, and holds Save", async () => {
    const { field, problems, saved, w } = await form(screw(INCH));
    type(field(".scr-tpi"), "-20");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Missing:.*pitch/i);
    await saved();
    expect(w.emitted("save")).toBeUndefined();
  });

  // One template input renders every numeric field of every part type, so each of them is walked.
  const PART_FIELDS = (Object.keys(PARTS) as PartName[]).flatMap((p) =>
    Object.entries(PARTS[p]).flatMap(([t, def]) => def.fields.map(([f, text]) => ({ p, t, f, text }))),
  );
  const KIND_OF = (p: PartName) => (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].parts.includes(p))!;

  it.each(PART_FIELDS)("the $p $t $f typed negative is a problem line that holds Save", async ({ p, t, f, text }) => {
    const { field, problems, saved, w } = await form(screw({ kind: KIND_OF(p), [p]: { type: t } }));
    const input = field(`.scr-${p}-${f}`);
    const phrase = fieldPhrase(p, text);
    type(input, "5");
    await flushPromises();
    expect(
      problems()
        .filter((line) => line?.startsWith("Missing:"))
        .join(" "),
    ).not.toContain(phrase);
    type(input, "-1");
    await flushPromises();
    expect(problems()[0]).toMatch(/^Missing:/);
    expect(problems()[0]).toContain(phrase);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    await saved();
    expect(w.emitted("save")).toBeUndefined();
  });

  it.each([
    ["-5", /^Countersink angle: At least 1/],
    ["0", /^Countersink angle: At least 1/],
    ["200", /^Countersink angle: At most 179/],
  ])("the countersink angle typed %s is refused in the field and holds Save", async (text, line) => {
    const { byLabel, problems, saved, w } = await form();
    const input = byLabel("Countersink angle");
    type(input, text);
    await flushPromises();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(problems()).toEqual([expect.stringMatching(line)]);
    await saved();
    expect(w.emitted("save")).toBeUndefined();
    await leave(input);
    expect(input.value).toBe(text);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    type(input, "82");
    await flushPromises();
    expect(problems()).toEqual([]);
    expect((await saved())!.head!["angle"]).toBe(82);
  });

  it("the driver number typed negative is refused in the field and holds Save", async () => {
    const { byLabel, problems, saved, w } = await form();
    const input = byLabel("Driver number");
    type(input, "-1");
    await flushPromises();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(problems()).toEqual([expect.stringMatching(/^Driver number: At least 0/)]);
    await saved();
    expect(w.emitted("save")).toBeUndefined();
    type(input, "2");
    await flushPromises();
    expect(problems()).toEqual([]);
    expect((await saved())!.drive!["number"]).toBe(2);
  });

  it("a refusal goes with its field when the part type no longer asks for it", async () => {
    const { w, byLabel, problems } = await form();
    type(byLabel("Countersink angle"), "-5");
    type(byLabel("Driver number"), "-1");
    await flushPromises();
    expect(problems()).toHaveLength(2);
    const select = (option: string) =>
      w.findAll("select").find((s) => s.findAll("option").some((o) => o.element.value === option))!;
    await select("countersunk").setValue("socketCap");
    await select("phillips").setValue("hex");
    await flushPromises();
    expect(problems().join(" ")).not.toMatch(/Countersink angle|Driver number/);
  });

  it("a blank countersink angle or driver number is optional", async () => {
    const { byLabel, saved, problems } = await form();
    type(byLabel("Driver number"), "2");
    await flushPromises();
    type(byLabel("Driver number"), "");
    await flushPromises();
    expect(problems()).toEqual([]);
    expect((await saved())!.drive!["number"]).toBeUndefined();
  });

  it("a written unit is refused in inches, since the form's numbers are in its own unit", async () => {
    const { field, saved } = await form(screw(INCH));
    const input = field(".scr-len-length");
    type(input, "2");
    await flushPromises();
    type(input, "2 in");
    await flushPromises();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await saved();
    const last = (document.body.querySelector(".scr-problems li") as HTMLElement | null)?.textContent;
    expect(last).toMatch(/^Missing:/);
  });

  it("the arrows step by 1 and stop at 0 where the field has that minimum", async () => {
    const { field, byLabel, saved } = await form();
    const length = field(".scr-len-length");
    press(length, "ArrowUp");
    await flushPromises();
    expect((await saved())!.length).toBe(13);
    const driver = byLabel("Driver number");
    type(driver, "0");
    await flushPromises();
    press(driver, "ArrowDown");
    await flushPromises();
    expect((await saved())!.drive!["number"]).toBe(0);
    press(driver, "ArrowUp");
    await flushPromises();
    expect((await saved())!.drive!["number"]).toBe(1);
  });

  it("the countersink arrows stop at 1 and at 179", async () => {
    const low = await form(screw({ head: { type: "countersunk", diameter: 7, height: 2, angle: 1 } }));
    press(low.byLabel("Countersink angle"), "ArrowDown");
    await flushPromises();
    expect((await low.saved())!.head!["angle"]).toBe(1);
    const high = await form(screw({ head: { type: "countersunk", diameter: 7, height: 2, angle: 179 } }));
    press(high.byLabel("Countersink angle"), "ArrowUp");
    await flushPromises();
    expect((await high.saved())!.head!["angle"]).toBe(179);
  });
});
