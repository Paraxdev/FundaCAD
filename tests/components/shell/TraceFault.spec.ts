import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { traceFaultToast } from "../../../src/ui/traceFault";
import { useToastStore } from "../../../src/stores/toasts";
import { errorNotice, dismissErrorNotice } from "../../../src/ui/errorNotice";
import { breadcrumbs } from "../../../src/diagnostics/breadcrumbs";
import { setLanguage } from "../../../src/i18n";

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

  it("shows the German line and leaves the English one in the problem report", async () => {
    await setLanguage("de");
    try {
      traceFaultToast(
        "Die Pfadverfolgung hat in 10 Sekunden kein Sample gesammelt",
        true,
        "Path tracing gathered no sample in 10 seconds",
      );
      expect(useToastStore().items[0]!.message).toBe(
        "Die Pfadverfolgung hat in 10 Sekunden kein Sample gesammelt. Die Pfadverfolgung bleibt bis zum Neustart von FundaCAD aus.",
      );
      expect(breadcrumbs().at(-1)).toContain(
        "[warning] Path tracing gathered no sample in 10 seconds. Path tracing is off until FundaCAD restarts.",
      );
    } finally {
      await setLanguage("system");
    }
  });
});
