import * as THREE from "three";
import { setPrompt } from "../ui/prompt";
import { contextMenu, dismissContextMenu } from "../ui/menu";
import { FEATURE_META } from "../ui/featureMeta";
import { bodyRowLabel, distinguish, dominantOwner, edgeChoiceLabel } from "../ui/edgeChoice";
import { ambiguousCandidates } from "../viewport/edgeTies";
import { useBrowserStore } from "../stores/browser";
import { edgeNudgePlacement } from "../features/edgeNudge";
import { faceNudgePlacement } from "../features/faceNudge";
import { regionNudgePlacement } from "../features/regionNudge";
import type { Engine } from "./engine";

/** How far the ambiguous-edge menu sits off the click, px. */
const AMBIGUOUS_MENU_OFFSET = 16;

/** Viewport callbacks and the two Escape listeners that clear its selections.
 *
 *  The Viewport publishes through public callback FIELDS rather than events, so
 *  each of these is a single-slot assignment — last writer wins, and there is
 *  exactly one writer for each. */
export function installViewportWiring(e: Engine): void {
  // clicking a construction plane in the viewport selects it (so it can be cut by)
  e.viewport.onPickDatum = (id) => e.selectFeature(id);

  e.viewport.onHit = (hit) => {
    if (e.toolBusy()) return;
    // No prompt here any more: onSelectionChange fires straight after this and
    // owns the face line, now that a face selection offers a handle rather than
    // a list of commands to go and find.
    if (hit?.kind === "face") {
      const owner = e.featureForFace(hit.faceId);
      if (owner) e.selectFeature(owner); // show which feature this face came from
    }
  };

  // -------------------------------------------------------------------------
  // Viewport right-click: context-aware menus — one provider per target (datum
  // plane / edge / face / whole body / empty space), all on the shared engine in
  // ui/menu.ts. The viewport owns the click-vs-pan gesture (right button is
  // camera pan) and fires onContextClick only for a genuine click; toolBusy
  // gates it — an active tool (or sketch mode, which has its own canvas menu)
  // owns the gesture.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // A click that landed on two edges at once.
  //
  // Two bodies that meet share a boundary, and each keeps its own edge there —
  // same curve, same pixels. The picker ranks by distance from the cursor, which
  // is a tie, so the winner was whichever the raycaster reported first: stable
  // within a session, arbitrary between them, and impossible to override. Click
  // the seam between two extrusions and you got one of them with no way to say
  // which.
  //
  // So it asks. The menu is the ordinary right-click menu, which already knows
  // how to place itself, dismiss on Escape or an outside click, and stay on
  // screen near an edge — and hovering a row lights the edge it names, so which
  // is which is answered by looking at the model rather than by reading two
  // similar sentences.
  e.viewport.onAmbiguousEdge = (cands, at, mods) => {
    if (e.toolBusy()) return false;
    const bodies = e.store.buildState.result?.bodies ?? [];
    const featureName = (id: string | null) => {
      if (!id) return null;
      const f = e.store.document.features.find((x) => x.id === id);
      if (!f) return null;
      // `name` is optional and only present on some members of the union, so it
      // is read off the record rather than the narrowed type.
      const named = (f as { name?: string }).name;
      return named || (FEATURE_META[f.type as keyof typeof FEATURE_META]?.label ?? f.type);
    };
    const rows = cands.map((c) => {
      const index = bodies.findIndex((b) => b.id === c.edge.body);
      const body = index >= 0 ? bodies[index] : undefined;
      const name = c.edge.body ? (e.store.bodyName(c.edge.body) ?? body?.name ?? null) : null;
      return { cand: c, index, name, feature: featureName(dominantOwner(body?.faceOwners)) };
    });
    // Two boxes are both called "Box", so the name alone cannot separate the
    // rows. Number them by their place in the BODY LIST, which is the browser's
    // order, so "Box 2" means the same thing in both places.
    const shared = new Map<string, number>();
    for (const r of rows) if (r.name) shared.set(r.name, (shared.get(r.name) ?? 0) + 1);
    // distinguish() is the last resort under that: two edges of ONE body still
    // read alike, and edgeTies would drop the choice rather than offer it.
    const labels = distinguish(rows.map((r) =>
      edgeChoiceLabel(
        bodyRowLabel(r.name, r.index, (shared.get(r.name ?? "") ?? 0) > 1),
        r.feature,
        r.name,
      )));
    const choices = ambiguousCandidates(
      rows.map((r, i) => ({ ...r, label: labels[i] ?? "Edge", screenDist: r.cand.screenDist })),
    );
    if (choices.length < 2) return false; // nothing worth asking — take the nearest

    // Offset off the cursor, unlike every other menu the app pops. This one is
    // asking about geometry AT the cursor, and opening its top-left corner
    // exactly there covered the edges it was asking about. A small diagonal
    // nudge cannot clear a line running in every direction at once, but it
    // reliably clears the pixel that was clicked, and the over-drawn emphasis
    // does the rest.
    contextMenu(at.x + AMBIGUOUS_MENU_OFFSET, at.y + AMBIGUOUS_MENU_OFFSET, choices.map((c) => ({
      label: c.label,
      // Both: the tint says "this is the hovered edge" in the model's own
      // vocabulary, and the over-drawn line makes it visible past the menu,
      // which by construction opens right on top of the edges in question.
      //
      // KNOWN LIMIT, and not an oversight: where the two edges are EXACTLY
      // coincident — two bodies meeting along one line, the commonest reason
      // this menu opens at all — both previews draw the same pixels and only
      // the label separates them. Which is why the label is the part that
      // decides whether the menu opens (viewport/edgeTies.ts) rather than the
      // geometry. Distinguishing them on screen would mean lighting the whole
      // owning BODY, which is a bigger claim than a hover should make.
      onHover: (on: boolean) => {
        e.viewport.hoverEdge(on ? c.cand.edge : null);
        e.viewport.emphasiseEdge(on ? c.cand.edge : null);
      },
      onClick: () => {
        e.viewport.emphasiseEdge(null); // the choice is made; the pointer is gone
        e.viewport.applyPick(c.cand, mods);
      },
    })));
    return true;
  };

  e.viewport.shouldOpenContextMenu = () => !e.toolBusy();
  e.viewport.onContextClick = (x, y) => e.menus.openCanvasMenu(x, y);

  // A context menu holds targets captured at open time (faceId, edge line, body
  // id) — a completed rebuild renumbers topology and replaces the mesh, and any
  // document change can invalidate the owning feature. Dismiss rather than let a
  // click act on stale targets ("Delete face" healing the WRONG face).
  e.store.onDocChange(() => dismissContextMenu());
  e.store.onBuild((s) => {
    if (s.result && !s.building) dismissContextMenu();
  });

  // SOLID-mode direct selection of a visible sketch's profile AREAS (MCAD-style):
  // click a shown sketch's cell to (pre)select it, then Extrude (E) uses it. Only
  // fires when a sketch is visible (overlay.regions is empty otherwise), so normal
  // face/body picking is untouched the rest of the time.
  e.viewport.regionHoverAt = (x, y) => {
    if (e.sketch.active || e.toolBusy()) { e.overlay.setHoverRegion(null); return false; }
    const wr = e.overlay.committedRegionAtRay(e.viewport.rayFrom(x, y).ray);
    e.overlay.setHoverRegion(wr);
    return !!wr;
  };
  e.viewport.regionPickAt = (x, y, additive) => {
    if (e.sketch.active || e.toolBusy()) return false;
    const wr = e.overlay.committedRegionAtRay(e.viewport.rayFrom(x, y).ray);
    if (!wr) return false;
    e.overlay.toggleRegionSelection(wr, additive);
    refreshNudge();
    return true;
  };
  // Esc clears a pre-selected profile-area selection (when not in a tool/sketch)
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !e.toolBusy() && !e.sketch.active && e.overlay.selectedRegions().length) {
      e.overlay.clearRegionSelection();
      refreshNudge();
    }
  });

  // The Viewport owns the body selection and is not reactive, so mirror it into
  // the browser store on every change. That is also what killed the tree's old
  // `isBodySelected(id)` predicate, which allocated a fresh array and scanned it
  // once PER BODY on every doc change and every build.
  const browser = useBrowserStore();
  browser.setSelectedBodies(e.viewport.getSelectedBodies());
  e.viewport.onBodySelectionChange = () => {
    browser.setSelectedBodies(e.viewport.getSelectedBodies());
    if (e.toolBusy()) return;
    const n = e.viewport.getSelectedBodies().length;
    setPrompt(n ? `${n} bod${n > 1 ? "ies" : "y"} selected, Move (M) to drag · Esc to clear` : null);
  };
  // Esc clears the body selection while in Bodies mode
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && e.viewport.selecting === "bodies" && !e.toolBusy() && e.viewport.getSelectedBodies().length) {
      e.viewport.setSelectedBodies([]);
    }
  });

  // --- sketch overlays follow the document (when not actively sketching) ---
  e.store.onDocChange(() => {
    if (!e.sketch.active) e.overlay.update(e.store.document);
  });

  // --- selecting offers the drag handle straight away -----------------------
  // The old behaviour was a prompt line and nothing else: the entity lit up,
  // and you were expected to know that Fillet, Chamfer, Press/Pull or Extrude
  // would consume it. The handle puts the offer where the geometry is; the
  // prompt now explains the handle rather than substituting for it.
  //
  // Three kinds of selection, one handle — so this is also where they are ranked.
  // Edges first: an edge hit is the most specific thing the picker can return.
  // Then profiles, matching the picker's own sketch-over-solid priority (and
  // because a region pick deliberately does NOT clear the face selection
  // underneath it, so without this rule the handle would answer the wrong click).
  // Faces last.
  function refreshNudge() {
    const edges = e.viewport.selectedEdgeLines();
    const regions = edges.length ? [] : e.overlay.selectedRegions();
    const faces = edges.length || regions.length ? null : e.viewport.selectedFacesForPressPull();

    if (edges.length) {
      // The bbox centre decides which way is "out of the material" — read from
      // the store, the same source EdgeFeatureTool reads, so the handle does not
      // flip at the instant the tool takes the gesture over.
      const bb = e.store.buildState.result?.bbox;
      const centre = bb
        ? new THREE.Vector3(
            (bb.min[0] + bb.max[0]) / 2,
            (bb.min[1] + bb.max[1]) / 2,
            (bb.min[2] + bb.max[2]) / 2,
          )
        : null;
      e.nudge.show(
        edgeNudgePlacement(
          edges,
          (x, y, tangent) => e.starters.grabEdgeHandle(x, y, tangent),
          centre,
        ),
      );
    } else if (regions.length) {
      e.nudge.show(regionNudgePlacement(regions, (x, y) => e.starters.grabRegionHandle(x, y)));
    } else {
      e.nudge.show(faceNudgePlacement(faces, (x, y) => e.starters.grabFaceHandle(x, y)));
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
      setPrompt(
        `Round face selected (⌀${(faces.round.radius * 2).toFixed(2)}mm), drag the handle to resize it ` +
          `· drag it away to nothing to remove it · Esc to clear`,
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

  // Profile selection has no change notification of its own — it lives on the
  // overlay, which tools clear directly (extrude's edit-mode cancel) and which
  // the doc-change handler above rebuilds wholesale. Refreshing here catches
  // both, and registration order matters: this runs after that rebuild, so it
  // reads the regions that now exist rather than the ones that just went.
  e.store.onDocChange(() => refreshNudge());
  e.store.onBuild((s) => {
    if (s.result && !s.building) refreshNudge();
  });

  // A rebuild used to be the end of the handle: setModel built a fresh
  // Highlighter, the edge selection went with it, and the only safe response
  // was to drop the handle rather than let it act on a stale anchor. Cancelling
  // a fillet therefore left you looking at the sharp edge you started from with
  // nothing selected and no arrow — the preview's OWN rebuild had eaten the
  // selection the gesture was standing on.
  //
  // setModel now carries the selection across (viewport.ts captureSelection /
  // restoreSelection) and fires onSelectionChange either way, so the handler
  // above already re-places the handle on the rebuilt edge, or hides it when
  // the edge genuinely did not survive. Nothing to do here.
}
