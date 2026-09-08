// Installing a plugin nobody has seen before.
//
// The whole flow exists to put two facts in front of a person before anything
// is installed: what it will be able to do, and who they are getting it from.
// So these are the failures that matter, in order:
//
//   1. installing without a consent screen at all
//   2. showing a consent screen that does not say where the bundle came from
//   3. reading a bundle and calling that installing it
//
// Each of them passes silently in a version of this screen that looks right, so
// each has a test with a control that must fail.
//
// The plugin module is stubbed at exactly three functions: the ones that talk
// to Rust. Everything else is the real thing, including the manifest parser and
// the two-list description, because those are the parts whose output is the
// question being asked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const inspectUrl = vi.fn();
const inspectFile = vi.fn();
const pickBundle = vi.fn();
const installCandidate = vi.fn();
const installedPlugins = vi.fn();

vi.mock("../../../src/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/plugins")>();
  return {
    ...real,
    inspectUrl: (u: string) => inspectUrl(u),
    inspectFile: (p: string) => inspectFile(p),
    pickBundle: () => pickBundle(),
    installCandidate: (c: unknown) => installCandidate(c),
    installedPlugins: () => installedPlugins(),
  };
});

const PluginsSection = (await import("../../../src/components/overlays/PluginsSection.vue"))
  .default;
const { candidateFrom } = await import("../../../src/plugins");
const { useToastStore } = await import("../../../src/stores/toasts");

enableAutoUnmount(afterEach);

