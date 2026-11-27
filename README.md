# Bluff backend

Real-time server for the Bluff card game (Node + Socket.IO + Express). It holds every game in memory, checks every move, and sends each player only their own hand. With MongoDB configured it also has accounts, coins, an admin API and saved game history; without it, everyone plays as a guest.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3001  (restarts on file changes)
npm test         # game rules + socket tests (account tests are skipped)
TEST_MONGODB_URI=mongodb://127.0.0.1:27099 npm test   # also runs the account tests on a throwaway database
```

For accounts locally, copy `.env.example` values into your shell (at least `MONGODB_URI`).

## Deploy on Render (free)

1. Push this folder to its own GitHub repo.
2. Render → **New → Web Service** → connect the repo, then set:
   - Runtime **Node**, Build `npm ci --include=dev && npm run build`, Start `npm start`, Instance **Free**
   - Health check path `/health`
   - (Or **New → Blueprint**; `render.yaml` fills these in.)
3. Environment variables: see the table below. `CLIENT_ORIGIN` = your Vercel URL.
4. Copy the service URL (`https://<name>.onrender.com`) into the frontend's `VITE_SERVER_URL`.

## Environment variables

| Name | Example | Needed for |
|---|---|---|
| `CLIENT_ORIGIN` | `https://bluff-frontend.vercel.app` | browsers allowed to connect (comma-separated) |
| `NODE_VERSION` | `22` | Render's Node version |
| `MONGODB_URI` | `mongodb+srv://…` (secret) | accounts; empty = guest-only |
| `VAPID_PUBLIC_KEY` | `BEl6…` (from `npx web-push generate-vapid-keys`) | friend-invite notifications; empty = off |
| `VAPID_PRIVATE_KEY` | `x3Kq…` (secret, same command) | friend-invite notifications |
| `RTC_TURN_URLS` | `turn:relay.example.com:3478` (optional, comma-separated) | live voice relay for networks that block direct connections; empty = public STUN only (no key needed) |
| `RTC_TURN_USERNAME` / `RTC_TURN_CREDENTIAL` | from the TURN provider (secret) | only with `RTC_TURN_URLS` |
| `VAPID_SUBJECT` | `mailto:you@example.com` or `https://bluff-frontend.vercel.app` | how push services can reach you; defaults to the first `CLIENT_ORIGIN` |

Everything else has a built-in default: database `bluff`; collections `users`, `sessions`, `games`, `audit_log`, `friends`, `settings`, `push_subscriptions` (created with their indexes on first start); 1000 starting coins; logins last 30 days.

## Friend-invite notifications (Web Push)

- When a friend is offline, **Invite** reaches their phone as a notification (if they turned it on in their Profile). Tapping it opens `/?room=CODE`. Online friends get the in-app popup as before.
- Works on Android browsers and the installed app, desktop Chrome/Edge/Firefox, and on iPhone/iPad (iOS 16.4+) only in the app added to the Home Screen.
- **Set up once:** run `npx web-push generate-vapid-keys` on your computer, then add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and (optionally) `VAPID_SUBJECT` in Render → Environment, and redeploy. Keep the private key secret; changing the keys later means everyone must turn notifications on again. Nothing is needed on Vercel: the app reads the public key from `/api/push/key`.
- Each phone is a row in `push_subscriptions` (account, the push service address and its two keys). Logging out removes that phone; addresses the push service reports gone (404/410) are deleted on the next send. The server only posts to the browsers' own push services (Google, Mozilla, Microsoft, Apple).
- **Admin switch:** Admin → Invite notifications on/off (`pushInvites` in `/api/admin/settings`), saved and logged like Guest play. While off, offline friends just get the WhatsApp hint and phones can't sign up; phones already signed up stay saved.
- The same friend can be invited at most once every 30 s. An invite notification expires after 10 minutes if the phone stays offline.

## Friend online alerts

- When an account's first connection opens after being away at least **15 seconds**, each of its friends who is online gets `friend:online` (`{ id, name, username, avatar }`), on any screen, except friends already in the same room. The app groups friends who come online together into one card.
- Away time comes from when the account's last connection closed while this server ran, else from `users.lastSeenAt` (which `markSeen` now returns before overwriting). A quick reconnect says nothing, and for **2 minutes after a server start** there are no alerts, because a restart brings everyone back at once. Tune with `createBluffServer({ onlineAlerts: { awayMs, quietMs } })`.
- Only accepted friends hear it (`FriendService.friendIdsOf`); turning alerts off is per player per phone, in the app.

## Coins

