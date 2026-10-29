import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { traceFaultToast } from "../../../src/ui/traceFault";
import { useToastStore } from "../../../src/stores/toasts";
import { errorNotice, dismissErrorNotice } from "../../../src/ui/errorNotice";

describe("path traced fallback", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    dismissErrorNotice();
  });

  it("is a warning toast carrying the whole reason, not a title bar error", () => {
    traceFaultToast("Path traced is not available on this GPU (adapter 7)", false);
    const items = useToastStore().items;
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("warning");
    expect(items[0]!.message).toContain("Path traced is not available on this GPU (adapter 7)");
    expect(items[0]!.message).toContain("Realtime");
    expect(errorNotice()).toBeNull();
  });

  it("says tracing is off when the tracer is disabled for the session", () => {
    traceFaultToast("The native tracer failed 3 times", true);
    const items = useToastStore().items;
    expect(items.map((i) => i.kind)).toEqual(["warning"]);
    expect(items[0]!.message).toContain("off until FundaCAD restarts");
    expect(errorNotice()).toBeNull();
  });
});
