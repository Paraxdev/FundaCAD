import { describe, expect, it, afterEach } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import FloatingPanel from "../../src/components/overlays/FloatingPanel.vue";
import { panelStack } from "../../src/ui/panelStack";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

const state = reactive({ a: false, b: false, c: false });
const Host = defineComponent({
  render: () =>
    ["a", "b", "c"].map((k) => h(FloatingPanel, { open: state[k as "a"], panelClass: `p-${k}` }, () => h("span", k))),
});
let app: ReturnType<typeof createApp> | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  Object.assign(state, { a: false, b: false, c: false });
});

Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 100 });

// Panel classes from the top of the column down.
const column = () =>
  [...document.querySelectorAll<HTMLElement>(".measure-panel")]
    .sort((x, y) => parseFloat(x.style.top) - parseFloat(y.style.top))
    .map((e) => e.className.split(" ").pop());

describe("FloatingPanel registers with the stack", () => {
  it("adds panels in open order, drops a closed one and reuses nothing from the last run", async () => {
    app = createApp(Host);
    app.mount(document.createElement("div"));
    state.c = true;
    await nextTick();
    state.a = true;
    await nextTick();
    state.b = true;
    await nextTick();
    expect(column()).toEqual(["p-c", "p-a", "p-b"]);
    const styles = [...document.querySelectorAll<HTMLElement>(".measure-panel")].map((e) => e.style.right);
    expect(new Set(styles).size).toBe(1);
    state.a = false;
    await nextTick();
    expect(panelStack.ids().length).toBe(2);
    expect(column()).toEqual(["p-c", "p-b"]);
    state.a = true;
    await nextTick();
    expect(column()).toEqual(["p-c", "p-b", "p-a"]);
    app.unmount();
    app = null;
    expect(panelStack.ids()).toEqual([]);
  });
});
