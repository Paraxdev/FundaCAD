import { computed, useId, type MaybeRefOrGetter, toValue } from "vue";
import { spokenUnit } from "../../ui/measure";

export interface FieldSpeechOptions {
  unit: MaybeRefOrGetter<string | null | undefined>;
  /** The caller's own `aria-describedby`, kept after the ids the field adds. */
  callerDescribedby: MaybeRefOrGetter<unknown>;
}

/** The plural, as it names the unit rather than an amount, so a description does not flip while typing. */
export function useFieldSpeech(o: FieldSpeechOptions) {
  const uid = useId();
  const unitId = `${uid}-unit`;
  const spoken = computed(() => {
    const u = toValue(o.unit);
    return u ? spokenUnit(u, true) : null;
  });
  const describedby = computed(() => {
    const caller = toValue(o.callerDescribedby);
    const ids = [spoken.value ? unitId : null, typeof caller === "string" ? caller : null].filter(Boolean);
    return ids.length ? ids.join(" ") : undefined;
  });
  return { unitId, spokenUnit: spoken, describedby };
}
