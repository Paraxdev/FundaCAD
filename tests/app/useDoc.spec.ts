// The load-bearing test of the whole migration's reactivity story.
//
// useDocValue exists to survive one specific fact: store.document returns the
// SAME object across an in-place mutate(), and Vue 3.4+ computeds stop
// propagating when a recomputed value is === the previous one. Get the shape
// wrong and every store-reading panel silently freezes on edits while still
// "waking up" on undo/load, which is why a happy-path smoke test misses it.
//
// These tests pin the behaviour rather than the implementation: they assert that
// a dependent effect re-runs after an in-place edit that preserves identity.

import { describe, it, expect } from "vitest";
import { defineComponent, h, watchEffect, ref } from "vue";
import { mount } from "@vue/test-utils";
import { ENGINE } from "../../src/app/engineKey";
import { useDocValue } from "../../src/app/useDoc";
import type { CadDocument } from "../../src/types";
import type { Engine } from "../../src/app/engine";

/** The narrowest thing useDocValue actually touches: a raw document that is
 *  mutated in place, and a version ref bumped on change. */
function makeFakeEngine() {
  const doc: CadDocument = { parameters: { width: 10 }, features: [] };
  const docVersion = ref(0);
  return {
    doc,
    docVersion,
    /** Edit in place, object identity is deliberately preserved, exactly as
     *  DocumentStore.mutate() does. */
    edit(fn: (d: CadDocument) => void) {
      fn(doc);
      docVersion.value++;
    },
    /** Replace wholesale, as New/Open/undo/redo do. */
    replace(next: CadDocument) {
      Object.assign(this, { doc: next });
      docVersion.value++;
    },
    engine: {
      store: { get document() { return doc; } },
      bridge: { docVersion },
    } as unknown as Engine,
  };
}

/** Mount a trivial component that derives from the document, and record every
 *  value its dependents observe. */
function trackDerived(fake: ReturnType<typeof makeFakeEngine>, pick: (d: CadDocument) => unknown) {
  const seen: unknown[] = [];
  const Comp = defineComponent({
    setup() {
      const v = useDocValue(pick);
      watchEffect(() => { seen.push(v.value); });
      return () => h("div", String(v.value));
    },
  });
  const wrapper = mount(Comp, { global: { provide: { [ENGINE as symbol]: fake.engine } } });
  return { seen, wrapper };
}

describe("useDocValue", () => {
  it("notifies dependents after an IN-PLACE edit that keeps document identity", async () => {
    const fake = makeFakeEngine();
    const { seen } = trackDerived(fake, (d) => d.parameters.width);

    expect(seen).toEqual([10]);

    fake.edit((d) => { d.parameters.width = 25; });
    await Promise.resolve();

    // The regression this guards: `seen` stays [10] because the intermediate
    // computed returned the same document object and refused to propagate.
    expect(seen).toEqual([10, 25]);
  });

  it("keeps notifying across repeated in-place edits", async () => {
    const fake = makeFakeEngine();
    const { seen } = trackDerived(fake, (d) => d.parameters.width);

    for (const w of [1, 2, 3]) {
      fake.edit((d) => { d.parameters.width = w; });
      await Promise.resolve();
    }
    expect(seen).toEqual([10, 1, 2, 3]);
  });

  it("does not re-notify when the derived value is genuinely unchanged", async () => {
    const fake = makeFakeEngine();
    const { seen } = trackDerived(fake, (d) => d.parameters.width);

    // An unrelated edit bumps the version but must not churn this dependent,
    // the computed still short-circuits, which is the behaviour we WANT here.
    fake.edit((d) => { d.parameters.depth = 3; });
    await Promise.resolve();

    expect(seen).toEqual([10]);
  });

  it("reads the live document rather than a reference cached in setup()", async () => {
    const fake = makeFakeEngine();
    const { seen } = trackDerived(fake, (d) => d.features.length);

    fake.edit((d) => { d.features.push({ id: "f1", type: "box" } as never); });
    await Promise.resolve();

    expect(seen).toEqual([0, 1]);
  });
});
