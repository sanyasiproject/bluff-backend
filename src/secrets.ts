import { secureRandom, shuffle, type RandomInt } from './cards.js';
import type { LoggedPlay, PlayerStats } from './models.js';
import { SECRET_MISSIONS, secretMissionOf, type GameKind, type SecretView } from './types.js';

/** the play hid at least one card that doesn't back up its claim */
const hasFake = (p: LoggedPlay) => p.lie;

/** a lie that got past everyone: it stood or survived a call, and can't be called any more */
const gotAway = (p: LoggedPlay) => hasFake(p) && !p.caught && !p.open;

/** what each secret mission card counts, from its holder's own stats and plays */
const COUNTERS: Record<string, (s: PlayerStats, plays: readonly LoggedPlay[]) => number> = {
  catch2: (s) => s.goodCalls,
  sneak2: (_, plays) => plays.filter(gotAway).length,
  bigLie: (_, plays) => plays.filter((p) => p.cards.length >= 3 && gotAway(p)).length,
  bait: (_, plays) => plays.filter((p) => !hasFake(p) && p.called).length,
  bigDrop: (_, plays) => plays.filter((p) => p.cards.length >= 4).length,
  sevens2: (s) => s.sevens ?? 0,
  stack7: (s) => s.stacks ?? 0,
  lastCard: (s) => s.lastCalls ?? 0,
};

/** one secret mission card of this game's kind for each person, at random; nobody shares a card while there are enough to go round; skip: cards this table can't do */
export function dealSecrets(people: readonly string[], game: GameKind, rand: RandomInt = secureRandom, skip: readonly string[] = []): Map<string, string> {
  const kinds = SECRET_MISSIONS.filter((m) => m.game === game && Object.hasOwn(COUNTERS, m.id) && !skip.includes(m.id)).map((m) => m.id);
  const dealt = new Map<string, string>();
  let left: string[] = [];
  for (const id of people) {
    // a fresh shuffle once every card is out, so repeats are spread evenly
    if (left.length === 0) left = shuffle(kinds, rand);
    const card = left.pop();
    if (card) dealt.set(id, card);
  }
  return dealt;
}

/** a card's progress from its holder's own game, capped at the goal; null for a card the server doesn't know */
export function secretView(cardId: string, stats: PlayerStats | undefined, plays: readonly LoggedPlay[] = []): SecretView | null {
  const def = secretMissionOf(cardId);
  if (!def || !Object.hasOwn(COUNTERS, cardId)) return null;
  const progress = stats ? Math.min(def.goal, Math.max(0, COUNTERS[cardId](stats, plays))) : 0;
  return { id: cardId, progress, done: progress >= def.goal };
}
