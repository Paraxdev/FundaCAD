import * as THREE from "three";
import { setPrompt } from "../ui/prompt";
import { escapeClaimed } from "../ui/escapeClaim";
import { isEditableTarget } from "../ui/focus";
import { contextMenu, dismissContextMenu } from "../ui/menu";
import { featureMeta } from "../ui/featureMeta";
import { bodyRowLabel, distinguish, dominantOwner, edgeChoiceLabel } from "../ui/edgeChoice";
import { TIE_BAND_PX, ambiguousCandidates } from "../viewport/edgeTies";
import { areaFilterLabel } from "../viewport/areaSelect";
import { useBrowserStore } from "../stores/browser";
import { useRibbonStore } from "../stores/ribbon";
import { analysisFlags } from "../ui/railActive";
import { edgeNudgePlacement } from "../features/edgeNudge";
import { faceNudgePlacement } from "../features/faceNudge";
import { regionNudgePlacement } from "../features/regionNudge";
import type { NudgePlacement } from "../features/selectionNudge";
import { regionBeatsSurface } from "../sketch/regionOverSurface";
import { regionArea } from "../sketch/region";
import type { Engine } from "./engine";
import type { Selector } from "../types";
import { hitPx } from "../input/pointerKind";
import { replayedPress } from "../viewport/navigator/input";
import { exactRound, roundFacePrompt } from "../ui/selectionMeasure";
import { offeredResize } from "../features/pressPullAxis";

const AMBIGUOUS_MENU_OFFSET = 16;

