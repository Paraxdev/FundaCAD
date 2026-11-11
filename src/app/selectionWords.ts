// What the selection is called on screen and in speech, whichever route made it. Only the readout makes one of these, so
// the other users of useSelectionOffers cost nothing here.

import { computed, shallowRef } from "vue";
import { t } from "../i18n";
import { countLine } from "../ui/selectionTools";
import { isOriginKey, useSelectionStore } from "../stores/selection";
import { describeChange, describePick, type FaceFacts, type PickFacts, type PickWords } from "../ui/describePick";
import { edgeKeyOf, edgeRows, faceRows, planeRows } from "../ui/geometryRows";
import { exactRound, type Pt3 } from "../ui/selectionMeasure";
import type { Engine } from "./engine";
import { bodyLabelsOf, labelled, ownerNamesOf, pickedRowKeys, softCancelOp } from "./geometryBrowser";
import { BASE_PLANES, SELECTION_SPEECH_DELAY } from "./planePick";

export interface SelectionSpeech {
  text: string;
  /** Only worth saying at Verbose. */
  verbose?: boolean;
}

type Said = Pick<PickWords, "label" | "spoken">;

// `f:<bodyId>:<place>` or `e:<bodyId>:<slot>`.
function keyPlace(key: string): { bodyId: string; place: number } {
  const at = key.lastIndexOf(":");
  return { bodyId: key.slice(2, at), place: Number(key.slice(at + 1)) };
}

