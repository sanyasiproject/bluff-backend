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
- **Peek power** (0–3 per player per game), **bets on bluff calls** (paid with the stake when the game finishes, never below zero) and **2v2 teams** (4 slots, 🔵 0 & 2 vs 🟠 1 & 3, chosen or swapped in the lobby; partners see each other's hand; the first team with both partners out wins and splits the pot; partners can't challenge each other; removing a player stops the game).
- **Levels** come from lifetime XP (`XP_RULES`, `levelOf` in `src/types.ts`): +20 per finished game, +50 for a win, +5 per caught liar, +3 per bluff nobody caught, plus `stats.bonusXp` from missions and secret mission cards. Level *n* needs 50 × (*n*−1) × *n* XP; titles run from Rookie (1) to Legend (50, 122,500 XP) and live in the frontend's `src/lib/progress.ts`.
- **Stakes** (host picks in the lobby): Free, 50, 100, 250, 500, 1K, 5K, 10K, 50K, 1L, 5L, 10L per player. Start checks everyone can pay; guests can only play Free games.
- Coins move only when a game **finishes**: every logged-in player pays the stake and the winner (1st place) gets the whole pot. A game stopped by the host, or by kicks leaving one player before anyone finished, moves nothing. A kicked player pays nothing and wins nothing. A player who uses **Leave game** mid-game forfeits: they lose and still pay the stake (in 2v2 their team loses; if one player is left, they win). Leaving right after putting down your last cards, before that play is settled, is a forfeit too.
- Every finished game stores the stake, pot and each player's coin change in `games`.
- **Daily and weekly missions** (`MISSIONS` in `src/types.ts`, `services/missions.ts`, `users.missions`): 3 a day (IST) and 3 a week (from Monday 00:00 IST), each set with exactly one social mission (a game with an accepted friend at the table), picked per account from a seed of its id and the day or week, and replaced lazily when read or counted on a new day or week (no cron). Only games that count for the daily ladder move them (finished, 1 minute or more, logged in, not removed). Reaching a goal pays its coins and XP (`stats.bonusXp`) at once, exactly once; there's nothing to claim. One free swap a day replaces an unfinished mission with another of the same set's period, never a social one (so it's the way out of playing with friends). Writes carry a `rev` guard and retry, so a save and a swap can't overwrite each other or pay twice. `CoinResult.missionsDone` lists the ones a game finished.
- **Weekly friends league** (`LEAGUE_POINTS`, `LEAGUE_CROWNS`, `services/league.ts`, `users.league`): games that count (finished, 1 minute or more) with 2+ logged-in players not removed by the host add points to each player's IST week (game +1, win +10, liar caught +3, lie nobody caught +2; never coins) in one atomic update that starts a new week on Monday and keeps last week's for its final board. `GET /api/me/league` builds my board from me and my friends (hidden ones left off), with the weekly crowns and last week's winners; `users.leagueHidden` leaves me off my friends' boards.
- **Rivals and Dosti** (`services/rivals.ts`): my record against each friend comes from the saved games of 1 minute or more we both finished as logged-in players (who finished ahead, the Dosti meter of games together, `DOSTI_LEVELS`), plus who caught whom lying from `games.catches` (recorded by `Game.callBluff` since this came in). Rival and Nemesis tags need `RIVAL_MIN_GAMES` decided games.
- **Ranked** (Bluff only, `config.ranked`, `src/rating.ts`, `services/ranked.ts`, `settings.rankedSeason`): a ranked table takes logged-in people only, no bots. Each finished ranked game of 1 minute or more updates a hidden skill rating (Plackett-Luce, Weng and Lin 2011) and moves visible rank points by the change, at most `RANK_DAILY_CAP` either way per IST day and never below the floor of the best division reached that season (`RANK_DIVISIONS`). Losses the floor or cap held off are owed (`ranked.debt`) and paid back from later wins first; 2v2 rates the winning pair against the losing pair. `CoinResult.rank` says what moved; an admin starts a new season (`POST /api/admin/ranked/season`) and everyone starts again.
- **Secret mission cards** (`SECRET_MISSIONS`, `src/secrets.ts`): when a game starts, each person (not bots) is dealt one card for that game at random (different ones at a table where possible), e.g. "Catch 2 liars" or "Say last card in time". Cards a table can't do, or that would give lies away, aren't dealt: no `stack7` with Stack 7s off, and with lies kept secret only `catch2` and `bigDrop`. A lie counts for `sneak2`/`bigLie` only once it settled (stood or survived a call), never when a walk-out or End game cut it off. `RoomView.secret` shows each player only their own card, with live progress counted from their own game; nobody sees another player's card until game over, when `RoomView.secrets` turns them all over. A card done in a game that counts adds `SECRET_XP` (25) to `stats.bonusXp` (`CoinResult.secretXp`) and counts for the secret-mission missions.
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
- The first player out wins at once; everyone else loses (the stake works as in Bluff). An empty deck is refilled from the pile; if
  nobody can play and nothing is left to pick, the fewest cards win.
- Bluff's extras (bluff rule, peeks, bets, teams) stay in the settings but are ignored in Crazy 7; End game doesn't apply.
- Lifetime stats count Crazy 7 games in `crazy7Games` (Bluff bots read only Bluff games); Crazy 7 picks don't count as cards picked up.
- Live games are stepwise: anything automatic (a pick when nothing matches, a turn that passes by itself, a 7's pick with stacking off,
  the missed-last-card penalty) happens one step at a time, about 1–1.5 s apart (`src/crazy7/auto.ts`, `RoomView.crazy7.auto` while one is
  due), so the table can follow it. Bots think at least 1.1 s (0.8 s after a pick). Simulations and rule tests keep the instant mode.
- Code: `src/crazy7/game.ts` (rules), `src/crazy7/auto.ts` (paced automatic steps), `src/crazy7/driver.ts` + `brain.ts` + `memory.ts` (bots that search ahead from what they've seen).

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
- **Saved habits** (`Habits` in `models.ts`, recorded in `game.ts` with `src/habits.ts`): every Bluff play and pass is counted with the true cards (lies by opening / following, pushes and passes with none of the rank, fakes per lie, finishing lies, fakes by tap position, real cards held back while honest or lying, claims that took the round past the copies and whether they were lies, and how often the person calls bots' plays, lies and truths apart, counting only bot plays they had their chance at: it stood, or they called it; the ways people play around bots). `GameRecorder.save` adds a game's counts to `users.habits` for logged-in players (finished or stopped games; Crazy 7 never). They're read with the account into `Member.habits` at join and before each Bluff deal with bots, never during a game, and never sent to any app (not in `PublicUser`, profiles or `RoomView`). Normal bots ignore them.
- Tune the engine with simulations, not by eye: `test/bots-detector.test.ts` covers big claims by deck count, finishing lies, the tap position from habits, smart peeks, the call window, a 5-to-7-card dumper and levels against each other; `test/bots-tricks.test.ts` covers the fake-then-real trap (from saved habits, within a room, through a peek, and a lying over-claim under "pick one" that isn't a trap), how much bots lie and hold back, plan changes, lying more to people who trust bots, and a person playing around the bots; `test/bots.test.ts` plays hundreds of games through the real rules. A bot's decision must not change when only the hidden cards of the play change (tested).
- New lifetime stats `plays` and `chances` (plays by others you could have called) feed the bots' read on each player; older accounts fall back to estimates.
- A player can call **Bluff at most 2 times in a row**; after that the call is refused until they play or pass on their own turn (`MAX_BLUFF_CALLS_IN_A_ROW` in `src/types.ts`). A player's last cards can always be called, even then (`Game.goingOut`).
- New rooms start on the **pick one card** bluff rule; the host can switch to show all in the lobby.
- **Saza for the loser** (`config.saza`, Bluff only, off by default): at game over (`Room.settleSaza`, called from `afterMove`) whoever won takes their badge off, and the one player left holding cards gets a random badge from `SAZA_BADGES` (`PublicPlayer.saza`, bots too); when the game closed with only bots holding cards (`endIfOnlyBots`), the bot holding the most (the first in seat order on a tie). Both lines are `room` notes: shown, not spoken, so the game-over lines read just before aren't cut off. The winner may swap it with `room:saza` while `RoomView.sazaPick` is set (game over, cleared back in the lobby). It stays on through other games until its wearer wins a Bluff game in the room (a team win and the host's End game count). 2v2, End game and walk-outs leave no single last player, so nobody gets a new one then. Switching Saza off takes every badge off; while Crazy 7 is picked they're hidden. Badges live in the room only, never saved.
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
| `GET /api/me/games` | logged in | `?limit=20` | `{ games }` most recent first, with per-game stats and coins |
| `GET /api/me/overview` | logged in | – | `{ coinRank, players, friends, loginBonusToday, gameBonusToday }` for the profile page |
| `GET /api/me/missions` | logged in | – | `MissionsResponse`: today's and this week's missions (`{ id, progress, done }`), `rerollLeft`, `dailyResetAt`, `weeklyResetAt`; a new day or week gets a fresh set |
| `GET /api/me/league` | logged in | – | `LeagueResponse`: this week's board of me and my friends, the crowns, last week's final board, `resetAt`, `hidden` |
| `POST /api/me/league/hide` | logged in | `{ hidden: boolean }` | `LeagueResponse`; hidden players are left off their friends' boards |
| `GET /api/me/rivals` | logged in | – | `RivalsResponse`: my record against every friend I've finished a game with |
| `GET /api/players/:username/rival` | logged in | – | `{ record }`: my record against that friend, or null (not a friend, or no games together) |
| `POST /api/me/missions/swap` | logged in | `{ id }` | `MissionsResponse`; once a day, an unfinished mission is swapped for another; 400 "You already swapped a mission today", "That mission is done", "That isn't one of your missions" |
| `POST /api/me/avatar` | logged in | `{ avatar: "face.bg" \| null }` (ids in `AVATAR_FACES` / `AVATAR_BACKGROUNDS`) | `{ user }`; 400 "Reach level N for that avatar" when locked; null goes back to the first letter. Rooms they're in update at once; `avatar` shows on players, watchers, friends, search and profiles |
| `POST /api/me/back` | logged in | `{ back: id \| null }` (ids in `CARD_BACKS`) | `{ user }`; 400 "Reach level N for that card back" when locked; null goes back to the classic one. Rooms they're in update at once; every seat carries its player's `back`, and `pileTopBy` says who played each of the top Bluff pile cards, so everyone sees each player's cards in that player's back |
| `POST /api/me/table` | logged in | `{ table: id \| null }` (ids in `TABLE_THEMES`) | `{ user }`; 400 "Reach level N for that table" when locked; null goes back to classic green. Rooms they're in update at once; every seat carries its player's `table`, so everyone sees that player's seat box in their table style |
| `POST /api/me/tutorial` | logged in | `{ game: 'bluff' \| 'crazy7' }` | `{ user }`; that game's practice tutorial is done (finished or skipped), so it isn't offered again (`user.tutorials`) |
| `GET /api/friends` | logged in | – | `{ friends, incoming, outgoing }` with `online`, `lastSeen` (when an offline friend last had the app open; `null` while online and for requests), `inRoom` and `roomPhase` (the stage of a friend's other room) |
| `GET /api/players/:username` | logged in | – | `{ profile }`: name, level, joined date, online (friends and yourself only, else `null`), `lastSeen` (an offline friend's last online time, else `null`), game stats and friend status; never coins, role or login times |
| `GET /api/friends/search` | logged in | `?q=` (2+ letters; username start or display name) | `{ players }` with `level`, `online` and `lastSeen` (friends only, else `null`), `status` |
| `POST /api/friends/request` | logged in | `{ username }` | `{ result: 'sent' \| 'accepted' }` |
| `POST /api/friends/:id/accept` | logged in | – | 204 |
| `POST /api/friends/:id/remove` | logged in | – | 204 (decline, cancel or unfriend) |
| `GET /api/admin/users` | admin | `?search=&limit=50&skip=0` | `{ users, total }` |
| `GET /api/admin/users/:id` | admin | – | `{ user, games, history, historyTotal, friends, activeSessions }` (last 10 games, first page of admin changes) |
| `GET /api/admin/users/:id/history` | admin | `?page=1` | `{ history, total }`, 10 admin changes per page, newest first |
| `POST /api/admin/users/:id` | admin | any of `{ displayName, role: 'user' \| 'admin', blocked }` | `{ user }`; blocking logs them out everywhere; not on yourself |
| `POST /api/admin/users/:id/password` | admin | `{ password }` | 204; logs them out everywhere |
| `POST /api/admin/users/:id/coins` | admin | `{ amount, reason? }` (negative takes coins) | `{ user }` |
| `GET /api/admin/settings` | admin | – | `{ settings }`: `{ guestsAllowed, pushInvites, rankedSeason, updatedBy, updatedAt }` |
| `POST /api/admin/ranked/season` | admin | `{ from?: number }` (the season the admin saw) | `{ season }`: everyone's rank starts again; 409 if the season already changed; logged in the admin's history, every open app gets `settings:changed` |
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
- Voice notes are the only free-form content: relayed to the room as they arrive, never written to the database or logs. Socket messages may be up to 128 KB (`maxHttpBufferSize`) to fit one, with at most one binary part per message (a custom `socket.io-parser` decoder), and a guest connection that sends anything over 16 KB is cut off. The 10 s wait is kept per account, so leaving and rejoining doesn't skip it.

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
| `friend:join` | `{ userId, watch? }` (logged in, friends only): join or watch the friend's room; once their game is on it's a request to the host, like `room:join` |
| `room:addBot` | – (host, lobby, free seat: a bot sits down; a stake over 100 drops to 100) |
| `room:cancelRequest` | – (withdraw a pending join request) |
| `room:admit` | `{ requestId, accept }` (host: let a pending request in to watch, or turn it down). After asking, or a no, the same account (a guest: network + name) waits 10 s before asking again |
| `room:rejoin` | `{ code, token }` |
| `room:config` | `{ game: 'bluff' \| 'crazy7', decks: 1 \| 2, bluffRule: 'all' \| 'one', stake, peeks: 0–3, bets: boolean, teams: boolean, handSize: 5 \| 7, maxPicks: 1–7, stack7: boolean, botLevel: 'normal' \| 'hard' \| 'expert', saza: boolean, secretLies: boolean, ranked: boolean, voice: boolean }` (host, lobby; missing fields: Bluff, off, 7 cards, 1 pick, stacking on, expert bots, no saza, lies revealed, not ranked, voice notes on; ranked needs logged-in people and no bots; Crazy 7 ignores Bluff's extras and keeps them for switching back) |
| `room:ready` | `{ ready: boolean }` (lobby, seated, not the host: ready to start, or "wait a minute"; Start and Play again are refused until every other person is ready; a new stake or game, or turning Ranked on or off, clears everyone's ready; apps that connect with `auth.ready: true` have the button, older apps always count as ready; `PublicPlayer.ready`) |
| `room:start` / `room:lobby` / `room:leave` | – (`room:leave` mid-game with cards is a forfeit: a loss that still pays the stake) |
| `room:rematch` | – (host, after game over: same table, same settings, dealt again) |
| `room:end` | – (host, once someone finished 1st: game over, 1st wins and everyone else loses) |
| `room:plays` | `{ playerId }` → `{ plays, hand }` (Bluff game over, lie reveal on: every play that player made, in order, with the real cards and `called`/`caught`, and the cards they still held; refused while the game runs or when lies are kept secret) |
| `room:saza` | `{ badge }` (game over with Saza on: the winner swaps the last player's badge for another from `SAZA_BADGES`, until the room goes back to the lobby) |
| `room:host` | `{ memberId }` (host, lobby only: make an online member the host) |
| `room:teams` | – (host, lobby, 2v2 with 4 players: give slot 1 a different partner) |
| `room:slot` | `{ slot: 0–3 }` (2v2 lobby: move yourself to a free slot; 🔵 0 & 2, 🟠 1 & 3) |
| `room:swap` | `{ memberId }` (2v2 lobby: ask someone to swap places) |
| `room:swapAnswer` | `{ memberId, accept }` (answer a swap request from `memberId`) |
| `room:watch` | `{ watching: boolean, memberId? }` (lobby only: sit out and watch, or take a free seat; with `memberId` the host moves someone else; chosen watchers aren't seated automatically) |
| `game:play` | `{ cardIds, rank? }` (rank only when starting a round) |
| `game:pass` | – |
| `game:bluff` | `{ playId, cardIndex?, bet? }` (`cardIndex` for the "pick one" rule; `bet` from `BET_STEPS`, at most the stake, coin games with bets on) |
| `game:peek` | `{ playId, cardIndex }` → `{ card }` only to the player who peeks (rooms with peeks on) |
| `c7:play` | `{ cardId }` (Crazy 7, your turn: one card of the top card's suit or number; only a 7 while a pick waits) |
| `c7:pick` | – (Crazy 7, your turn: pick one card, up to `maxPicks` a turn; while a 7's pick waits, take it) |
| `c7:pass` | – (Crazy 7, your turn: stop picking early; only after a pick and while more picks are allowed) |
| `c7:call` | – (Crazy 7: "last card", with one card left, or on your turn with two) |
| `chat:send` | `{ kind: 'reaction' \| 'message', index, on? }` (`on: 'pile'`, reactions only, while a game is on: the emoji lands on the last play instead of floating up) |
| `chat:throw` | `{ to: memberId, index }` (index into `THROWS`; shares the chat speed limit) |
| `voice:send` | `{ audio: binary, mime, ms }` (logged-in members only, while `config.voice` is on; up to `VOICE_MAX_BYTES` and `VOICE_MAX_MS`, one every `VOICE_GAP_MS` per member; formats in `VOICE_TYPES`; passed on to everyone else in the room as `voice` and never stored or logged) |
| `friend:gift` | `{ memberId \| userId, amount }` (logged in, friends only; amount from `GIFT_STEPS`; at most `DAILY_GIFT_LIMIT` = 100 coins given per IST day in total) → `{ coins, giftLeft }` |
| `room:kick` | `{ memberId }` (host only; mid-game the player's cards leave the game) |
| `friend:invite` | `{ userId }` (logged in, friends only, not already in a room; once per friend per 30 s) → `{}` when online (popup), `{ pushed: true }` when offline and a notification went to their phone(s) |

Connect with `io(url, { auth: { token, ready: true } })` to play as a logged-in account (`ready: true`: this app has the lobby's Ready button). Server → client: `server:info` (`{ accounts, guestsAllowed }`, on every connection and to a guest who is turned away, so the app shows Log in and the guest lock even when its `/health` check is blocked), `state` (that player's `RoomView`), `announce` (`{ kind, text }`, read aloud), `chat` (`{ from, kind, index }`), `invite` (`{ fromId, fromName, code }`), `friend:online` (`{ id, name, username, avatar }`: a friend's app opened after 15+ seconds away, not sent within the same room; see below), `friends:changed` (a friend request was sent, accepted or removed; both people's open apps get it, so the lobby reloads its friend buttons only then instead of polling), `throw` (`{ from, to, index }`), `voice` (`{ from, audio, mime, ms }`: someone else's voice note, binary), `gift` (`{ from, to, amount }`, member ids, only when both are in the same room), `gift:received` (`{ fromName, amount }`, to whoever got coins), `watch:admitted` (`{ code, token, name }`: the host let you in, rejoin with it), `watch:denied` (`{ code, reason? }`), `room:kicked`, `session:replaced`. `RoomView.crazy7` carries the Crazy 7 table (top card, deck and pile counts, waiting pick, my playable cards and choices, who said last card, the last move). The host's `RoomView.watchRequests` lists pending requests (empty for everyone else). `RoomView.leftPlayers` lists who used Leave game in the current game (for names, the pot and the results), cleared back in the lobby.