/** The Viewport's callbacks are single slot fields, so this is the one writer of each. */
export function installViewportWiring(e: Engine): void {
  e.viewport.onPickDatum = (id) => e.selectFeature(id);

  // A double click edits the feature that made the face, or the sketch of a visible profile, which is asked first.
  // A single click selects only the face, or the plate a hole was cut into would open the Hole.
  e.viewport.onDoubleClick = (x, y) => {
    if (e.toolBusy() || e.sketch.active) return;
    const profile = regionAt(x, y);
    if (profile) {
      e.editFeature(profile.sketchId);
      return;
    }
    const faceId = e.viewport.faceIdAt(x, y);
    if (faceId == null) {
      const datum = e.viewport.pickDatumAt(x, y);
      if (datum) e.editFeature(datum);
      return;
    }
    const owner = e.featureForFace(faceId);
    if (owner) e.editFeature(owner);
  };

  // Two bodies that meet each keep their own edge on the same pixels, so a click there asks which one it meant.
  e.viewport.onAmbiguousEdge = (cands, at, mods) => {
    if (e.toolBusy()) return false;
    const bodies = e.store.buildState.result?.bodies ?? [];
    const featureName = (id: string | null) => {
      if (!id) return null;
      const f = e.store.document.features.find((x) => x.id === id);
      if (!f) return null;
      const named = (f as { name?: string }).name;
      return named || featureMeta(f).label;
    };
    const rows = cands.map((c) => {
      const index = bodies.findIndex((b) => b.id === c.edge.body);
      const body = index >= 0 ? bodies[index] : undefined;
      const name = c.edge.body ? (e.store.bodyName(c.edge.body) ?? body?.name ?? null) : null;
      return { cand: c, index, name, feature: featureName(dominantOwner(body?.faceOwners)) };
    });
    // Same names are numbered by body list order, so "Box 2" matches the browser.
    const shared = new Map<string, number>();
    for (const r of rows) if (r.name) shared.set(r.name, (shared.get(r.name) ?? 0) + 1);
    // distinguish() separates two edges of one body, which edgeTies would otherwise drop.
    const labels = distinguish(
      rows.map((r) =>
        edgeChoiceLabel(bodyRowLabel(r.name, r.index, (shared.get(r.name ?? "") ?? 0) > 1), r.feature, r.name),
      ),
    );
    // Tied by rank, so a faint tangent edge beside a sharp one is not a question; touch gets a wider band.
    const choices = ambiguousCandidates(
      rows.map((r, i) => ({ ...r, label: labels[i] ?? "Edge", screenDist: r.cand.rankPx })),
      hitPx(TIE_BAND_PX),
    );
    if (choices.length < 2) return false;

    // Offset, unlike other menus, so it does not cover the clicked edges.
    contextMenu(
      at.x + AMBIGUOUS_MENU_OFFSET,
      at.y + AMBIGUOUS_MENU_OFFSET,
      choices.map((c) => ({
        label: c.label,
        // Exactly coincident edges draw the same pixels, so only the label separates them (viewport/edgeTies.ts).
        onHover: (on: boolean) => {
          e.viewport.hoverEdge(on ? c.cand.edge : null);
          e.viewport.emphasiseEdge(on ? c.cand.edge : null);
        },
        onClick: () => {
          e.viewport.emphasiseEdge(null);
          e.viewport.applyPick(c.cand, mods);
        },
      })),
    );
    return true;
  };

  // toolOwnsScreen, not toolBusy, or a selected body (which raises Move) gets no menu. openCanvasMenu gates again.
  e.viewport.shouldOpenContextMenu = () => !e.toolOwnsScreen();
  e.viewport.onContextClick = (x, y) => e.menus.openCanvasMenu(x, y);

  // toolOwnsScreen, or one box over bodies would block every later box; the gizmo's handles stop their own press.
  e.viewport.canAreaSelect = () => !e.toolOwnsScreen() && !e.sketch.active;
  // The box replaces the selection that raised the gizmo, which would point at the old centroid.
  e.viewport.onAreaBegin = () => e.dropBodyGizmo();
  // The drag direction decides what the box takes, so say so while dragging.
  e.viewport.onAreaDrag = (mode) => {
    if (mode === null) {
      e.viewport.onSelectionChange?.();
      return;
    }
    const takes = areaFilterLabel(e.viewport.areaTakes);
    setPrompt(
      mode === "window"
        ? `Taking ${takes} fully inside the box, drag left to take anything it touches · Tab filters`
        : `Taking ${takes} the box touches, drag right to take only what is fully inside · Tab filters`,
    );
  };

  // A menu holds targets captured at open time, which a rebuild renumbers, so it closes before a stale click acts.
  e.store.onDocChange(() => dismissContextMenu());
  e.store.onBuild((s) => {
    if (s.result && !s.building) dismissContextMenu();
  });

  // A face's area only changes with a rebuild, and hover asks on every move.
  const faceAreas = new Map<number, number>();
  e.store.onBuild(() => faceAreas.clear());
  const regionAt = (x: number, y: number) => {
    // A cut answer that landed under a tool or dialog applies before an area from the old split is offered.
    if (e.overlay.splitStale) {
      e.overlay.update(e.store.document);
      e.viewport.requestRender();
    }
    const ray = e.viewport.rayFrom(x, y).ray;
    const wr = e.overlay.committedRegionAtRay(ray);
    if (!wr) return null;
    const onPlane = ray.intersectPlane(wr.plane.plane, new THREE.Vector3());
    const surface = e.viewport.surfaceHitAt(x, y);
    if (!onPlane || !surface) return wr;
    let faceArea = 0;
    if (surface.faceId !== null) {
      faceArea = faceAreas.get(surface.faceId) ?? e.viewport.faceArea(surface.faceId);
      faceAreas.set(surface.faceId, faceArea);
    }
    return regionBeatsSurface({
      regionDist: onPlane.distanceTo(ray.origin),
      surfaceDist: surface.distance,
      modelScale: e.viewport.modelDiagonal() ?? 0,
      regionArea: regionArea(wr.region),
      faceArea,
    })
      ? wr
      : null;
  };
  // A visible sketch's areas are pickable outside sketch mode, so Extrude can use them.
  e.viewport.regionHoverAt = (x, y) => {
    if (e.sketch.active || e.toolBusy()) {
      if (e.overlay.setHoverRegion(null)) e.viewport.requestRender();
      return false;
    }
    const wr = regionAt(x, y);
    if (e.overlay.setHoverRegion(wr)) e.viewport.requestRender();
    return !!wr;
  };
  // The section's handle lights on hover and is not a tool, so it keeps the per-move frame.
  e.viewport.quietPointer = () => !e.toolBusy() && !e.tools.section.editing;
  e.viewport.regionPickAt = (x, y, additive) => {
    if (e.sketch.active || e.toolBusy()) return false;
    const wr = regionAt(x, y);
    if (!wr) return false;
    e.overlay.toggleRegionSelection(wr, additive);
    refreshNudge();
    return true;
  };
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !e.toolBusy() && !e.sketch.active && e.overlay.selectedRegions().length) {
      e.overlay.clearRegionSelection();
      refreshNudge();
    }
  });

  // The Viewport is not reactive, so its body selection is mirrored into the browser store.
  const ribbonStore = useRibbonStore();
  const pushAnalysis = () => (ribbonStore.viewOn = analysisFlags(e.viewport));
  e.viewport.onAnalysisChange = pushAnalysis;
  pushAnalysis();
  const browser = useBrowserStore();
  browser.setSelectedBodies(e.viewport.getSelectedBodies());
  // Picking a body raises the Move gizmo on it; the tool hands a plain click back, so the next pick moves it on.
  e.viewport.onBodySelectionChange = (cause) => {
    browser.setSelectedBodies(e.viewport.getSelectedBodies());
    if (e.toolBusy()) return;
    const ids = e.viewport.getSelectedBodies();
    if (!ids.length) {
      setPrompt(null);
      return;
    }
    // Not on a rebuild restore: the gizmo's focused field would swallow every later Ctrl+Z (FI-2).
    if (cause === "restore") return;
    e.raiseBodyGizmo();
  };
  // toolOwnsScreen, since the raised gizmo cancels on the same key; capture phase, since its value box stops bubbling.
  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape" || escapeClaimed()) return;
      if (isEditableTarget(ev.target) && !e.tools.move.active) return;
      if (e.viewport.selecting === "bodies" && !e.toolOwnsScreen() && e.viewport.getSelectedBodies().length) {
        e.viewport.setSelectedBodies([]);
      }
    },
    true,
  );

  e.store.onDocChange(() => {
    if (!e.sketch.active) e.overlay.update(e.store.document);
  });

  // One handle for three selections, ranked: edges, then profiles (a region pick keeps the face selection under it),
  // then faces.
  function refreshNudge() {
    roundAsk++;
    exactRound.value = null;
    const edges = e.viewport.selectedEdgeLines();
    const regions = edges.length ? [] : e.overlay.selectedRegions();
    const faces = edges.length || regions.length ? null : e.viewport.selectedFacesForPressPull();

    if (edges.length) {
      // The same bbox centre EdgeFeatureTool reads, so the handle does not flip when the tool takes over.
      const bb = e.store.buildState.result?.bbox;
      const centre = bb
        ? new THREE.Vector3((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2)
        : null;
      e.nudge.show(
        edgeNudgePlacement(
          edges,
          (x, y, tangent, anchor) => e.starters.grabEdgeHandle(x, y, tangent, anchor),
          centre,
          e.viewport.selectedEdgeClickPoint(),
        ),
      );
    } else if (regions.length) {
      e.nudge.show(regionNudgePlacement(regions, (x, y) => e.starters.grabRegionHandle(x, y)));
    } else {
      e.nudge.show(faceNudgePlacement(faces, (x, y) => e.starters.grabFaceHandle(x, y)) ?? recentExtrudePlacement());
    }

    if (e.toolBusy()) return;
    const plural = (n: number, one: string) => `${n} ${one}${n > 1 ? "s" : ""}`;
    if (edges.length) {
      setPrompt(
        `${plural(edges.length, "edge")} selected, drag the handle to round it off ` +
          `(out fillets, back past zero chamfers) · Esc to clear`,
      );
    } else if (regions.length) {
      setPrompt(
        `${plural(regions.length, "profile area")} selected, drag the handle to pull it into a solid ` +
          `(in cuts) · Ctrl-click adds · Esc clears`,
      );
    } else if (faces?.round) {
      setPrompt(roundFacePrompt({ radius: faces.round.radius, full: faces.round.full !== false }));
      askExactRound(faces.selectors[0]!, faces.bodyId, faces.faceIds[0]!);
    } else if (faces?.lead) {
      setPrompt(
        `${plural(faces.faceIds.length, "face")} selected, drag the handle to resize them as one ` +
          `if they run smoothly together, or push them · Esc to clear`,
      );
    } else if (faces?.faceIds.length) {
      setPrompt(
        `${plural(faces.faceIds.length, "face")} selected, drag the handle to push or pull ` +
          `(out adds, in cuts) · Del removes it and heals · Esc to clear`,
      );
    } else {
      setPrompt(null);
    }
  }
  e.viewport.onSelectionChange = refreshNudge;

  let roundAsk = 0;
  /** The engine's size and wrap replace the mesh's guess in the prompt and the readout. */
  function askExactRound(face: Selector, bodyId: string | null, faceId: number) {
    const ask = roundAsk;
    void e.store.faceAxis(face, bodyId).then((reply) => {
      const r = offeredResize(reply, ["cylinder"]);
      if (ask !== roundAsk || !r) return;
      exactRound.value = { faceId, radius: r.radius, full: r.full };
      if (!e.toolBusy()) setPrompt(roundFacePrompt(r));
    });
  }

  // An extrude that just committed keeps its arrow on the far face until the user
  // moves on, so the next pull edits it instead of needing a double-click.
  function recentExtrudePlacement(): NudgePlacement | null {
    const last = e.tools.extrude.lastCommit;
    if (!last) return null;
    const features = e.store.document.features;
    const stillLast = features[features.length - 1]?.id === last.id && e.store.rollbackIndex === features.length;
    if (!stillLast || e.store.buildState.errorFeatureId === last.id) return null;
    return {
      anchor: last.top,
      axis: () => last.dir,
      grab: (x, y) => e.starters.grabExtrudeEdit(last.id, x, y),
    };
  }
  const dropRecentExtrude = () => {
    if (!e.tools.extrude.lastCommit || e.toolBusy()) return;
    e.tools.extrude.lastCommit = null;
    refreshNudge();
  };
  // Bubble phase: a press on the handle itself is stopped in capture by the nudge.
  e.viewport.domElement.addEventListener("pointerdown", (ev) => {
    // A finger drag nobody claimed orbits, as a mouse orbit would not drop it.
    if (ev.button === 0 && replayedPress(ev) !== "drag") dropRecentExtrude();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") dropRecentExtrude();
  });

  // Profile selection has no change event; registered after the overlay rebuild above, so it reads the new regions.
  e.store.onDocChange(() => refreshNudge());
  e.store.onBuild((s) => {
    if (s.result && !s.building) refreshNudge();
  });
}
