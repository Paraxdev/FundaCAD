// A feature a plugin contributes keeps its English name for English-only paths (error reports, step counting,
// announcements) whatever the language, so a German and an English session number and report steps the same.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "../../src/app/engine";
import { setLanguage } from "../../src/i18n";
import { contributedFeatureTypes, resetContributions } from "../../src/plugins/contrib";
import { featureEnglish } from "../../src/ui/featureMeta";

const mains = import.meta.glob<{ activate?: (e: Engine) => Promise<() => void> | (() => void) }>(
  "../../plugins/*/main.ts",
  { eager: true },
);

// Any property an activate() reaches for answers with something callable, so a plugin needs no hand-made engine.
function anything(own: Record<string, unknown> = {}): object {
  return new Proxy(() => {}, {
    get: (_t, key) => (typeof key === "symbol" || key === "then" ? undefined : key in own ? own[key] : anything()),
    apply: () => anything(),
    construct: () => anything(),
  });
}

const engine = anything({ viewport: anything({ domElement: document.createElement("canvas") }) }) as Engine;

beforeEach(() => setActivePinia(createPinia()));

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

describe("a contributed feature's English name", () => {
  it("is the same in German as in English for every bundled plugin", async () => {
    const stops: (() => void)[] = [];
    const failed: string[] = [];
    for (const [path, mod] of Object.entries(mains)) {
      try {
        stops.push(await mod.activate!(engine));
      } catch (err) {
        failed.push(`${path}: ${String(err)}`);
      }
    }
    expect(failed).toEqual([]);

    const types = contributedFeatureTypes();
    expect(types.length).toBeGreaterThan(8);

    await setLanguage("en");
    const english = types.map((type) => featureEnglish({ type }));
    await setLanguage("de");
    const german = types.map((type) => featureEnglish({ type }));
    expect(german).toEqual(english);
    for (const stop of stops) stop();
  });
});