- New accounts get 1000 coins. **+200** on the first login (or app open) of each India-time day, sign-up day included.
- **Daily games ladder** (IST day, win or lose): reaching 1 / 3 / 5 / 10 / 20 / 50 finished games pays +100 / +300 / +500 / +1,000 / +2,000 / +5,000 (up to 8,900 a day). Only games of 1 minute or more count (`DAILY_GAME_REWARDS`, `MIN_REWARD_GAME_SEC` in `src/types.ts`).
- **Card Shield** (`config.shields`, 0–3 per player per game, off by default; `MAX_CARD_SHIELDS`): on their turn a player may shield a play of up to `SHIELD_MAX_CARDS` (2) cards, never the play that would empty their hand; nobody can call or peek at it (`LastPlayView.shielded`, 🔒), so it stands. Shielded plays give nobody a call chance and aren't saved to habits. `RoomView.shieldsLeft` is your own count. Bots respect shields but never use one. Not the shop's Rank Shield.
- **Peek power** (0–3 per player per game), **bets on bluff calls** (paid with the stake when the game finishes, never below zero) and **2v2 teams** (4 slots, 🔵 0 & 2 vs 🟠 1 & 3, chosen or swapped in the lobby; partners see each other's hand; the first team with both partners out wins and splits the pot; partners can't challenge each other; removing a player stops the game).
- **Levels** come from lifetime XP (`XP_RULES`, `levelOf` in `src/types.ts`): +20 per finished game, +50 for a win, +5 per caught liar, +3 per bluff nobody caught, plus `stats.bonusXp` from missions and secret mission cards. Level *n* needs 50 × (*n*−1) × *n* XP; titles run from Rookie (1) to Legend (50, 122,500 XP) and live in the frontend's `src/lib/progress.ts`.
- **Stakes** (host picks in the lobby): Free, 50, 100, 250, 500, 1K, 5K, 10K, 50K, 1L, 5L, 10L per player. Start checks everyone can pay; guests can only play Free games.
- Coins move only when a game **finishes**: every logged-in player pays the stake and the winner (1st place) gets the whole pot. A game stopped by the host, or by kicks leaving one player before anyone finished, moves nothing. A kicked player pays nothing and wins nothing. A player who uses **Leave game** mid-game forfeits: they lose and still pay the stake (in 2v2 their team loses; if one player is left, they win). Leaving right after putting down your last cards, before that play is settled, is a forfeit too.
- Every finished game stores the stake, pot and each player's coin change in `games`.
- **Daily and weekly missions** (`MISSIONS` in `src/types.ts`, `services/missions.ts`, `users.missions`): `MISSIONS_PER_SET` (4) a day (IST) and 4 a week (from Monday 00:00 IST) from a pool of 19 daily and 20 weekly (counters include Bluff wins, lies told, ranked games and wins, 2v2 wins, wins with a friend, Crazy 7 stacks and last cards, counted in `GameRecorder.countMissions`), each set with exactly one social mission (a game with an accepted friend at the table), picked per account from a seed of its id and the day or week, and replaced lazily when read or counted on a new day or week (no cron). Only games that count for the daily ladder move them (finished, 1 minute or more, logged in, not removed). Reaching a goal pays its coins and XP (`stats.bonusXp`) at once, exactly once; there's nothing to claim. One free swap a day replaces an unfinished mission with another of the same set's period, never a social one (so it's the way out of playing with friends). Writes carry a `rev` guard and retry, so a save and a swap can't overwrite each other or pay twice. `CoinResult.missionsDone` lists the ones a game finished.
- **Season pass** (`PASS_TIERS`, `PASS_XP` in `src/types.ts`, `services/seasonPass.ts`, `users.pass`): a free 30-tier track (100 pass XP each) for the ranked season now on, started again lazily when the season changes. Games that count give pass XP (per game, per win, per daily or weekly mission finished; `CoinResult.passXp`). Rewards are claimed by tapping: coins growing along the track, some bonus XP, a Rank Shield at tiers 5, 15 and 25 (`PASS_SHIELD_COINS` instead at `MAX_SHIELDS`) and big coin prizes at 10, 20 and 30. A claim checks the season, the tier reached and not yet claimed in the write itself, so it pays once.
- **Weekly friends league** (`LEAGUE_POINTS`, `LEAGUE_CROWNS`, `services/league.ts`, `users.league`): games that count (finished, 1 minute or more) with 2+ logged-in players not removed by the host add points to each player's IST week (game +1, win +10, liar caught +3, lie nobody caught +2; never coins) in one atomic update that starts a new week on Monday and keeps last week's for its final board. `GET /api/me/league` builds my board from me and my friends (hidden ones left off), with the weekly crowns and last week's winners; `users.leagueHidden` leaves me off my friends' boards.
- **Rivals and Dosti** (`services/rivals.ts`): my record against each friend comes from the saved games of 1 minute or more we both finished as logged-in players (who finished ahead, the Dosti meter of games together, `DOSTI_LEVELS`), plus who caught whom lying from `games.catches` (recorded by `Game.callBluff` since this came in). Read from running totals per pair (`rival_tallies`, `tallyOps`), added once per game when it's saved (`games.rivalsCounted`); games from before the totals are added once by `RivalService.backfillOnce` at startup (`settings.rivalsBackfilled`). Rival and Nemesis tags need `RIVAL_MIN_GAMES` decided games.
- **Ranked** (Bluff only, `config.ranked`, `src/rating.ts`, `services/ranked.ts`, `settings.rankedSeason`): a ranked table takes logged-in people only, no bots. Each finished ranked game of 1 minute or more updates a hidden skill rating (Plackett-Luce, Weng and Lin 2011) and moves visible rank points by the change, scaled by the division shown (`RANK_RATES` in `services/ranked.ts`: higher divisions climb slower and fall faster; server-only and kept out of `types.ts` so apps never see the numbers). No permanent floor: points only stop at 0, and the division shown (`ranked.floor` = its start, `shownDivision`, `shownFloor`) holds until points are `RANK_PROTECTION` (50) below its start; a loss inside that zone says `held: 'grace'`, with no daily limit (`ranked.today` only adds up the day's change); points stop at 0, and a loss at 0 costs nothing and is never owed (`ranked.debt` is always 0 now; older owed points are dropped); 2v2 rates the winning pair against the losing pair. `CoinResult.rank` says what moved; each person's division and points travel with the room as `PublicPlayer.rank` (read at join, updated after each ranked game), and switching a table between casual and ranked posts a room note. Everyone starts at Bronze 0 (`rankViewOf` / `rankBadgeOf` never return null). **Seasons:** an admin books the next one `SEASON_START_DELAY_DAYS` (7) days ahead (`POST /api/admin/ranked/season`, `POST /api/admin/ranked/season/cancel`; `settings.nextSeasonAt`, one `ranked_seasons` document per season with its start and end); a timer in `server.ts` starts it when due (`SettingsService.startDueSeason`) and tells open apps. A standing from an earlier season is carried into the new one `RANK_SEASON_DROP` (1.5) divisions lower (`standingIn`, `seasonStartPoints`; the top division counts as 700 wide), skill kept; `GET /api/me` (`RankedService.rollover`) or the player's next ranked game saves that and adds the old season to `users.rankHistory`. `RankView.history` and `PublicProfile.seasons` list past seasons; `RankView.startedAt` / `nextAt` drive the "ends in N days" line. The admin page counts the season's days and highlights the button from day `SEASON_REMIND_DAY` (23).
- **House twists** (Bluff only, both off by default; the app offers Classic and Chaos presets): **Kismat card** (`config.kismat`): `Game.kismat` is one rank drawn at the deal (after the rest of the deal, so games without it deal as before), shown as `RoomView.kismat` and read out at the start; its cards back up any claim (`backsClaim` in `src/types.ts`; lies, calls, the lie reveal, secret cards and saved habits all use it). **Seedhi** (`config.seedhi`): after the opener each claim is one rank below, the same or one above the last claim, K and A wrapping (`claimsAllowed`, `seedhiClaims`); `RoomView.roundRank` is then the last claim. A follow play without a rank (older apps) claims the same rank. Apps that know the twists connect with `auth.twists: true`; a game with a twist on won't start while a seated person is on an older app (they're asked to reload). Seedhi games don't add to people's saved habits, since a pass or a push means something else there.
- **Secret mission cards** (`SECRET_MISSIONS`, `src/secrets.ts`): when a game starts, each person (not bots) is dealt one card for that game at random (different ones at a table where possible), e.g. "Catch 2 liars" or "Say last card in time". Cards a table can't do, or that would give lies away, aren't dealt: no `stack7` with Stack 7s off, and with lies kept secret only `catch2` and `bigDrop`. A lie counts for `sneak2`/`bigLie` only once it settled (stood or survived a call), never when a walk-out or End game cut it off. `RoomView.secret` shows each player only their own card, with live progress counted from their own game; nobody sees another player's card until game over, when `RoomView.secrets` turns them all over. A card done in a game that counts adds `SECRET_XP` (25) to `stats.bonusXp` (`CoinResult.secretXp`) and counts for the secret-mission missions.
- **Coin shop** (`SHOP_ITEMS` in `src/types.ts`, `services/shop.ts`, `users.shop`): everything is rented for a day or a week, nothing is kept for good; buying an item again adds its time (at most 28 days ahead). XP boosts (1.25x / 1.5x / 2x for a day, 1.25x / 1.5x for a week) multiply a game's own XP (not missions or secret cards) in games that count, paid into `stats.bonusXp` (`CoinResult.boostXp`); Coin Magnet adds 25% to the daily ladder and mission coins for 7 days (`CoinResult.boostCoins`). 🛡️ Rank Shield (300 coins, one-use, hold up to `MAX_SHIELDS` = 5, `users.shop.shields`): the next ranked loss that would cost points costs none and owes nothing (`rank.held: 'shield'`), used up in the same guarded write as the rank. One XP boost and one coin boost at a time. Looks: auras (seat box, card backs, profile card), win bursts and entry flashes, one worn per kind (`users.shop.wearing`), shown to everyone as `PublicPlayer.shop` and `PublicProfile.aura` only while the rental runs. A buy is one `rev`-guarded write that checks the coins, so a double tap can't pay twice; each buy goes to the audit log (`shop`).
- **Bots** have no coins. With a bot seated the stake is capped by the bot level (`BOT_STAKE_CAPS`, `botStakeCap` in `src/types.ts`): Normal bots play only free games, Hard up to 100, Expert up to 1,000; Crazy 7 bots always play their best, so a Crazy 7 table with bots goes up to 1,000. Adding a bot, picking a lower level or switching game lowers a higher stake (announced); asking for more than the bots allow is refused. People pay in as usual; bots put in nothing, but their seats count: a person who wins takes the stake for every seat. If a bot wins, the people's stakes are simply gone. Bets work the same way (lost to a bot: gone; won from a bot: paid in full). Bot games count for XP, stats and the daily ladder like any other.
- **Last online:** `users.lastSeenAt` is saved when an account's first connection opens and when its last one closes (so a restart can't leave it far behind). Friends see it while that friend is offline (`lastSeen`); older accounts fall back to their last login.
- **Gifts:** friends can give each other 10 / 25 / 50 / 100 coins, at most 100 a day in total per giver (one atomic update checks balance and limit). Both sides get an audit entry (`gift`), shown in the admin history. `PublicUser.giftLeft` says what's left today.

## Crazy 7 (second game)

The host picks the game in the lobby (`config.game`: `bluff`, the default, or `crazy7`). Rooms, seats (2–5), watchers, bots, stakes,
XP, the daily ladder, kicks, leaving and Stop game work the same for both.

- 5 or 7 cards each (`handSize`), 1 or 2 decks; the rest is the face-down deck and its top card starts the pile (never a 7).
- On your turn play ONE card of the top card's suit or number. With no matching card the server picks one for you; after that you
  may pick more, up to `maxPicks` (1–7) in the turn. Pass only stops picking early: it needs at least one pick and more picks still
  allowed, so a 1-pick room has no Pass, and at the limit a card that fits must be played. Reaching the limit with nothing to play
  passes the turn by itself. You may also pick on purpose while you could play.
- A 7 makes the next player pick 2 and lose the turn. With `stack7` on they can answer with their own 7 and the next player picks 4,
  then 6…; everyone facing a pick taps Pick N themselves (`c7:pick`), so a pause never shows who holds a 7. With stacking off the pick
  is taken for them.
- Going down to one card, say "last card" (`c7:call`): on your turn with two cards, or right after, until ANOTHER player makes a
  deliberate move (play, pick or pass). If the turn comes back through automatic steps, nobody caught you. Caught: on your next turn
  you pick 1 (plus any waiting 7 pick) and miss the turn. Bots wait at least 3.5 s while a person is at risk, and sometimes forget too.
- The first player out wins at once; the rest are ranked by the value of cards left (`placeOf`, `handValue`: A 1 … 10, J 11, Q 12, K 13; lower is better, equal values share a place) and only the last place loses (the stake works as in Bluff). An empty deck is refilled from the pile; if
  nobody can play and nothing is left to pick, the fewest cards win.
