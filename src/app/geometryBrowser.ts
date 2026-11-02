// Feeds the Geometry list: asks the engine for the active body's faces, caches the replies, follows the selection and
// turns a row into a pick. The list's state lives in stores/geometryBrowser.ts.

import type { GeometryBackend } from "../geometry/client";
import type { DocumentStore, RebuildState } from "../document/store";
import { useGeometryBrowserStore, type GeometryKind } from "../stores/geometryBrowser";
import type { TopologyReply } from "../types";
import { stepName } from "../ui/featureMeta";
import { edgeKeyOf, edgeRows, faceKeyOf, faceRows, type BodyMeta, type GeometryRow } from "../ui/geometryRows";
import type { EdgeRef } from "../viewport/edgeLines";
import { faceIdOf, type SelectorHost } from "../viewport/modelSelectors";
import type { PickRef } from "../viewport/picking";
import type { Viewport } from "../viewport/viewport";

export interface GeometryBrowserHost {
  store: SelectorHost["store"] & Pick<DocumentStore, "document" | "isBodyVisible" | "sessions" | "topology">;
  geometry: Pick<GeometryBackend, "cancel" | "softCancel">;
  viewport: SelectorHost["viewport"] &
    Pick<
      Viewport,
      | "applyPicks"
      | "bodyEdgeRefs"
      | "faceIdToBodyId"
      | "getSelectedBodies"
      | "getSelectedFaceIds"
      | "hoverPick"
      | "modelUnsettled"
      | "picksSuspended"
      | "policy"
      | "selectedEdgeLines"
      | "selectionBodyIds"
    >;
  sketch: { active: boolean };
  toolBusy(): boolean;
  toolOwnsScreen(): boolean;
  dropBodyGizmo(): void;
  handleAction(action: string): void;
}

type Body = NonNullable<NonNullable<RebuildState["result"]>["bodies"]>[number];

// A reply at 10,004 faces measured 1.47 MB.
const CACHED_REPLIES = 4;

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

  function ownerNames(): (id: string) => string | null {
    const names = new Map(e.store.document.features.map((f) => [f.id, stepName(f as Parameters<typeof stepName>[0])]));
    return (id) => names.get(id) ?? null;
  }

  function showRows(body: BodyMeta, key: string, reply: TopologyReply | null) {
    const stamp = `${key}|${list.kind}|${reply ? "reply" : "bare"}`;
    if (!rowsStale && rowsKey === stamp) return;
    if (list.kind === "edges") {
      const refs = e.viewport.bodyEdgeRefs(body.id);
      edgeRefs = new Map(refs.map((r) => [r.slot, r]));
      list.setRows(edgeRows(refs, refs[0]?.draw.refs.length ?? 0, reply?.edgeFaces, body, ownerNames()));
    } else if (reply) {
      list.setRows(faceRows(reply, body, ownerNames()));
    } else {
      // Old face rows stay until the new ones land, so focus can survive them. Their numbers may no longer mean the
      // same faces, which is why rowsKey keeps the old stamp and pickRows refuses them.
      return;
    }
    rowsKey = stamp;
    rowsStale = false;
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
      list.setState("error", "The engine could not list this body's faces.");
      if (list.kind === "faces") list.setRows([]);
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
    list.setState("idle");
    rowsKey = null;
    if (wanted()) ensure();
  }

  function selectionOwner(among: readonly { id: string }[]): string | null {
    const ids = new Set(among.map((b) => b.id));
    return e.viewport.selectionBodyIds().find((id) => ids.has(id)) ?? null;
  }

  function readSelection(): readonly string[] {
    const keys = new Set<string>();
    const metas = new Map<string, Body | null>();
    for (const faceId of e.viewport.getSelectedFaceIds()) {
      const id = e.viewport.faceIdToBodyId(faceId);
      if (id === null) continue;
      if (!metas.has(id)) metas.set(id, metaOf(id));
      const body = metas.get(id);
      if (body) keys.add(faceKeyOf(body, faceId - body.faceStart));
    }
    for (const edge of e.viewport.selectedEdgeLines()) {
      if (edge.body !== undefined) keys.add(edgeKeyOf(edge.body, edge.slot));
    }
    for (const id of e.viewport.getSelectedBodies()) keys.add(`b:${id}`);
    return [...keys];
  }

  function syncSelected(): boolean {
    const next = readSelection();
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

  /** Why a row cannot be picked now, in words, or null when it can. */
  function pickBlocked(): string | null {
    if (e.sketch.active) return "Finish the sketch first";
    if (e.toolOwnsScreen()) return "Finish the tool first";
    // The Move gizmo a body selection raises suspends picking too, but picking a row drops it first.
    const unsettled = e.toolBusy() ? e.viewport.modelUnsettled : e.viewport.picksSuspended;
    return unsettled ? "The model is still building" : null;
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

    /** Selects these rows as one change, a click's route. The reason in words when refused. */
    pickRows(rows: readonly GeometryRow[], o: { additive: boolean }): string | null {
      const blocked = pickBlocked();
      if (blocked) return blocked;
      const refs = rows.map(refOf);
      if (refs.some((r) => r === null)) return "That row has changed, the list is catching up";
      e.dropBodyGizmo();
      // applyPicks leaves the policy alone, and with Bodies still set the toolbar would keep showing it.
      if (e.viewport.policy === "bodies") e.handleAction("selmode-faces");
      e.viewport.applyPicks(refs as PickRef[], o);
      return null;
    },

    /** Lights a row in the view. Not while a tool runs, its own hover shares the edge emphasis. */
    hover(row: GeometryRow | null) {
      if (pickBlocked()) return;
      e.viewport.hoverPick(row && refOf(row));
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
