// The Plugins screen, as the thing a person actually sees.
//
// manifest.test.ts proves the two lists are computed correctly and
// registry.spec.ts proves the switch persists. This proves they reach the
// screen, and that it does not install without asking: an install button that
// installs without a consent screen is the one failure that makes every other
// guard in this system decoration.
//
// EVERY PLUGIN IS A DOWNLOAD NOW, including the ones written in this
// repository, so this file no longer has an "in the app" half. What it lost
// with that half is worth naming: there used to be rows on this screen for
// three capabilities that were already present, with a switch each and no
// install step. Nothing is already present.
//
// Nothing is stubbed. Outside Tauri the plugin module answers "nothing
// installed" rather than throwing, which is what a plain browser session should
// see, and the install path is never reached because no test presses the second
// button.

import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";

enableAutoUnmount(afterEach);

const consent = ".plug-consent";
// Selected by identity rather than by position. An earlier version of this file
// indexed into `.plug-row`, and adding a row to the screen silently pointed
// every assertion at the wrong plugin, which is a way for a test about consent
// to keep passing while testing nothing.
const row = (w: ReturnType<typeof mount>, id: string) => w.get(`[data-plugin="${id}"]`);
const offerRow = (w: ReturnType<typeof mount>, id: string) => row(w, id);

afterEach(() => localStorage.clear());

describe("what is offered", () => {
  it("offers every plugin this project publishes, and none of them is already here", () => {
    const w = mount(PluginsSection);
    for (const name of ["MCP server", "Printer connection", "3D mouse", "Multi-material"]) {
      expect(w.text(), name).toContain(name);
    }
    // Nothing installed, so no switch: the only control on an offer is Install.
    expect(w.findAll("input[type=checkbox]").length).toBe(0);
    expect(w.text()).toContain("Nothing installed yet.");
  });

  it("says a builtin runs with the app's own reach", async () => {
    // The sentence that carries the whole bargain for a plugin that draws. It
    // used to describe code that was already in the app and could not be
    // refused; it now describes a download, which is exactly when somebody
    // needs to read it.
    const w = mount(PluginsSection);
    await offerRow(w, "FundaCAD.Printing").get(".btn").trigger("click");
    const note = offerRow(w, "FundaCAD.Printing").get(consent).text();
    expect(note).toContain("Part of FundaCAD itself");
    // The sentence a process plugin gets. Reusing it here would describe a
    // boundary neither of them has, in words that suggest one of them does.
    expect(note.toLowerCase()).not.toContain("normal program on your computer");
  });

  it("tells one plugin's reach from another's", async () => {
    const w = mount(PluginsSection);
    await offerRow(w, "FundaCAD.MultiColor").get(".btn").trigger("click");
    const block = offerRow(w, "FundaCAD.MultiColor").get(consent);
    expect(block.text()).toContain("Change the document you have open");
    // The control: a plugin that reads and writes the document is not thereby a
    // plugin that touches your printer, and the screen has to be able to tell
    // those apart or it says nothing.
    expect(block.find(".plug-can").text()).not.toContain("Send jobs to your printer");
    expect(block.find(".plug-cannot").text()).toContain("Touch your printer");
  });
});

describe("the plugins that are downloaded", () => {
  const downloadRow = (w: ReturnType<typeof mount>) => row(w, "FundaCAD.MCP");

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