const STRANGER = {
  manifest: {
    id: "widgets",
    name: "Widgets",
    version: "1.2.0",
    kind: "compute",
    summary: "Adds some widgets.",
    grants: ["document.read", "document.write"],
  },
  sha256: "c".repeat(64),
  source: "https://plugins.example.com/widgets.zip",
  official: false,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

async function mounted() {
  const w = mount(PluginsSection);
  await flush();
  return w;
}

const addRow = (w: ReturnType<typeof mount>) => w.get("[data-plugin-add]");
const candidateRow = (w: ReturnType<typeof mount>) => w.find("[data-plugin-candidate]");

/** Type a URL and press the button that reads it. */
async function readUrl(w: ReturnType<typeof mount>, url: string) {
  const field = addRow(w).get("input.plug-url");
  await field.setValue(url);
  await addRow(w).findAll("button")[0]!.trigger("click");
  await flush();
}

beforeEach(() => {
  // A real toast store, not a stub. Every failure below is meant to be
  // reported to the person who caused it, and a screen that swallows a refusal
  // is indistinguishable from one that never checked.
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
  installedPlugins.mockResolvedValue([]);
  inspectUrl.mockResolvedValue(candidateFrom(STRANGER, "url"));
});
afterEach(() => localStorage.clear());

describe("reading a bundle from a link", () => {
  it("does not read anything until the button is pressed", async () => {
    const w = await mounted();
    expect(inspectUrl).not.toHaveBeenCalled();
    expect(candidateRow(w).exists()).toBe(false);
    // And the button will not act on an empty field.
    expect(addRow(w).findAll("button")[0]!.attributes("disabled")).toBeDefined();
  });

  it("describes it, and installs nothing by doing so", async () => {
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/widgets.zip");

    expect(inspectUrl).toHaveBeenCalledWith("https://plugins.example.com/widgets.zip");
    // The screen changed. Nothing was installed.
    expect(candidateRow(w).exists()).toBe(true);
    expect(installCandidate).not.toHaveBeenCalled();
  });

  it("says who it is from, and does not dress it up as ours", async () => {
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/widgets.zip");

    const origin = candidateRow(w).get(".plug-origin").text();
    expect(origin).toContain("plugins.example.com");
    expect(origin).toContain("Nobody has checked it but you");
    // The control: the sentence reserved for what we published must not appear
    // over a bundle from somewhere else.
    expect(origin).not.toContain("published by FundaCAD");
  });

  it("says the other thing when it really is ours", async () => {
    inspectUrl.mockResolvedValue(
      candidateFrom(
        {
          ...STRANGER,
          source: "https://github.com/Paraxdev/fundacad/releases/download/beta/widgets.zip",
          official: true,
        },
        "url",
      ),
    );
    const w = await mounted();
    await readUrl(w, "https://github.com/Paraxdev/fundacad/releases/download/beta/widgets.zip");

    const origin = candidateRow(w).get(".plug-origin").text();
    expect(origin).toContain("published by FundaCAD");
    expect(origin).not.toContain("Nobody has checked it but you");
  });

  it("shows what it will and will not be able to do", async () => {
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/widgets.zip");

    const block = candidateRow(w).get(".plug-consent");
    expect(block.find(".plug-can").text()).toContain("Change the document you have open");
    // The control. Widgets asked for two document permissions and nothing else,
    // so a screen that listed the printer would be listing everything.
    expect(block.find(".plug-can").text()).not.toContain("Send jobs to your printer");
    expect(block.find(".plug-cannot").text()).toContain("Touch your printer");
  });

  it("reports a bundle it could not read, and offers nothing to install", async () => {
    inspectUrl.mockRejectedValue(new Error('unknown permission: "gpu.direct"'));
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/bad.zip");

    expect(candidateRow(w).exists()).toBe(false);
    expect(installCandidate).not.toHaveBeenCalled();
    // Reported in full, naming the line that was wrong. "Could not install" on
    // its own is a message nobody can tell from a flat network.
    const said = useToastStore().items.map((t) => t.message).join(" ");
    expect(said).toContain("gpu.direct");
  });
});

describe("agreeing to it", () => {
  it("installs only on the second press, and passes the pinned digest", async () => {
    installCandidate.mockResolvedValue({});
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/widgets.zip");

    const buttons = candidateRow(w).get(".plug-consent").findAll("button");
    await buttons[1]!.trigger("click");
    await flush();

    expect(installCandidate).toHaveBeenCalledTimes(1);
    const sent = installCandidate.mock.calls[0]![0] as { sha256: string; source: string };
    // The digest of what was read goes back down, so a bundle whose bytes moved
    // between the screen and the install is refused rather than installed under
    // the description that was shown.
    expect(sent.sha256).toBe("c".repeat(64));
    expect(sent.source).toBe("https://plugins.example.com/widgets.zip");
  });

  it("backs out leaving nothing installed", async () => {
    const w = await mounted();
    await readUrl(w, "https://plugins.example.com/widgets.zip");

    const buttons = candidateRow(w).get(".plug-consent").findAll("button");
    await buttons[0]!.trigger("click");

    expect(candidateRow(w).exists()).toBe(false);
    expect(installCandidate).not.toHaveBeenCalled();
  });
});

describe("reading a bundle from a file", () => {
  it("asks for a file, then describes what was picked", async () => {
    pickBundle.mockResolvedValue("C:/Users/x/widgets.zip");
    inspectFile.mockResolvedValue(
      candidateFrom({ ...STRANGER, source: "C:/Users/x/widgets.zip" }, "file"),
    );
    const w = await mounted();
    await addRow(w).findAll("button")[1]!.trigger("click");
    await flush();

    expect(inspectFile).toHaveBeenCalledWith("C:/Users/x/widgets.zip");
    expect(candidateRow(w).get(".plug-origin").text()).toContain("a file on this computer");
    expect(installCandidate).not.toHaveBeenCalled();
  });

  it("does nothing at all when the picker is dismissed", async () => {
    pickBundle.mockResolvedValue(null);
    const w = await mounted();
    await addRow(w).findAll("button")[1]!.trigger("click");
    await flush();

    expect(inspectFile).not.toHaveBeenCalled();
    expect(candidateRow(w).exists()).toBe(false);
  });
});

describe("the list of what is installed", () => {
  const record = (over: Record<string, unknown>) => ({
    id: "widgets",
    version: "1.2.0",
    promise: "compute|document.read",
    source: "https://plugins.example.com/widgets.zip",
    sha256: "c".repeat(64),
    installedAt: 0,
    dir: "/plugins/widgets",
    consented: { kind: "compute", version: "1.2.0", grants: ["document.read"], hosts: [] },
    official: false,
    ...over,
  });

  it("says where a plugin came from when it is not ours", async () => {
    installedPlugins.mockResolvedValue([record({})]);
    const w = await mounted();
    expect(w.get('[data-plugin="widgets"]').text()).toContain(
      "Installed from plugins.example.com",
    );
  });

  it("says nothing about origin when it is ours", async () => {
    // A label on every row is a label nobody reads, so the one that matters
    // only appears where it means something.
    installedPlugins.mockResolvedValue([
      record({
        official: true,
        source: "https://github.com/Paraxdev/fundacad/releases/download/beta/widgets.zip",
      }),
    ]);
    const w = await mounted();
    expect(w.get('[data-plugin="widgets"]').text()).not.toContain("Installed from");
  });

  it("says so plainly for one installed off the disk", async () => {
    installedPlugins.mockResolvedValue([record({ source: "C:/Users/x/widgets.zip" })]);
    const w = await mounted();
    expect(w.get('[data-plugin="widgets"]').text()).toContain(
      "Installed from a file on this computer",
    );
  });

  it("does not describe one whose record it cannot read", async () => {
    // Fail closed, on a screen. A row that cannot be described accurately must
    // not be described reassuringly.
    installedPlugins.mockResolvedValue([
      record({ consented: { kind: "compute", version: "1", grants: ["gpu.direct"], hosts: [] } }),
    ]);
    const w = await mounted();
    const shown = w.get('[data-plugin="widgets"]');
    expect(shown.text()).toContain("cannot read what this plugin agreed to");
    expect(shown.find(".plug-consent").exists()).toBe(false);
  });

  it("stops offering a suggestion once it is installed", async () => {
    installedPlugins.mockResolvedValue([record({ id: "FundaCAD.MCP" })]);
    const w = await mounted();
    // One row, not two: the suggested entry and the installed one are the same
    // plugin, and a screen showing both offers to install what is installed.
    expect(w.findAll('[data-plugin="FundaCAD.MCP"]').length).toBe(1);
    expect(w.get('[data-plugin="FundaCAD.MCP"]').text()).toContain("Remove");
  });
});
