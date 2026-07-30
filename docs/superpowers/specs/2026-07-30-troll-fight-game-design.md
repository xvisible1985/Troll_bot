# «Драка» — health-for-everyone + fight mini-game — design

## Purpose

Replace troll-bot's `/kick` ("👢 Пнуть") with a turn-based fight ("⚔️
Драка") between a chat user and the troll: 3 rounds, each side takes a
swing, damage lands on a successful hit. This requires a health stat for
every human participant — built in **tg-bot** (`mutes.db`), not troll-bot,
even though the game itself runs in troll-bot. One combined spec per the
user's request, even though tg-bot's half must ship and deploy before
troll-bot's half can write to it.

## Part 1 — Human health (tg-bot)

### Schema (`mutes.db`)

```sql
CREATE TABLE IF NOT EXISTS user_health (
  user_id INTEGER PRIMARY KEY,
  health INTEGER NOT NULL DEFAULT 100,
  max_health INTEGER NOT NULL DEFAULT 100,
  last_regen_at INTEGER
);
CREATE TABLE IF NOT EXISTS injuries (
  user_id INTEGER PRIMARY KEY,
  injury_type TEXT NOT NULL,   -- 'arm' | 'leg' | 'head'
  injured_until INTEGER NOT NULL
);
```

Global per `user_id`, same scope as the existing `mutes` table (not
per-chat) — a person has one health total across every chat tg-bot serves.
Both tables are created defensively by **both** processes (tg-bot owns the
file; troll-bot connects to it the same way it already does for
`troll_smell` — see `TG_BOT_DB_PATH`/sibling-directory guess in troll-bot's
`bot.js`), so deploy order between the two bots doesn't matter.

### Regen (new background job in tg-bot — this bot has no `setInterval` today)

- Every ~10 minutes: for every row where `health < max_health`, add health
  proportional to 10/hour elapsed since `last_regen_at`, capped at
  `max_health`, then update `last_regen_at`.
- Once daily at **04:00 server time**: set `health = max_health` for
  everyone (a full overnight restore) — guarded by a `last_full_restore_date`
  check (stored as a plain date string in a tiny key/value spot, e.g. reuse
  the existing settings-style table if tg-bot has one, otherwise a single
  new row) so it only fires once per calendar day, not every tick during the
  04:00 hour.

### 0-health → knocked out

Reuses the **existing** mute system as-is (`muteUser`, `isMuted`, the
message-delete-on-mute handler) — no new mute mechanism. When health hits 0:

```js
muteUser(userId, chatId, username, 0, 'драка', 30 * 60 * 1000);
```

The existing delete-on-mute reply (`bot.js` ~line 1163-1169) branches on
`muted_by_name`: if it's `'драка'`, reply "😵 {first_name} находится в
отключке..." instead of the normal "вы замучены {until}" — same deletion
behavior either way, just different flavor text for this specific cause.

### Injuries (critical hits only — see Part 2)

- `injury_type` is one of `arm`, `leg`, `head`; `injured_until` a unix
  timestamp, lazily expired the same way `troll_smell`/`mutes` already are
  (checked and deleted at read time once past).
- **All three types fully block starting "Драка"** (checked by troll-bot
  before a fight begins — same read-only cross-bot access already used
  elsewhere).
