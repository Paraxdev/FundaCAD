import { markRaw, shallowRef } from "vue";
import type { Keys } from "./client";

export interface LinkAnswer {
  link: string;
  /** typed into the dialog because none were stored, or replacing stored ones */
  keys?: Keys;
  remember: boolean;
}

export interface LinkRequest {
  askKeys: boolean;
  resolve: (answer: LinkAnswer | null) => void;
}

export const linkReq = shallowRef<LinkRequest | null>(null);

/** Ask for the link, and the keys when none are stored. Resolves null on Cancel. */
export function askForLink(askKeys: boolean): Promise<LinkAnswer | null> {
  return new Promise((resolve) => {
    linkReq.value = markRaw<LinkRequest>({
      askKeys,
      resolve: (answer) => {
        linkReq.value = null;
        resolve(answer);
      },
    });
  });
}
