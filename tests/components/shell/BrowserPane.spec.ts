// The Browser tree as a function of state.
//
// Two things this is here to catch, both invisible to a happy-path smoke test:
//
//   1. A computed that stopped propagating. store.document keeps the SAME object
//      identity across an in-place mutate(), so a panel derived through an
//      intermediate computed freezes on every edit while still waking on
//      undo/load (see app/useDoc.ts). The test edits in place, deliberately
//      preserving identity, and asserts the rows moved.
//   2. Double-escaping. The innerHTML version needed an esc() on every
//      document-sourced label; interpolation escapes on its own, so a leftover
//      esc() would render a STEP product called "Bracket & Plate" as
//      "Bracket &amp; Plate" — a bug you only see with the right file open.
//
// Nothing measurement-driven is asserted: happy-dom implements no layout, so
// paddingLeft is readable as an inline style but getComputedStyle/offsetWidth
// are not meaningful. Indentation as a rendered VALUE is checked; indentation as
// pixels stays e2e territory (e2e/assembly_tree_e2e.cjs).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import BrowserPane from "../../../src/components/shell/BrowserPane.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { setFeatureFlag } from "../../../src/ui/featureFlags";
import type { Engine } from "../../../src/app/engine";
import type { CadDocument, Feature } from "../../../src/types";

/** The narrowest engine BrowserPane actually touches. The document is a plain
 *  raw object mutated in place, exactly as DocumentStore.mutate() leaves it. */
function makeEngine(doc: CadDocument, bodies: { id: string; name: string; nodeRef?: string }[] = []) {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const hidden = new Set<string>();
  const slots = new Map<string, number>();
  const store = {
    get document() { return doc; },
    buildState: {
      building: false,
      errorFeatureId: null as string | null,
      result: { mesh: { positions: bodies.length ? [0] : [] }, bodies },
    },
    colorPalette: [{ name: "Slot 1", color: "#ff0000" }],
    isPlaneVisible: () => true,
    isBodyVisible: (id: string) => !hidden.has(id),
    setBodiesVisibility: (vis: Map<string, boolean>) => {
      for (const [id, v] of vis) v ? hidden.delete(id) : hidden.add(id);
      buildVersion.value++;
    },
    bodyName: () => undefined,
    bodyColorSlot: (id: string) => slots.get(id),
    setBodyColorSlot: (id: string, slot: number | null) => {
      if (slot == null) slots.delete(id);
      else slots.set(id, slot);
      buildVersion.value++;
    },
  };
  return {
    docVersion,
    buildVersion,
    store,
    /** Edit in place — identity is preserved on purpose. */
    edit(fn: (d: CadDocument) => void) { fn(doc); docVersion.value++; },
    engine: {
      store,
      bridge: { docVersion, buildVersion },
      isSketchVisible: () => true,
      selectFeature: () => {},
      editFeature: () => {},
      syncDatumPlanes: () => {},
    } as unknown as Engine,
  };
}

function render(fake: ReturnType<typeof makeEngine>): VueWrapper {
  return mount(BrowserPane, {
    global: { provide: { [ENGINE as symbol]: fake.engine } },
  });
}

// The filament palette is the printer's toolhead slots, so the panel only draws
// it once a printer has answered. The probe is behind a dynamic import and a
// desktop-shell check, both of which have to be satisfied for the section to
// exist at all — hence the stub rather than a flag on the component.
vi.mock("../../../src/print/printerClient", () => ({
  activePrinterId: () => "p1",
  printerProbe: () => Promise.resolve({ online: true }),
  printerFilaments: () => Promise.resolve([]),
  asPrinterError: (e: unknown) => e,
}));

/** Render with a printer on the other end AND multi-material turned on, then
 *  wait for the probe to land. The probe is a dynamic import followed by an
 *  awaited call, so it settles over several microtasks; nextTick drains one each
 *  time round.
 *
 *  The flag is part of the setup because the palette needs both: it is a set of
 *  toolheads, so it wants a machine, and it is the multi-material feature, which
 *  ships off. "Off" is a case of its own below, not a state these reach into. */
async function renderWithPrinter(fake: ReturnType<typeof makeEngine>): Promise<VueWrapper> {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
  setFeatureFlag("multiColor", true);
  const w = render(fake);
  for (let i = 0; i < 20 && !w.find(".pal-dot").exists(); i++) await nextTick();
  return w;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  setFeatureFlag("multiColor", false);
  vi.useRealTimers();
});

/** Every folder head and row in document order, as [class, label]. */
function panel(w: VueWrapper) {
  return w.findAll(".tree-folder, .feature-row").map((el) => ({
    kind: el.classes("tree-folder") ? "folder" : "row",
    text: el.find(".tree-label").exists() ? el.find(".tree-label").text() : el.text(),
  }));
}

/** A folder head by its label. The palette head deliberately carries no
 *  .tree-label (the e2e panel dump reads that), so guard the lookup. */
