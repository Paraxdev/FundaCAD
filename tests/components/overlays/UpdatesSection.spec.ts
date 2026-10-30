import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const h = vi.hoisted(() => ({
  supported: true,
  seen: false,
  answer: null as string | null,
  choose: vi.fn(),
  open: vi.fn(async (_url: string) => {}),
}));
vi.mock("../../../src/ui/updates", () => ({ updatesSupported: async () => h.supported }));
vi.mock("../../../src/ui/choice", () => ({ choose: h.choose }));
vi.mock("../../../src/ui/welcome", () => ({ openExternal: h.open }));
vi.mock("../../../src/ui/updateChannel", async (orig) => ({
  ...(await orig<typeof import("../../../src/ui/updateChannel")>()),
  stableReleaseSeen: () => h.seen,
}));

import UpdatesSection from "../../../src/components/overlays/UpdatesSection.vue";
import { autoUpdateCheck, setAutoUpdateCheck, setUpdatePeriod, updatePeriod } from "../../../src/ui/updatePrefs";
import { recordStableSeen, setUpdateChannel, updateChannel } from "../../../src/ui/updateChannel";

enableAutoUnmount(afterEach);

async function open() {
  const w = mount(UpdatesSection, { attachTo: document.body });
  await flushPromises();
  return w;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const channel = () => $("#prefs-update-channel");
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const label = (o: HTMLElement) => o.querySelector(".opt-label")!.textContent;
const text = (el: Element) => el.textContent!.trim();

async function pick(name: string) {
  channel().click();
  await flushPromises();
  options()
    .find((o) => label(o) === name)!
    .click();
  await flushPromises();
}

beforeEach(() => {
  h.supported = true;
  h.seen = false;
  h.answer = null;
  h.choose.mockReset().mockImplementation(async () => h.answer);
  h.open.mockClear();
  setUpdateChannel("beta");
  localStorage.removeItem("fundacad.updates.channel");
  setAutoUpdateCheck(true);
  setUpdatePeriod("daily");
});

describe("Updates in Preferences", () => {
  it("shows the switch on and the period Daily by default", async () => {
    const w = await open();
    const sw = w.get("#prefs-update-auto input").element as HTMLInputElement;
    const period = w.get("#prefs-update-period");
    expect([sw.checked, period.text(), period.attributes("disabled")]).toEqual([true, "Daily", undefined]);
  });

  it("writes the switch and disables the period while it is off", async () => {
    const w = await open();
    await w.get("#prefs-update-auto input").setValue(false);
    expect([autoUpdateCheck(), w.get("#prefs-update-period").attributes("aria-disabled")]).toEqual([false, "true"]);
    await w.get("#prefs-update-auto input").setValue(true);
    expect([autoUpdateCheck(), w.get("#prefs-update-period").attributes("aria-disabled")]).toEqual([true, undefined]);
  });

  it("follows a period set elsewhere", async () => {
    const w = await open();
    setUpdatePeriod("launch");
    await flushPromises();
    expect([updatePeriod(), w.get("#prefs-update-period").text()]).toEqual(["launch", "Every launch"]);
  });

  it("says where updates come from on an install that cannot update itself, with no controls", async () => {
    h.supported = false;
    const w = await open();
    expect([
      w.get("[data-updates-unsupported]").text(),
      w.find("#prefs-update-auto").exists(),
      w.find("#prefs-update-period").exists(),
      w.find("#prefs-update-channel").exists(),
      w.get("[data-updates-channel-info]").text(),
    ]).toEqual([
      "This install updates through its package manager, the GitHub releases page or the SourceForge mirror.",
      false,
      false,
      false,
      "Channel Beta",
    ]);
  });
});

describe("the Channel row", () => {
  it("is a combobox named Channel with its value, described by its hint", async () => {
    const w = await open();
    expect([
      channel().getAttribute("role"),
      channel().getAttribute("aria-label"),
      text($("label[for=prefs-update-channel]")),
      channel().getAttribute("aria-describedby"),
      text($("#prefs-update-channel-hint")),
      w.find("[data-updates-channel-info]").exists(),
    ]).toEqual([
      "combobox",
      "Channel, Beta",
      "Channel",
      "prefs-update-channel-hint",
      "The next check looks in this channel. Its files are also on the SourceForge mirror.",
      false,
    ]);
  });

  it("offers Stable only once a stable release is seen, and Development as an install beside", async () => {
    await open();
    channel().click();
    await flushPromises();
    expect(
      options().map((o) => [label(o), o.getAttribute("aria-disabled"), o.querySelector(".opt-hint")?.textContent]),
    ).toEqual([
      ["Stable", "true", "No stable release yet"],
      ["Beta", null, undefined],
      ["Development", null, "Installs FundaCAD Dev beside this app"],
    ]);
  });

  it("enables Stable when a check finds a stable release", async () => {
    await open();
    h.seen = true;
    recordStableSeen(true);
    await flushPromises();
    channel().click();
    await flushPromises();
    expect(options()[0]!.getAttribute("aria-disabled")).toBeNull();
  });

  it("switches Beta to Stable and back, so the next check asks the picked feed", async () => {
    h.seen = true;
    await open();
    await pick("Stable");
    expect([updateChannel(), localStorage.getItem("fundacad.updates.channel"), text(channel())]).toEqual([
      "stable",
      "stable",
      "Stable",
    ]);
    await pick("Beta");
    expect([updateChannel(), localStorage.getItem("fundacad.updates.channel"), text(channel())]).toEqual([
      "beta",
      "beta",
      "Beta",
    ]);
  });

  it("never stores Development, it offers FundaCAD Dev beside this app and opens its release page", async () => {
    h.answer = "open";
    await open();
    await pick("Development");
    expect(h.choose.mock.calls[0]!.slice(0, 2)).toEqual([
      "Install FundaCAD Dev beside this app",
      [
        { value: "open", label: "Open release page" },
        { value: "cancel", label: "Cancel" },
      ],
    ]);
    expect([
      updateChannel(),
      localStorage.getItem("fundacad.updates.channel"),
      text(channel()),
      h.open.mock.calls,
    ]).toEqual(["beta", null, "Beta", [["https://github.com/Paraxdev/fundacad/releases/tag/development"]]]);
  });

  it("opens nothing when the install beside is cancelled", async () => {
    await open();
    await pick("Development");
    expect([h.choose.mock.calls.length, h.open.mock.calls.length, updateChannel()]).toEqual([1, 0, "beta"]);
  });

  it("opens the SourceForge mirror folder of the picked channel", async () => {
    h.seen = true;
    const w = await open();
    await w.get("[data-updates-mirror]").trigger("click");
    setUpdateChannel("stable");
    await flushPromises();
    await w.get("[data-updates-mirror]").trigger("click");
    expect(h.open.mock.calls).toEqual([
      ["https://sourceforge.net/projects/fundacad/files/beta/"],
      ["https://sourceforge.net/projects/fundacad/files/"],
    ]);
  });
});
