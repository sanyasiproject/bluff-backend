import type { SeaBoardView, SeaShipView, SeaView } from '../../types.js';
import type { SeaGame } from './game.js';

/** one member's view: their own fleet in full, anyone else's ships only once sunk, radar counts only for who scanned */
export function seaViewOf(g: SeaGame, meId: string, seated: boolean): SeaView {
  const mine = seated && g.order.includes(meId) ? meId : null;
  const seas: Record<string, SeaBoardView> = {};
  for (const id of g.order) {
    const fleet = g.fleets.get(id) ?? [];
    const hits = g.shipHits.get(id)!;
    const ships: SeaShipView[] = [];
    fleet.forEach((s, i) => {
      const sunk = hits[i] >= s.len;
      if (id === mine || sunk) ships.push({ x: s.x, y: s.y, len: s.len, v: s.v, sunk, hits: hits[i] });
    });
    seas[id] = { shots: [...g.shots.get(id)!], ships, afloat: g.afloatOf(id) };
  }
  const last = g.last ? { ...g.last, cells: g.last.cells.map((c) => ({ ...c })) } : null;
  // a radar's number is the scanner's alone
  if (last && last.kind === 'radar' && last.by !== mine) delete last.count;
  const places: Record<string, number> = {};
  for (const id of g.order) if (!g.isOut(id) && (g.over || !g.alive(id))) places[id] = g.placeOf(id)!;
  return {
    phase: g.phase,
    powers: g.powers,
    placeEndsAt: g.placeEndsAt,
    ready: Object.fromEntries(g.order.map((id) => [id, g.ready.has(id)])),
    seas,
    turnId: g.over ? null : g.turnId,
    deadline: g.deadline,
    held: Object.fromEntries(g.order.map((id) => [id, [...g.held.get(id)!]])),
    radars: g.radars.filter((r) => r.by === mine).map((r) => ({ target: r.target, x: r.x, y: r.y, count: r.count })),
    last,
    places,
    now: g.now(),
  };
}
