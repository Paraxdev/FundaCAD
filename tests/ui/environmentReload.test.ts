import { describe, expect, it } from "vitest";
import { createEnvLibrary, memoryKv } from "../../src/ui/environmentLibrary";
import { activeSavedId, adoptSavedForCurrentLook, chooseBuiltInEnvironment } from "../../src/ui/environmentImport";
import { envSettingsOf, renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";

const HASH_A = "a1b2c3d4e5f60718";
const HASH_B = "0f1e2d3c4b5a6978";

// A reload keeps the prefs and the library but not the module's record of the saved look.
async function reloadedWith(hash: string | null, library: ReturnType<typeof createEnvLibrary>) {
  chooseBuiltInEnvironment(null, "studio");
  if (hash) setRenderPref("environment", `hdr:${hash}`);
  await adoptSavedForCurrentLook(library);
  return activeSavedId();
}

describe("the saved environment after a reload", () => {
  it("is the entry whose panorama the look names, for either of two", async () => {
    const lib = createEnvLibrary(memoryKv());
    setRenderPref("environment", `hdr:${HASH_A}`);
    const a = await lib.save("Alpha", envSettingsOf(renderPrefs()), "");
    setRenderPref("environment", `hdr:${HASH_B}`);
    const b = await lib.save("Beta", { ...envSettingsOf(renderPrefs()), envRotation: 35 }, "");
    expect(await reloadedWith(HASH_B, lib)).toBe(b.id);
    expect(await reloadedWith(HASH_A, lib)).toBe(a.id);
  });

  it("stays unset for a panorama nothing saved and for a built in room", async () => {
    const lib = createEnvLibrary(memoryKv());
    setRenderPref("environment", `hdr:${HASH_A}`);
    await lib.save("Alpha", envSettingsOf(renderPrefs()), "");
    expect(await reloadedWith(HASH_B, lib)).toBeNull();
    expect(await reloadedWith(null, lib)).toBeNull();
  });

  it("does not replace a saved look that is already active", async () => {
    const lib = createEnvLibrary(memoryKv());
    setRenderPref("environment", `hdr:${HASH_A}`);
    await lib.save("Alpha", envSettingsOf(renderPrefs()), "");
    await lib.save("Beta", envSettingsOf(renderPrefs()), "");
    expect(await reloadedWith(HASH_A, lib)).not.toBeNull();
    const first = activeSavedId();
    await adoptSavedForCurrentLook(lib);
    expect(activeSavedId()).toBe(first);
  });
});
