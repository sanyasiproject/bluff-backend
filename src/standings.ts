/** final places: the finishing order, then everyone still in by the lowest value of cards left (equal values share a place) */
export function standingsOf(places: string[], still: string[], valueOf: (id: string) => number): Map<string, number> {
  const out = new Map(places.map((id, i) => [id, i + 1]));
  const rest = still.filter((id) => !out.has(id));
  for (const id of rest) out.set(id, places.length + 1 + rest.filter((o) => valueOf(o) < valueOf(id)).length);
  return out;
}

/** the players in the worst place among those who didn't finish */
export function lastPlaced(standings: Map<string, number>, places: string[]): string[] {
  const rest = [...standings].filter(([id]) => !places.includes(id));
  const worst = Math.max(0, ...rest.map(([, p]) => p));
  return rest.filter(([, p]) => p === worst).map(([id]) => id);
}
