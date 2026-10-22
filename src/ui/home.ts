import { useHomeStore } from "../stores/home";
import type { OpenOutcome } from "../io/files";
import type { VersionRepo } from "../document/versions";

export interface HomeCallbacks {
  newDocument: () => Promise<void>;
  openDoc: () => Promise<void>;
  newFromTemplate: (id: string) => Promise<void>;
  openPath: (path: string) => Promise<OpenOutcome | "cancelled">;
  currentPath: () => string | null;
  /** The open document's history, live, unsaved versions included. */
  currentVersions: () => Readonly<VersionRepo> | null;
  /** True once the document shows that version (a copy: as a new untitled document). */
  openVersion: (path: string, id: string, copy: boolean) => Promise<boolean>;
  openBranch: (path: string, name: string) => Promise<boolean>;
}

let shown: Home | null = null;

export class Home {
  constructor(cb: HomeCallbacks) {
    useHomeStore().bind(cb);
    shown = this;
  }

  isOpen(): boolean {
    return useHomeStore().visible;
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

export function homeIsOpen(): boolean {
  return shown?.isOpen() ?? false;
}