- Bluff's extras (bluff rule, peeks, bets, teams) stay in the settings but are ignored in Crazy 7; End game doesn't apply.
- Lifetime stats count Crazy 7 games in `crazy7Games` (Bluff bots read only Bluff games); Crazy 7 picks don't count as cards picked up.
- **Power cards** (`config.c7Power`, off by default): J goes on anything and names the next suit (`Crazy7Game.wish`; the next card follows it or is another J), 8 skips the next player, A reverses `dir` (a skip with 2 players), 2 makes the next player pick `TWO_PENALTY` (answered by a 2 or 7 with `stack7` on). The first pile card is never a power card. `c7:play` takes `suit` for a J.

### Rang (third game, `config.game: 'rang'`, `src/rang/`)

Our own colour-card game: 108 cards (`RangCard`: 4 colours × 0, two each of 1–9, Skip, Reverse, +2; 4 Wild, 4 Wild +4), 7 each, a number card starts the pile. Same rooms, seats, bots, coins, turn timer and tools as Crazy 7; the room holds `room.rang` (`RangGame`, stepwise like Crazy 7 with `RangAuto` for automatic steps) and the view `RoomView.rang` (`RangView`, my hand in `rang.hand`; `RoomView.hand` stays empty).
- Match the colour in play (`RangGame.color`, set by a wild) or the value. Skip, Reverse (`dir`; a skip with 2 players), +2 and +4 as usual; a penalty means pick and lose the turn.
- `rangPicks` (1–`RANG_MAX_PICKS`, default 1): keep picking until a card fits, up to the limit; Pass after a pick, like Crazy 7.
- `rangStack` (default on): +2 answers +2, +4 answers either; the total grows. `rangChallenge` (default on): the player hit by a single +4 may challenge (`rang:challenge`): if its player held the colour in play they pick 4 and the challenger plays on, else the challenger picks 6. `rangSwap` (default off): a 7 swaps hands with a chosen player (`targetId`), a 0 passes every hand on; not on a last card.
- `rangTime` (0 = no limit, 3 or 5 minutes; `RangGame.endsAt`, `RangClock` in `src/rang/clock.ts`, `RangView.msLeft`): when it runs out, `RangGame.timeUp` ends the game and everyone is ranked by `rangHandPoints`, fewest first; equal points share the place, so a tie for the fewest wins together and splits the pot; 2v2 goes by the team total.
- 2v2 (`config.teams`): partners sit 1st and 3rd; each gets the other's cards as `RangView.partner` (nobody else's), like Bluff's `partnerHand`.
- Last card as in Crazy 7 (`rang:call`; missed: pick `RANG_MISSED_PENALTY`). First out wins; the rest are ranked by `rangHandPoints` (numbers face value, actions 20, wilds 50), the highest loses. Ranked, teams, Saza, Kismat/Seedhi, secret cards and habits are Bluff only.
- Live games are stepwise: anything automatic (a pick when nothing matches, a turn that passes by itself, a 7's pick with stacking off,
  the missed-last-card penalty) happens one step at a time, about 1–1.5 s apart (`src/crazy7/auto.ts`, `RoomView.crazy7.auto` while one is
  due), so the table can follow it. Bots think at least 1.1 s (0.8 s after a pick). Simulations and rule tests keep the instant mode.
