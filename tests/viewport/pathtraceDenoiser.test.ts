import { beforeEach, describe, expect, it } from "vitest";
import {
  denoiserState,
  describeDenoiser,
  downloadDenoiser,
  refreshDenoiser,
  sizeLabel,
} from "../../src/viewport/pathtrace/denoiser";

const filter = {
  active: "filter" as const,
  version: "2.5.1",
  offered: true,
  bytes: 51_840_672,
  note: "not downloaded",
};
const oidn = { ...filter, active: "oidn" as const, note: null };

describe("native denoiser row", () => {
  beforeEach(() => {
    denoiserState.info = null;
    denoiserState.error = "";
    denoiserState.downloading = false;
  });

  it("names the filter until Open Image Denoise is installed, then names it", async () => {
    await refreshDenoiser(async () => filter);
    expect(describeDenoiser(denoiserState)).toBe("Native tracer: the edge aware filter.");
    expect(sizeLabel(filter.bytes)).toBe("about 52 MB");
    await downloadDenoiser(async (cmd) => (cmd === "pt_denoiser_download" ? oidn : filter));
    expect(describeDenoiser(denoiserState)).toBe("Native tracer: Open Image Denoise 2.5.1.");
  });

  it("keeps the filter with a clear note when the download fails", async () => {
    await refreshDenoiser(async () => filter);
    await downloadDenoiser(async () => {
      throw "the download failed, the edge aware filter stays (offline)";
    });
    expect(denoiserState.info?.active).toBe("filter");
    expect(denoiserState.downloading).toBe(false);
    expect(describeDenoiser(denoiserState)).toContain("the download failed, the edge aware filter stays");
  });

  it("carries the macOS refusal note", async () => {
    await refreshDenoiser(async () => ({
      ...filter,
      offered: false,
      note: "the high quality denoise is not offered on macOS yet",
    }));
    expect(describeDenoiser(denoiserState)).toContain("not offered on macOS yet");
  });
});
