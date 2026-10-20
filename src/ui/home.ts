import { useHomeStore } from "../stores/home";
import type { OpenOutcome } from "../io/files";

export interface HomeCallbacks {
  newDocument: () => Promise<void>;
  openDoc: () => Promise<void>;
  newFromTemplate: (id: string) => Promise<void>;
  openPath: (path: string) => Promise<OpenOutcome | "cancelled">;
  currentPath: () => string | null;
}

let shown: Home | null = null;

export class Home {
  constructor(cb: HomeCallbacks) {
    useHomeStore().bind(cb);
    shown = this;
  }

  open(): void {
    useHomeStore().visible = true;
  }

  close(): void {
    useHomeStore().visible = false;
  }

  toggle(): void {
    const s = useHomeStore();
    s.visible = !s.visible;
  }
}

/** For code that must not depend on the engine graph, such as the window drop. */
export function closeHome(): void {
  shown?.close();
}
