import { inject, type InjectionKey } from "vue";
import type { Engine } from "./engine";

export const ENGINE: InjectionKey<Engine> = Symbol("neocad.engine");

/** The engine is provided at the app root and is markRaw'd — it is a graph of
 *  Three.js objects, the document store and ten tool classes, none of which may
 *  ever be wrapped in a reactive proxy (see app/docBridge.ts for why). */
export function useEngine(): Engine {
  const e = inject(ENGINE);
  if (!e) throw new Error("useEngine() called outside the app, ENGINE was not provided");
  return e;
}
