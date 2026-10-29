import { computed, useAttrs, warn, type ComputedRef } from "vue";

/** What every base control must be given so a screen reader can say what it is: a label (its aria-label, or the
 *  visible text where the control draws one) or the id of the element that names it. Both keys sit in both branches
 *  so Vue's runtime props stay optional and only the type check demands one. */
export type Named = { label: string; labelledby?: undefined } | { labelledby: string; label?: undefined };

export interface NameProps {
  label?: string | undefined;
  labelledby?: string | undefined;
  tip?: string | undefined;
}

export type NameBind = { "aria-label": string | undefined; "aria-labelledby": string | undefined };

/** The aria-label or aria-labelledby a control puts on its focusable element. Plugins in plain JS skip the type
 *  check, so an aria-label or aria-labelledby attribute still counts, the tip (without its key chord) names a control
 *  nothing else names, and a dev build warns when no label, labelledby or attribute is given.
 *  `named` reports a name from elsewhere, such as a Checkbox's slot text. */
export function useName(props: NameProps, kind: string, named?: () => boolean): ComputedRef<NameBind> {
  const attrs = useAttrs();
  const attr = (k: string) => (typeof attrs[k] === "string" && attrs[k] ? (attrs[k] as string) : undefined);
  if (import.meta.env.DEV && !props.label && !props.labelledby && !attr("aria-label") && !attr("aria-labelledby")) {
    if (!named?.()) warn(`${kind} has no name: give it label or labelledby, a screen reader cannot say what it is.`);
  }
  return computed(() => {
    const by = props.labelledby || attr("aria-labelledby");
    return { "aria-label": by ? undefined : props.label || attr("aria-label") || props.tip, "aria-labelledby": by };
  });
}
