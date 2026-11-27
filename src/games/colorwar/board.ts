import { COLORWAR_BURST, COLORWAR_FIRST, type ColorWarCell } from '../../types.js';

/** the most burst waves one tap may set off */
export const COLORWAR_MAX_WAVES = 200;

/** orthogonal neighbours of a cell */
export function neighbours(size: number, cell: number): number[] {
  const r = Math.floor(cell / size);
  const c = cell % size;
  const out: number[] = [];
  if (r > 0) out.push(cell - size);
  if (r < size - 1) out.push(cell + size);
  if (c > 0) out.push(cell - 1);
  if (c < size - 1) out.push(cell + 1);
  return out;
}

/** what one tap did: burst waves and cells taken from each other player */
export interface TapResult {
  waves: number[][];
  captured: Map<string, number>;
}

/**
 * plays a tap on the cells in place: first move places COLORWAR_FIRST dots, later ones add a dot; then every cell at
 * COLORWAR_BURST bursts at once, wave by wave. A chain stops once no rival colour is left (rivals still to place count)
 */
export function applyTap(size: number, cells: ColorWarCell[], who: string, cell: number, first: boolean, rivalsWaiting: boolean): TapResult {
  const captured = new Map<string, number>();
  const take = (i: number) => {
    const was = cells[i].owner;
    if (was !== null && was !== who) captured.set(was, (captured.get(was) ?? 0) + 1);
    cells[i].owner = who;
  };
  if (first) cells[cell] = { owner: who, dots: COLORWAR_FIRST };
  else cells[cell].dots++;
  const waves: number[][] = [];
  const rivalsLeft = () => rivalsWaiting || cells.some((c) => c.owner !== null && c.owner !== who);
  while (waves.length < COLORWAR_MAX_WAVES && rivalsLeft()) {
    const wave = cells.flatMap((c, i) => (c.dots >= COLORWAR_BURST ? [i] : []));
    if (wave.length === 0) break;
    waves.push(wave);
    for (const i of wave) cells[i] = { owner: null, dots: 0 };
    for (const i of wave) {
      for (const j of neighbours(size, i)) {
        take(j);
        cells[j].dots++;
      }
    }
  }
  return { waves, captured };
}
