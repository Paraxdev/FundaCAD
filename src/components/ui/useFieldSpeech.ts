import { computed, onBeforeUnmount, shallowRef, useId, watch, type MaybeRefOrGetter, toValue } from "vue";
import { announce } from "../../ui/announce";
import { a11yPrefs, onA11yPrefsChange } from "../../ui/a11yPrefs";
import { spokenUnit } from "../../ui/measure";

const unitsInFull = shallowRef(a11yPrefs().unitsInFull);
onA11yPrefsChange(() => (unitsInFull.value = a11yPrefs().unitsInFull));

/** A typing pause in live mode: long enough that a half typed "-" is not called an error. */
export const LIVE_ERROR_PAUSE_MS = 700;

export interface FieldSpeechOptions {
  el: Readonly<{ value: HTMLElement | null }>;
  unit?: MaybeRefOrGetter<string | null | undefined>;
  /** The reason the field is refused, own or from outside, or null. */
  error: MaybeRefOrGetter<string | null | undefined>;
  /** Live fields speak after a pause, change fields at once. */
  live: MaybeRefOrGetter<boolean>;
  /** The caller's own `aria-describedby`, kept after the ids the field adds. */
  callerDescribedby: MaybeRefOrGetter<unknown>;
}

function nameOf(input: HTMLElement): string {
  const label = input.getAttribute("aria-label");
  if (label) return label;
  const ids = input.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim())
    .filter(Boolean)
    .join(" ");
}

export function useFieldSpeech(o: FieldSpeechOptions) {
  const uid = useId();
  const unitId = `${uid}-unit`;
  const errorId = `${uid}-error`;
  // The plural, as it names the unit rather than an amount, so a description does not flip while typing.
  const spoken = computed(() => {
    const u = toValue(o.unit);
    return u ? spokenUnit(u, unitsInFull.value) : null;
  });
  const error = computed(() => toValue(o.error) || null);
  const describedby = computed(() => {
    const caller = toValue(o.callerDescribedby);
    const ids = [
      spoken.value ? unitId : null,
      error.value ? errorId : null,
      typeof caller === "string" ? caller : null,
    ].filter(Boolean);
    return ids.length ? ids.join(" ") : undefined;
  });

  let timer = 0;
  function say() {
    const reason = error.value;
    const input = o.el.value;
    if (!reason) return;
    const name = input && document.activeElement !== input ? nameOf(input) : "";
    announce(name ? `${name}, ${reason}` : reason, "assertive");
  }
  // Only none to a reason is spoken: a reason that changes while the field stays refused is not said again.
  watch(error, (now, was) => {
    if (!now) {
      window.clearTimeout(timer);
      timer = 0;
      return;
    }
    if (was) return;
    if (!toValue(o.live)) return say();
    timer = window.setTimeout(() => {
      timer = 0;
      say();
    }, LIVE_ERROR_PAUSE_MS);
  });
  onBeforeUnmount(() => window.clearTimeout(timer));

  return { unitId, errorId, spokenUnit: spoken, describedby };
}
