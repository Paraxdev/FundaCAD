// The Experimental page: its numbers are NumberFields that commit on Enter or blur, the HDR size a Segmented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import ExperimentalSection from "../../../src/components/overlays/ExperimentalSection.vue";
import {
  DEFAULT_EXPERIMENTAL,
  experimentalPrefs,
  resetExperimentalPrefs,
  setExperimentalPref,
} from "../../../src/ui/experimentalPrefs";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../../../src/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/toast")>()),
  toast,
}));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../../../src/ui/choice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/choice")>()),
  confirmDanger: confirm,
}));

enableAutoUnmount(afterEach);

async function open() {
  const w = mount(ExperimentalSection, { attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
type W = Awaited<ReturnType<typeof open>>;

const box = (w: W, key: string) => w.get(`#prefs-x-${key}`);
const el = (w: W, key: string) => box(w, key).element as HTMLInputElement;

async function type(w: W, key: string, text: string, end: "Enter" | "blur" = "Enter") {
  await box(w, key).setValue(text);
  if (end === "Enter") await box(w, key).trigger("keydown", { key: "Enter" });
  else await box(w, key).trigger("blur");
  await flushPromises();
}

beforeEach(() => {
  resetExperimentalPrefs();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  toast.mockReset();
});

describe("Experimental numbers", () => {
  it("keeps the ids, labels and data hooks on the typed field", async () => {
    const w = await open();
    expect(w.get("label[for=prefs-x-bounces]").text()).toBe("Bounces");
    expect([el(w, "bounces").dataset.experimental, el(w, "bounces").value]).toEqual(["bounces", "6"]);
  });

  it("puts each unit word in the field's chip and says it, with no separate readout", async () => {
    const w = await open();
    expect(w.findAll(".prefs-readout").length).toBe(0);
    const words = (key: string) => {
      const field = box(w, key).element.closest(".ui-number-field")!;
      const ids = (el(w, key).getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      return [
        [...field.querySelectorAll(".ui-unit-chip")].map((c) => c.textContent),
        ids.map((id) => document.getElementById(id)?.textContent),
      ];
    };
    expect(words("bounces")).toEqual([["bounces"], ["bounces"]]);
    expect(words("firefly")).toEqual([["luminance"], ["luminance"]]);
    await type(w, "bounces", "999");
    expect(words("bounces")[1]).toEqual(["bounces", "At most 64 bounces"]);
  });

  it("commits on Enter or blur, not while typing", async () => {
    const w = await open();
    await box(w, "bounces").setValue("12");
    expect(experimentalPrefs().bounces).toBe(DEFAULT_EXPERIMENTAL.bounces);
    await box(w, "bounces").trigger("keydown", { key: "Enter" });
    expect(experimentalPrefs().bounces).toBe(12);
    await type(w, "firefly", "40", "blur");
    expect(experimentalPrefs().firefly).toBe(40);
  });

  it("refuses a value past the range and keeps the text with the reason", async () => {
    const w = await open();
    await type(w, "bounces", "999");
    expect(experimentalPrefs().bounces).toBe(DEFAULT_EXPERIMENTAL.bounces);
    expect([el(w, "bounces").value, el(w, "bounces").getAttribute("aria-invalid"), el(w, "bounces").title]).toEqual([
      "999",
      "true",
      "At most 64 bounces",
    ]);
  });

  it("steps with the arrows by the field's own step", async () => {
    const w = await open();
    await box(w, "bounces").trigger("keydown", { key: "ArrowUp" });
    await box(w, "bounces").trigger("keydown", { key: "Enter" });
    expect(experimentalPrefs().bounces).toBe(7);
    await box(w, "traceScale").trigger("keydown", { key: "ArrowUp" });
    await box(w, "traceScale").trigger("keydown", { key: "Enter" });
    expect(experimentalPrefs().traceScale).toBe(0.05);
  });

  it("reads an empty trace resolution as Auto and stores millions of triangles", async () => {
    setExperimentalPref("traceScale", 0.5);
    const w = await open();
    expect(el(w, "traceScale").value).toBe("0.5");
    await type(w, "traceScale", "", "blur");
    expect([experimentalPrefs().traceScale, el(w, "traceScale").value, el(w, "traceScale").placeholder]).toEqual([
      0,
      "",
      "Auto",
    ]);
    await type(w, "triangleBudget", "2");
    expect(experimentalPrefs().triangleBudget).toBe(2_000_000);
  });
});

describe("Experimental HDR size and reset", () => {
  it("is one Tab stop whose arrows pick a width, each choice keeping its data hook", async () => {
    const w = await open();
    const radios = () => w.findAll("#prefs-env-width [role=radio]");
    expect(radios().map((r) => [r.attributes("data-env-width"), r.attributes("tabindex")])).toEqual([
      ["2048", "0"],
      ["4096", "-1"],
      ["8192", "-1"],
      ["16384", "-1"],
      ["gpu", "-1"],
    ]);
    (radios()[0]!.element as HTMLElement).focus();
    await radios()[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(experimentalPrefs().envWidth).toBe(4096);
    expect((document.activeElement as HTMLElement).dataset.envWidth).toBe("4096");
  });

  it("holds Reset disabled until something changed, then resets", async () => {
    const w = await open();
    const reset = w.get("[data-experimental-reset]");
    expect(reset.attributes("aria-disabled")).toBe("true");
    setExperimentalPref("bounces", 12);
    await flushPromises();
    expect(reset.attributes("aria-disabled")).toBeUndefined();
    await reset.trigger("click");
    await flushPromises();
    expect(confirm.mock.calls.map((c) => [c[0], c[1]])).toEqual([["Reset experimental limits?", "Reset"]]);
    expect(experimentalPrefs().bounces).toBe(DEFAULT_EXPERIMENTAL.bounces);
    expect(w.get("[data-experimental-reset]").attributes("aria-disabled")).toBe("true");
    expect(toast.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/Experimental.*defaults/)]);
  });

  it("keeps every changed limit when the confirm is cancelled", async () => {
    const w = await open();
    setExperimentalPref("bounces", 12);
    setExperimentalPref("envWidth", 4096);
    await flushPromises();
    confirm.mockResolvedValueOnce(false);
    await w.get("[data-experimental-reset]").trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect([experimentalPrefs().bounces, experimentalPrefs().envWidth]).toEqual([12, 4096]);
    expect(w.get("[data-experimental-reset]").attributes("aria-disabled")).toBeUndefined();
    expect(toast).not.toHaveBeenCalled();
  });
});
