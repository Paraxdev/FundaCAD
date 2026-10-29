// The viewport meta must let the page scale: maximum-scale and user-scalable=no lock low vision users out of
// zoom (SR-39, SCAN-14). Pinch on the canvas is stopped by touch-action in _touch.scss, not here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function viewportOf(html: string): Map<string, string> | null {
  const tag = html.match(/<meta\s+[^>]*name=["']viewport["'][^>]*>/i)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  if (content == null) return null;
  return new Map(
    content
      .split(",")
      .map((part) => part.split("=").map((s) => s.trim().toLowerCase()))
      .filter(([key]) => key)
      .map(([key, value = ""]) => [key, value]),
  );
}

function scalingLocks(html: string): string[] {
  const meta = viewportOf(html);
  if (!meta) return ["no viewport meta"];
  const locks: string[] = [];
  if (meta.has("maximum-scale")) locks.push("maximum-scale");
  if (meta.has("minimum-scale")) locks.push("minimum-scale");
  if (["no", "0"].includes(meta.get("user-scalable") ?? "")) locks.push("user-scalable");
  return locks;
}

const indexHtml = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

describe("the viewport meta in index.html", () => {
  it("fits the device width at scale 1", () => {
    const meta = viewportOf(indexHtml);
    expect(meta?.get("width")).toBe("device-width");
    expect(Number(meta?.get("initial-scale"))).toBe(1);
  });

  it("does not lock page scaling", () => {
    expect(scalingLocks(indexHtml)).toEqual([]);
  });

  it("flags the old locked meta", () => {
    const old =
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no" />';
    expect(scalingLocks(old)).toEqual(["maximum-scale", "user-scalable"]);
    expect(scalingLocks("<title>no meta</title>")).toEqual(["no viewport meta"]);
  });
});
