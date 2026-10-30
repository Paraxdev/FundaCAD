// The updater signing key lives in the updater-signing environment and reaches only the sign job, which builds
// nothing and runs no package scripts, so no build plugin, crate build script or downloaded tool sees it.

import { describe, expect, it } from "vitest";
import { grants } from "../../scripts/actionPins.mjs";

const all = import.meta.glob("../../.github/**/*.{yml,yaml}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const buildPath = Object.keys(all).find((p) => p.endsWith("/workflows/build.yml"))!;
const build = all[buildPath].replace(/\r\n/g, "\n");
const updaterAction = all[Object.keys(all).find((p) => p.endsWith("/actions/updater-artifacts/action.yml"))!].replace(
  /\r\n/g,
  "\n",
);

function job(name: string): string {
  const lines = build.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

const steps = (text: string) => text.split(/\n {6}- /).slice(1);
const usesOf = (text: string) => [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1].replace(/@.*$/, ""));
const runText = (text: string) =>
  [...(text + "\n").matchAll(/^([ \t]*)(?:- )?run:[ \t]*(\|?)(.*)\n((?:\1[ \t]+.*\n|[ \t]*\n)*)/gm)]
    .map((m) => m[3] + "\n" + m[4])
    .join("\n");

const FORBIDDEN = [/\bnpm (?:run|install|i|exec|rebuild)\b/, /\bnpx\b/, /\bcargo\b/, /\bcurl\b/, /\bwget\b/, /\bpip\b/];

describe("the sign job", () => {
  const sign = job("sign");

  it("exists, needs the bundles and runs behind the updater-signing environment", () => {
    expect(sign).not.toBe("");
    expect(sign).toMatch(/^ {4}needs: \[channel, bundle\]$/m);
    expect(sign).toMatch(/^ {4}environment: updater-signing$/m);
    expect(sign).toMatch(/vars\.UPDATER_SIGNING == 'true'/);
  });

  it("can only read the repository", () => {
    expect(grants(all).filter((g) => g.startsWith("build.yml sign "))).toEqual(["build.yml sign contents: read"]);
  });

  it("uses only checkout, setup-node, the artifact actions and the updater-artifacts check", () => {
    const used = [...new Set(usesOf(sign))].sort();
    expect(used).toEqual(
      [
        "./.github/actions/updater-artifacts",
        "actions/checkout",
        "actions/download-artifact",
        "actions/setup-node",
        "actions/upload-artifact",
      ].sort(),
    );
  });

  it("installs without package scripts and runs no build, downloader or package runner", () => {
    const run = runText(sign) + "\n" + runText(updaterAction);
    expect(run).toMatch(/npm ci --ignore-scripts/);
    expect(run.replace(/npm ci --ignore-scripts/g, "")).not.toMatch(/\bnpm ci\b/);
    expect(FORBIDDEN.filter((re) => re.test(run)).map(String)).toEqual([]);
  });

  it("signs every updater bundle the release offers with the lockfile's tauri CLI", () => {
    const signStep = steps(sign).find((s) => s.startsWith("name: Sign the updater bundles")) ?? "";
    expect(signStep).toMatch(/node_modules\/\.bin\/tauri signer sign/);
    for (const pattern of ["'*.AppImage'", "'*setup.exe'", "'*.msi'", "'*.app.tar.gz'"]) expect(signStep).toContain(pattern);
    expect(signStep).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
    expect(sign).toMatch(/name: fundacad-signatures/);
  });

  it("is the only job or action the signing key reaches", () => {
    const outside = Object.entries(all).flatMap(([path, raw]) => {
      const text = raw.replace(/\r\n/g, "\n");
      const rest = path === buildPath ? text.replace(sign, "") : text;
      return rest.includes("TAURI_SIGNING_PRIVATE_KEY") ? [path] : [];
    });
    expect(outside).toEqual([]);
  });
});

describe("the bundle job", () => {
  const bundle = job("bundle");

  it("always turns off the bundler's own updater signing", () => {
    const run = runText(updaterAction);
    const off = run.indexOf("createUpdaterArtifacts=false");
    expect(off).toBeGreaterThan(-1);
    expect(run.slice(0, off)).not.toMatch(/\bexit\b/);
    expect(bundle).toMatch(/signing: \$\{\{ vars\.UPDATER_SIGNING == 'true' \}\}/);
  });

  it("uploads no signatures of its own", () => {
    const upload = steps(bundle).find((s) => s.startsWith("name: Upload artifacts")) ?? "";
    expect(upload).not.toBe("");
    expect(upload).not.toMatch(/\.sig\b/);
  });
});

describe("the release job", () => {
  const release = job("release");

  it("waits for the sign job and takes each signature from it by the bundle's name", () => {
    expect(release).toMatch(/^ {4}needs: \[[^\]]*\bsign\b[^\]]*\]$/m);
    expect(release).toMatch(/needs\.sign\.result == 'success'/);
    expect(release).toMatch(/name: fundacad-signatures\n\s+path: sigs/);
    expect(release).toMatch(/sig="sigs\/\$\(basename "\$src"\)\.sig"/);
  });

  it("publishes past a failed sign job only off the gated channel", () => {
    const cond = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(release + "\n")?.[1] ?? "";
    const failure = [...cond.matchAll(/[^()]*needs\.sign\.result == 'failure'[^()]*/g)].map((m) => m[0]);
    expect(failure.length).toBe(1);
    expect(failure[0]).toMatch(/needs\.channel\.outputs\.gated == 'false' &&/);
  });
});
