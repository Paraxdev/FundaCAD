import { computed, shallowRef, useId, type MaybeRefOrGetter, toValue } from "vue";
import { a11yPrefs, onA11yPrefsChange } from "../../ui/a11yPrefs";
import { spokenUnit } from "../../ui/measure";

const unitsInFull = shallowRef(a11yPrefs().unitsInFull);
onA11yPrefsChange(() => (unitsInFull.value = a11yPrefs().unitsInFull));

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
    return u ? spokenUnit(u, unitsInFull.value) : null;
  });
  const describedby = computed(() => {
    const caller = toValue(o.callerDescribedby);
    const ids = [spoken.value ? unitId : null, typeof caller === "string" ? caller : null].filter(Boolean);
    return ids.length ? ids.join(" ") : undefined;
  });
  return { unitId, spokenUnit: spoken, describedby };
}
