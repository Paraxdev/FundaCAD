/** Labels with ", row N" (1 based position) added to every label another row shares, so each row is told apart. */
export function distinctNames(labels: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  return labels.map((l, i) => (count.get(l)! > 1 ? `${l}, row ${i + 1}` : l));
}
