export interface FileStat {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}
