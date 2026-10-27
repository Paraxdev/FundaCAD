import { computed, type ComputedRef } from "vue";

export interface DisabledProps {
  disabled?: boolean | undefined;
  /** The tooltip while disabled, saying why. */
  disabledReason?: string | undefined;
  /** Greyed but still answers a click, as ChoiceList's option does: a soft block the click lifts. */
  clickable?: boolean | undefined;
}

export type DisabledBind = {
  "aria-disabled": "true" | undefined;
  class: { "is-disabled": boolean };
  onClickCapture?: (e: MouseEvent) => void;
  onKeydownCapture?: (e: KeyboardEvent) => void;
};

/** Stops the activation of a disabled control: any click, and Enter or Space. Plain, so dom.ts shares it. */
export function swallowDisabled(e: Event): boolean {
  if (e.type === "keydown" && !["Enter", " "].includes((e as KeyboardEvent).key)) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

/** The one disabled model: `aria-disabled` and `.is-disabled` instead of the native attribute, so the title stays
 *  live (some webviews show no tooltip on a native disabled button), and the control swallows its own activation. */
export function useDisabled(props: DisabledProps): {
  isDisabled: ComputedRef<boolean>;
  /** v-bind onto the root element. */
  bind: ComputedRef<DisabledBind>;
  /** The tooltip to render: the reason while disabled, else `title`. */
  title: (title: string | undefined) => string | undefined;
  /** `fn`, refused while disabled. */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
} {
  const isDisabled = computed(() => !!props.disabled);
  const swallows = computed(() => isDisabled.value && !props.clickable);
  const swallow = (e: Event) => {
    if (swallows.value) swallowDisabled(e);
  };
  // Note: the capture listeners exist only while disabled. Vue drops an event at a second listener attached in the
  // millisecond the event was stamped, so a standing capture listener ate a click that came right after mount.
  const bind = computed<DisabledBind>(() => ({
    "aria-disabled": isDisabled.value ? "true" : undefined,
    class: { "is-disabled": isDisabled.value },
    ...(swallows.value ? { onClickCapture: swallow, onKeydownCapture: swallow } : {}),
  }));
  return {
    isDisabled,
    bind,
    title: (title) => (isDisabled.value && props.disabledReason ? props.disabledReason : title),
    guard:
      (fn) =>
      (...args) => {
        if (!swallows.value) fn(...args);
      },
  };
}
