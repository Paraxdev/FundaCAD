// What the selection is called on screen and in speech, whichever route made it. Only the readout makes one of these, so
// the other users of useSelectionOffers cost nothing here.

import { computed, shallowRef } from "vue";
import { describeChange, describePick, type FaceFacts, type PickFacts, type PickWords } from "../ui/describePick";
import { edgeKeyOf, edgeRows } from "../ui/geometryRows";
import { exactRound, type Pt3 } from "../ui/selectionMeasure";
import type { Engine } from "./engine";
import { ownerNamesOf, pickedRowKeys } from "./geometryBrowser";

export interface SelectionSpeech {
  text: string;
  /** Only worth saying at Verbose. */
  verbose?: boolean;
}

/** How long a selection's words wait to be spoken, so a run of Ctrl-clicks says only its last. */
export const SELECTION_SPEECH_DELAY = 250;

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

  let said: string[] = [];
  let seen: { signature: string; result: unknown } | null = null;

  const metaOf = (id: string) => e.store.buildState.result?.bodies?.find((b) => b.id === id) ?? null;

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
    const row = e.geometryBrowser.rowFacts(key);
    if (row) return row;
    if (!key.startsWith("e:")) return null;
    const edge = e.viewport.selectedEdgeLines().find((x) => x.body !== undefined && edgeKeyOf(x.body, x.slot) === key);
    const meta = edge ? metaOf(edge.body!) : null;
    return meta ? edgeRows([edge!], 0, undefined, meta, ownerNamesOf(e.store))[0]!.facts : null;
  }

  function wordsOf(key: string, known: PickFacts | null): Said {
    const facts = known ?? factsOf(key);
    if (facts) return describePick(facts);
    const kind = key.slice(0, 2);
    if (kind === "b:") {
      const name = metaOf(key.slice(2))?.name ?? key.slice(2);
      return { label: name, spoken: name };
    }
    if (kind === "r:") return { label: "Profile", spoken: "1 profile" };
    const name = `${kind === "e:" ? "Edge" : "Face"} ${keyPlace(key).place + 1}`;
    return { label: name, spoken: name };
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
  function update(signature: string, toolOwns: boolean) {
    if (toolOwns) {
      // The tool's prompt speaks. Whatever stays selected when it ends is said whole.
      said = [];
      seen = null;
      speech.value = null;
      return;
    }
    const result = e.store.buildState.result;
    if (seen?.signature === signature && seen.result === result) return;
    seen = { signature, result };

    const regionKeys = e.overlay.selectedRegions().map((r) => `r:${r.interior3D.x}`);
    const rowKeys = pickedRowKeys(e);
    const keys = [...rowKeys, ...regionKeys];
    faceRowCount.value = rowKeys.filter((k) => k.startsWith("f:")).length;
    edges.value = e.viewport.selectedEdgeLines().map((x) => x.points);

    const only = keys.length === 1 ? keys[0]! : null;
    const facts = only ? (factsOf(only) ?? (only.startsWith("f:") ? meshFacts(only) : null)) : null;
    lone.value = facts && {
      facts,
      faceId: facts.kind === "face" ? (e.viewport.getSelectedFaceIds()[0] ?? null) : null,
    };

    const text = describeChange(said, keys, (k) => wordsOf(k, k === only ? facts : null));
    said = keys;
    if (text) speech.value = keys.length ? { text } : { text, verbose: true };
  }

  return { speech, line, edges, faceRowCount, update };
}
