// The consent screen, as the thing a person actually sees.
//
// manifest.test.ts proves the two lists are computed correctly. This proves
// they reach the screen, and that the screen does not show them before there
// is anything to decide: an install button that installs without asking is the
// one failure mode that makes every other guard in this system decoration.
//
// Nothing is stubbed. Outside Tauri the module answers "nothing installed"
// rather than throwing, which is what a plain browser session should see, and
// the install path is never reached because no test presses the second button.

import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";

enableAutoUnmount(afterEach);

const consent = ".plug-consent";

describe("the Plugins section", () => {
  it("lists what can be installed without asking anything yet", async () => {
    const w = mount(PluginsSection);
    expect(w.text()).toContain("MCP server");
    expect(w.find(consent).exists()).toBe(false);
  });

  it("shows what the plugin will and will not be able to do before it installs", async () => {
    const w = mount(PluginsSection);
    await w.get(".plug-head .btn").trigger("click");

    const block = w.get(consent);
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
    await w.get(".plug-head .btn").trigger("click");
    // The one sentence on this screen that is about the limits of the promise
    // rather than the promise. It goes when process plugins are sandboxed by
    // the OS, and not before.
    expect(w.get(consent).text()).toContain("normal program on your computer");
  });

  it("can be backed out of, leaving nothing decided", async () => {
    const w = mount(PluginsSection);
    await w.get(".plug-head .btn").trigger("click");
    expect(w.find(consent).exists()).toBe(true);

    const buttons = w.get(consent).findAll("button");
    await buttons[0]!.trigger("click");
    expect(w.find(consent).exists()).toBe(false);
  });
});
