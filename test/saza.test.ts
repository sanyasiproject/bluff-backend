import { describe, expect, it } from 'vitest';
import { Room } from '../src/rooms.js';
import type { Card, GameConfig, Rank } from '../src/types.js';
import { parseConfig, parseSaza } from '../src/validate.js';

let seq = 0;
const card = (rank: Rank): Card => ({ id: `${rank}S${++seq}`, rank, suit: 'S' });
const SAZA: GameConfig = parseConfig({ decks: 1, bluffRule: 'one', saza: true });

/** a Bluff room with these people (the first is host), Saza on, dealt */
function room(names: string[], config: GameConfig = SAZA) {
  const r = new Room('SAZA');
  const people = names.map((n) => r.addMember(n));
  r.setConfig(people[0].id, config);
  r.start(people[0].id);
  return { r, people, host: people[0] };
}

/** the winner goes out with one true King; the only other player left holding cards passes */
function finish(r: Room, winnerId: string, loserId: string) {
  const g = r.game!;
  g.hands.set(winnerId, [card('K')]);
  g.hands.set(loserId, [card('2'), card('3')]);
  g.turnId = winnerId;
  g.play(winnerId, [g.hand(winnerId)[0].id], 'K');
  g.pass(loserId);
  expect(r.phase).toBe('over');
}

const sazaIn = (r: Room, viewerId: string) => Object.fromEntries(r.view(viewerId).players.map((p) => [p.name, p.saza]));
const texts = (notes: { text: string }[]) => notes.map((n) => n.text);

