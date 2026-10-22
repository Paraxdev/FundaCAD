// Viewport right-click menus, one provider per target (datum, edge, face, body, empty space) on ui/menu.ts.
// The viewport fires onContextClick only for a real click, since the right button also pans the camera.
import { markRaw } from "vue";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchMode } from "../sketch/sketchMode";
import type { MeasureTool } from "../features/measureTool";
import { bodyExtraMenu, elementMoveMenu, materialMenu } from "./browserTree";
import { ancestryOf } from "../document/elements";
import { useBrowserStore } from "../stores/browser";
import { contextMenu, type CtxItem } from "./menu";
import { useContextMenuStore } from "../stores/contextMenu";
import { isInspectorEditable } from "../document/numFields";
import { allCommands } from "./commands";
import { featureMeta } from "./featureMeta";
import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { keyHint } from "../input/shortcuts";
import type { Feature, PlaneDef } from "../types";
import type { EdgeHit, FaceHit } from "../viewport/picking";
import type { FacePlanePick } from "../features/facePlanePick";
import type { FlatSource } from "../io/exportSettings";

export interface ContextMenusDeps {
  store: DocumentStore;
  viewport: Viewport;
  sketch: SketchMode;
  measure: MeasureTool;
  toolBusy: () => boolean;
  /** toolBusy() minus the Move gizmo a body selection raises, so right-clicking a selected body still opens a menu. */
  toolOwnsScreen: () => boolean;
  /** Every item acting on the body calls this first, or the command it offers refuses because of the gizmo. */
  dropBodyGizmo: () => void;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selectFeature: (id: string | null) => void;
  editFeature: (id: string) => void;
  featureForFace: (faceId: number) => string | null;
  deleteSelectedFace: () => boolean;
  syncDatumPlanes: () => void;
  datumPlaneDef: (f: Extract<Feature, { type: "datumPlane" }>) => PlaneDef;
  handleAction: (action: string) => void;
  getLastAction: () => string | null;
  setLastAction: (action: string) => void;
  startCutByPlane: (planeId: string) => void | Promise<void>;
  offsetPlaneFromFace: (face: PlaneDef, parentId?: string) => void;
  axisFromRoundFace: (face: FacePlanePick | null) => void;
  exportFlat: (source: FlatSource, format: "dxf" | "svg") => void;
}

