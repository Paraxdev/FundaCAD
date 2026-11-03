// The macOS runner's 7 GB gives Node about 2 GB of heap by default, and the bundle's vite build ran out of it.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

const step = workflow.split(/^ {6}- /m).find((text) => /name: Build \+ bundle Tauri app/.test(text))!;

describe("the bundle build", () => {
  it("gives Node 4 GB of heap on macOS and leaves the other runners at their default", () => {
    expect(/^ {10}NODE_OPTIONS: (.*)$/m.exec(step)?.[1]).toBe(
      "${{ matrix.platform == 'macos-15' && '--max-old-space-size=4096' || '' }}",
    );
  });
});
