import { describe, expect, it } from 'vitest';
import { LUDO_QUICK_MESSAGES, LUDO_REACTIONS, QUICK_MESSAGES, chatSetOf, speaksQuickChat } from '../src/types.js';
import { parseChat } from '../src/validate.js';

describe('Ludo chat set', () => {
  it('a Ludo table uses its own lines and emoji, other games the shared ones', () => {
    expect(chatSetOf('ludo').messages).toBe(LUDO_QUICK_MESSAGES);
    expect(chatSetOf('ludo').reactions).toBe(LUDO_REACTIONS);
    expect(chatSetOf('bluff').messages).toBe(QUICK_MESSAGES);
    expect(speaksQuickChat('ludo')).toBe(true);
    expect(speaksQuickChat('bluff')).toBe(false);
  });

  it('checks the index against the table’s own list', () => {
    const last = LUDO_QUICK_MESSAGES.length - 1;
    expect(parseChat({ kind: 'message', index: last }, 'ludo')).toEqual({ kind: 'message', index: last });
    expect(() => parseChat({ kind: 'message', index: LUDO_QUICK_MESSAGES.length }, 'ludo')).toThrow('Invalid message');
    expect(() => parseChat({ kind: 'message', index: QUICK_MESSAGES.length }, 'bluff')).toThrow('Invalid message');
  });

  it('every line is unique so an index means one line', () => {
    expect(new Set(LUDO_QUICK_MESSAGES).size).toBe(LUDO_QUICK_MESSAGES.length);
  });
});

describe('Ludo voice lines', () => {
  it('one spoken line for every quick line', async () => {
    const { LUDO_QUICK_VOICE } = await import('../src/types.js');
    expect(LUDO_QUICK_VOICE.length).toBe(LUDO_QUICK_MESSAGES.length);
  });
});
