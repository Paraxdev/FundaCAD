import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useHomeStore } from "../../../src/stores/home";
import { useToastStore } from "../../../src/stores/toasts";
import { useWhatsNewStore } from "../../../src/stores/whatsNew";
import { setLibrary } from "../../../src/io/library";
import { loadNotes, notesHash, parseNotes, startWhatsNew, whatsNewSection } from "../../../src/ui/whatsNew";
import type { HomeCallbacks } from "../../../src/ui/home";
import HomeScreen from "../../../src/components/home/HomeScreen.vue";
import WhatsNewCard from "../../../src/components/home/WhatsNewCard.vue";
import capabilities from "../../../src-tauri/capabilities/default.json";

vi.mock("../../../src/ui/updates", async (orig) => ({
  ...(await orig<typeof import("../../../src/ui/updates")>()),
  appVersion: async () => "1.0.412",
}));

enableAutoUnmount(afterEach);

const KEY = "fundacad.whatsNewSeen";
const RELEASES = "https://github.com/Paraxdev/fundacad/releases";
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

const section = whatsNewSection(await loadNotes("beta"));
const hash = notesHash(section);
const groups = parseNotes(section);

const homeHost = {
  isOpen: () => useHomeStore().visible,
  open: () => {
    useHomeStore().visible = true;
  },
};

const RECENTS = JSON.stringify([{ path: "D:/prints/hinge_v3.funda", openedAt: 1717 }]);

function returning() {
  localStorage.setItem("fundacad.recentFiles", RECENTS);
}

// A blocked store throws on every read and write, a full one only on writes.
function fakeStorage(o: { blocked?: boolean; full?: boolean }, seed: Record<string, string>): Map<string, string> {
  const items = new Map(Object.entries(seed));
  const refuse = () => {
    throw new DOMException("refused", o.blocked ? "SecurityError" : "QuotaExceededError");
  };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (o.blocked ? refuse() : (items.get(k) ?? null)),
    setItem: (k: string, v: string) => (o.blocked || o.full ? refuse() : void items.set(k, v)),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
  });
  return items;
}

function mountHome() {
  setLibrary(null);
  const home = useHomeStore();
  home.bind({
    newDocument: async () => {},
    openDoc: async () => {},
    newFromTemplate: async () => {},
    openPath: async () => "ok" as const,
    currentPath: () => null,
    currentVersions: () => null,
    openVersion: async () => true,
    openBranch: async () => true,
  } satisfies HomeCallbacks);
  home.visible = true;
  return mount(HomeScreen, { attachTo: document.body });
}

describe("What's new on Home", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a returning user the card at the top of Home, and records the notes", async () => {
    returning();
    mountHome();
    await startWhatsNew(homeHost, false);
    await nextTick();
    expect($(".home-scroll")!.firstElementChild!.classList.contains("home-news")).toBe(true);
    expect($(".home-news-title")!.textContent).toBe("What's new in FundaCAD 1.0.412");
    expect($$(".home-news-group").map((g) => g.textContent)).toEqual(groups.map((g) => g.title));
    expect($$(".home-news-list li")).toHaveLength(groups.reduce((n, g) => n + g.bullets.length, 0));
    expect(localStorage.getItem(KEY)).toBe(hash);
    expect(useToastStore().items).toEqual([]);
  });

  it("shows the same notes only once", async () => {
    returning();
    await startWhatsNew(homeHost, false);
    setActivePinia(createPinia());
    await startWhatsNew(homeHost, false);
    expect(useWhatsNewStore().notes).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe(hash);
  });

  it("shows notes that changed since the ones a returning user saw", async () => {
    returning();
    localStorage.setItem(KEY, "0badc0de");
    await startWhatsNew(homeHost, false);
    expect(useWhatsNewStore().notes).toEqual(groups);
    expect(localStorage.getItem(KEY)).toBe(hash);
  });

  it("records the notes for a brand new user and shows nothing", async () => {
    await startWhatsNew(homeHost, false);
    expect(useWhatsNewStore().notes).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe(hash);
    expect(useToastStore().items).toEqual([]);
  });

  it("reads and writes nothing in a dev build", async () => {
    returning();
    await startWhatsNew(homeHost, true);
    expect(useWhatsNewStore().notes).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("with Home off says the app was updated, and What's new opens Home with the card", async () => {
    returning();
    await startWhatsNew(homeHost, false);
    const toasts = useToastStore().items;
    expect(toasts.map((t) => [t.message, t.kind, t.action?.label])).toEqual([
      ["FundaCAD was updated.", "info", "What's new"],
    ]);
    toasts[0]!.action!.onClick();
    expect(useHomeStore().visible).toBe(true);
    mountHome();
    await nextTick();
    expect($(".home-news-title")!.textContent).toBe("What's new in FundaCAD 1.0.412");
  });

  it("hides the card on Hide and keeps the notes recorded", async () => {
    returning();
    mountHome();
    await startWhatsNew(homeHost, false);
    await nextTick();
    $(".home-news-hide")!.click();
    await nextTick();
    expect($(".home-news")).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(hash);
  });

  it("opens the releases page, which the opener allows", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    useWhatsNewStore().show("1.0.412", groups);
    mount(WhatsNewCard, { attachTo: document.body });
    $(".home-news-all")!.click();
    await flushPromises();
    expect(open.mock.calls).toEqual([[RELEASES, "_blank", "noopener"]]);
    const scopes = capabilities.permissions
      .flatMap((p) => (typeof p === "object" && "allow" in p ? (p.allow as { url?: string }[]) : []))
      .flatMap((a) => (a.url ? [a.url.replace(/\*$/, "")] : []));
    expect(scopes.some((s) => RELEASES.startsWith(s))).toBe(true);
  });

  it("leaves the version out of the title when the app cannot read it", async () => {
    useWhatsNewStore().show("unknown", [{ title: "Modeling", bullets: ["Extrude makes a thin wall."] }]);
    mount(WhatsNewCard, { attachTo: document.body });
    await nextTick();
    expect($(".home-news-title")!.textContent).toBe("What's new in FundaCAD");
    expect($$(".home-news-list li").map((li) => li.textContent)).toEqual(["Extrude makes a thin wall."]);
  });

  it("shows nothing and does not throw when storage is blocked", async () => {
    fakeStorage({ blocked: true }, { "fundacad.recentFiles": RECENTS });
    await expect(startWhatsNew(homeHost, false)).resolves.toBeUndefined();
    expect(useWhatsNewStore().notes).toEqual([]);
    expect(useToastStore().items).toEqual([]);
  });

  it("still shows the card this session when the notes cannot be recorded", async () => {
    const kept = fakeStorage({ full: true }, { "fundacad.recentFiles": RECENTS });
    await startWhatsNew(homeHost, false);
    expect(useWhatsNewStore().notes).toEqual(groups);
    expect(kept.has(KEY)).toBe(false);
  });
});
