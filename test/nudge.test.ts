import { describe, expect, it } from 'vitest';
import { Room } from '../src/rooms.js';
import { NUDGE_COOLDOWN_MS } from '../src/types.js';

function room() {
  const r = new Room('NUDG');
  const host = r.addMember('Host');
  const a = r.addMember('Asha');
  const b = r.addMember('Bina');
  // apps with the Ready button
  for (const m of [a, b]) m.hasReady = true;
  return { r, host, a, b };
}

describe('host nudge', () => {
  it('buzzes only the people not ready, then waits out the cooldown', () => {
    const { r, host, a, b } = room();
    r.setReady(a.id, true);
    expect(r.nudge(host.id, 1_000).map((m) => m.id)).toEqual([b.id]);
    expect(() => r.nudge(host.id, 1_000 + NUDGE_COOLDOWN_MS - 1)).toThrow(/Wait 1s/);
    expect(r.nudge(host.id, 1_000 + NUDGE_COOLDOWN_MS).map((m) => m.id)).toEqual([b.id]);
  });

  it('host only, and not when everyone is ready', () => {
    const { r, host, a, b } = room();
    expect(() => r.nudge(a.id)).toThrow();
    r.setReady(a.id, true);
    r.setReady(b.id, true);
    expect(() => r.nudge(host.id)).toThrow('Everyone is ready');
  });
});
