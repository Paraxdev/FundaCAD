// How long a toast or the title bar error notice stays. null means no timer: it stays until dismissed.

import { a11yPrefs, type NoticeTime } from "./a11yPrefs";

export type NoticeKind = "info" | "warning" | "error";

const NORMAL_HOLD_MS: Record<NoticeKind, number> = { info: 5000, warning: 8000, error: 10000 };
const ACTION_HOLD_MS = 15000;
const LONGER = 3;

/** A caller's own time only ever lengthens the floor, so a button stays reachable. */
export function noticeHoldMs(
  kind: NoticeKind,
  hasAction: boolean,
  requested?: number,
  time: NoticeTime = a11yPrefs().noticeTime,
): number | null {
  if (time === "until-dismissed") return null;
  const floor = hasAction ? Math.max(NORMAL_HOLD_MS[kind], ACTION_HOLD_MS) : NORMAL_HOLD_MS[kind];
  const base = Math.max(floor, requested ?? 0);
  return time === "longer" ? base * LONGER : base;
}
