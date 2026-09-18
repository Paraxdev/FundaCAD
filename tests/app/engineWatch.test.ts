import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../../src/ui/toast", () => ({ toast: () => {} }));

import { deathMessage } from "../../src/app/engineWatch";

describe("what a dead geometry engine is called", () => {
  it("says the engine was restarted when the Rust shell restarted it", () => {
    expect(deathMessage({ kind: "restarted", cause: "exit code 3" })).toBe(
      "The geometry engine crashed (exit code 3) and was restarted. The last operation did not finish.",
    );
  });

  it("says it could not start, not that it crashed, when the worker never ran", () => {
    expect(deathMessage({ kind: "start_failed", cause: "access denied" })).toContain("could not start");
  });

  it("never calls it the sidecar, whichever shell sent it", () => {
    for (const kind of ["restarted", "start_failed", "port_in_use", "exited", undefined]) {
      expect(deathMessage({ kind, cause: "x" }).toLowerCase()).not.toContain("sidecar");
    }
    expect(deathMessage(null)).toBe("The geometry engine crashed. Save your work, then restart FundaCAD.");
  });
});