export function createContextMenus(deps: ContextMenusDeps) {
  const {
    store,
    viewport,
    sketch,
    measure,
    toolBusy,
    toolOwnsScreen,
    dropBodyGizmo,
    setStatus,
    selectFeature,
    editFeature,
    featureForFace,
    deleteSelectedFace,
    syncDatumPlanes,
    datumPlaneDef,
    handleAction,
    getLastAction,
    setLastAction,
    startCutByPlane,
    offsetPlaneFromFace,
    axisFromRoundFace,
    exportFlat,
  } = deps;

  /** For items that start a tool or edit the document: a shortcut may have started a tool since the menu opened, and
   *  refusals are reported. Display-only items stay unwrapped, like the tree's eye toggles. */
  function unlessBusy(fn: () => void): () => void {
    return () => {
      // The gizmo a body pick raises would refuse every item below. A no-op for datum, edge and face menus.
      dropBodyGizmo();
      if (toolBusy()) {
        setStatus("Finish the active tool first (Esc cancels it)", "");
        return;
      }
      fn();
    };
  }

  function openDatumMenu(x: number, y: number, datumId: string) {
    const f = store.document.features.find(
      (ft): ft is Extract<Feature, { type: "datumPlane" }> => ft.id === datumId && ft.type === "datumPlane",
    );
    selectFeature(datumId); // same as clicking it, the menu acts on a visible selection
    contextMenu(x, y, [
      { label: "Cut all bodies", onClick: unlessBusy(() => void startCutByPlane(datumId)) },
      // Enter by id: the def is only the cached placement, the id makes the sketch follow later offset edits.
      {
        label: "Sketch on plane",
        disabled: !f,
        onClick: unlessBusy(() => {
          if (f) sketch.enter(datumPlaneDef(f), store, undefined, f.id);
        }),
      },
      {
        label: "Offset plane",
        disabled: !f,
        onClick: unlessBusy(() => {
          if (f) offsetPlaneFromFace(datumPlaneDef(f), f.id);
        }),
      },
      { separator: true, label: "" },
      // setPlaneVisibility deliberately emits nothing (a plane toggle costs no
      // rebuild), so the browser is told by hand, see stores/browser.ts.
      {
        label: "Hide plane",
        onClick: () => {
          store.setPlaneVisibility(datumId, false);
          syncDatumPlanes();
          useBrowserStore().bumpView();
        },
      },
      {
        label: "Delete plane",
        danger: true,
        onClick: unlessBusy(() => {
          store.removeFeature(datumId);
          selectFeature(null);
        }),
      },
    ]);
  }

  function openEdgeMenu(x: number, y: number, hit: EdgeHit) {
    contextMenu(x, y, [
      // routed through handleAction so "Repeat <command>" records them
      {
        label: "Fillet",
        shortcut: keyHint("fillet"),
        onClick: unlessBusy(() => {
          viewport.selectOnlyEdge(hit.edge);
          handleAction("fillet");
        }),
      },
      {
        label: "Chamfer",
        shortcut: keyHint("chamfer"),
        onClick: unlessBusy(() => {
          viewport.selectOnlyEdge(hit.edge);
          handleAction("chamfer");
        }),
      },
      {
        label: "Plane normal to edge",
        onClick: unlessBusy(() => {
          viewport.selectOnlyEdge(hit.edge);
          handleAction("plane-normal-edge");
        }),
      },
      {
        label: "Plane at angle",
        onClick: unlessBusy(() => {
          viewport.selectOnlyEdge(hit.edge);
          handleAction("plane-angle");
        }),
      },
      { separator: true, label: "" },
      {
        label: "Measure from here",
        shortcut: keyHint("measure"),
        onClick: unlessBusy(() => {
          setLastAction("measure");
          measure.startWith(hit);
        }),
      },
    ]);
  }

  function openFaceMenu(x: number, y: number, hit: FaceHit) {
    const facePick = viewport.facePlanePick(x, y);
    const plane = facePick?.def ?? null;
    // The anchor the plane picker hands startSketch, so the sketch follows its face. Planar only: a cylinder tangent
    // plane differs at every point, so a rebuild has nothing to re-derive.
    const anchor = facePick && facePick.kind === "planar" ? { selector: facePick.selector, at: facePick.at } : null;
    const bodyId = viewport.faceIdToBodyId(hit.faceId);
    // The plane a sketch on this face takes, so the drawing lines up with one.
    const flatFace = facePick && facePick.kind === "planar" ? facePick : null;
    const exportFace = (format: "dxf" | "svg") => {
      if (!flatFace) return;
      const label = `${(bodyId && store.bodyName(bodyId)) || "part"} face`;
      exportFlat({ face: flatFace.selector, plane: flatFace.def, label }, format);
    };
    const ownerId = featureForFace(hit.faceId);
    const owner = ownerId ? store.document.features.find((f) => f.id === ownerId) : undefined;
    const ownerLabel = owner ? featureMeta(owner).label : "";
    const items: CtxItem[] = [
      {
        label: "Press/Pull face",
        shortcut: keyHint("presspull"),
        onClick: unlessBusy(() => {
          viewport.selectOnlyFace(hit.faceId);
          handleAction("presspull");
        }),
      },
      {
        label: "Sketch on this face",
        shortcut: keyHint("sketch"),
        disabled: !plane,
        onClick: unlessBusy(() => {
          if (plane) sketch.enter(plane, store, undefined, undefined, anchor);
        }),
      },
      {
        label: "Measure from here",
        shortcut: keyHint("measure"),
        onClick: unlessBusy(() => {
          setLastAction("measure");
          measure.startWith(hit);
        }),
      },
      { separator: true, label: "" },
      {
        label: "Select coplanar faces",
        onClick: unlessBusy(() => {
          const n = viewport.selectCoplanarFaces(hit.faceId);
          setStatus(`Selected ${n} coplanar face${n === 1 ? "" : "s"}`, "");
        }),
      },
      {
        label: "Offset plane from face",
        shortcut: keyHint("offset-plane"),
        disabled: !plane,
        onClick: unlessBusy(() => {
          if (plane) offsetPlaneFromFace(plane);
        }),
      },
      ...(facePick?.kind === "tangent"
        ? [{ label: "Axis of cylinder", onClick: unlessBusy(() => axisFromRoundFace(facePick)) }]
        : []),
      { separator: true, label: "" },
      { label: "Export face as DXF…", disabled: !flatFace, onClick: unlessBusy(() => exportFace("dxf")) },
      { label: "Export face as SVG…", disabled: !flatFace, onClick: unlessBusy(() => exportFace("svg")) },
      { separator: true, label: "" },
      ...(owner
        ? [
            {
              label: `${isInspectorEditable(owner.type) ? "Edit" : "Select"} ${ownerLabel}`,
              onClick: unlessBusy(() => editFeature(owner.id)),
            },
          ]
        : []),
      ...(bodyId
        ? [
            { label: "Hide body", onClick: () => hideBody(bodyId) },
            { label: "Isolate body", onClick: () => isolateBody(bodyId) },
          ]
        : []),
      { separator: true, label: "" },
      {
        label: "Delete face (heal)",
        danger: true,
        onClick: unlessBusy(() => {
          viewport.selectOnlyFace(hit.faceId);
          deleteSelectedFace();
        }),
      },
    ];
    contextMenu(x, y, items);
    if (facePick?.kind !== "planar") offerTangentFaces(hit);
  }

  /** Added once the engine names a tangent run. It joins the still open menu in place, since reopening would move the
   *  row under the pointer. */
  function offerTangentFaces(hit: FaceHit) {
    const menu = useContextMenuStore();
    const epoch = menu.epoch;
    const face = { kind: "face" as const, by: "nearest" as const, point: hit.point };
    void store.faceAxis(face, viewport.faceIdToBodyId(hit.faceId)).then((reply) => {
      const run = reply?.resize?.tangent?.run;
      if (!Array.isArray(run) || run.length < 2 || !menu.open || menu.epoch !== epoch) return;
      const item: CtxItem = {
        label: "Select tangent faces",
        onClick: unlessBusy(() => {
          const ids = new Set([hit.faceId]);
          for (const p of run) {
            const id = viewport.faceIdNear(p);
            if (id !== null) ids.add(id);
          }
          viewport.selectOnlyFaces([...ids]);
          setStatus(`Selected ${ids.size} tangent face${ids.size === 1 ? "" : "s"}`, "");
        }),
      };
      const items = menu.items;
      const at = items.findIndex((i) => i.label === "Select coplanar faces") + 1;
      menu.items = markRaw([...items.slice(0, at), item, ...items.slice(at)]);
    });
  }

  /** The whole selection when the body under the cursor is in it, else just that body; same rule as the Browser row. */
  function bodiesUnder(bodyId: string): string[] {
    const selected = viewport.getSelectedBodies();
    return selected.includes(bodyId) ? [...selected] : [bodyId];
  }

  function moveToElementMenu(bodyId: string): CtxItem {
    const ids = bodiesUnder(bodyId);
    return elementMoveMenu(store.bodyElements, ids, store.bodyElementOf(bodyId), {
      toNew: () => {
        const id = store.addElement();
        store.setBodiesElement(ids, id);
        // Open the tree at it and start the rename, or the new folder appears off screen with a default name.
        const browser = useBrowserStore();
        browser.expand("f:Bodies");
        for (const key of ancestryOf(store.bodyElements, id)) browser.expand(`e:${key}`);
        browser.beginRename(id);
      },
      to: (element) => store.setBodiesElement(ids, element),
    });
  }

  function openBodyMenu(x: number, y: number, bodyId: string) {
    if (!viewport.getSelectedBodies().includes(bodyId)) viewport.setSelectedBodies([bodyId]);
    contextMenu(x, y, [
      // routed through handleAction so "Repeat <command>" records them
      { label: "Move", shortcut: keyHint("move"), onClick: unlessBusy(() => handleAction("move")) },
      // Neither needs an edge pre-picked (edgeFeatureTool.start asks), so both work from a plain body selection.
      { label: "Fillet…", shortcut: keyHint("fillet"), onClick: unlessBusy(() => handleAction("fillet")) },
      { label: "Chamfer…", shortcut: keyHint("chamfer"), onClick: unlessBusy(() => handleAction("chamfer")) },
      // All three booleans, not one dialog entry, so a right-clicked body is one click from the boolean you want.
      ...BOOLEAN_COMMANDS.map((c) => ({
        label: `${c.label} with…`,
        shortcut: keyHint(c.action),
        onClick: unlessBusy(() => handleAction(c.action)),
      })),
      { label: "Separate", onClick: unlessBusy(() => handleAction("separate")) },
      { label: "Properties", onClick: unlessBusy(() => handleAction("properties")) },
      { separator: true, label: "" },
      { label: "Hide body", onClick: () => hideBody(bodyId) },
      { label: "Isolate body", onClick: () => isolateBody(bodyId) },
      {
        label: "Show all bodies",
        shortcut: keyHint("show-all-bodies"),
        onClick: () => handleAction("show-all-bodies"),
      },
      { separator: true, label: "" },
      { label: "Rename…", onClick: () => useBrowserStore().beginRename(bodyId) },
      // Same submenu as the Browser row: on a big import the part you want to file is the one you just clicked.
      moveToElementMenu(bodyId),
      materialMenu(
        store.materialLibrary,
        bodiesUnder(bodyId),
        store.bodyMaterialId(bodyId),
        (m) => store.setBodiesMaterial(bodiesUnder(bodyId), m),
        {
          count: bodiesUnder(bodyId).reduce((n, id) => n + store.faceMaterialCount(id), 0),
          clear: () => store.clearFaceMaterials(bodiesUnder(bodyId)),
        },
      ),
      ...bodyExtraMenu(bodyId),
      { separator: true, label: "" },
      { label: "Duplicate body", onClick: unlessBusy(() => store.duplicateBody(bodyId)) },
      { label: "Remove body", danger: true, onClick: unlessBusy(() => store.removeBody(bodyId)) },
    ]);
  }

  // "Repeat <last command>": navigation, view and file actions are not repeated, so they do not overwrite it.
  function actionLabel(id: string): string {
    return allCommands().find((c) => c.id === id)?.label ?? id;
  }

  function openEmptyMenu(x: number, y: number) {
    const lastAction = getLastAction();
    contextMenu(x, y, [
      {
        label: lastAction ? `Repeat ${actionLabel(lastAction)}` : "Repeat last command",
        disabled: !lastAction,
        onClick: () => {
          if (lastAction) handleAction(lastAction);
        },
      },
      { separator: true, label: "" },
      { label: "Fit view", shortcut: keyHint("fit"), onClick: () => handleAction("fit") },
      {
        label: "Look",
        children: [
          { label: "Isometric", onClick: () => handleAction("iso") },
          { label: "Top", onClick: () => handleAction("top") },
          { label: "Front", onClick: () => handleAction("front") },
          { label: "Right", onClick: () => handleAction("right") },
        ],
      },
      {
        label: "Show all bodies",
        shortcut: keyHint("show-all-bodies"),
        onClick: () => handleAction("show-all-bodies"),
      },
      { separator: true, label: "" },
      { label: "Undo", shortcut: "Ctrl+Z", disabled: !store.canUndo, onClick: () => store.undo() },
      { label: "Redo", shortcut: "Ctrl+Y", disabled: !store.canRedo, onClick: () => store.redo() },
    ]);
  }

  // Both re-emit the build (see store.setBodiesVisibility), which repaints the browser.
  function hideBody(id: string) {
    // Otherwise the gizmo floats over a hidden body, still offering to drag it.
    dropBodyGizmo();
    store.setBodyVisibility(id, false);
  }

  /** Hides every other body in one batched store update. Undone by "Show all bodies" (Shift+H). */
  function isolateBody(id: string) {
    store.isolateBodies([id]);
  }

  function openCanvasMenu(x: number, y: number) {
    if (toolOwnsScreen()) return;
    // a construction plane is preferred where its quad is exposed (same order as click-select)
    const datumId = viewport.pickDatumAt(x, y);
    if (datumId) return openDatumMenu(x, y, datumId);
    if (viewport.selecting === "bodies" || viewport.bodyClickAt(x, y)) {
      // Plain mesh raycast like left-click select, or right-clicking near an edge misses the body menu.
      const bodyId = viewport.bodyIdAt(x, y);
      return bodyId ? openBodyMenu(x, y, bodyId) : openEmptyMenu(x, y);
    }
    const hit = viewport.pickEntity(x, y);
    if (hit?.kind === "edge") return openEdgeMenu(x, y, hit);
    if (hit?.kind === "face") return openFaceMenu(x, y, hit);
    openEmptyMenu(x, y);
  }

  return { openDatumMenu, openEdgeMenu, openFaceMenu, openBodyMenu, openEmptyMenu, openCanvasMenu };
}

export type ContextMenus = ReturnType<typeof createContextMenus>;
