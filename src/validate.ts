import { GameError } from './game.js';
import { QUICK_MESSAGES, RANKS, REACTIONS, type ChatKind, type GameConfig, type Rank } from './types.js';

export type Payload = Record<string, unknown>;

export function asPayload(input: unknown): Payload {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Payload) : {};
}

export function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > 16) throw new GameError('Name must be 1 to 16 characters');
  return name;
}

export function parseCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{4}$/.test(code)) throw new GameError('Room code is 4 letters');
  return code;
}

export function parseToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new GameError('Invalid session');
  return value;
}

export function parseConfig(p: Payload): GameConfig {
  const decks = p.decks === 1 || p.decks === 2 ? p.decks : null;
  const bluffRule = p.bluffRule === 'all' || p.bluffRule === 'one' ? p.bluffRule : null;
  if (!decks || !bluffRule) throw new GameError('Invalid settings');
  return { decks, bluffRule };
}

/** no per-play limit; 104 (two full decks) is just a sanity cap */
export function parseCardIds(value: unknown): string[] {
  const valid = Array.isArray(value) && value.length <= 104 && value.every((id) => typeof id === 'string' && id.length <= 8);
  if (!valid) throw new GameError('Invalid cards');
  return value as string[];
}

export function parseRank(value: unknown): Rank | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(RANKS as readonly string[]).includes(value)) throw new GameError('Invalid rank');
  return value as Rank;
}

export function parsePlayId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw new GameError('Invalid play');
  return value;
}

/** only picks from the fixed lists, never free text */
export function parseChat(p: Payload): { kind: ChatKind; index: number } {
  const kind = p.kind === 'reaction' || p.kind === 'message' ? p.kind : null;
  const size = kind === 'reaction' ? REACTIONS.length : QUICK_MESSAGES.length;
  const index = p.index;
  if (!kind || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= size) {
    throw new GameError('Invalid message');
  }
  return { kind, index };
}

export function parseCardIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new GameError('Invalid card');
  return value;
}
