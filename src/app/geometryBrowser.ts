// Feeds the Geometry list: asks the engine for the active body's faces, caches the replies, follows the selection and
// turns a row into a pick. The list's state lives in stores/geometryBrowser.ts.

import type { GeometryBackend } from "../geometry/client";
import type { RebuildState } from "../document/store";
import { useSelectionStore } from "../stores/selection";
import { useGeometryBrowserStore, type GeometryKind } from "../stores/geometryBrowser";
import type { TopologyReply } from "../types";
import { stepName } from "../ui/featureMeta";
import {
  edgeKeyOf,
  edgeRows,
  faceKeyOf,
  faceRows,
  planeRowKey,
  planeRows,
  type BodyMeta,
  type GeometryRow,
} from "../ui/geometryRows";
import type { EdgeRef } from "../viewport/edgeLines";
import { faceIdOf, type SelectorHost } from "../viewport/modelSelectors";
import type { PickRef } from "../viewport/picking";
import type { Viewport } from "../viewport/viewport";
import type { Engine } from "./engine";
import { featurePick } from "./featurePick";
import { writeFeatureRows } from "./featureRows";
import { BASE_PLANES, routePlaneRow, sketchOnPlane, type PlanePick } from "./planePick";

export interface GeometryBrowserHost {
  store: Engine["store"];
  geometry: Pick<GeometryBackend, "cancel" | "softCancel">;
  viewport: SelectorHost["viewport"] &
    Pick<
      Viewport,
      | "applyPicks"
      | "bodyEdgeRefs"
      | "faceIdToBodyId"
      | "getSelectedBodies"
      | "getSelectedFaceIds"
      | "hoverDatum"
      | "hoverPick"
      | "hoverPlane"
      | "modelUnsettled"
      | "picksSuspended"
      | "policy"
      | "selectedEdgeLines"
      | "selectionBodyIds"
      | "showAllPlanes"
    >;
  sketch: Pick<Engine["sketch"], "active" | "enter">;
  datumPlaneDef: Engine["datumPlaneDef"];
  selectFeatureRows: Engine["selectFeatureRows"];
  setStatus: Engine["setStatus"];
  toolBusy(): boolean;
  toolOwnsScreen(): boolean;
  dropBodyGizmo(): void;
  handleAction(action: string): void;
}

type Body = NonNullable<NonNullable<RebuildState["result"]>["bodies"]>[number];

export function ownerNamesOf(store: Engine["store"]): (id: string) => string | null {
  const names = new Map(store.document.features.map((f) => [f.id, stepName(f as Parameters<typeof stepName>[0])]));
  return (id) => names.get(id) ?? null;
}

/** The selected faces, edges and bodies as row keys, a run's pieces as one. */
export function pickedRowKeys(e: {
  store: Engine["store"];
  viewport: Pick<Viewport, "faceIdToBodyId" | "getSelectedBodies" | "getSelectedFaceIds" | "selectedEdgeLines">;
}): string[] {
  const keys = new Set<string>();
  const metas = new Map<string, Body | null>();
  for (const faceId of e.viewport.getSelectedFaceIds()) {
    const id = e.viewport.faceIdToBodyId(faceId);
    if (id === null) continue;
    if (!metas.has(id)) metas.set(id, e.store.buildState.result?.bodies?.find((b) => b.id === id) ?? null);
    const body = metas.get(id);
    if (body) keys.add(faceKeyOf(body, faceId - body.faceStart));
  }
  for (const edge of e.viewport.selectedEdgeLines()) {
    if (edge.body !== undefined) keys.add(edgeKeyOf(edge.body, edge.slot));
  }
  for (const id of e.viewport.getSelectedBodies()) keys.add(`b:${id}`);
  return [...keys];
}

// A reply at 10,004 faces measured 1.47 MB.
const CACHED_REPLIES = 4;
const ROW_CHANGED = "That row has changed, the list is catching up";