- Code: `src/crazy7/game.ts` (rules), `src/crazy7/auto.ts` (paced automatic steps), `src/crazy7/driver.ts` + `brain.ts` + `memory.ts` (bots that search ahead from what they've seen).

## Game Baithak: the game registry

The app is now **Game Baithak**, a home for many 2–4 player games. Bluff, Crazy 7 and Rang stay wired by hand; every new game
plugs in through `src/games/`: `module.ts` (the `GameModule` interface), `registry.ts` (`MODULES`, `moduleOf`, one line per game)
and `driver.ts` (one `PluggedDriver` for all of them: automatic steps, bots at a human pace, game time, the turn timer's stand-in).
The room keeps the game in `room.plugged` (part of `room.table`), shows it as `RoomView.plugged` (`PluggedView`), takes every move
through one socket event, `game:move` (`PluggedMove`: `{ kind, move }`), and announces through the module's `describe`.
`GAME_CATALOG` (in `types.ts`) lists every game with its players, 2v2, bots and lobby options (`config.opts`, kept by `parseOpts`:
known ids and choices only; missing means the default). Apps say which registry games they have with `auth.games` in the
handshake; a game won't start while a seated person's app lacks it ("must update the app"). A game for fewer seats than the room
(Ludo and Saanp Seedhi: 4) refuses the switch while too many sit, and newcomers past its seats watch. Every finished game adds
`stats.perGame.<kind>.played/.wins` (all games), plus the registry game's own counters. No replay or secret cards for registry games.

### Ludo (`config.game: 'ludo'`, `src/games/ludo/`)

- 2–4 players, colours by count (2: red + yellow, 3: red, green, yellow, 4: all), turns clockwise from a random first player.
  2v2 (`config.teams`, exactly 4): slot order, so partners sit opposite (red + yellow against green + blue).
- Each goti's progress: -1 in base, 0..50 round the ring from its own start, 51..55 its lane, 56 home (exact roll only).
  A 6 opens a goti; landing on an opponent off the safe squares (`LUDO_SAFE_RING`: starts and stars) sends all of theirs there
  back to base (never a partner's). A 6, a kill or a goti home earns another roll; a 6 still rolls again when nothing can move;
  three 6s in a row lose the turn.
- After a roll the room plays the step itself when there's no choice: a pass (~0.9 s, so the dice is seen; 1.1 s after three 6s)
  or the only move (~0.7 s; gotis on the same square count once). Otherwise the player sends a move.
- Modes (`opts.mode`): **Classic** (all 4 home; play on until one is left), **Quick** (gotis start open, 2 home wins at once),
  **Timed** (`opts.time` 5 or 10 min; ends at time up or the first finisher; ranked by points: a square 1, a kill 20, a goti home 15,
  a knocked goti loses the squares it had covered), **Master** (no goti may pass square 50 before its player's first kill; if only the
  lock keeps everyone still for 3 rounds, the gates open for all).
- 2v2: a player whose gotis are all home rolls and moves for their partner (`LudoView.movesFor`); the team wins once both are home.
- Winners: 1st place (Timed: most points, ties share; 2v2: the team); losers: everyone else (walk-outs too, removed players not).
  Leaving mid-game is a forfeit (gotis leave the board); a kick pays nothing; host End game is refused (use Stop game).
- Bots (`brain.ts`, the host's bot level): Normal mostly random with a light taste for kills, Hard greedy scoring (it slips now and
  then), Expert adds the real chance of being hit, what's at stake, gotis to hunt next and its partner. Simulated Classic 1v1:
  Expert beats Normal ~93%, Hard ~66%.
- Counters per account: `stats.perGame.ludo.kills/killed/home/sixes`; missions `ludoGames`, `ludoWins`, `ludoKills`, `ludoHome`,
  `ludoSixes`; awards Goti hunter and Lucky sixes.

### Saanp Seedhi (`config.game: 'snakes'`, `src/games/snakes/`)

- 2–4 players, one token each (`SNAKES_COLORS` in seat order), turns in seat order from a random first player. Board and art come
  from `SNAKES` / `LADDERS` / `snakesCellOf` in `types.ts`.
- One move, `roll`: the server moves the token at once and the app animates from `SnakesView.last`. `rollSeq` goes up with every
  roll; `last.seq` only when a token moved (so a roll with no move, or a third 6, leaves `last` as it was). `dice` and `sixes` keep
  the latest roll after the turn moves on (`sixes` counts the latest roller's 6s in a row).
- Options (`opts`, all on by default): `six` (a token at 0 needs a 6 and enters on square 1, no further steps), `exact` (land on 100
  exactly; overshoot walks to 100 and back, `bounced`, `landed` = that square), `bonus` (a 6 rolls again, `last.bonus`; a third 6
  in a row loses the turn with no move), `bite` (others on the final square, not 0 or 100, go back `SNAKES_BITE_BACK` (5), at least
  to 1, no chain). After landing a snake head slides to its tail, a ladder foot climbs to its top (`last.via`), then the bite.
- Reaching 100 gives a place; play goes on until one is left. Winner: 1st place; losers like Ludo; leaving is a forfeit (token off
  the board); host End game is refused.
- Bots just roll: the module's `auto()` rolls for a bot after the last roll has had time to show (dice 0.8 s + 0.17 s a square +
  0.9 s for a snake or ladder + 0.7 s for a bite, plus up to 0.7 s). A person's turn uses the room's turn timer (it rolls for them).
- Counters: `stats.perGame.snakes.ladders/snakes/bites` (bites made); awards Ladder climber and Snake food. Chat and voice use
  Ludo's set (`chatSetOf`, `speaksQuickChat`).

### Raja Mantri Chor Sipahi (`config.game: 'rmcs'`, `src/games/rmcs/`)

- Exactly 4 players ("needs exactly 4 players. Add bots to fill the table"); `opts.rounds` 5 or 10. Every step is timed through
  `auto()`, so the room's turn timer never runs here.
- A round: `deal` (4 chits shuffled), phase `open` (`endsAt` = deal + `RMCS_OPEN_SEC` 8 s; each player sends `{ type: 'open' }`,
  bots open 1.2–3.7 s after the deal, every shut chit opens by itself at `endsAt`). Once all 4 are open: phase `guess`, `turnId`
  = the Mantri, `endsAt` = now + 20 s; the Mantri sends `{ type: 'guess', target }` (one of the two others; a bot picks 50/50 after
  1.8–4.3 s); time up = wrong, `guess: null`. Then phase `result` for 4 s (`endsAt`), then the next deal, or game over after the
  last round (the last result stays in the view, `endsAt` null).
- Points: Raja 1000, Mantri 800, Sipahi 500, Chor 0; a wrong guess swaps the Mantri's and the Chor's for that round. Every round
  adds 2300 in all. Ranking by total, ties share; winners: the top score.
- Secrecy: a seated player's view has their own `myRole` and only the chits shown to all (`shown`: the Raja once opened, the Mantri
  from `guess`, all four at `result`); watchers get `myRole: null`. `history` lists finished rounds (public).
- Leaving is a forfeit: that seat's chit and guess then play by themselves (0.4 s); one player left wins; no person left stops it
  with no winner.
- Counters: `stats.perGame.rmcs.caught` (Mantri, right), `escaped` (Chor, not caught), `raja`; awards Sharp Mantri and Master Chor.
- Announcer: "Round 2 of 5", "Raja is Asha 👑", "Mantri Ravi, find the Chor!", "Pakda gaya! 🦹 Bina was the Chor" /
  "Chor bach gaya! 😈 Bina was the Chor", "Game over. Asha wins with 4,300 points 🎉". Chat and voice use Ludo's set.

### Darts (`config.game: 'darts'`, `src/games/darts/`)

- 2–4 players, `opts.start` 301 or 501, turns in seat order from a random first player; colours `PARTY_COLORS` by seat.
- Move `{ type: 'throw', x, y }`: where the app's wobbling reticle was released, board units (centre 0,0, x right, y up, scoring
  radius 1; clamped to ±2). The server adds its own shake (Normal, σ `DART_SHAKE` 0.03), scores it with `dartScore` and subtracts.
  Every dart bumps `last.seq` and lands in `thrown`.
- Below 0 is a bust: `left` goes back to `turnStart`, `last.bust`, the turn ends. Exactly 0 checks out (a place, `places`); play
  goes on until one is left, who takes the last place. After a turn ends (3 darts, bust or checkout) the turn stays on the thrower
  for `DARTS_TURN_PAUSE_MS` (1.6 s) so the board shows its darts; a throw then gets "Wait for the next turn". Then `turnId` moves on,
  `thrown` empties and `turnStart` is the new player's `left` (`last` stays).
- Bots throw through `auto()` 1.1–1.8 s apart, aiming at treble 20, or at an exact one-dart finish (single, treble, double, bull),
  or a set-up single, with level noise (σ Normal 0.22, Hard 0.14, Expert 0.08). A person's timed-out turn throws one Hard dart.
- Winner: first to check out; the rest by place, then fewest points left. Leaving is a forfeit (a turn in progress doesn't count).
- Counters `stats.perGame.darts.t180/bulls/checkouts` (bulls = the 50 only); awards Maximum! and Bull hunter. Announcer: "ONE
  HUNDRED AND EIGHTY! 🎯 Asha", "Bust! Asha stays on 32", "Bullseye for Asha! 🐂", "Asha checked out first! 🏆".

### Dots and Boxes (`config.game: 'dots'`, `src/games/dots/`)

- 2–4 players, `opts.size` 4, 5 or 6 boxes a side. Lines are numbered as in `dotsLineAt` (horizontal rows first, then vertical).
- Move `{ type: 'line', line }`; every line bumps `last.seq`. A line closing 1 or 2 boxes scores them (`boxes`, `scores`,
  `last.closed`) and the same player goes again; otherwise the turn passes. All boxes closed: most boxes wins, ties share.
- Bots move through the driver's think pause (0.7–1.3 s): take a closing line, else a line that gives no box (no third side), else
  Hard the line giving the fewest boxes at once, Expert the shortest chain the next player could run. Normal sometimes misses
  a box or doesn't look.
- Leaving is a forfeit (their boxes stay); one player left wins. Counter `stats.perGame.dots.boxes`; award Box collector.
  Announcer: "Double! Asha closed two boxes with one line ✌️", "Game over. Asha wins with 9 boxes 🎉" / "share first with 8 boxes".

### Colour Wars (`config.game: 'colorwar'`, `src/games/colorwar/`)

- 2–4 players, `opts.size` 5 or 7. Move `{ type: 'tap', cell }` (row-major). First move: any empty cell gets `COLORWAR_FIRST`
  (3) dots ("Pick an empty cell to start"); later: one of your own cells +1 ("Tap one of your own cells").
- At `COLORWAR_BURST` (4) a cell bursts: it empties and each orthogonal neighbour gets +1 dot and the tapper's colour; all ripe cells
  burst together, wave by wave (`last.waves`, at most 200 waves). A chain stops once no rival colour is left (rivals still to place
  their first cell count as left). Every tap bumps `last.seq`.
- A player who has placed and holds no cell is out (`out` event, `places`: first out = last place); last colour standing wins.
- Bots tap through `auto()` once the last chain has shown (0.9 s + 0.38 s a wave, plus up to 0.7 s): Hard and Expert score each
  tap by rival cells removed, own cells and danger (own cells next to a rival's 3-dot cell); Expert also checks the next player's
  best reply; Normal taps at random 45% of the time.
- Leaving is a forfeit (their cells empty); one player left wins. Counters `stats.perGame.colorwar.captures/bursts`; awards Colour
  thief and Chain reactor. Announcer: "Asha is wiped out, 3rd place 💥", "Chain reaction! Asha took 7 cells 💥" (5+ waves).

### Real-time registry games (Fruit Slice Duel, Spike Attack)

- Everyone moves at once: `turnId` stays null, so the turn timer, its stand-in moves and "away" never apply. The countdown, every
  timed step and the bots run through the module's `auto()`, keyed on the game's `stepSeq`, which only timed steps bump (a person's
  move never resets the plan). Steps marked `quiet` that change nothing send no views. Views carry `now` (server ms) so apps can
  line up their clocks; times in views (`startsAt`, `endsAt`, `warnAt`, `strikeAt`, `safeUntil`) are server ms since epoch.
- Socket limit: `game:move` in these games counts against the module's own `moveRate` per 10 s (Fruit 150, Spikes 100) in a
  separate bucket; every other event keeps the usual 40 per 10 s.

### Fruit Slice Duel (`config.game: 'fruit'`, `src/games/fruit/`)

- 2–4 players, `opts.time` 45 or 60 s. `phase: 'countdown'` for 3 s (`FRUIT_COUNTDOWN_MS`) until `startsAt`, then `'play'` until
  `endsAt`, then `'over'`. The server picks `seed`; every phone draws `fruitWave(seed, seconds)` with `fruitAt`.
- Move `{ type: 'slice', ids, at }`: 1–12 fruit ids, `at` = ms after `startsAt` (server clock via `now`). Refused: before the start
  ("Wait for the countdown"), `at` more than `FRUIT_SLICE_SLACK_MS` (450) behind the server's elapsed time ("Too late, that swipe did
  not count") or ahead of it ("That swipe is ahead of the clock"), after the end ("Time's up"). Each id counts once per player and
  only if on screen at `at` (`fruitAt` within -0.05..1.05); others in the swipe are dropped, and a swipe with none left gets
  "Already sliced" (all were mine already) or "Nothing to slice there".
- Points `FRUIT_POINTS` (bomb -10, scores may go below 0); 3+ fruit in one swipe add +1 per fruit over 2. Highest score wins, ties
  share. The game ends on time through `auto()`, and through `clock()` too if nobody is connected.
- Bots plan every swipe at the start: each fruit near its peak (±250 ms) with 55 / 72 / 85 % (Normal / Hard / Expert), a bomb by
  mistake 10 / 5 / 2 %; cuts within 160 ms make one swipe (combos); swipes within 120 ms go out as one step.
- Counters `stats.perGame.fruit.sliced/bombs/bestCombo` (`best*` counters are saved with `$max`, the rest add up). Announcer: "Slice!
  45 seconds on the clock 🍉", "Asha sliced 5 in one swipe! 🔥" (5+ only), "Time's up! Asha wins with 42 points 🎉".

### Spike Attack (`config.game: 'spikes'`, `src/games/spikes/`)

- 2–4 players, `opts.size` 5 or 6, `opts.speed` normal or fast. Players start in the corners (`pos` is `[col, row]`, row 0 on top)
  with `SPIKES_LIVES` (3). 3 s countdown (`startsAt`), then play.
- Move `{ type: 'step', dir: 'up' | 'down' | 'left' | 'right' }`; "Wait for the countdown", "Too quick, one step at a time"
  (under 140 ms since your last step), "Can't go that way" (wall), "You're out". Players may share a square.
- Warnings: the first 0.6 s into play, then every gap + 0–0.4 s; each shows `warn` ms before `strikeAt`. Normal: warn 3 s → 1 s and
  gap 1.7 s → 0.55 s over 75 s of play; fast: 2 s → 1 s and 1.25 s → 0.45 s over 50 s. At most 1 + one per 15 s of play at once
  (never more than size − 1, so a safe square is left); a row or column is never warned twice at once.
- A strike hits everyone on the line not `safeUntil` (1 s after a hit): -1 life. 0 lives = out (`places`; players out on the same
  strike share the place). Last one standing wins (`finish` event); the last players out together share first. After 3 minutes
  of play (`SPIKES_MAX_MS`) most lives left wins. When no person is left standing, bots still up are ranked by lives.
- Bots look around every 160–360 ms (180–300 ms while stepping) and only see a warning after a reaction time (Expert 0.2–0.5 s,
  Hard 0.3–0.8 s, Normal 0.55–1.3 s; now and then 0.8–1.1 s later, Normal most often); on a warned line they run to the nearest square no seen spike crosses,
  otherwise they now and then wander (better levels drift to the middle).
- Counters `stats.perGame.spikes.dodges` (stepped off a line you stood on when it was warned) and `hits`. Announcer: "Dodge the
  spikes! 🔺", "Asha is out 💀 (3rd)", "Ravi is the last one standing! 🏆", "Time's up! Most lives left wins", "Game over. Ravi wins 🎉".

## Rules worth knowing

- **Bots** (`src/bots/`): the host adds them in the lobby (`room:addBot`). A person must be seated to start; when the last person leaves, the bots go and the room closes; once no person holds cards and the last play can't be called any more, the game ends at once (2v2 plays on), so a person who puts down every card still gets called. Bots can't host, watch or be invited; in 2v2 they accept swaps at once. They pause while no person is connected.
- **Bot level** (`config.botLevel`: `normal`, `hard` or `expert`, the default; Bluff only, `src/bots/levels.ts`): how sharp the reads are, how much saved habits count, how mixed the calls are near the line, how many tricks a bot plays and how far its plans swing. Every level lies often and changes plans; Normal ignores saved habits, never reads a round as a whole (so the fake-then-real trap still works on it) and is sloppier. Older apps that don't send it get expert bots.
- **Bot engine**: each bot draws its own numbers from one of six styles (shark, maniac, rock, detective, trickster, gambler; never two of the same at a table) and drifts a little every game. It decides only from `room.view(botId)` (exactly what a seated player gets), its own memory of public events, and each person's saved habits from past games (below). Choices are weighted at random, and think time is drawn before deciding, so a pause never gives a lie away.
- **Plans** (`planOf` in `brain.ts`): every 1 to 4 rounds, and right after being caught or calling wrong, a bot draws a new plan: a mode (straight, pressure: heavy on fakes, tricky: slow-plays and fake now / real later, tight: honest with sharper calls; how often each comes up depends on its style), a little noise on it, and which ranks it fancies opening. So the pattern someone spots in one round says little about the next.
- **Lie detector** (`src/bots/detector.ts`): for the last play it works out the chance of 0, 1, 2… fake cards. Card counting from the bot's seat (its cards, its partner's, its own cards in the pile and in discards, how many decks) sets the fewest fakes a claim must hold; the claimer's hand is dealt from the cards nobody can see that aren't in this pile or thrown away, minus the real cards earlier plays probably held. Hard and expert bots keep that last part as a spread (`goneSpread`): every way the earlier claims of the round (and thrown-away piles) could have gone is weighed by how likely it makes the new claim, so a claim they believed can turn out to have been the lie. A claim that clashes with the round (everyone's claims go past the copies in the game, or other people's do with the copies only the bot knows of) is then weighed against the player's record on such claims (`over`: lies, or real cards springing a trap). A real card seen in a play (turned over or peeked) counts as a sprung trap only when the bot's own cards prove it: the copies it's sure of, those real cards and the player's earlier claims that round add up to more than exist (`noteTrap`). That is weighed against how the player tends to play (`src/bots/profile.ts`): slipping fakes in, pushing fakes instead of passing, opening with ranks they hold (bigger groups far more often), faking the last cards to finish, how many fakes a lie usually holds, and where in the tap order fakes sit. Every card turned over (anyone's call, or the bot's peek) is checked against what the read expected, and the read on that player is scaled to match, so called plays (the suspicious ones) don't make an honest player look like a liar; plays that clash with the round or spring a proven trap are left out of that check, since they're about the whole round. Under "pick one" a real card turned over counts as 1/n of an honest play, clashing ones included. A bot never peeks at the same card twice: what it already saw counts when it weighs the play again on its own turn.
- **Calls** (`brain.ts`): call when the chance of finding a fake times what it gains (they take the pile; far more if the play would finish them) beats being wrong (I take the pile, worse when I'm close to going out), with the style's leaning and the plan's. Near the line the answer is mixed (a logistic on the call's worth, `callTemp`), so there's no fixed point where it stops calling; it gets steadier with a big pile and with more players around. Now and then it tests a claim that looks fine while the pile is small (`audit`, shared round the table), so no lie is ever free. Under "pick one" it turns over the card most likely to be fake. A player's **last cards** (a play that empties their hand) are always called, at every level: if the play stands they're out. There, under "pick one", it turns over any card at random, likelier fakes more often, so real cards placed first or last can't dodge the check; hard and expert bots with a peek left look first. A claim card counting proves false is always called under "show all". With 1 deck a claim of 5+ of a rank is always a lie, and 6+ card claims get called almost every time; 2 decks move the line up on their own (8 copies).
- **Peeks**: expert and hard bots weigh what a peek could change (a fake seen means a sure call with that card; a real one sharpens the rest) against keeping a scarce peek for later (`peekCost`), and look at the likeliest fake. Normal bots peek on a whim.
- **The bots' own play** (`open` / `follow` in `brain.ts`): every turn it scores each way to play: all its real cards, some held back, fakes slipped in, fakes now with the real ones kept for later (the trap, used on people too), a rank it hasn't got, a pass even while holding the rank. Each is worth the cards it sheds (junk that's hard to shed honestly counts extra at hard and expert) minus the pile it may cost when a call finds a fake, plus the pile a wrong call hands the caller, plus a clean last play kept ready, plus the plan's leanings; the pick is weighted at random. How likely a call is comes from each person's call rate, and from saved habits on how often they call bots' lies and truths (someone who trusts bots gets lied to more; under "show all" a heavy caller gets almost none). It never claims more than could exist from its side, thinks about who could prove a claim false from their own cards (fully at hard and expert, half at normal), now and then keeps its real cards back anyway (half the time by passing while holding the rank, though most passes still mean it has none; never instead of a play that goes out), doesn't hand the next opening to someone about to go out (hard and expert), makes no long-shot test calls when it's 3 cards from going out, and fakes its last cards to go out when it's worth the risk (up to 1 / 2 / 3 fakes by level).
- **Time to call**: after any play, people get at least 2 s (more for big plays and a player going out) to call it before a bot's own move can close it (`CALL_WINDOW` in `bots/driver.ts`). Bot calls on someone going out come quicker.
- **Saved habits** (`Habits` in `models.ts`, recorded in `game.ts` with `src/habits.ts`): every Bluff play and pass is counted with the true cards (lies by opening / following, pushes and passes with none of the rank, fakes per lie, finishing lies, fakes by tap position, real cards held back while honest or lying, claims that took the round past the copies and whether they were lies, and how often the person calls bots' plays, lies and truths apart, counting only bot plays they had their chance at: it stood, or they called it; the ways people play around bots). `GameRecorder.save` merges a game's counts into `users.habits` for logged-in players (finished or stopped games; Crazy 7 never; a game with nothing counted changes nothing): the old totals fade by `HABIT_DECAY` (0.96) first, and are scaled down to `HABIT_TURN_LIMIT` (1,000) turns at most, so the last ~25 games carry most of the weight (old : new about 24 : 1) and a player who changes style is read by the new one (`mergeHabits` / `habitsPipeline` in `src/habits.ts`). They're read with the account into `Member.habits` at join and before each Bluff deal with bots, never during a game, and never sent to any app (not in `PublicUser`, profiles or `RoomView`). Normal bots ignore them.
- Tune the engine with simulations, not by eye: `test/bots-detector.test.ts` covers big claims by deck count, finishing lies, the tap position from habits, smart peeks, the call window, a 5-to-7-card dumper and levels against each other; `test/bots-tricks.test.ts` covers the fake-then-real trap (from saved habits, within a room, through a peek, and a lying over-claim under "pick one" that isn't a trap), how much bots lie and hold back, plan changes, lying more to people who trust bots, and a person playing around the bots; `test/bots.test.ts` plays hundreds of games through the real rules. A bot's decision must not change when only the hidden cards of the play change (tested).
- New lifetime stats `plays` and `chances` (plays by others you could have called) feed the bots' read on each player; older accounts fall back to estimates.
- A player can call **Bluff at most 2 times in a row**; after that the call is refused until they play or pass on their own turn (`MAX_BLUFF_CALLS_IN_A_ROW` in `src/types.ts`). A player's last cards can always be called, even then (`Game.goingOut`). No limit once only 2 players hold cards (incl. one whose last cards are still open).
- New rooms start on the **pick one card** bluff rule; the host can switch to show all in the lobby.
- **Saza for the loser** (`config.saza`, Bluff only, off by default): at game over (`Room.settleSaza`, called from `afterMove`) whoever won takes their badge off, and the one player left holding cards gets a random badge from `SAZA_BADGES` (`PublicPlayer.saza`, bots too); when the game closed with only bots holding cards (`endIfOnlyBots`) or the host used End game, last place by card value (`losers()`, one of them at random on a tie). Both lines are `room` notes: shown, not spoken, so the game-over lines read just before aren't cut off. The winner may swap it with `room:saza` while `RoomView.sazaPick` is set (game over, cleared back in the lobby). It stays on through other games until its wearer wins a Bluff game in the room (a team win and the host's End game count). 2v2 and walk-outs leave no single last player, so nobody gets a new one then. Switching Saza off takes every badge off; while Crazy 7 is picked they're hidden. Badges live in the room only, never saved.
- **Lie reveal** (Bluff; `config.secretLies` is off by default, so lies are shown): `Game` logs every lying play with its true cards and marks it at `callBluff` (called, caught). Once the game is over, `RoomView.lieRecap` (`Game.lieRecap()`) lists up to 6 uncaught lies, most fake cards first (ties in play order; `survivedCall` when a call turned over a real card), how many got away in all, and each player's plays, lies and lies caught (from `PlayerStats`). It's null while the game runs, when the host keeps lies secret, and in Crazy 7. Tapping a name asks `room:plays` for that player's every play (truths too) and leftover cards (`Game.playsOf`, from the same log of every play). Not saved.

`/health` answers `{"ok":true,"accounts":"on","guests":true}` when the database is connected (`guests` is false while an admin has guest play turned off).

- **Guest play switch:** with guest play off, guests get "Guest play is off right now. Log in to play" on `room:create` / `room:join`. Guests already in a room keep their seat and can `room:rejoin`.

## Accounts API

All bodies are JSON. Protected routes need `Authorization: Bearer <token>` (the token from register/login).

| Method & path | Who | Body / query | Returns |
|---|---|---|---|
| `POST /api/auth/register` | anyone | `{ username, password, displayName? }` | `{ token, user }` (201) |
| `POST /api/auth/login` | anyone | `{ username, password }` | `{ token, user, bonus }` |
| `POST /api/auth/logout` | logged in | – | 204, token revoked |
| `GET /api/me` | logged in | – | `{ user, bonus, friendRequests }` (bonus = daily +200 if just paid) |
| `GET /api/me/games` | logged in | `?limit=20` | `{ games }` most recent first, with per-game stats and coins (`hasReplay` when a replay was saved) |
| `GET /api/me/games/:id/replay` | a player of that game, or admin | – | `ReplayResponse`: players and up to 800 steps (lines, turn, card counts, pile, Bluff claim/call, Crazy 7 top card; Bluff's real cards only when lies weren't secret); 404 for others, older games, or games older than `REPLAY_KEEP_DAYS` (30; the server clears them every 6 hours, `GameRecorder.clearOldReplays`) |
| `GET /api/me/overview` | logged in | – | `{ coinRank, players, friends, loginBonusToday, gameBonusToday }` for the profile page |
| `GET /api/me/missions` | logged in | – | `MissionsResponse`: today's and this week's missions (`{ id, progress, done }`), `rerollLeft`, `dailyResetAt`, `weeklyResetAt`; a new day or week gets a fresh set |
| `GET /api/me/league` | logged in | – | `LeagueResponse`: this week's board of me and my friends, the crowns, last week's final board, `resetAt`, `hidden` |
| `POST /api/me/league/hide` | logged in | `{ hidden: boolean }` | `LeagueResponse`; hidden players are left off their friends' boards |
| `GET /api/me/rivals` | logged in | – | `RivalsResponse`: my record against every friend I've finished a game with |
| `GET /api/players/:username/rival` | logged in | – | `{ record }`: my record against that friend, or null (not a friend, or no games together) |
| `POST /api/me/missions/swap` | logged in | `{ id }` | `MissionsResponse`; once a day, an unfinished mission is swapped for another; 400 "You already swapped a mission today", "That mission is done", "That isn't one of your missions" |
| `GET /api/me/pass` | logged in | – | `PassResponse`: the free season pass for the ranked season now on: `season`, `startedAt`, `endsAt` (null until the next season is booked), pass `xp`, `tier`, all 30 `tiers` (`{ tier, reward, reached, claimed }`) and `claimable`; a new season starts it again. Pass XP comes from games that count (`PASS_XP`: per game, per win, per mission finished) |
| `POST /api/me/pass/claim` | logged in | `{ tier }` | `PassClaimResponse` `{ pass, got, shieldSwapped, user }`; pays one reached tier once (coins, bonus XP, or a Rank Shield; `PASS_SHIELD_COINS` instead when holding `MAX_SHIELDS`); 400 "Reach tier N first" or not a tier, 409 "You already claimed that tier" |
| `GET /api/me/shop` | logged in | – | `ShopResponse`: coins, running rentals (`{ id, until }`), and the look worn per kind |
| `POST /api/me/shop/buy` | logged in | `{ id }` | `{ shop, user }`; pays and rents (or adds time); a look is worn at once and shows in their room; 400 not enough coins, another XP or coin boost still running, over 28 days ahead |
| `POST /api/me/shop/wear` | logged in | `{ kind: 'aura' \| 'win' \| 'entry', id \| null }` | `{ shop, user }`; wear another running look of that kind, or none |
| `POST /api/me/spin` | logged in | – | `{ index, prize, user }`: today's free spin (IST day), coins or bonus XP from `SPIN_PRIZES`; 409 once spun today |
| `POST /api/me/name` | logged in | `{ displayName }` | `{ user }`: changes your own display name; the first change any time, then one every `NAME_CHANGE_DAYS` (60), 409 with the date until then (`PublicUser.nameChangeAt`); admins any time; logged in your history |
| `POST /api/me/avatar` | logged in | `{ avatar: "face.bg" \| null }` (ids in `AVATAR_FACES` / `AVATAR_BACKGROUNDS`) | `{ user }`; 400 "Reach level N for that avatar" when locked; null goes back to the first letter. Rooms they're in update at once; `avatar` shows on players, watchers, friends, search and profiles |
| `POST /api/me/back` | logged in | `{ back: id \| null }` (ids in `CARD_BACKS`) | `{ user }`; 400 "Reach level N for that card back" when locked; null goes back to the classic one. Rooms they're in update at once; every seat carries its player's `back`, and `pileTopBy` says who played each of the top Bluff pile cards, so everyone sees each player's cards in that player's back |
| `POST /api/me/table` | logged in | `{ table: id \| null }` (ids in `TABLE_THEMES`) | `{ user }`; 400 "Reach level N for that table" when locked; null goes back to classic green. Rooms they're in update at once; every seat carries its player's `table`, so everyone sees that player's seat box in their table style |
| `POST /api/me/tutorial` | logged in | `{ game: 'bluff' \| 'crazy7' }` | `{ user }`; that game's practice tutorial is done (finished or skipped), so it isn't offered again (`user.tutorials`) |
| `GET /api/friends` | logged in | – | `{ friends, incoming, outgoing }` with `online`, `lastSeen` (when an offline friend last had the app open; `null` while online and for requests), `inRoom` and `roomPhase` (the stage of a friend's other room) |
| `GET /api/players/:username` | logged in | – | `{ profile }`: name, level, joined date, online (friends and yourself only, else `null`), `lastSeen` (an offline friend's last online time, else `null`), game stats and friend status; never coins, role or login times |
| `GET /api/friends/search` | logged in | `?q=` (2+ letters; the start of the username, the display name or any word of it, `users.nameWords`) | `{ players }` with `level`, `online` and `lastSeen` (friends only, else `null`), `status` |
| `POST /api/friends/request` | logged in | `{ username }` | `{ result: 'sent' \| 'accepted' }` |
| `POST /api/friends/:id/accept` | logged in | – | 204 |
| `POST /api/friends/:id/remove` | logged in | – | 204 (decline, cancel or unfriend) |
| `GET /api/friends/unread` | logged in | – | `DmUnreadResponse` `{ total, byFriend }`: unread private messages, from current friends only |
| `GET /api/friends/:id/messages` | logged in, friends only | `?before=<ISO time>` (optional) | `DmHistoryResponse` `{ messages, more }`: the newest `DM_PAGE_SIZE` (50) before that time, oldest first |
| `POST /api/friends/:id/messages` | logged in, friends only | `{ text }` (trimmed, 1–`DM_MAX_LENGTH` = 300) | 201 `{ message }`; also sent live as `dm` to both people's open apps. 20 a minute per sender (429); a blocked friend can't be messaged; the newest 200 per pair are kept |
| `POST /api/friends/:id/messages/read` | logged in | – | 204; marks what that friend sent me as read and sends `dm:read` to both |
| `GET /api/admin/users` | admin | `?search=&limit=50&skip=0` | `{ users, total }` |
| `GET /api/admin/users/:id` | admin | – | `{ user, games, history, historyTotal, friends, activeSessions }` (last 10 games, first page of admin changes) |
| `GET /api/admin/users/:id/history` | admin | `?page=1` | `{ history, total }`, 10 admin changes per page, newest first |
| `POST /api/admin/users/:id` | admin | any of `{ displayName, username, role: 'user' \| 'admin', blocked }` | `{ user }`; a new username follows the sign-up rules (409 if taken), keeps them logged in and is logged as `Username: @old → @new`; blocking logs them out everywhere; role and block not on yourself |
| `POST /api/admin/users/:id/password` | admin | `{ password }` | 204; logs them out everywhere |
| `POST /api/admin/users/:id/coins` | admin | `{ amount, reason? }` (negative takes coins) | `{ user }` |
| `GET /api/admin/settings` | admin | – | `{ settings }`: `{ guestsAllowed, pushInvites, rankedSeason, rankedSeasonStartedAt, nextSeasonAt, updatedBy, updatedAt }` |
| `POST /api/admin/ranked/season` | admin | `{ from?: number }` (the season the admin saw) | `{ season, nextSeasonAt }`: books the next season 7 days out; 409 if the season already changed or one is booked; logged in the admin's history, every open app gets `settings:changed` |
| `POST /api/admin/ranked/season/cancel` | admin | – | 204: calls off the booked season; 409 if none is booked; logged |
| `POST /api/admin/settings` | admin | any of `{ guestsAllowed, pushInvites }` | `{ settings }`; saved in the `settings` collection, logged in the admin's history, every open app gets `settings:changed` |
| `GET /api/push/key` | anyone | – | `{ publicKey, enabled }`: null key = notifications not set up; `enabled` false = an admin switched invites off |
| `POST /api/push/subscribe` | logged in | the browser's `PushSubscription.toJSON()` | 204; this phone gets the account's invite notifications (503 while switched off) |
| `POST /api/push/unsubscribe` | logged in | `{ endpoint }` | 204 |
| `POST /api/admin/make-admin` | admin, or header `X-Admin-Key` | `{ username }` | `{ user }` |

Rules: usernames are 3–20 lowercase letters, numbers or `_`; passwords 8–128 characters; display names follow the in-game name rules (1–16 characters). Coins never go below zero. Login, register and make-admin allow 20 attempts per IP per 15 minutes. Search, player profiles and friend actions share a limit of 20 per minute per account (429 after that).

**Make the first admin:** sign up in the app, then in MongoDB (e.g. Atlas → Browse Collections → `users`) change your document's `role` from `"user"` to `"admin"`. After that, admins promote others from the app's Admin screen.

(Alternative without touching the database: set an `ADMIN_API_KEY` env var and call `POST /api/admin/make-admin` with header `X-Admin-Key: <key>` and body `{"username":"…"}`.)

## Security notes

- Passwords: scrypt with a random salt per user. Tokens: 256-bit random; only their SHA-256 hash is stored, and they expire via a TTL index.
- Logged-in players are identified from the socket handshake token; a missing or bad token just means guest.
- Admin actions are written to the audit collection with who did them and how (admin login or API key).
- Game saving runs in the background; a database error is logged and never stops a game.
- One room per account: joining or creating a room releases your old seat, unless it's open on another connection or you still hold cards in a running game there.
- Per network (client IP from `cf-connecting-ip`, else the last `X-Forwarded-For` entry, else the socket address): 50 connections, 10 new rooms per 10 minutes and 5 open rooms. Tune with `createBluffServer({ limits })`.
- Watchers see every hand, so after a game starts newcomers must be let in by the host (see `room:admit`).
- Chat is quick messages and emoji only (no free text); live voice goes phone to phone and never touches the server or its logs. Socket messages may be up to 128 KB (`maxHttpBufferSize`), with at most one binary part per message (a custom `socket.io-parser` decoder), and a guest connection that sends anything over 16 KB is cut off.

## Good to know

- Free instances sleep after 15 min without traffic; the first connection after that takes up to about a minute.
- Rooms live in memory: a redeploy or restart ends running games, and players land back on the home screen. Don't deploy while friends are playing.
- Without `CLIENT_ORIGIN` only localhost and home-network (192.168.x / 10.x / 172.16–31.x) pages can connect.
- Limits: 5 players + up to 7 watchers per room (12 people, bots included), 200 rooms, 40 events per 10 s per connection, one chat message per 0.7 s, names up to 16 characters.
- When 5 are seated, newcomers watch; they take free seats when the room returns to the lobby. After a game has started, a join becomes a request the host approves; anyone still waiting is let in when the room returns to the lobby.
- Chat only sends an index into the fixed `REACTIONS` / `QUICK_MESSAGES` lists in `src/types.ts`, so there is no free text to moderate.

## Code map

| File | What it does |
|---|---|
| `src/game.ts` | Game rules: deal, play, pass, bluff (both rules), finishing order, per-player stats |
| `src/crazy7/` | Crazy 7: `game.ts` (rules), bots (`driver.ts`, `brain.ts`, `memory.ts`) |
| `src/games/` | The game registry: `module.ts` (`GameModule`), `registry.ts` (`MODULES`), `driver.ts` (automatic steps, bots, game time for every registry game); `ludo/` (`game.ts` rules, `brain.ts` bots, `module.ts`); `snakes/` and `rmcs/` (`game.ts` rules, `module.ts` with bots and timed steps); `darts/`, `dots/`, `colorwar/` (`game.ts` rules, `brain.ts` bots, `module.ts`; Colour Wars' burst chain in `board.ts`); `fruit/` and `spikes/` (real-time: `game.ts` rules and timeline, Spikes' `brain.ts`, `module.ts`) |
| `src/bots/` | Bluff bots: `personality.ts` (styles, names), `levels.ts` (Normal / Hard / Expert), `memory.ts` (what a bot saw), `profile.ts` (how a player tends to play), `detector.ts` (how many fakes a play likely holds, and where), `brain.ts` (calls, peeks, its own plays), `driver.ts` (timers, the 2 s call window, moves through the same rules) |
| `src/habits.ts` | Counts each player's true plays for the bots' saved habits |
| `src/rooms.ts` | Rooms, seats and watchers, host, lobby settings, chat throttle, game snapshots, spoken announcements |
| `src/awards.ts` | End-of-game awards (Biggest liar, Best detective, …) |
| `src/socket.ts` | Socket events, per-player state, login token check, saving finished games |
| `src/http/` | Express app, CORS, rate limit, `/api` routes |
| `src/services/` | `UserService` (accounts, sessions, coins, admin), `GameRecorder` (games + stats), `MissionService` (missions), `LeagueService` (weekly friends league), `RivalService` (records between friends) and `RankedService` (rank points, seasons) |
| `src/rating.ts` | The ranked skill rating (Plackett-Luce) |
| `src/secrets.ts` | Secret mission cards: dealing and progress |
| `src/db/` | MongoDB connection, indexes, document shapes |
| `src/validate.ts` | Checks every incoming payload |
| `src/types.ts` | Shapes shared with the frontend (copy kept in `bluff-frontend/src/types.ts`) |

## Socket events

| Client → server | Payload |
|---|---|
| `room:create` | `{ name }` → `{ code, token }` (name ignored when logged in) |
| `room:join` | `{ code, name, watch? }` → `{ code, token }`, or `{ code, pending: true }` once a game has started (waits for the host). `watch`: join the lobby as a watcher |
| `friend:join` | `{ userId, watch? }` (logged in, friends only) → `{ code, pending: true, askedOf }`: never straight in; a request that friend answers with `room:admit` (shown to them in `RoomView.watchRequests` with `watch` and `viaFriend`), or the host once that friend has left; a yes lets them in to play or watch as asked and clears the wait, a no starts it. Room codes and invite links still join directly |
| `room:addBot` | – (host, lobby, free seat: a bot sits down; a stake over 100 drops to 100) |
| `room:cancelRequest` | – (withdraw a pending join request) |
| `room:admit` | `{ requestId, accept }` (host: let a pending request in to watch, or turn it down). After asking, or a no, the same account (a guest: network + name) waits 10 s before asking again |
| `room:rejoin` | `{ code, token }` |
| `room:config` | `{ game: 'bluff' \| 'crazy7', decks: 1 \| 2, bluffRule: 'all' \| 'one', stake, peeks: 0–3, bets: boolean, teams: boolean, handSize: 5 \| 7, maxPicks: 1–7, stack7: boolean, botLevel: 'normal' \| 'hard' \| 'expert', saza: boolean, secretLies: boolean, ranked: boolean, voice: boolean, kismat: boolean, seedhi: boolean, turnTimer: boolean, turnSec: 15 | 30 | 45 }` (host, lobby; missing fields: Bluff, off, 7 cards, 1 pick, stacking on, expert bots, no saza, lies revealed, not ranked, live voice on, no twists, no turn timer (30 s when on); ranked needs logged-in people and no bots; Crazy 7 ignores Bluff's extras and keeps them for switching back) |
| `room:ready` | `{ ready: boolean }` (lobby, seated, not the host: ready to start, or "wait a minute"; Start and Play again are refused until every other person is ready; a new stake or game, or turning Ranked or a twist on or off, clears everyone's ready; apps that connect with `auth.ready: true` have the button, older apps always count as ready; `PublicPlayer.ready`) |
| `room:start` / `room:lobby` / `room:leave` | – (`room:leave` mid-game with cards is a forfeit: a loss that still pays the stake) |
| `room:rematch` | – (host, after game over: same table, same settings, dealt again) |
| `room:end` | – (host, once someone finished 1st: game over, 1st wins; the rest are ranked by the value of cards left (A 1 … K 13, lower is better) and only the last place loses; 2v2: 1st place's team wins) |
| `room:plays` | `{ playerId }` → `{ plays, hand }` (Bluff game over, lie reveal on: every play that player made, in order, with the real cards and `called`/`caught`, and the cards they still held; refused while the game runs or when lies are kept secret) |
| `room:saza` | `{ badge }` (game over with Saza on: the winner swaps the last player's badge for another from `SAZA_BADGES`, until the room goes back to the lobby) |
| `room:host` | `{ memberId }` (host, lobby only: make an online member the host) |
| `room:teams` | – (host, lobby, 2v2 with 4 players: give slot 1 a different partner) |
| `room:slot` | `{ slot: 0–3 }` (2v2 lobby: move yourself to a free slot; 🔵 0 & 2, 🟠 1 & 3) |
| `room:swap` | `{ memberId }` (2v2 lobby: ask someone to swap places) |
| `room:swapAnswer` | `{ memberId, accept }` (answer a swap request from `memberId`) |
| `room:watch` | `{ watching: boolean, memberId? }` (lobby only: sit out and watch, or take a free seat; with `memberId` the host moves someone else; chosen watchers aren't seated automatically) |
| `game:play` | `{ cardIds, rank?, shield? }` (rank only when starting a round; `shield: true` uses a Card Shield) |
| `game:pass` | – |
| `game:bluff` | `{ playId, cardIndex?, bet? }` (`cardIndex` for the "pick one" rule; `bet` from `BET_STEPS`, at most the stake, coin games with bets on) |
| `game:peek` | `{ playId, cardIndex }` → `{ card }` only to the player who peeks (rooms with peeks on) |
| `c7:play` | `{ cardId, suit? }` (Crazy 7, your turn: one card of the top card's suit or number; only a 7 while a pick waits) |
| `c7:pick` | – (Crazy 7, your turn: pick one card, up to `maxPicks` a turn; while a 7's pick waits, take it) |
| `c7:pass` | – (Crazy 7, your turn: stop picking early; only after a pick and while more picks are allowed) |
| `c7:call` | – (Crazy 7: "last card", with one card left, or on your turn with two) |
| `rang:play` | `{ cardId, color?, targetId? }` (Rang, your turn: a card that fits; `color` for a wild, `targetId` for a 7 with 7-0 on) |
| `rang:pick` | – (Rang: pick one card, or take the waiting +2/+4) |
| `rang:pass` | – (Rang: end the turn after picking) |
| `rang:call` | – (Rang: "last card") |
| `rang:challenge` | – (Rang: challenge the single +4 that hit you) |
| `game:move` | `PluggedMove` `{ kind, move }` (registry games; `kind` must be the game on, else "That move is for another game"). Ludo: `{ kind: 'ludo', move: { type: 'roll' } }` or `{ kind: 'ludo', move: { type: 'move', token: 0..3 } }` (a goti in `LudoView.movable`). Saanp Seedhi: `{ kind: 'snakes', move: { type: 'roll' } }`. Raja Mantri: `{ kind: 'rmcs', move: { type: 'open' } }` or `{ kind: 'rmcs', move: { type: 'guess', target: memberId } }`. Darts: `{ kind: 'darts', move: { type: 'throw', x, y } }`. Dots and Boxes: `{ kind: 'dots', move: { type: 'line', line } }`. Colour Wars: `{ kind: 'colorwar', move: { type: 'tap', cell } }`. Fruit: `{ kind: 'fruit', move: { type: 'slice', ids, at } }`. Spike Attack: `{ kind: 'spikes', move: { type: 'step', dir } }`. Errors come back in the ack as `{ ok: false, error }` (e.g. "Not your turn", "Roll the dice first", "Move a goti first", "That goti can't move 3", "Pick one of your gotis", "Invalid move"; Raja Mantri: "Your chit is already open", "Wait for everyone to open their chit", "Only the Mantri finds the Chor", "Pick one of the two players left", "This round is over"; Darts: "Aim at the board", "Wait for the next turn"; Dots: "Pick a line between two dots", "That line is already drawn"; Colour Wars: "Tap a cell on the board", "Pick an empty cell to start", "Tap one of your own cells"; Fruit: "Wait for the countdown", "Too late, that swipe did not count", "That swipe is ahead of the clock", "Time's up", "Already sliced", "Nothing to slice there"; Spikes: "Wait for the countdown", "Too quick, one step at a time", "Can't go that way", "You're out") |
| `chat:send` | `{ kind: 'reaction' \| 'message', index, on? }` (`on: 'pile'`, reactions only, while a game is on: the emoji lands on the last play instead of floating up; a Quick Chat line also goes into the room's chat list) |
| `room:say` | `{ text }` (1–`ROOM_CHAT_LENGTH` 200 characters, one line): a typed line for everyone in the room, sent to all as `room:msg` |
| `room:messages` | → `{ messages }`: the room's chat list, oldest first (last `ROOM_CHAT_MAX` 500 lines, kept in memory only and gone when the room closes) |
| `chat:throw` | `{ to: memberId, index }` (index into `THROWS`; shares the chat speed limit) |
| `voice:live` | `{ on: boolean, mic?: boolean }` → `{ iceServers }` (live voice on or off; on only for logged-in, seated players while `config.voice` is on; who's in shows as `PublicPlayer.live`, mic on as `PublicPlayer.mic`; a new connection starts with it off) |
| `rtc:signal` | `{ to: memberId, sdp: { type: 'offer' \| 'answer', sdp } }` (live voice: one offer or answer, up to `RTC_MAX_SDP`, passed only between two players in live voice as `rtc:signal` `{ from, sdp }`; audio goes phone to phone, never through the server) |
| `friend:gift` | `{ memberId \| userId, amount }` (logged in, friends only; amount from `GIFT_STEPS`; at most `DAILY_GIFT_LIMIT` = 100 coins given per IST day in total) → `{ coins, giftLeft }` |
| `room:kick` | `{ memberId }` (host only; mid-game the player's cards leave the game) |
| `friend:invite` | `{ userId }` (logged in, friends only, not already in a room; once per friend per 30 s) → `{}` when online (popup), `{ pushed: true }` when offline and a notification went to their phone(s) |

Connect with `io(url, { auth: { token, ready: true, games: ['ludo'] } })` to play as a logged-in account (`ready: true`: this app has the lobby's Ready button; `games`: the registry games this app has, `PLUGGED_GAMES`). Server → client: `server:info` (`{ accounts, guestsAllowed }`, on every connection and to a guest who is turned away, so the app shows Log in and the guest lock even when its `/health` check is blocked), `state` (that player's `RoomView`), `announce` (`{ kind, text }`, read aloud), `chat` (`{ from, kind, index }`), `invite` (`{ fromId, fromName, code }`), `friend:online` (`{ id, name, username, avatar }`: a friend's app opened after 15+ seconds away, not sent within the same room; see below), `friends:changed` (a friend request was sent, accepted or removed; both people's open apps get it, so the lobby reloads its friend buttons only then instead of polling), `throw` (`{ from, to, index }`), `voice` (`{ from, audio, mime, ms }`: someone else's voice note, binary), `gift` (`{ from, to, amount }`, member ids, only when both are in the same room), `gift:received` (`{ fromName, amount }`, to whoever got coins), `dm` (`DirectMessage`: a private message, to every open app of both people), `dm:read` (`{ reader, other }`: `reader` read everything `other` sent them), `room:msg` (`RoomMessage`: a new line in the room's chat list), `watch:admitted` (`{ code, token, name }`: the host let you in, rejoin with it), `watch:denied` (`{ code, reason? }`), `room:kicked`, `session:replaced`. `RoomView.crazy7` carries the Crazy 7 table (top card, deck and pile counts, waiting pick, my playable cards and choices, who said last card, the last move). The host's `RoomView.watchRequests` lists pending requests (empty for everyone else). `RoomView.leftPlayers` lists who used Leave game in the current game (for names, the pot and the results), cleared back in the lobby.