- Additional passive effects, both live entirely in tg-bot's message
  handler:
  - **leg** — every 3rd message from that user, tg-bot replies "🦵
    {first_name} хромает..." (identical in-memory-counter pattern to the
    existing troll-smell throttle: count per user while the injury is
    active, reply on every 3rd, reset when it clears).
  - **head** — each message from that user has a flat chance (default 25%)
    of getting a nonsense reply from a small canned pool (e.g. "Ты вообще
    о чём?", "Моя видеть единорога, извини, что?", ~6-8 lines) — no
    counter, just a per-message dice roll.
  - **arm** — no passive chat effect, only the fight-block.
- A new critical hit while already injured overwrites the existing row
  (`INSERT OR REPLACE`) with a fresh roll and a fresh 24h timer — no
  stacking multiple injuries at once.

## Part 2 — «Драка» (troll-bot)

### Replacing `/kick`

`TROLL_ACTION_KEYBOARD`'s "👢 Пнуть" button becomes "⚔️ Драка"
(`callback_data: 'troll_fight'`), and `performKick` is retired entirely —
its dodge-roll, per-user `kick_blocked_until`, and the "2 kicks in an hour
→ hide" mechanic all go away with it, replaced by the flow below. Same
`checkCommandCooldown(from.id, 'fight')` gate as every other direct
interaction; same cocoon/regen-sleep guards as the other four remaining
buttons (play/feed/tease/boobs) — a cocooned or regen-sleeping troll can't
fight either.

### Pre-fight checks

1. Troll's own guards (cocoon, regen-sleep) — same as today.
2. Read the challenger's injury row from tg-bot's `mutes.db` (via the
   existing `tgBotDb` connection already used for `troll_smell`) — if any
   injury is active, refuse with a message naming which body part
   ("{user}, твоя рука ещё болит, не до драки!" / нога / голова), no fight
   starts, no cooldown/health touched.
3. Read the challenger's health — if it's 0 (should be rare, since 0
   health means they're muted and couldn't have sent the button-press's
   underlying message/click anyway, but Telegram button clicks aren't
   blocked by mute) refuse the same way ("твоя в отключке, какая драка").

### The fight (3 rounds, stops early if either side hits 0)

Each round, in order:

1. **Human's swing at the troll.** Pick a random weapon + body part (see
   pools below), roll `rollTrollTryResult(`увернуться от удара ${actorName(from)} ${weapon} ${bodyPart}`)`
   — same 50/50 engine already used for kick-dodging, unchanged. Dodge
   **succeeds** → miss, no damage. Dodge **fails** → hit lands: roll damage
   1-10, apply to the troll's `health` (same `MAX(0, health - dmg)` clamp
   as everywhere else troll health is written).
2. If the troll's health is now 0, stop the fight early (see "Troll reaches
   0" below) — skip the troll's counter-swing this round.
3. **Troll's counter-swing at the human.** New weapon + body part roll,
   `rollTrollTryResult(`ударить ${actorName(from)} ${weapon} ${bodyPart}`)`
   — same engine again, troll is just the one framed as attempting the
   action this time. **Success** → hit lands: roll damage 1-20, apply to
   the human's health in tg-bot's `user_health` (write via `tgBotDb`, same
   direction as `markSmelly`). **Failure** → miss, no damage.
4. **Critical-hit injury check** — only on a landed troll hit (step 3
   success) where the underlying `rollTrollTryResult` roll was ≥ 90: roll
   one of `arm`/`leg`/`head` at random and write it to tg-bot's `injuries`
   table with `injured_until = now + 24h`.
5. If the human's health is now 0, stop the fight early. troll-bot performs
   the mute itself, in the same `tgBotDb` write as the health update — no
   waiting on tg-bot's regen job to notice: `INSERT OR REPLACE INTO mutes
   (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES
   (?, ?, ?, 0, 'драка', ?)`, mirroring tg-bot's own `muteUser`'s exact SQL
   shape (troll-bot can't call tg-bot's JS functions across processes, but
   the SQL itself is simple enough to duplicate, same precedent as
   `markSmelly`/`troll_smell`'s dual-write setup).

Every landed/missed swing is narrated in chat via its `rollTrollTryResult`
text (same style as the current kick-dodge message) — no separate
flavor-text category needed, the roll's own text line IS the narration.

No attitude change either way — this is mutual gameplay, not an unwanted
attack, so `attitude_kick_delta` and its enemy-declaration checks don't
apply to fights at all.

### Weapon / body-part pools (flat arrays, no stage variation, no admin
### phrase-management integration — small, fixed, not meant to be tuned)

```js
const FIGHT_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const FIGHT_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
```

### End of fight

A short summary message once all 3 rounds resolve (or the fight ends
early): who's left standing, remaining health on both sides. Logged as
`troll_actions.action = 'fight'` (win/loss detail not split into separate
action names — one category is enough for the existing stats aggregation
to pick up).

## Explicitly out of scope

- No admin-tunable hit-chance, damage ranges, or weapon/body-part pools —
  fixed values/arrays for now.
- No per-chat health — confirmed global per user.
- No stacking multiple simultaneous injuries.
- No stage-gating of fight content.

## Testing

No automated test suite in either repo. Verify: trigger enough troll
critical hits (or force a 90+ roll via direct DB manipulation for testing)
to confirm an injury is written and blocks a subsequent "Драка" attempt
with the right message per type; confirm leg's every-3rd-message "хромает"
and head's occasional nonsense reply fire in tg-bot outside of any fight;
confirm a human's health reaching 0 triggers the existing mute flow with
the "находится в отключке" variant text; confirm the daily 04:00 full
restore and the hourly +10 trickle both work via direct timestamp
manipulation in `mutes.db`.
