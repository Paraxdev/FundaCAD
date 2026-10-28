import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import Announcer from "../../../src/components/ui/Announcer.vue";
import { announce, recentAnnouncements } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);

const politeText = () => document.getElementById("a11y-polite")?.textContent ?? null;

describe("Announcer", () => {
  it("puts both regions on body, outside the app root, live before any text arrives", () => {
    const app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
    mount(Announcer, { attachTo: app });
    const root = document.getElementById("a11y-announcer")!;
    expect(root.parentElement).toBe(document.body);
    expect(app.contains(root)).toBe(false);
    expect(root.classList.contains("sr-only")).toBe(true);
    const polite = document.getElementById("a11y-polite")!;
    const assertive = document.getElementById("a11y-assertive")!;
    expect([polite.getAttribute("role"), polite.getAttribute("aria-live"), polite.getAttribute("aria-atomic")]).toEqual(
      ["status", "polite", "true"],
    );
    expect([
      assertive.getAttribute("role"),
      assertive.getAttribute("aria-live"),
      assertive.getAttribute("aria-atomic"),
    ]).toEqual(["alert", "assertive", "true"]);
    expect(polite.textContent).toBe("");
    app.remove();
  });

  it("speaks announce() text in the polite region a frame later, and errors in the assertive one", async () => {
    mount(Announcer, { attachTo: document.body });
    announce("Extrude, Select a profile · Esc to cancel");
    announce("Build failed at Extrude 2", "assertive");
    expect(politeText()).toBe("");
    await vi.waitFor(() => expect(politeText()).toBe("Extrude, Select a profile, Esc to cancel"));
    expect(document.getElementById("a11y-assertive")?.textContent).toBe("Build failed at Extrude 2");
  });

  it("stops writing once unmounted, and the next mount picks up what was said meanwhile", async () => {
    const w = mount(Announcer, { attachTo: document.body });
    w.unmount();
    announce("Saved plate.funda");
    await new Promise((r) => setTimeout(r, 150));
    expect(document.getElementById("a11y-polite")).toBeNull();
    expect(recentAnnouncements().at(-1)?.text).not.toBe("Saved plate.funda");
    mount(Announcer, { attachTo: document.body });
    await vi.waitFor(() => expect(politeText()).toBe("Saved plate.funda"));
  });
});
