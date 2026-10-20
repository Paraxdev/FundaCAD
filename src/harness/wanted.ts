// Kept apart from driver.ts so main.ts can ask without loading the driver.
export function harnessWanted(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get("harness") === "1";
}
