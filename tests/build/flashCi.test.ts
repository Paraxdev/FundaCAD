import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

const steps = workflow
  .split(/^ {6}- /m)
  .slice(1)
  .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
const stepIndex = (name: string) => steps.findIndex((s) => s.name === name);
const FLASH_STEPS = ["Path traced flash end-to-end", "WebGPU tracer preview end-to-end"];

describe("the flash steps", () => {
  it("fail the job on a failed run and each stop at five minutes", () => {
    const seen = FLASH_STEPS.map((name) => {
      const { text } = steps[stepIndex(name)]!;
      return {
        name,
        limit: /^ {8}timeout-minutes: (\d+)$/m.exec(text)?.[1],
        tolerated: /continue-on-error/.test(text),
        run: /^ {8}run: (.*)$/m.exec(text)?.[1],
      };
    });
    expect(seen).toEqual([
      {
        name: FLASH_STEPS[0],
        limit: "5",
        tolerated: false,
        run: "node e2e/pathtrace_flash_e2e.cjs /tmp/pathtrace_flash_shots",
      },
      {
        name: FLASH_STEPS[1],
        limit: "5",
        tolerated: false,
        run: "node e2e/pathtrace_flash_e2e.cjs /tmp/pathtrace_flash_webgpu_shots",
      },
    ]);
  });

  it("leave their reports and frames behind when the job fails", () => {
    const at = stepIndex("Flash test frames on failure");
    expect(at).toBeGreaterThan(stepIndex(FLASH_STEPS[1]!));
    const lines = steps[at]!.text.split(/\r?\n/).slice(1);
    expect(lines.filter((line) => !/^\s*(#.*)?$/.test(line))).toEqual([
      "        if: failure()",
      "        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
      "        with:",
      "          name: flash-frames",
      "          path: |",
      "            /tmp/pathtrace_flash_shots",
      "            /tmp/pathtrace_flash_webgpu_shots",
      "          if-no-files-found: ignore",
      "          retention-days: 7",
    ]);
  });
});
