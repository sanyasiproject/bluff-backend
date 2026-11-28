import { isPlugged, type GameKind, type PluggedKind } from '../types.js';
import { chessModule } from './chess/module.js';
import { colorwarModule } from './colorwar/module.js';
import { dartsModule } from './darts/module.js';
import { dotsModule } from './dots/module.js';
import { fruitModule } from './fruit/module.js';
import { ludoModule } from './ludo/module.js';
import { rmcsModule } from './rmcs/module.js';
import { snakesModule } from './snakes/module.js';
import { spikesModule } from './spikes/module.js';
import type { GameModule, PluggedGame } from './module.js';

/** every registry game; a new game adds its folder and one line here */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MODULES: Record<PluggedKind, GameModule<any>> = {
  ludo: ludoModule,
  snakes: snakesModule,
  rmcs: rmcsModule,
  darts: dartsModule,
  dots: dotsModule,
  colorwar: colorwarModule,
  fruit: fruitModule,
  spikes: spikesModule,
  chess: chessModule,
};

export const moduleOf = (kind: PluggedKind): GameModule<PluggedGame> => MODULES[kind];

/** the module of a game kind, or null for Bluff, Crazy 7 and Rang */
export const maybeModule = (kind: GameKind | undefined | null): GameModule<PluggedGame> | null => (isPlugged(kind) ? MODULES[kind] : null);
