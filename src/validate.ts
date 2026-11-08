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

export function parseUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new GameError('Username must be 3 to 20 letters, numbers or _');
  return username;
}

export function parsePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new GameError('Password must be 8 to 128 characters');
  }
  return value;
}

export function parseCoinAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value === 0 || Math.abs(value) > 1_000_000) {
    throw new GameError('Amount must be a whole number between -1,000,000 and 1,000,000 (not 0)');
  }
  return value;
}

export function parseReason(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 100) throw new GameError('Reason is at most 100 characters');
  return value.trim();
}

/** query-string number in 0..max, falling back when missing or invalid */
export function parseQueryInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

export function parseSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 40) : '';
}

export function parseCardIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new GameError('Invalid card');
  return value;
}
