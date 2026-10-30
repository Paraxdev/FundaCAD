// The packaged udev rule gives the seat user 3Dconnexion devices only, through uaccess.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import conf from "../../src-tauri/tauri.conf.json";
import setup from "../../packaging/setup-spacemouse.sh?raw";

const root = resolve(__dirname, "../..");
const installs = ["deb", "rpm"].map((k) => {
  const files = (conf.bundle.linux as Record<string, { files: Record<string, string> }>)[k].files;
  const dest = Object.keys(files).find((d) => d.startsWith("/usr/lib/udev/rules.d/")) ?? "";
  return { dest, src: resolve(root, "src-tauri", files[dest] ?? "") };
});
const rule = readFileSync(installs[0].src, "utf8");
const lines = rule
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const matching = lines.filter((l) => l.includes("ATTRS{idVendor}"));
const products = (vendor: string) =>
  matching
    .filter((l) => l.includes(`ATTRS{idVendor}=="${vendor}"`))
    .map((l) => /ATTRS\{idProduct\}=="([0-9a-f]{4})"/.exec(l)?.[1] ?? "none");

describe("the SpaceMouse udev rule", () => {
  it("is installed by deb and rpm from the same file under a name that sorts before 73-seat-late", () => {
    expect(installs[0].src).toBe(installs[1].src);
    for (const { dest } of installs) {
      const name = basename(dest);
      expect(name).toMatch(/^\d\d-fundacad-spacemouse\.rules$/);
      expect(Number(name.slice(0, 2))).toBeLessThan(73);
    }
  });

  it("matches 046d only together with a 3Dconnexion product id", () => {
    const ids = products("046d");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("none");
    expect(ids).toEqual(expect.arrayContaining(["c626", "c62b"]));
  });

  it("keeps the 3Dconnexion vendor 256f", () => {
    expect(products("256f")).toEqual(["none"]);
  });

  it("grants access through uaccess alone, on hidraw nodes, skipping remove events", () => {
    expect(rule).not.toMatch(/MODE\s*=/);
    expect(rule).not.toMatch(/GROUP\s*=/);
    for (const l of matching) expect(l).toMatch(/TAG\+="uaccess"/);
    expect(lines[0]).toMatch(/^ACTION=="remove", GOTO="(\w+)"$/);
    expect(lines[1]).toMatch(/^SUBSYSTEM!="hidraw", GOTO="(\w+)"$/);
    const label = /GOTO="(\w+)"/.exec(lines[0])?.[1];
    expect(lines[lines.length - 1]).toBe(`LABEL="${label}"`);
  });
});

describe("setup-spacemouse.sh", () => {
  it("installs the packaged rule file and changes no group or mode itself", () => {
    expect(setup).toContain(`/${basename(installs[0].src)}"`);
    expect(setup).not.toMatch(/\bchgrp\b|\bchmod\b/);
  });

  it("reports devices by the same 046d product list as the rule", () => {
    const list = /^LOGITECH_3DX="([^"]*)"/m.exec(setup)?.[1] ?? "";
    const ids = list.split(/\s+/).filter(Boolean).map((p) => p.toLowerCase());
    expect(ids.sort()).toEqual(products("046d").sort());
    expect(setup).not.toMatch(/v0000046D[|"]/i);
  });
});