describe('saza for the loser', () => {
  it('puts a badge on the last player that everyone sees, and only the winner may swap it until the lobby', () => {
    const { r, people, host } = room(['Asha', 'Ravi']);
    const ravi = people[1];
    finish(r, host.id, ravi.id);
    expect(texts(r.settleSaza(() => 0))).toEqual(['Ravi gets the Joker saza 🤡']);
    for (const viewer of people) {
      expect(sazaIn(r, viewer.id)).toEqual({ Asha: null, Ravi: 'joker' });
      expect(r.view(viewer.id).sazaPick).toEqual({ loserId: ravi.id, winnerId: host.id });
    }

    expect(() => r.pickSaza(ravi.id, 'aloo')).toThrow('Only the winner picks the saza');
    expect(texts(r.pickSaza(host.id, 'murga'))).toEqual(['Asha gave Ravi the Murga saza 🐔']);
    expect(r.pickSaza(host.id, 'murga')).toEqual([]);
    expect(sazaIn(r, ravi.id).Ravi).toBe('murga');

    // back in the lobby the pick is over, the badge stays
    r.backToLobby(host.id);
    expect(r.view(host.id).sazaPick).toBe(null);
    expect(sazaIn(r, host.id).Ravi).toBe('murga');
    expect(() => r.pickSaza(host.id, 'joker')).toThrow('There is no saza to pick now');
  });

  it('keeps the badge through other games until its wearer wins one', () => {
    const { r, people, host } = room(['Asha', 'Ravi', 'Meena']);
    const [, ravi, meena] = people;
    // Meena went out first, then Asha; Ravi was left holding cards
    r.game!.hands.set(meena.id, []);
    r.game!.places.push(meena.id);
    finish(r, host.id, ravi.id);
    r.settleSaza(() => 0.99);
    expect(sazaIn(r, host.id).Ravi).toBe('mirchi');
    expect(r.view(host.id).sazaPick).toEqual({ loserId: ravi.id, winnerId: meena.id });

    // next game he still wears it, and taking 2nd doesn't count
    r.backToLobby(host.id);
    r.start(host.id);
    expect(sazaIn(r, meena.id).Ravi).toBe('mirchi');
    expect(r.view(meena.id).sazaPick).toBe(null);
    r.game!.hands.set(meena.id, []);
    r.game!.places.push(meena.id);
    finish(r, ravi.id, host.id);
    r.settleSaza(() => 0);
    expect(sazaIn(r, ravi.id)).toEqual({ Asha: 'joker', Ravi: 'mirchi', Meena: null });

    // the game after, he goes out first and it comes off; Asha keeps hers, Meena is last
    r.backToLobby(host.id);
    r.start(host.id);
    r.game!.hands.set(ravi.id, []);
    r.game!.places.push(ravi.id);
    finish(r, host.id, meena.id);
    expect(texts(r.settleSaza(() => 0.5))).toEqual(['Ravi won and the saza comes off!', 'Meena gets the Aloo saza 🥔']);
    expect(sazaIn(r, ravi.id)).toEqual({ Asha: 'joker', Ravi: null, Meena: 'aloo' });
    expect(r.view(ravi.id).sazaPick).toEqual({ loserId: meena.id, winnerId: ravi.id });
  });

  it("can't be swapped once the loser has left the room", () => {
    const { r, people, host } = room(['Asha', 'Ravi']);
    finish(r, host.id, people[1].id);
    r.settleSaza(() => 0);
    r.removeMember(people[1].id);
    expect(() => r.pickSaza(host.id, 'aloo')).toThrow('They already left');
  });

  it('gives bots badges too, and a bot winner leaves the random one', () => {
    const r = new Room('SAZA');
    const host = r.addMember('Asha');
    const { bot } = r.addBot(host.id, 'Isha');
    r.setConfig(host.id, SAZA);
    r.start(host.id);
    finish(r, bot.id, host.id);
    r.settleSaza(() => 0.5);
    expect(sazaIn(r, host.id)).toEqual({ Asha: 'aloo', Isha: null });
    expect(() => r.pickSaza(host.id, 'joker')).toThrow('Only the winner picks the saza');
  });

  it("gives no new badge with Saza off, after 2v2, the host's End game or when only bots were left, but a win there takes one off", () => {
    const off = room(['Asha', 'Ravi'], parseConfig({ decks: 1, bluffRule: 'one' }));
    finish(off.r, off.host.id, off.people[1].id);
    expect(off.r.settleSaza()).toEqual([]);
    expect(sazaIn(off.r, off.host.id)).toEqual({ Asha: null, Ravi: null });
    expect(off.r.view(off.host.id).sazaPick).toBe(null);

    // Ravi wears one, goes out first, and the host ends the game: he won, and nobody was left last
    const early = room(['Asha', 'Ravi', 'Meena']);
    const ravi = early.people[1];
    ravi.saza = 'aloo';
    early.r.game!.hands.set(ravi.id, []);
    early.r.game!.places.push(ravi.id);
    early.r.endGame(early.host.id);
    expect(early.r.phase).toBe('over');
    expect(texts(early.r.settleSaza())).toEqual(['Ravi won and the saza comes off!']);
    expect(Object.values(sazaIn(early.r, early.host.id))).toEqual([null, null, null]);
    expect(early.r.view(early.host.id).sazaPick).toBe(null);

    // 2v2: Asha walks out, so Ravi's team wins; his badge comes off and nobody gets one
    const teams = room(['Asha', 'Ravi', 'Meena', 'Kiran'], { ...SAZA, teams: true });
    const [asha, ravi2, meena, kiran] = teams.people;
    expect(teams.r.game!.teams).toEqual([[asha.id, meena.id], [ravi2.id, kiran.id]]);
    ravi2.saza = 'bandar';
    meena.saza = 'murga';
    teams.r.game!.leave(asha.id);
    expect(texts(teams.r.settleSaza())).toEqual(['Ravi won and the saza comes off!']);
    expect(sazaIn(teams.r, kiran.id)).toEqual({ Asha: null, Ravi: null, Meena: 'murga', Kiran: null });
    expect(teams.r.view(kiran.id).sazaPick).toBe(null);

    // closed before anyone went out: nobody won
    const closed = room(['Asha', 'Ravi']);
    closed.r.game!.close();
    expect(closed.r.settleSaza()).toEqual([]);
  });

  it('gives it to the bot holding the most cards when a person went out and only bots were left, and only shows (never speaks) it', () => {
    const r = new Room('SAZA');
    const host = r.addMember('Asha');
    const isha = r.addBot(host.id, 'Isha').bot;
    const vihu = r.addBot(host.id, 'Vihu').bot;
    r.setConfig(host.id, SAZA);
    r.start(host.id);
    host.saza = 'mirchi';
    const g = r.game!;
    g.hands.set(host.id, [card('K')]);
    g.hands.set(isha.id, [card('2'), card('3')]);
    g.hands.set(vihu.id, [card('4'), card('5'), card('6')]);
    g.turnId = host.id;
    g.play(host.id, [g.hand(host.id)[0].id], 'K');
    // both bots let it go: Asha is out and only bots hold cards
    g.pass(g.turnId!);
    g.pass(g.turnId!);
    r.endIfOnlyBots();
    expect(g.closed).toBe(true);
    const notes = r.settleSaza(() => 0);
    expect(texts(notes)).toEqual(['Asha won and the saza comes off!', 'Vihu gets the Joker saza 🤡']);
    // announced as room notes: shown on screen, not read aloud after the game-over lines
    expect(notes.map((n) => n.kind)).toEqual(['room', 'room']);
    expect(sazaIn(r, host.id)).toEqual({ Asha: null, Isha: null, Vihu: 'joker' });
    expect(r.view(host.id).sazaPick).toEqual({ loserId: vihu.id, winnerId: host.id });
  });

  it('takes every badge off when the host switches Saza off, and hides them while Crazy 7 is picked', () => {
    const { r, people, host } = room(['Asha', 'Ravi']);
    finish(r, host.id, people[1].id);
    r.settleSaza(() => 0);
    r.backToLobby(host.id);

    r.setConfig(host.id, { ...SAZA, game: 'crazy7' });
    expect(sazaIn(r, host.id).Ravi).toBe(null);
    r.setConfig(host.id, SAZA);
    expect(sazaIn(r, host.id).Ravi).toBe('joker');

    r.setConfig(host.id, { ...SAZA, saza: false });
    r.setConfig(host.id, SAZA);
    expect(sazaIn(r, host.id).Ravi).toBe(null);
  });

  it('reads the setting and the badge from what apps send', () => {
    expect(parseConfig({ decks: 1, bluffRule: 'one' }).saza).toBe(false);
    expect(parseConfig({ decks: 1, bluffRule: 'one', saza: true }).saza).toBe(true);
    expect(() => parseConfig({ decks: 1, bluffRule: 'one', saza: 'yes' })).toThrow('Invalid settings');
    expect(parseSaza('aloo')).toBe('aloo');
    for (const bad of ['nope', '', null, 3, undefined]) expect(() => parseSaza(bad)).toThrow('Pick one of the badges');
  });
});
