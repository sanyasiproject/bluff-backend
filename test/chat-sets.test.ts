import { describe, expect, it } from 'vitest';
import { CRAZY7_BOT_LINES } from '../src/crazy7/driver.js';
import { PLUGGED_BOT_LINES } from '../src/games/driver.js';
import { RANG_BOT_LINES } from '../src/rang/driver.js';
import {
  GAME_CATALOG,
  LUDO_QUICK_MESSAGES,
  LUDO_QUICK_VOICE,
  LUDO_REACTIONS,
  QUICK_MESSAGES,
  REACTIONS,
  chatSetOf,
  speaksQuickChat,
  type GameKind,
} from '../src/types.js';
import { parseChat } from '../src/validate.js';

const GAMES: GameKind[] = GAME_CATALOG.map((g) => g.kind);

describe('per-game chat sets', () => {
  it('covers every game with its own set', () => {
    expect(GAMES.length).toBe(18);
    const sets = GAMES.map((g) => chatSetOf(g));
    expect(new Set(sets.map((s) => s.messages)).size).toBe(GAMES.length);
    expect(new Set(sets.map((s) => s.reactions)).size).toBe(GAMES.length);
  });

  it('keeps Bluff and Ludo exactly as they were', () => {
    expect(chatSetOf('bluff').messages).toBe(QUICK_MESSAGES);
    expect(chatSetOf('bluff').reactions).toBe(REACTIONS);
    expect(chatSetOf('ludo').messages).toBe(LUDO_QUICK_MESSAGES);
    expect(chatSetOf('ludo').reactions).toBe(LUDO_REACTIONS);
    expect(chatSetOf('ludo').voice).toBe(LUDO_QUICK_VOICE);
    expect(chatSetOf(undefined).messages).toBe(QUICK_MESSAGES);
  });

  it.each(GAMES)('%s: 8 emoji, 16 to 26 unique lines', (g) => {
    const s = chatSetOf(g);
    expect(s.reactions.length).toBe(8);
    expect(new Set(s.reactions).size).toBe(8);
    expect(s.messages.length).toBeGreaterThanOrEqual(16);
    expect(s.messages.length).toBeLessThanOrEqual(26);
    expect(new Set(s.messages).size).toBe(s.messages.length);
  });

  it.each(GAMES.filter(speaksQuickChat))('%s: one voice line per quick line', (g) => {
    const s = chatSetOf(g);
    expect(s.voice?.length).toBe(s.messages.length);
    for (const v of s.voice!) {
      expect(v.say.length).toBeGreaterThan(0);
      // Hindi lines are written in Devanagari
      expect(v.lang === 'hi').toBe(/[ऀ-ॿ]/.test(v.say));
    }
  });

  it.each(GAMES)('%s: indexes are checked against its own lists', (g) => {
    const s = chatSetOf(g);
    const last = s.messages.length - 1;
    expect(parseChat({ kind: 'message', index: last }, g)).toEqual({ kind: 'message', index: last });
    expect(() => parseChat({ kind: 'message', index: s.messages.length }, g)).toThrow('Invalid message');
    expect(parseChat({ kind: 'reaction', index: 7 }, g)).toEqual({ kind: 'reaction', index: 7 });
    expect(() => parseChat({ kind: 'reaction', index: 8 }, g)).toThrow('Invalid message');
  });

  it('a longer set’s index is refused at a shorter table', () => {
    const big = GAMES.reduce((a, b) => (chatSetOf(a).messages.length >= chatSetOf(b).messages.length ? a : b));
    const small = GAMES.reduce((a, b) => (chatSetOf(a).messages.length <= chatSetOf(b).messages.length ? a : b));
    const index = chatSetOf(small).messages.length;
    expect(index).toBeLessThan(chatSetOf(big).messages.length);
    expect(() => parseChat({ kind: 'message', index }, small)).toThrow('Invalid message');
    expect(parseChat({ kind: 'message', index }, big)).toEqual({ kind: 'message', index });
  });
});

describe('bot lines come from their own game', () => {
  const allIn = (game: GameKind, lines: Record<string, readonly string[]>) => {
    for (const list of Object.values(lines)) for (const l of list) expect(chatSetOf(game).messages, `${game}: ${l}`).toContain(l);
  };

  it('Crazy 7 and Rang', () => {
    allIn('crazy7', CRAZY7_BOT_LINES);
    allIn('rang', RANG_BOT_LINES);
  });

  it('registry games', () => {
    for (const [game, lines] of Object.entries(PLUGGED_BOT_LINES)) allIn(game as GameKind, lines as unknown as Record<string, readonly string[]>);
    // games without their own moments still find GG and a rematch line
    for (const g of GAMES.filter(speaksQuickChat)) {
      expect(chatSetOf(g).messages).toContain('GG 🎉');
      expect(chatSetOf(g).messages).toContain('Ek aur game! 🔁');
    }
  });
});