export function createGeometryBrowser(e: GeometryBrowserHost) {
  const list = useGeometryBrowserStore();
  const cache = new Map<string, TopologyReply>();

  let shown = false;
  let stepped = false;
  let asking: { key: string; requestId: string | null } | null = null;
  let failedKey: string | null = null;
  // Which body and etag the rows on show were made from, and whether they must be made again whatever it says.
  let rowsKey: string | null = null;
  let rowsStale = true;
  let edgeRefs = new Map<number, EdgeRef>();
  let lastResult: RebuildState["result"] = null;
  let resultSerial = 0;

  const metaOf = (id: string | null): Body | null =>
    (id !== null && e.store.buildState.result?.bodies?.find((b) => b.id === id)) || null;

  // A body with no etag is rebuilt on every build, so its reply is good for this build alone.
  const cacheKey = (body: Body) => `${body.id}|${body.etag ?? `#${resultSerial}`}`;

  function showRows(body: BodyMeta, key: string, reply: TopologyReply | null) {
    const stamp = `${key}|${list.kind}|${reply ? "reply" : "bare"}`;
    if (!rowsStale && rowsKey === stamp) return;
    // Old face rows stay until the new ones land, so focus can survive them. Their numbers may no longer mean the same
    // faces, which is why rowsKey keeps the old stamp and pickRows refuses them.
    if (list.kind !== "edges" && !reply) return;
    // Before setRows, whose watchers ask refOf about the new rows at once.
    rowsKey = stamp;
    rowsStale = false;
    if (list.kind === "edges") {
      const refs = e.viewport.bodyEdgeRefs(body.id);
      edgeRefs = new Map(refs.map((r) => [r.slot, r]));
      list.setRows(edgeRows(refs, refs[0]?.draw.refs.length ?? 0, reply?.edgeFaces, body, ownerNamesOf(e.store)));
    } else {
      list.setRows(faceRows(reply!, body, ownerNamesOf(e.store)));
    }
  }

  // A hard cancel restarts the engine, too much for a list. Without a soft one the old op is left to finish.
  function softCancel(requestId: string) {
    if (e.geometry.softCancel) void e.geometry.cancel?.(requestId, { soft: true }).catch(() => {});
  }

  function stopAsking() {
    const was = asking;
    asking = null;
    if (was?.requestId) softCancel(was.requestId);
  }

  function landed(bodyId: string, key: string, reply: TopologyReply | null) {
    const body = metaOf(bodyId);
    if (!body) return;
    if (cacheKey(body) !== key) {
      if (wanted()) ensure();
      return;
    }
    if (!reply) {
      failedKey = key;
      if (list.kind === "faces") list.setRows([]);
      list.setState("error", "The engine could not list this body's faces.");
      return;
    }
    cache.set(key, reply);
    while (cache.size > CACHED_REPLIES) cache.delete(cache.keys().next().value!);
    showWithReply(body, key, reply);
  }

  function showWithReply(body: Body, key: string, reply: TopologyReply) {
    showRows(body, key, reply);
    list.setTruncated(reply.truncated?.faces ?? null);
    list.setState("ready");
  }

  function ask(body: Body, key: string) {
    stopAsking();
    const mine: { key: string; requestId: string | null } = { key, requestId: null };
    asking = mine;
    list.setState("loading");
    const onStarted = (id: string) => {
      mine.requestId = id;
      if (asking !== mine) softCancel(id);
    };
    e.store.topology(body.id, undefined, onStarted).then(
      (reply) => {
        if (asking !== mine) return;
        asking = null;
        landed(body.id, key, reply);
      },
      () => {
        if (asking !== mine) return;
        asking = null;
        landed(body.id, key, null);
      },
    );
  }

  // The last rows stay through a preview or a stream, the settled build calls this again.
  function ensure() {
    if (list.kind === "planes") {
      list.setRows(
        planeRows(BASE_PLANES, e.store.document.features, e.datumPlaneDef, (id) => e.store.isSuppressed(id)),
      );
      list.setState("ready");
      return;
    }
    const build = e.store.buildState;
    if (build.building || build.previewBuilt) return;
    const body = metaOf(list.bodyId);
    if (!body) {
      stopAsking();
      list.setRows([]);
      list.setState("idle");
      rowsKey = null;
      return;
    }
    const key = cacheKey(body);
    if (failedKey !== key) failedKey = null;
    const hit = cache.get(key);
    if (hit) {
      stopAsking();
      cache.delete(key);
      cache.set(key, hit);
      showWithReply(body, key, hit);
      return;
    }
    showRows(body, key, null);
    if (asking?.key !== key && failedKey !== key) ask(body, key);
  }

  const wanted = () => shown || stepped;
  const visibleBodies = () => (e.store.buildState.result?.bodies ?? []).filter((b) => e.store.isBodyVisible(b.id));

  function setBody(id: string | null) {
    if (id === list.bodyId) return;
    stopAsking();
    list.setBody(id);
    if (list.kind === "planes") return;
    list.setState("idle");
    rowsKey = null;
    if (wanted()) ensure();
  }

  function selectionOwner(among: readonly { id: string }[]): string | null {
    const ids = new Set(among.map((b) => b.id));
    return e.viewport.selectionBodyIds().find((id) => ids.has(id)) ?? null;
  }

  function syncSelected(): boolean {
    const next = pickedRowKeys(e);
    const was = list.selected;
    if (next.length === was.length && next.every((k, i) => k === was[i])) return false;
    list.setSelected(next);
    return true;
  }

  function refOf(row: GeometryRow): PickRef | null {
    const body = metaOf(row.bodyId);
    if (!body || rowsKey?.startsWith(`${cacheKey(body)}|`) !== true) return null;
    if (row.kind === "edge") {
      const edge = edgeRefs.get(row.index);
      return edge && edge.body === row.bodyId ? { kind: "edge", edge } : null;
    }
    const faceId = faceIdOf(e, row.bodyId, row.index);
    return faceId === null ? null : { kind: "face", faceId };
  }

  function heldBlocked(): string | null {
    if (e.sketch.active) return "Finish the sketch first";
    return e.toolOwnsScreen() ? "Finish the tool first" : null;
  }

  /** Why a row cannot be picked now, in words, or null when it can. */
  function pickBlocked(): string | null {
    const held = heldBlocked();
    if (held) return held;
    // The Move gizmo a body selection raises suspends picking too, but picking a row drops it first.
    const unsettled = e.toolBusy() ? e.viewport.modelUnsettled : e.viewport.picksSuspended;
    return unsettled ? "The model is still building" : null;
  }

  // Resolved at the moment of acting, so a datum goes where it stands now. Null for one the document has lost.
  function planePickOf(row: GeometryRow): PlanePick | null {
    const p = row.plane;
    if (p?.kind === "basePlane") return p;
    const f = e.store.document.features.find((x) => x.id === p?.id);
    return f?.type === "datumPlane" ? (featurePick(e, f) as PlanePick) : null;
  }

  function lightPlane(row: GeometryRow | null) {
    const p = row?.plane;
    // Origin tiles draw only in a plane pick, and a pick owns them while it waits.
    if (!heldBlocked()) e.viewport.showAllPlanes(p?.kind === "basePlane");
    e.viewport.hoverPlane(p?.kind === "basePlane" ? p.plane : null);
    e.viewport.hoverDatum(p?.kind === "datumPlane" ? p.id : null);
  }

  // Selects as Ctrl or Shift on an Items row does. A build changes nothing about a plane, so only a tool or a sketch
  // stands in the way.
  function pickPlanes(rows: readonly GeometryRow[], additive: boolean): string | null {
    const blocked = heldBlocked();
    if (blocked) return blocked;
    const named = rows.map((r) => planeRowKey(r.plane!));
    const last = named.at(-1);
    if (last === undefined) return null;
    const had = useSelectionStore().rows.keys;
    const keys = additive
      ? [...had.filter((k) => !named.includes(k)), ...named.filter((k) => !had.includes(k))]
      : named;
    writeFeatureRows(e, { keys, anchor: last }, last);
    return null;
  }

  function forgetDocument() {
    asking = null;
    cache.clear();
    failedKey = null;
    stepped = false;
    rowsKey = null;
    rowsStale = true;
    edgeRefs = new Map();
    lastResult = null;
    list.reset();
  }

  const own = (s: { own(dispose: () => void): unknown }) => {
    s.own(forgetDocument);
  };
  own(e.store.sessions.current);
  e.store.sessions.onBegin(own);
  // A rename or a newly suppressed datum changes the plane rows before any build lands.
  e.store.onDocChange(() => {
    if (list.kind === "planes" && wanted()) ensure();
  });

  return {
    /** The Geometry tab came into view or left it. */
    show(on: boolean) {
      shown = on;
      if (!on) return;
      rowsStale = true;
      ensure();
    },
    setBody,
    setKind(kind: GeometryKind) {
      if (kind === list.kind) return;
      if (list.kind === "planes") lightPlane(null);
      if (kind === "planes") stopAsking();
      list.setKind(kind);
      rowsKey = null;
      if (wanted()) ensure();
    },
    /** Ask again after an error. */
    retry() {
      failedKey = null;
      ensure();
    },

    buildChanged(s: RebuildState) {
      if (s.building || s.previewBuilt) return;
      if (s.result !== lastResult) {
        lastResult = s.result;
        resultSerial++;
        rowsStale = true;
      }
      const bodies = visibleBodies();
      list.setBodies(bodies.map((b) => ({ id: b.id, name: b.name })));
      if (!bodies.some((b) => b.id === list.bodyId)) setBody(selectionOwner(bodies) ?? bodies[0]?.id ?? null);
      syncSelected();
      if (wanted()) ensure();
    },

    /** Follows only a selection that changed, so a build cannot undo the Body field. */
    selectionChanged() {
      if (e.store.buildState.previewBuilt || !syncSelected()) return;
      if (list.bodyId !== null && e.viewport.selectionBodyIds().includes(list.bodyId)) return;
      const owner = selectionOwner(visibleBodies());
      if (owner !== null) setBody(owner);
    },

    pickBlocked,

    /** A row's facts, while its number still means this build's face or edge. */
    rowFacts(key: string): GeometryRow["facts"] | null {
      const row = list.rows.find((r) => r.key === key);
      const body = row ? metaOf(row.bodyId) : null;
      return row && body && rowsKey?.startsWith(`${cacheKey(body)}|`) ? row.facts : null;
    },

    /** Selects these rows as one change, a click's route. The reason in words when refused. */
    pickRows(rows: readonly GeometryRow[], o: { additive: boolean }): string | null {
      if (list.kind === "planes") return pickPlanes(rows, o.additive);
      const blocked = pickBlocked();
      if (blocked) return blocked;
      const refs = rows.map(refOf);
      if (refs.some((r) => r === null)) return ROW_CHANGED;
      e.dropBodyGizmo();
      // applyPicks leaves the policy alone, and with Bodies still set the toolbar would keep showing it.
      if (e.viewport.policy === "bodies") e.handleAction("selmode-faces");
      e.viewport.applyPicks(refs as PickRef[], o);
      return null;
    },

    /** Enter or a plain click on a plane row: a waiting pick takes it, otherwise a sketch starts on it. `start` false
     *  only offers it to the pick, for a Ctrl or Shift click. True when nothing further should happen. */
    activatePlane(row: GeometryRow, start = true): boolean {
      const pick = planePickOf(row);
      if (!pick) {
        e.setStatus(ROW_CHANGED, "");
        return true;
      }
      if (routePlaneRow(e, pick) !== "row") return true;
      if (!start) return false;
      lightPlane(null);
      sketchOnPlane(e, pick);
      return true;
    },

    /** Lights a row in the view. Not while a tool runs, its own hover shares the edge emphasis. */
    hover(row: GeometryRow | null) {
      if (list.kind === "planes") {
        lightPlane(pickBlocked() ? null : row);
        return;
      }
      if (pickBlocked()) return;
      e.viewport.hoverPick(row && refOf(row));
    },

    /** From here on the list stays live through builds, tab open or not. */
    startStepping() {
      stepped = true;
      ensure();
    },

    /** Moves the cursor along the filtered list and wraps, the first step also starts the fetch. */
    step(delta: 1 | -1): GeometryRow | null {
      stepped = true;
      ensure();
      const rows = list.filtered;
      if (!rows.length) return null;
      const at = rows.findIndex((r) => r.key === list.cursor);
      const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length;
      const row = rows[next]!;
      list.setCursor(row.key);
      return row;
    },
  };
}

export type GeometryBrowser = ReturnType<typeof createGeometryBrowser>;