function folderNamed(w: VueWrapper, label: string) {
  return w.findAll(".tree-folder").find((el) => {
    const l = el.find(".tree-label");
    return l.exists() && l.text() === label;
  });
}

/** Which icon a row's caret / eye is currently wearing.
 *
 *  These used to be `.text()` against a Unicode glyph. They are <svg> now, and
 *  an <svg> has no text content at all — so the assertion moves to the
 *  `data-icon` name Icon.vue stamps on every mark it draws, which is both
 *  readable in a failure message and independent of which icon pack is active. */
const iconIn = (el: ReturnType<typeof folderNamed>, sel: string) =>
  el?.find(`${sel} svg`).attributes("data-icon");
const caretName = (el: ReturnType<typeof folderNamed>) => iconIn(el, ".tree-caret");
const eyeName = (el: ReturnType<typeof folderNamed>) => iconIn(el, ".tree-eye");

const sketch = (id: string, name?: string): Feature =>
  ({ id, type: "sketch", plane: "XY", entities: [], ...(name ? { name } : {}) }) as Feature;

const IMPORT = (nodes: { name: string; parent: number | null }[]): Feature =>
  ({ id: "imp1", type: "import", format: "step", geom: "", nodes }) as unknown as Feature;

describe("BrowserPane", () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it("renders the built-in folders and the sketches in the document", () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] });
    const rows = panel(render(fake));

    // Bodies is always emitted, even empty — it carries the "No bodies yet"
    // state, exactly as before.
    expect(rows.filter((r) => r.kind === "folder").map((r) => r.text)).toEqual([
      "Origin", "Bodies", "Sketches",
    ]);
    expect(rows.some((r) => r.kind === "row" && r.text === "Sketch1")).toBe(true);
    // three base planes, click one to start a sketch on it
    expect(rows.filter((r) => r.kind === "row" && r.text.endsWith(" plane"))).toHaveLength(3);
  });

  it("follows an IN-PLACE document edit that preserves object identity", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] });
    const w = render(fake);
    expect(panel(w).some((r) => r.text === "Sketch1")).toBe(true);

    // The regression: the panel keeps painting "Sketch1" forever because the
    // document object it derived from is === the one it saw last time.
    fake.edit((d) => { d.features.push(sketch("s2", "Base")); });
    await nextTick();

    expect(panel(w).some((r) => r.text === "Base")).toBe(true);
  });

  it("shows a renamed sketch under its new name", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1", "Old")] });
    const w = render(fake);
    expect(panel(w).some((r) => r.text === "Old")).toBe(true);

    fake.edit((d) => { (d.features[0] as { name?: string }).name = "New"; });
    await nextTick();

    expect(panel(w).map((r) => r.text)).toContain("New");
    expect(panel(w).map((r) => r.text)).not.toContain("Old");
  });

  it("starts assembly nodes COLLAPSED and expands them on click", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([{ name: "Robot", parent: null }, { name: "MCU", parent: 0 }, { name: "Board", parent: 0 }])] },
      [{ id: "b1", name: "MCU", nodeRef: "imp1/1" }, { id: "b2", name: "Board", nodeRef: "imp1/2" }],
    );
    const w = render(fake);

    const robot = folderNamed(w, "Robot");
    expect(robot).toBeDefined();
    // a 3,000-part import must not paint 3,000 rows on arrival
    expect(caretName(robot!)).toBe("caretRight");
    expect(panel(w).some((r) => r.text === "MCU")).toBe(false);

    await robot!.trigger("click");

    expect(panel(w).some((r) => r.kind === "row" && r.text === "MCU")).toBe(true);
    expect(caretName(folderNamed(w, "Robot")!)).toBe("caretDown");
  });

  it("indents nested assembly rows and caps the step", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([
        { name: "Robot", parent: null }, { name: "Electronics", parent: 0 },
        { name: "MCU", parent: 1 }, { name: "Header", parent: 1 },
      ])] },
      [{ id: "b1", name: "MCU", nodeRef: "imp1/2" }, { id: "b2", name: "Header", nodeRef: "imp1/3" }],
    );
    const w = render(fake);
    for (const want of ["Robot", "Electronics"]) {
      await folderNamed(w, want)!.trigger("click");
    }

    const electronics = folderNamed(w, "Electronics");
    // depth 1 head: 8 + 1*8
    expect(electronics!.attributes("style")).toContain("padding-left: 16px");
    const mcu = w.findAll(".feature-row").find((el) => el.find(".tree-label").text() === "MCU");
    // depth 2 row: 26 + 2*8
    expect(mcu!.attributes("style")).toContain("padding-left: 42px");
  });

  it("renders a product name containing markup as literal text, escaped exactly once", () => {
    const evil = "<img src=x onerror=alert(1)> Bracket & Plate";
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([{ name: evil, parent: null }, { name: "a", parent: 0 }, { name: "b", parent: 0 }])] },
      [{ id: "b1", name: "a", nodeRef: "imp1/1" }, { id: "b2", name: "b", nodeRef: "imp1/2" }],
    );
    const w = render(fake);

    expect(w.findAll("img")).toHaveLength(0);
    // Not "&amp;" — {{ }} escapes for us, so an esc() left in place here would
    // show the ampersand entity to the user.
    expect(panel(w).map((r) => r.text)).toContain(evil);
  });

  it("narrows the tree to one kind of item, and back", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [sketch("s1"), { id: "dp", type: "datumPlane", plane: "XY", offset: 5 } as Feature] },
      [{ id: "b1", name: "Body1" }],
    );
    const w = await renderWithPrinter(fake);
    // The palette head is a .tree-folder with no .tree-label, so it falls
    // through to el.text() and reads as its label plus its count.
    const heads = () => panel(w).filter((r) => r.kind === "folder").map((r) => r.text);
    expect(heads()).toEqual(["Origin", "Planes", "Palette1", "Bodies", "Sketches"]);

    const select = w.get("#browser-filter");
    await select.setValue("sketches");
    expect(heads()).toEqual(["Sketches"]);
    // The Bodies folder's own empty state must go with it — under "Sketches" a
    // "No bodies yet" row would be answering a question nobody asked.
    expect(panel(w).some((r) => r.text.includes("bodies"))).toBe(false);

    await select.setValue("planes");
    expect(heads()).toEqual(["Origin", "Planes"]);

    await select.setValue("all");
    expect(heads()).toEqual(["Origin", "Planes", "Palette1", "Bodies", "Sketches"]);
  });

  it("keeps the palette with the bodies", async () => {
    // The palette head carries no .tree-label, so it is found by its own class.
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    const w = await renderWithPrinter(fake);
    expect(w.find(".pal-dot").exists()).toBe(true);

    await w.get("#browser-filter").setValue("sketches");
    expect(w.find(".pal-dot").exists()).toBe(false);

    await w.get("#browser-filter").setValue("bodies");
    expect(w.find(".pal-dot").exists()).toBe(true);
  });

  it("shows no palette until a printer answers", async () => {
    // Every slot in it means "the filament loaded in toolhead N", and the sync
    // button and the staleness dot only mean anything against a machine that
    // replies. With nothing on the other end it was four fixed rows of nothing
    // pinned above the bodies. Bodies exist here and the filter is "all", so
    // the ONLY thing keeping it off screen is the missing printer.
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    const w = render(fake);
    for (let i = 0; i < 20; i++) await nextTick();
    expect(w.find(".pal-dot").exists()).toBe(false);
    expect(panel(w).map((r) => r.text)).not.toContain("Palette1");
    // ...and the bodies it colours are still there, so this is the palette
    // being absent rather than the section it rides with failing to render.
    expect(panel(w).some((r) => r.text === "Body1")).toBe(true);
  });

  it("shows no palette while multi-material is off, printer or no printer", async () => {
    // The default. A palette is four toolhead slots, and on a single-material
    // machine there is nothing for them to name — so the whole section is
    // absent rather than present and inert. The printer IS answering here and
    // the filter is "all", so the flag is the only thing holding it back.
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    const w = render(fake);
    for (let i = 0; i < 20; i++) await nextTick();
    expect(w.find(".pal-dot").exists()).toBe(false);
    expect(panel(w).map((r) => r.text)).not.toContain("Palette1");
    // The bodies it would have coloured are untouched, so this is the palette
    // being absent and not the section it rides with failing to render.
    expect(panel(w).some((r) => r.text === "Body1")).toBe(true);
  });

  it("gives a body no colour swatch and no Color menu while it is off", async () => {
    // The assignment stays in the document — this is about what is offered, not
    // about what is stored.
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "b1", name: "Body1" }]);
    fake.store.setBodyColorSlot("b1", 0);
    const w = render(fake);
    await nextTick();
    expect(w.find(".tree-swatch").exists()).toBe(false);

    setFeatureFlag("multiColor", true);
    await nextTick();
    expect(w.find(".tree-swatch").exists()).toBe(true);
  });

  it("hides every body under an assembly node from its eye", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([{ name: "Robot", parent: null }, { name: "a", parent: 0 }, { name: "b", parent: 0 }])] },
      [{ id: "b1", name: "a", nodeRef: "imp1/1" }, { id: "b2", name: "b", nodeRef: "imp1/2" }],
    );
    const w = render(fake);
    const eye = folderNamed(w, "Robot")!.find(".tree-eye");
    expect(eyeName(folderNamed(w, "Robot"))).toBe("visible");

    await eye.trigger("click");

    expect(fake.engine.store.isBodyVisible("b1")).toBe(false);
    expect(fake.engine.store.isBodyVisible("b2")).toBe(false);
    // ...and the click must NOT also have collapsed the section it hid
    const robot = folderNamed(w, "Robot");
    expect(caretName(robot)).toBe("caretRight");
    expect(eyeName(robot)).toBe("hidden");
  });
});
