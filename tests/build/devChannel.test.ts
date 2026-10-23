// The development build as its own product, FundaCAD Dev, and the Start menu
// entry an install started by the updater makes. The bundle itself is checked
// on the Windows runner (build.yml, "Install as the updater does and find the
// Start menu entry"); this holds the configs that step relies on.

import { describe, expect, it } from "vitest";

import confRaw from "../../src-tauri/tauri.conf.json?raw";
import betaRaw from "../../src-tauri/tauri.beta.conf.json?raw";
import stableRaw from "../../src-tauri/tauri.stable.conf.json?raw";
import devRaw from "../../src-tauri/tauri.dev.conf.json?raw";
import productRaw from "../../src-tauri/tauri.dev-product.conf.json?raw";
import hooks from "../../src-tauri/windows/installer-hooks.nsh?raw";
import workflow from "../../.github/workflows/build.yml?raw";
import linkRs from "../../crates/fundacad-mcp/src/link.rs?raw";
import { productName, versionLabel } from "../../src/app/channel";

const conf = JSON.parse(confRaw);
const product = JSON.parse(productRaw);
const channels = { beta: JSON.parse(betaRaw), stable: JSON.parse(stableRaw), dev: JSON.parse(devRaw) };

describe("FundaCAD Dev", () => {
  it("is a product of its own that installs beside the beta", () => {
    expect(product.productName).toBe("FundaCAD Dev");
    expect(product.productName).not.toBe(conf.productName);
    expect(product.identifier).not.toBe(conf.identifier);
    expect(product.mainBinaryName).toBe("fundacad-dev");
    expect(product.app.windows[0].title).toBe("FundaCAD Dev");
  });

  it("keeps the beta's window apart from its title", () => {
    expect(product.app.windows).toHaveLength(conf.app.windows.length);
    expect({ ...product.app.windows[0], title: conf.app.windows[0].title }).toEqual(conf.app.windows[0]);
    expect(product.app.security).toBeUndefined();
  });

  it("leaves .funda and .fundab to the beta", () => {
    expect(conf.bundle.fileAssociations.length).toBeGreaterThan(0);
    expect(product.bundle.fileAssociations).toEqual([]);
  });

  it("keeps the development update feed", () => {
    expect(product.plugins).toBeUndefined();
    expect(channels.dev.plugins.updater.endpoints).toEqual([
      "https://github.com/Paraxdev/fundacad/releases/download/development/latest.json",
    ]);
  });

  it("leaves the beta and stable names alone", () => {
    for (const [name, c] of Object.entries(channels)) {
      for (const key of ["productName", "identifier", "mainBinaryName"])
        expect(c[key], `${name} ${key}`).toBeUndefined();
    }
  });

  it("is built only for the development channel, and not on Linux", () => {
    expect(workflow).toContain('if [ "${{ needs.channel.outputs.config }}" = dev ] && [ "$RUNNER_OS" != Linux ]; then');
    expect(workflow).toContain('args="$args --config src-tauri/tauri.dev-product.conf.json"');
    expect(workflow).toContain("args: --verbose ${{ env.TAURI_CONFIG_ARGS }}");
  });

  it("ships its renamed binary as the portable build", () => {
    expect(workflow).toContain(`src-tauri/target/release/${product.mainBinaryName}.exe`);
    expect(workflow).toContain("put 'fundacad*.exe' FundaCAD-windows-x64-portable.exe");
  });

  it("is the app the development release notes name", () => {
    expect(workflow).toContain(`[ "$RELEASE" != development ] || app='${product.productName}'`);
  });

  it("finds itself as the engine when started as an MCP server", () => {
    expect(linkRs).toContain(`"${product.mainBinaryName}.exe"`);
    expect(linkRs).toContain(`"${product.mainBinaryName}"`);
  });

  it("names itself in the window title and shows its build number", () => {
    expect(productName("development")).toBe(product.productName);
    expect(productName("beta")).toBe(conf.productName);
    expect(productName("v1.2.0")).toBe(conf.productName);
    expect(versionLabel("1.0.512", "development")).toBe("dev-512");
    expect(versionLabel("1.0.512", "beta")).toBe("1.0.512");
    expect(versionLabel("1.2.3", "v1.2.3")).toBe("1.2.3");
    expect(versionLabel("unknown", "development")).toBe("unknown");
  });
});

describe("an install the updater starts", () => {
  it("runs the installer in a mode the hook covers", () => {
    // passive, the default, is /P /R /UPDATE; quiet is /S /R /UPDATE.
    const mode = conf.plugins.updater.windows?.installMode;
    expect([undefined, "passive", "quiet"]).toContain(mode);
    for (const c of [...Object.values(channels), product]) expect(c.plugins?.updater?.windows).toBeUndefined();
  });

  it("makes the Start menu entry when nothing is installed yet", () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe("windows/installer-hooks.nsh");
    for (const c of [...Object.values(channels), product]) {
      expect(c.bundle?.windows?.nsis?.installerHooks).toBeUndefined();
    }
    const preinstall = /!macro NSIS_HOOK_PREINSTALL([\s\S]*?)!macroend/.exec(hooks)?.[1] ?? "";
    expect(preinstall).toContain("${If} $UpdateMode = 1");
    expect(preinstall).toContain('${AndIfNot} ${FileExists} "$INSTDIR\\${MAINBINARYNAME}.exe"');
    expect(preinstall).toContain("StrCpy $UpdateMode 0");
  });
});
