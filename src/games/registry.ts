import { isPlugged, type GameKind, type PluggedKind } from '../types.js';
import { ludoModule } from './ludo/module.js';
import type { GameModule, PluggedGame } from './module.js';

/** every registry game; a new game adds its folder and one line here */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MODULES: Record<PluggedKind, GameModule<any>> = {
  ludo: ludoModule,
};

export const moduleOf = (kind: PluggedKind): GameModule<PluggedGame> => MODULES[kind];

/** the module of a game kind, or null for Bluff, Crazy 7 and Rang */
export const maybeModule = (kind: GameKind | undefined | null): GameModule<PluggedGame> | null => (isPlugged(kind) ? MODULES[kind] : null);
