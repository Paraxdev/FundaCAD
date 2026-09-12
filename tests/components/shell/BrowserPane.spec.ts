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
//      "Bracket &amp; Plate", a bug you only see with the right file open.
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
import { contribute, resetContributions } from "../../../src/plugins/contrib";
import { setBrowserFilter } from "../../../src/ui/browserFilter";
import { contextMenu, type CtxItem } from "../../../src/ui/menu";
import { useBrowserStore } from "../../../src/stores/browser";
import {
  descendantsOf, type ElementDef, freshElementName, reparented, withElementRemoved,
} from "../../../src/document/elements";
import type { MaterialDef } from "../../../src/document/materials";
import type { Engine } from "../../../src/app/engine";
import type { CadDocument, Feature } from "../../../src/types";

// The menu is read, not drawn: what matters is which rows a menu entry acts on.
vi.mock("../../../src/ui/menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/menu")>()),
  contextMenu: vi.fn(),
}));

/** The narrowest engine BrowserPane actually touches. The document is a plain
 *  raw object mutated in place, exactly as DocumentStore.mutate() leaves it. */
function makeEngine(doc: CadDocument, bodies: { id: string; name: string; nodeRef?: string }[] = []) {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const hidden = new Set<string>();
  const hiddenSketches = new Set<string>();
  /** Every batched body visibility write, to count re-renders by. */
  const bodyWrites: Map<string, boolean>[] = [];
  let selectedBodies: string[] = [];
  const slots = new Map<string, number>();
  // Elements are a display overlay in the real store, not part of the document
  // object, so the fake keeps them the same way. The PURE half is imported
  // rather than reimplemented: a fake that disagreed with document/elements.ts
  // about what a delete does would pass while the panel was broken.
  let elements: ElementDef[] = [];
  const bodyElement = new Map<string, string>();
  // Materials, likewise a display overlay. The panel reads three of them: the
  // library for the "Material" submenu, the raw id to grey out the current row,
  // and the resolved material for the row's colour chip.
  let materials: MaterialDef[] = [];
  const bodyMaterial = new Map<string, string>();
  const store = {
    get materialLibrary() { return materials; },
    bodyMaterialId: (id: string) => bodyMaterial.get(id),
    bodyMaterialOf: (id: string) => {
      const held = bodyMaterial.get(id);
      return held ? materials.find((m) => m.id === held) : undefined;
    },
    addMaterial(m: Partial<MaterialDef>) {
      const def: MaterialDef = { id: m.id ?? `m${materials.length + 1}`, name: m.name ?? "M", color: m.color ?? "#808080" };
      materials = [...materials, def];
      buildVersion.value++;
      return def.id;
    },
    setBodiesMaterial(ids: Iterable<string>, material: string | null) {
      for (const id of ids) {
        if (material === null) bodyMaterial.delete(id);
        else bodyMaterial.set(id, material);
      }
      buildVersion.value++;
    },
    get bodyElements() { return elements; },
    bodyElementOf: (id: string) => bodyElement.get(id),
    bodyElementMap: () => bodyElement,
    elementSubtree: (id: string) => descendantsOf(elements, id),
    addElement(name?: string, parent: string | null = null) {
      const id = `e${elements.length + 1}`;
      elements = [
        ...elements,
        { id, name: name ?? freshElementName(elements, parent), ...(parent ? { parent } : {}) },
      ];
      buildVersion.value++;
      return id;
    },
    renameElement(id: string, name: string) {
      elements = elements.map((e) => (e.id === id ? { ...e, name } : e));
      buildVersion.value++;
    },
    removeElement(id: string) {
      const { elements: next, movedTo } = withElementRemoved(elements, id);
      elements = next;
      for (const [body, held] of [...bodyElement]) {
        if (held !== id) continue;
        if (movedTo === null) bodyElement.delete(body);
        else bodyElement.set(body, movedTo);
      }
      buildVersion.value++;
    },
    setElementParent(id: string, parent: string | null) {
      elements = reparented(elements, id, parent);
      buildVersion.value++;
    },
    setBodiesElement(ids: Iterable<string>, element: string | null) {
      for (const id of ids) {
        if (element === null) bodyElement.delete(id);
        else bodyElement.set(id, element);
      }
      buildVersion.value++;
    },
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
      bodyWrites.push(new Map(vis));
      for (const [id, v] of vis) v ? hidden.delete(id) : hidden.add(id);
      buildVersion.value++;
    },
    setSketchVisibility: (id: string, v: boolean) => { v ? hiddenSketches.delete(id) : hiddenSketches.add(id); },
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
    bodyWrites,
    isSketchVisible: (id: string) => !hiddenSketches.has(id),
    /** Edit in place, identity is preserved on purpose. */
    edit(fn: (d: CadDocument) => void) { fn(doc); docVersion.value++; },
    engine: {
      store,
      bridge: { docVersion, buildVersion },
      isSketchVisible: (id: string) => !hiddenSketches.has(id),
      sketch: { active: false },
      overlay: { update: () => {} },
      viewport: {
        getSelectedBodies: () => [...selectedBodies],
        setSelectedBodies: (ids: string[]) => { selectedBodies = [...ids]; },
      },
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

/** A section a plugin might contribute, as the panel sees it: a component with
 *  one recognisable row in it.
 *
 *  A stand-in rather than the real palette panel, deliberately. What is being
 *  checked here is that the PANEL places a contributed section, hides it with
 *  the filter it named, and forgets it when the contribution goes, none of
 *  which is about what any particular section draws. The palette's own
 *  behaviour is tested against the palette, in tests/plugins/. */
const MarkerSection = {
  name: "MarkerSection",
  template: `<div class="tree-folder"><span class="marker">Contributed</span></div>`,
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  resetContributions();
  // The chosen filter is module state in ui/browserFilter.ts, not per-component
  // and not per-test, so a case that narrows the tree leaves it narrowed for
  // every case after it. That was survivable while the cases that changed it
  // happened to end on a wide filter; it is not something to keep relying on.
  setBrowserFilter("all");
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
 *  an <svg> has no text content at all, so the assertion moves to the
 *  `data-icon` name Icon.vue stamps on every mark it draws, which is both
 *  readable in a failure message and independent of which icon pack is active. */
const iconIn = (el: ReturnType<typeof folderNamed>, sel: string) =>
  el?.find(`${sel} svg`).attributes("data-icon");
const caretName = (el: ReturnType<typeof folderNamed>) => iconIn(el, ".tree-caret");
const eyeName = (el: ReturnType<typeof folderNamed>) => iconIn(el, ".tree-eye");

type Found = NonNullable<ReturnType<typeof folderNamed>>;

/** A row by its label. */
function rowNamed(w: VueWrapper, label: string): Found {
  const row = w.findAll(".feature-row").find((el) => el.find(".tree-label").text() === label);
  if (!row) throw new Error(`no row "${label}"`);
  return row;
}

/** Press an eye the way a mouse does: the press acts, then the click that
 *  follows must not act a second time. */
async function clickEye(el: Found, init: PointerEventInit = {}) {
  const eye = el.find(".tree-eye");
  await eye.trigger("pointerdown", { button: 0, ...init });
  window.dispatchEvent(new Event("pointerup"));
  await eye.trigger("click");
  await nextTick();
}

/** Press an eye and keep the button down. */
async function pressEye(el: Found, init: PointerEventInit = {}) {
  await el.find(".tree-eye").trigger("pointerdown", { button: 0, ...init });
}

const sketch = (id: string, name?: string): Feature =>
  ({ id, type: "sketch", plane: "XY", entities: [], ...(name ? { name } : {}) }) as Feature;

const IMPORT = (nodes: { name: string; parent: number | null }[]): Feature =>
  ({ id: "imp1", type: "import", format: "step", geom: "", nodes }) as unknown as Feature;

describe("BrowserPane", () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  // --- elements: the user's own folders over the bodies --------------------

  it("draws an element as a folder, with the bodies filed into it under it", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, [
      { id: "body1", name: "Bracket" },
      { id: "body2", name: "Plate" },
    ]);
    const w = render(fake);
    // the control: with no element, both bodies are top-level rows
    expect(panel(w).filter((r) => r.kind === "row").map((r) => r.text))
      .toEqual(expect.arrayContaining(["Bracket", "Plate"]));
    expect(folderNamed(w, "Rig")).toBeUndefined();

    const rig = fake.store.addElement("Rig");
    fake.store.setBodiesElement(["body1"], rig);
    await nextTick();

    expect(folderNamed(w, "Rig")).toBeDefined();
    const rows = panel(w);
    // an element head is emitted, and the filed body sits inside it (which is
    // to say: after the head, and before the body that was left alone)
    const at = (t: string) => rows.findIndex((r) => r.text === t);
    expect(at("Rig")).toBeGreaterThan(-1);
    expect(at("Bracket")).toBeGreaterThan(at("Rig"));
    expect(at("Plate")).toBeGreaterThan(at("Bracket"));
  });

  it("keeps an element that holds nothing, so it can be filled afterwards", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "body1", name: "Bracket" }]);
    const w = render(fake);
    fake.store.addElement("Empty");
    await nextTick();
    const head = folderNamed(w, "Empty");
    expect(head).toBeDefined();
    // and it says so: no count badge, rather than a stale one
    expect(head!.find(".tree-count").text()).toBe("");
  });

  it("hides every body under an element from its eye, one batched write", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, [
      { id: "body1", name: "A" },
      { id: "body2", name: "B" },
    ]);
    const w = render(fake);
    const rig = fake.store.addElement("Rig");
    fake.store.setBodiesElement(["body1", "body2"], rig);
    await nextTick();

    expect(eyeName(folderNamed(w, "Rig"))).toBe("visible");
    await clickEye(folderNamed(w, "Rig")!);
    expect(fake.store.isBodyVisible("body1")).toBe(false);
    expect(fake.store.isBodyVisible("body2")).toBe(false);
    await nextTick();
    expect(eyeName(folderNamed(w, "Rig"))).toBe("hidden");
  });

  it("takes a body dragged onto an element head into it, and back out on the Bodies head", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "body1", name: "Bracket" }]);
    const w = render(fake);
    const rig = fake.store.addElement("Rig");
    await nextTick();

    const row = w.findAll(".feature-row").find((el) => el.text().includes("Bracket"))!;
    await row.trigger("dragstart");
    await folderNamed(w, "Rig")!.trigger("dragover");
    await folderNamed(w, "Rig")!.trigger("drop");
    expect(fake.store.bodyElementOf("body1")).toBe(rig);

    await nextTick();
    const back = w.findAll(".feature-row").find((el) => el.text().includes("Bracket"))!;
    await back.trigger("dragstart");
    await folderNamed(w, "Bodies")!.trigger("drop");
    expect(fake.store.bodyElementOf("body1")).toBeUndefined();
  });

  it("refuses a drop that would bury an element inside its own child", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, []);
    const w = render(fake);
    const rig = fake.store.addElement("Rig");
    const motor = fake.store.addElement("Motor", rig);
    await nextTick();

    await folderNamed(w, "Rig")!.trigger("dragstart");
    await folderNamed(w, "Motor")!.trigger("drop");
    expect(fake.store.bodyElements.find((e) => e.id === rig)!.parent).toBeUndefined();

    // the control: the same gesture the other way round is taken
    await folderNamed(w, "Motor")!.trigger("dragstart");
    await folderNamed(w, "Bodies")!.trigger("drop");
    expect(fake.store.bodyElements.find((e) => e.id === motor)!.parent).toBeUndefined();
    expect(fake.store.bodyElements.map((e) => e.id)).toEqual([rig, motor]);
  });

  it("gives an assembly node no rename and no menu, an element both", async () => {
    // Two levels, so "Robot" is a genuine folder: a product owning ONE body and
    // no children is drawn as that body's row instead of a head wrapping it.
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([{ name: "Robot", parent: null }, { name: "MCU", parent: 0 }])] },
      [{ id: "body1", name: "MCU", nodeRef: "imp1/1" }, { id: "body2", name: "Loose" }],
    );
    const w = render(fake);
    fake.store.addElement("Rig");
    await nextTick();

    // An element head is draggable (it can be filed somewhere itself); an
    // imported product is a fact about a file and is not.
    expect(folderNamed(w, "Rig")!.attributes("draggable")).toBe("true");
    expect(folderNamed(w, "Robot")!.attributes("draggable")).toBe("false");
  });

  it("renders the built-in folders and the sketches in the document", () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] });
    const rows = panel(render(fake));

    // Bodies is always emitted, even empty, it carries the "No bodies yet"
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
    // Not "&amp;", {{ }} escapes for us, so an esc() left in place here would
    // show the ampersand entity to the user.
    expect(panel(w).map((r) => r.text)).toContain(evil);
  });

  it("narrows the tree to one kind of item, and back", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [sketch("s1"), { id: "dp", type: "datumPlane", plane: "XY", offset: 5 } as Feature] },
      [{ id: "b1", name: "Body1" }],
    );
    const w = render(fake);
    await nextTick();
    const heads = () => panel(w).filter((r) => r.kind === "folder").map((r) => r.text);
    expect(heads()).toEqual(["Origin", "Planes", "Bodies", "Sketches"]);

    const select = w.get("#browser-filter");
    await select.setValue("sketches");
    expect(heads()).toEqual(["Sketches"]);
    // The Bodies folder's own empty state must go with it, under "Sketches" a
    // "No bodies yet" row would be answering a question nobody asked.
    expect(panel(w).some((r) => r.text.includes("bodies"))).toBe(false);

    await select.setValue("planes");
    expect(heads()).toEqual(["Origin", "Planes"]);

    await select.setValue("all");
    expect(heads()).toEqual(["Origin", "Planes", "Bodies", "Sketches"]);
  });

  it("draws a contributed section between the document's structure and its bodies", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    contribute("Some.Body", {
      browserSections: [{ key: "marker", component: MarkerSection }],
    });
    const w = render(fake);
    await nextTick();
    const heads = panel(w).filter((r) => r.kind === "folder").map((r) => r.text);
    expect(heads).toEqual(["Origin", "Contributed", "Bodies", "Sketches"]);
  });

  it("forgets a section when its plugin stops", async () => {
    // The control for the case above: a section that appears and never leaves
    // would pass that test and would be a panel that keeps drawing a switched-off
    // capability's panel until the window is reloaded.
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "b1", name: "Body1" }]);
    const off = contribute("Some.Body", {
      browserSections: [{ key: "marker", component: MarkerSection }],
    });
    const w = render(fake);
    await nextTick();
    expect(w.find(".marker").exists()).toBe(true);
    off();
    await nextTick();
    expect(w.find(".marker").exists()).toBe(false);
  });

  it("hides a contributed section with the filter section it named", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    contribute("Some.Body", {
      browserSections: [{ key: "marker", component: MarkerSection, filter: "palette" }],
    });
    const w = render(fake);
    await nextTick();
    expect(w.find(".marker").exists()).toBe(true);

    await w.get("#browser-filter").setValue("sketches");
    expect(w.find(".marker").exists()).toBe(false);

    // ...and back, with the bodies it rides alongside.
    await w.get("#browser-filter").setValue("bodies");
    expect(w.find(".marker").exists()).toBe(true);
  });

  it("shows a contributed section that names no filter under every filter", async () => {
    // A section may name one of the panel's own filter sections to be hidden
    // with, and a plugin's section usually corresponds to none of them. The
    // panel cannot guess, and the wrong guess is a section that vanishes under a
    // filter nobody told it about.
    const fake = makeEngine({ parameters: {}, features: [sketch("s1")] }, [{ id: "b1", name: "Body1" }]);
    contribute("Some.Body", {
      browserSections: [{ key: "marker", component: MarkerSection }],
    });
    const w = render(fake);
    await nextTick();
    await w.get("#browser-filter").setValue("sketches");
    expect(w.find(".marker").exists()).toBe(true);
  });

  it("gives a body no colour swatch while nothing says it has a colour", async () => {
    // The assignment stays in the document, this is about what is offered, not
    // about what is stored. A chip nobody can explain or change is worse than no
    // chip: the menu that would change it comes from the same capability.
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "b1", name: "Body1" }]);
    fake.store.setBodyColorSlot("b1", 0);
    const w = render(fake);
    await nextTick();
    expect(w.find(".tree-swatch").exists()).toBe(false);

    contribute("Some.Body", { palette: () => [{ name: "Slot 1", color: "#ff0000" }] });
    await nextTick();
    expect(w.find(".tree-swatch").exists()).toBe(true);
  });

  it("hides every body under an assembly node from its eye", async () => {
    const fake = makeEngine(
      { parameters: {}, features: [IMPORT([{ name: "Robot", parent: null }, { name: "a", parent: 0 }, { name: "b", parent: 0 }])] },
      [{ id: "b1", name: "a", nodeRef: "imp1/1" }, { id: "b2", name: "b", nodeRef: "imp1/2" }],
    );
    const w = render(fake);
    expect(eyeName(folderNamed(w, "Robot"))).toBe("visible");

    await clickEye(folderNamed(w, "Robot")!);

    expect(fake.engine.store.isBodyVisible("b1")).toBe(false);
    expect(fake.engine.store.isBodyVisible("b2")).toBe(false);
    // ...and the click must NOT also have collapsed the section it hid
    const robot = folderNamed(w, "Robot");
    expect(caretName(robot)).toBe("caretRight");
    expect(eyeName(robot)).toBe("hidden");
  });
  // --- showing and hiding many rows at once ----------------------------------

  it("paints a press on one sketch eye across every sketch the drag crosses, skipped rows too", async () => {
    const fake = makeEngine({ parameters: {}, features: ["a", "b", "c", "d", "e"].map((n) => sketch(n, n.toUpperCase())) });
    const w = render(fake);
    await pressEye(rowNamed(w, "A"));
    // one frame of a fast drag: straight from A into D, never entering B or C
    await rowNamed(w, "D").trigger("pointerenter");
    expect(["a", "b", "c", "d", "e"].map(fake.isSketchVisible)).toEqual([false, false, false, false, true]);
    // the button comes up anywhere, and the drag is over
    window.dispatchEvent(new Event("pointerup"));
    await rowNamed(w, "E").trigger("pointerenter");
    expect(fake.isSketchVisible("e")).toBe(true);
  });

  it("gives every crossed row the pressed row's NEW state instead of flipping each one", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("a", "A"), sketch("b", "B"), sketch("c", "C")] });
    fake.store.setSketchVisibility("b", false);
    const w = render(fake);
    await pressEye(rowNamed(w, "A"));
    await rowNamed(w, "C").trigger("pointerenter");
    window.dispatchEvent(new Event("pointerup"));
    expect(["a", "b", "c"].map(fake.isSketchVisible)).toEqual([false, false, false]);
  });

  it("leaves the bodies alone when a sketch drag runs on into them", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("a", "A"), sketch("b", "B")] }, [{ id: "body1", name: "Bracket" }]);
    const w = render(fake);
    await pressEye(rowNamed(w, "A"));
    await rowNamed(w, "Bracket").trigger("pointerenter");
    window.dispatchEvent(new Event("pointerup"));
    expect(fake.store.isBodyVisible("body1")).toBe(true);
    expect(fake.bodyWrites).toHaveLength(0);
  });

  it("paints across bodies in one batched write per step, however many rows a step crossed", async () => {
    const names = ["A", "B", "C", "D", "E"];
    const fake = makeEngine({ parameters: {}, features: [] }, names.map((n, i) => ({ id: `b${i + 1}`, name: n })));
    const w = render(fake);
    await pressEye(rowNamed(w, "A"));
    await rowNamed(w, "E").trigger("pointerenter");
    window.dispatchEvent(new Event("pointerup"));
    // every body hidden, and the whole model re-rendered twice, not five times
    expect(names.map((_, i) => fake.store.isBodyVisible(`b${i + 1}`))).toEqual([false, false, false, false, false]);
    expect(fake.bodyWrites).toHaveLength(2);
  });

  it("shows only the Alt-pressed sketch, and puts the rest back on a second Alt-press", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("a", "A"), sketch("b", "B"), sketch("c", "C")] });
    fake.store.setSketchVisibility("c", false);
    const w = render(fake);
    await clickEye(rowNamed(w, "B"), { altKey: true });
    expect(["a", "b", "c"].map(fake.isSketchVisible)).toEqual([false, true, false]);
    await clickEye(rowNamed(w, "B"), { altKey: true });
    expect(["a", "b", "c"].map(fake.isSketchVisible)).toEqual([true, true, false]);
  });

  it("does not pick a body up when a press on its eye turns into a drag", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, [{ id: "body1", name: "Bracket" }]);
    const w = render(fake);
    const browser = useBrowserStore();
    await pressEye(rowNamed(w, "Bracket"));
    await rowNamed(w, "Bracket").trigger("dragstart");
    expect(browser.drag).toBeNull();
    window.dispatchEvent(new Event("pointerup"));
    // an ordinary drag of the row still files the body
    await rowNamed(w, "Bracket").trigger("dragstart");
    expect(browser.drag).not.toBeNull();
  });

  // --- selecting several rows --------------------------------------------------

  it("takes a Shift-click run of sketches and offers to hide the whole run", async () => {
    const fake = makeEngine({ parameters: {}, features: ["a", "b", "c", "d"].map((n) => sketch(n, n.toUpperCase())) });
    const w = render(fake);
    await rowNamed(w, "A").trigger("click");
    await rowNamed(w, "C").trigger("click", { shiftKey: true });
    await nextTick();
    expect(["A", "B", "C", "D"].map((n) => rowNamed(w, n).classes("selected"))).toEqual([true, true, true, false]);

    await rowNamed(w, "B").trigger("contextmenu");
    const items = vi.mocked(contextMenu).mock.calls.at(-1)![2] as CtxItem[];
    const visibility = items.find((i) => i.label === "Visibility");
    visibility!.children!.find((c) => c.label === "Hide these 3")!.onClick!();
    expect(["a", "b", "c", "d"].map(fake.isSketchVisible)).toEqual([false, false, false, true]);
  });

  it("Ctrl adds a sketch to the selection and takes it back out", async () => {
    const fake = makeEngine({ parameters: {}, features: [sketch("a", "A"), sketch("b", "B")] });
    const w = render(fake);
    await rowNamed(w, "A").trigger("click");
    await rowNamed(w, "B").trigger("click", { ctrlKey: true });
    await nextTick();
    expect(["A", "B"].map((n) => rowNamed(w, n).classes("selected"))).toEqual([true, true]);
    await rowNamed(w, "A").trigger("click", { ctrlKey: true });
    await nextTick();
    expect(["A", "B"].map((n) => rowNamed(w, n).classes("selected"))).toEqual([false, true]);
  });

  it("takes a Shift-click run of bodies into the viewport's selection", async () => {
    const fake = makeEngine({ parameters: {}, features: [] }, ["A", "B", "C", "D"].map((n, i) => ({ id: `b${i + 1}`, name: n })));
    const w = render(fake);
    await rowNamed(w, "A").trigger("click");
    await rowNamed(w, "C").trigger("click", { shiftKey: true });
    const viewport = (fake.engine as unknown as { viewport: { getSelectedBodies(): string[] } }).viewport;
    expect(viewport.getSelectedBodies()).toEqual(["b1", "b2", "b3"]);
  });
});
