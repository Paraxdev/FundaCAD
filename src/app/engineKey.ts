import { inject, type InjectionKey } from "vue";
import type { Engine } from "./engine";

export const ENGINE: InjectionKey<Engine> = Symbol("fundacad.engine");

/** The engine is markRaw'd and must never be wrapped in a reactive proxy (see app/docBridge.ts). */
export function useEngine(): Engine {
  const e = inject(ENGINE);
  if (!e) throw new Error("useEngine() called outside the app, ENGINE was not provided");
  return e;
}
