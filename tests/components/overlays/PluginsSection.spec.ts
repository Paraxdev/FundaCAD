// The Plugins screen, as the thing a person actually sees.
//
// manifest.test.ts proves the two lists are computed correctly and
// registry.spec.ts proves the switches persist. This proves they reach the
// screen, that the screen distinguishes the app's own capabilities from
// somebody else's code, and that it does not install without asking: an install
// button that installs without a consent screen is the one failure that makes
// every other guard in this system decoration.
//
// Nothing is stubbed. Outside Tauri the plugin module answers "nothing
// installed" rather than throwing, which is what a plain browser session should
// see, and the install path is never reached because no test presses the second
// button.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";
import { pluginEnabled, setPluginEnabled } from "../../../src/plugins/registry";

enableAutoUnmount(afterEach);

const consent = ".plug-consent";
// Selected by identity rather than by position. An earlier version of this file
// indexed into `.plug-row`, and adding a row to the screen silently pointed
// every assertion at the wrong plugin, which is a way for a test about consent
// to keep passing while testing nothing.
const row = (w: ReturnType<typeof mount>, id: string) => w.get(`[data-plugin="${id}"]`);
/** the rows for the app's own capabilities, in registry order */
const builtinRows = (w: ReturnType<typeof mount>) =>
  ["multi-material", "printing", "spacemouse"].map((id) => row(w, id));
/** the row for the one thing that is downloaded */
const downloadRow = (w: ReturnType<typeof mount>) => row(w, "mcp");

beforeEach(() => {
  localStorage.clear();
  setPluginEnabled("multi-material", false);
  setPluginEnabled("printing", true);
  setPluginEnabled("spacemouse", true);
});
afterEach(() => localStorage.clear());

describe("the capabilities that are in the app", () => {
  it("lists them with a switch each, on where they were on", () => {
    const w = mount(PluginsSection);
    expect(w.text()).toContain("Printer connection");
    expect(w.text()).toContain("3D mouse");
    expect(w.text()).toContain("Multi-material");

    const boxes = w.findAll<HTMLInputElement>(".plug-row input[type=checkbox]");
    expect(boxes.length).toBe(3);
    // multi-material, printing, spacemouse — registry order.
    expect(boxes.map((b) => b.element.checked)).toEqual([false, true, true]);
  });

  it("turns one off, and that is what the rest of the app will read", async () => {
    const w = mount(PluginsSection);
    const printing = w.findAll<HTMLInputElement>(".plug-row input[type=checkbox]")[1]!;
    printing.element.checked = false;
    await printing.trigger("change");
    // The screen is a view of the registry, not a second copy of the answer.
    // Everything that hides a menu row or declines to load a chunk reads this.
    expect(pluginEnabled("printing")).toBe(false);
  });

  it("shows what a capability uses when it is switched on", async () => {
    const w = mount(PluginsSection);
    expect(w.find(consent).exists()).toBe(false);

    const multi = w.findAll<HTMLInputElement>(".plug-row input[type=checkbox]")[0]!;
    multi.element.checked = true;
    await multi.trigger("change");

    const block = builtinRows(w)[0]!.get(consent);
    expect(block.text()).toContain("Change the document you have open");
    // The control: a capability that reads and writes the document is not
    // thereby a capability that touches your printer, and the screen has to be
    // able to tell those apart or it says nothing.
    expect(block.find(".plug-can").text()).not.toContain("Send jobs to your printer");
    expect(block.find(".plug-cannot").text()).toContain("Touch your printer");
  });

  it("does not describe the app's own code as if something were containing it", async () => {
    const w = mount(PluginsSection);
    await builtinRows(w)[1]!.get(".plug-link").trigger("click");
    const note = builtinRows(w)[1]!.get(consent).text();
    expect(note).toContain("part of FundaCAD itself");
    // The sentence a downloaded process plugin gets. Reusing it here would be
    // claiming a boundary that does not exist.
    expect(note).not.toContain("Install it only if you trust where it came from");
  });
});

describe("the plugins that are downloaded", () => {
  it("offers one, and asks nothing until the button is pressed", () => {
    const w = mount(PluginsSection);
    expect(w.text()).toContain("MCP server");
    expect(w.find(consent).exists()).toBe(false);
  });

  it("shows what it will and will not be able to do before it installs", async () => {
    const w = mount(PluginsSection);
    await downloadRow(w).get(".btn").trigger("click");

    const block = downloadRow(w).get(consent);
    expect(block.text()).toContain("Change the document you have open");
    expect(block.text()).toContain("Use the geometry engine");

    // The half that makes the other half mean something. The MCP server asks
    // for neither of these, so both belong on this side.
    expect(block.find(".plug-cannot").text()).toContain("Use the internet");
    expect(block.find(".plug-cannot").text()).toContain("Start other programs on your computer");

    // And the control: a permission it did NOT ask for must not appear as one
    // it has. Without this the test passes on a block that lists everything.
    expect(block.find(".plug-can").text()).not.toContain("Send jobs to your printer");
  });

  it("says a process plugin is a program on the machine", async () => {
    const w = mount(PluginsSection);
    await downloadRow(w).get(".btn").trigger("click");
    // The one sentence on this screen that is about the limits of the promise
    // rather than the promise. It goes when process plugins are sandboxed by
    // the OS, and not before.
    expect(downloadRow(w).get(consent).text()).toContain("normal program on your computer");
  });

  it("can be backed out of, leaving nothing decided", async () => {
    const w = mount(PluginsSection);
    await downloadRow(w).get(".btn").trigger("click");
    expect(downloadRow(w).find(consent).exists()).toBe(true);

    const buttons = downloadRow(w).get(consent).findAll("button");
    await buttons[0]!.trigger("click");
    expect(downloadRow(w).find(consent).exists()).toBe(false);
  });
});