export function createSelectionWords(e: Engine) {
  const speech = shallowRef<SelectionSpeech | null>(null);
  const lone = shallowRef<{ facts: PickFacts; faceId: number | null } | null>(null);
  const edges = shallowRef<readonly (readonly Pt3[])[]>([]);
  const faceRowCount = shallowRef(0);
  const planeCount = shallowRef(0);

  let said: string[] = [];
  let seen: { signature: string; result: unknown; rows: unknown } | null = null;
  let asking = 0;
  // The engine runs one op at a time, so a click's ask left running would hold up the next one and the next rebuild.
  let askingId: string | null = null;
  // When the lone item's words went out, while they may still be waiting to be spoken.
  let spokenAt: number | null = null;

  const metaOf = (id: string) => {
    const meta = e.store.buildState.result?.bodies?.find((b) => b.id === id);
    return meta ? labelled(meta, bodyLabelsOf(e.store)) : null;
  };

  // What the mesh already knows of the one selected face, memoised by press and pull. The engine knows more.
  function meshFacts(key: string): FaceFacts | null {
    const { bodyId, place } = keyPlace(key);
    const meta = metaOf(bodyId);
    if (!meta) return null;
    const faceIds = e.viewport.getSelectedFaceIds();
    const facts: FaceFacts = { kind: "face", number: place + 1, surface: "curved", body: meta.name };
    const owner = meta.faceOwners?.[place];
    if (owner) facts.owner = ownerNamesOf(e.store)(owner);
    if (faceIds.length > 1) facts.pieces = faceIds.length;
    const press = e.viewport.selectedFacesForPressPull();
    const round = press?.round ?? press?.lead;
    if (round) {
      facts.surface = round.centre ? "sphere" : "cylinder";
      facts.radius = round.radius;
      facts.full = round.full !== false;
      facts.concave = !round.solidInside;
      return facts;
    }
    const flat = e.viewport.planarFace(faceIds[0]!);
    if (flat) {
      facts.surface = "plane";
      facts.normal = [flat.normal.x, flat.normal.y, flat.normal.z];
      facts.centroid = [flat.origin.x, flat.origin.y, flat.origin.z];
    }
    return facts;
  }

  // A mesh walk per Ctrl-click would freeze a big body (faceAnalysis.ts), so only a lone face gets one.
  function factsOf(key: string): PickFacts | null {
    if (key.startsWith("p:")) {
      const planes = planeRows(BASE_PLANES, e.store.document.features, e.datumPlaneDef, (id) =>
        e.store.isSuppressed(id),
      );
      return planes.find((r) => r.key === key)?.facts ?? null;
    }
    const row = e.geometryBrowser.rowFacts(key);
    if (row) return row;
    if (!key.startsWith("e:")) return null;
    const edge = e.viewport.selectedEdgeLines().find((x) => x.body !== undefined && edgeKeyOf(x.body, x.slot) === key);
    const meta = edge ? metaOf(edge.body!) : null;
    return meta ? edgeRows([edge!], 0, undefined, meta, ownerNamesOf(e.store))[0]!.facts : null;
  }

  function wordsOf(key: string, known: PickFacts | null): Said {
    const facts = known ?? factsOf(key);
    if (facts) {
      const words = describePick(facts);
      // A row's Enter starts a sketch, a plane picked elsewhere may not.
      return facts.kind === "plane" ? { label: words.label, spoken: words.aloud ?? words.spoken } : words;
    }
    const kind = key.slice(0, 2);
    if (kind === "b:") {
      const name = metaOf(key.slice(2))?.name ?? key.slice(2);
      return { label: name, spoken: name };
    }
    if (kind === "r:") return { label: t("pick.name.profile"), spoken: countLine("sketch-region", 1) };
    const name = t(kind === "e:" ? "pick.name.edge" : "pick.name.face", { type: "other", n: keyPlace(key).place + 1 });
    return { label: name, spoken: name };
  }

  // The one face alone, so a person who never opens the list never loads a 10,000 face body. A late answer changes the
  // screen but says nothing more, its first words have been heard by then.
  function askEngine(key: string) {
    const build = e.store.buildState;
    const meta = metaOf(keyPlace(key).bodyId);
    if (!meta || build.building || build.previewBuilt) return;
    const mine = asking;
    const { result } = build;
    const faces = e.viewport.getSelectedFaceIds().map((id) => id - meta.faceStart);
    const onStarted = (id: string) => {
      if (mine === asking) askingId = id;
      else softCancelOp(e.geometry, id);
    };
    e.store.topology(meta.id, { faces }, onStarted).then(
      (reply) => {
        if (mine !== asking) return;
        askingId = null;
        if (e.store.buildState.result !== result || !reply) return;
        const row = faceRows(reply, meta, ownerNamesOf(e.store)).find((r) => r.key === key);
        if (!row) return;
        lone.value = { facts: row.facts, faceId: lone.value?.faceId ?? null };
        if (spokenAt !== null && performance.now() - spokenAt < SELECTION_SPEECH_DELAY) {
          speech.value = { text: describePick(row.facts).spoken };
        }
      },
      () => {
        if (mine === asking) askingId = null;
      },
    );
  }

  function supersede() {
    asking++;
    if (askingId) softCancelOp(e.geometry, askingId);
    askingId = null;
  }

  // Planes stay selected as rows of Items, the viewport knows nothing of them.
  function pickedPlaneKeys(rows: readonly string[]): string[] {
    const features = e.store.document.features;
    const isDatum = (k: string) =>
      features.some((f) => f.id === k && f.type === "datumPlane") && !e.store.isSuppressed(k);
    return rows.filter((k) => isOriginKey(k) || isDatum(k)).map((k) => `p:${k}`);
  }

  const line = computed(() => {
    const now = lone.value;
    if (!now) return "";
    const exact = exactRound.value;
    if (now.facts.kind !== "face" || !exact || exact.faceId !== now.faceId || now.facts.radius === undefined) {
      return describePick(now.facts).readout;
    }
    return describePick({ ...now.facts, radius: exact.radius, full: exact.full }).readout;
  });

  /** Called every frame, it costs nothing until the selection or the build changed. */
  function update(signature: string, toolOwns: boolean, escaped: boolean) {
    if (toolOwns) {
      // The tool's prompt speaks. Whatever stays selected when it ends is said whole.
      supersede();
      said = [];
      seen = null;
      speech.value = null;
      return;
    }
    const result = e.store.buildState.result;
    const rows = useSelectionStore().rows.keys;
    if (seen?.signature === signature && seen.result === result && seen.rows === rows) return;
    seen = { signature, result, rows };
    supersede();

    const regionKeys = e.overlay.selectedRegions().map((r) => `r:${r.interior3D.x}`);
    const rowKeys = pickedRowKeys(e);
    const planeKeys = pickedPlaneKeys(rows);
    const keys = [...rowKeys, ...regionKeys, ...planeKeys];
    planeCount.value = planeKeys.length;
    faceRowCount.value = rowKeys.filter((k) => k.startsWith("f:")).length;
    edges.value = e.viewport.selectedEdgeLines().map((x) => x.points);

    const only = keys.length === 1 ? keys[0]! : null;
    const known = only ? factsOf(only) : null;
    const needsEngine = !known && only?.startsWith("f:") === true;
    const facts = needsEngine ? meshFacts(only!) : known;
    lone.value = facts && {
      facts,
      faceId: facts.kind === "face" ? (e.viewport.getSelectedFaceIds()[0] ?? null) : null,
    };

    const bodyOf = (k: string) => (/^[fe]:/.test(k) ? (metaOf(keyPlace(k).bodyId)?.name ?? null) : null);
    const text = describeChange(said, keys, (k) => wordsOf(k, k === only ? facts : null), bodyOf);
    said = keys;
    spokenAt = null;
    if (text) {
      speech.value = keys.length || escaped ? { text } : { text, verbose: true };
      if (facts && text === describePick(facts).spoken) spokenAt = performance.now();
    }
    if (needsEngine) askEngine(only!);
  }

  return { speech, line, edges, faceRowCount, planeCount, update };
}
