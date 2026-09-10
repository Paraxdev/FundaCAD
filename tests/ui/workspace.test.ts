// Which arrangement of the window is up.
import { describe, it, expect, beforeEach } from "vitest";
import {
  canEditMaterials, onWorkspaceChange, setWorkspace, workspace, WORKSPACES,
} from "../../src/ui/workspace";

describe("workspace", () => {
  beforeEach(() => setWorkspace("model"));

  it("opens in Model", () => {
    // Not persisted, deliberately: see the module header. This is the assertion
    // that keeps somebody from adding a localStorage read to it later without
    // noticing that reopening a week-old part would then land in Render.
    expect(workspace()).toBe("model");
  });

  it("switches, and says so", () => {
    const seen: string[] = [];
    const off = onWorkspaceChange((w) => seen.push(w));
    setWorkspace("render");
    expect(workspace()).toBe("render");
    expect(seen).toEqual(["render"]);
    off();
  });

  it("says nothing when the workspace it is set to is the one it is in", () => {
    setWorkspace("render");
    const seen: string[] = [];
    const off = onWorkspaceChange((w) => seen.push(w));
    setWorkspace("render");
    expect(seen).toEqual([]);
    off();
  });

  it("refuses a value that is not one of the two", () => {
    setWorkspace("render");
    setWorkspace("nonsense" as never);
    expect(workspace()).toBe("render");
  });

  it("stops telling an unsubscribed listener", () => {
    const seen: string[] = [];
    onWorkspaceChange((w) => seen.push(w))();
    setWorkspace("render");
    expect(seen).toEqual([]);
  });

  it("only allows materials to be EDITED in Render", () => {
    expect(canEditMaterials()).toBe(false);
    setWorkspace("render");
    expect(canEditMaterials()).toBe(true);
  });

  it("offers exactly the two, in order, each with an icon", () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual(["model", "render"]);
    expect(WORKSPACES.every((w) => w.label && w.icon)).toBe(true);
  });
});
