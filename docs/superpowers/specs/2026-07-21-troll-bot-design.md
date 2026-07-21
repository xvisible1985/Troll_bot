# Troll Bot — design

## Purpose

A separate Telegram bot (its own account, name, and avatar — not a feature
bolted onto the existing `tg-bot`) that plays a virtual-pet "troll" living
under a bridge in a chat. Users can play with it, kick it, and feed it; it
grows through 4 life stages, has weight/mood/health, remembers who did what
to it, and occasionally causes mischief on its own. A second, separate admin
chat lets admins tune its behavior and speak through it.

## Why a separate bot/repo

Telegram messages are always attributed to the sending bot account's own
name and avatar — a single bot process cannot make a message appear to come
from a different persona. Making the troll feel like "a real character" (not
just another status prefix in `tg-bot`'s existing messages, e.g. `🧓 {ник}:`)
requires an actual second bot account, registered separately via BotFather,
with its own token, display name, and profile picture. It is added to the
same public group as `tg-bot` as an independent member, plus to a second,
private admin-only chat.

Because messages already carry the troll's own name/avatar natively, none of
the troll's own messages need a text prefix (unlike `tg-bot`'s shared-bot
convention) — they're just plain troll-speak text.

## Two chats

- **Public chat** — the same group `tg-bot` lives in. Everyone interacts
  with the troll here (`/play`, `/kick`, `/feed`, `/troll`), and this is
  where autonomous mischief and growth announcements post.
- **Admin chat** — a separate chat (private group or DM), whose chat ID is
  hardcoded in `.env` as `ADMIN_CHAT_ID`. Every `/troll_set*`/`/troll_say`
  command is a no-op unless the message's `chat.id` matches `ADMIN_CHAT_ID` —
  no registration command, no per-user role table, just a chat-id compare.

## Data model (SQLite, `better-sqlite3`, mirroring `tg-bot`'s style)

```sql
CREATE TABLE troll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_id INTEGER NOT NULL,
  stage INTEGER NOT NULL DEFAULT 1,          -- 1 малыш / 2 подросток / 3 молодой / 4 взрослый
  feed_count INTEGER NOT NULL DEFAULT 0,
  mood INTEGER NOT NULL DEFAULT 50,          -- 0..100
  health INTEGER NOT NULL DEFAULT 100,       -- 0..100
  message_count INTEGER NOT NULL DEFAULT 0,  -- for the every-Nth-message mischief trigger
  silenced_until INTEGER,                    -- set after /kick; troll ignores everything until this unix time passes
  last_fed_at INTEGER,
  born_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE troll_actions (             -- memory of every interaction, for flavor text
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT,
  action TEXT NOT NULL,                  -- 'play' | 'kick' | 'feed'
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE troll_settings (             -- admin-tunable, key/value
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

There is exactly one troll (single-row `troll_state`, same `CHECK (id = 1)`
singleton pattern `tg-bot` already uses for its own single-row tables). This
bot serves one chat, same as `tg-bot`.

### Settings (`troll_settings`, all admin-tunable via `/troll_set`)

| key | default | meaning |
|---|---|---|
| `sleep_start` | `0` | hour (0-23, server time) the troll falls asleep |
| `sleep_end` | `8` | hour it wakes up; no mischief between start and end |
| `naughtiness` | `5` | 1-10, skews mischief tone meaner/more frequent at higher values |
| `mischief_interval_hours` | `1` | autonomous mischief timer cadence |
| `mischief_message_trigger` | `50` | every Nth public-chat message also rolls mischief |
| `health_decay_per_hour` | `2` | health lost per hour once neglected (see below) |
| `health_regen_per_hour` | `1` | health gained per hour while NOT neglected |
| `neglect_threshold_hours` | `6` | hours since last `/feed` before decay (vs. regen) applies |
| `paused` | `0` | `1` disables autonomous mischief only; `/play`/`/kick`/`/feed` keep working |

## Public commands

- **`/troll_here`** (admin, in the public chat) — one-time summon: posts the
  arrival announcement ("a troll cub appeared in the village and settled
  under the bridge"), creates `troll_state` (stage 1, `feed_count 0`,
  `mood 50`, `health 100`). If a troll already exists (a row is already
  present), refuses with a short message pointing at `/troll_reset` instead
  — this command never silently overwrites an existing troll.
- **`/troll`** — status card: health, weight (see formula below), mood
  (numeric shown as a word: e.g. "весёлый" high / "грустный" mid / "злой"
  low), stage name.
- **`/play`** — anyone. If currently silenced (see `/kick` below), the troll
  ignores it entirely (no response, no state change). Otherwise: a
  purring + kind-words response (troll-speak), `mood += 10` (cap 100),
  logs a `play` action.
- **`/kick`** — anyone. If already silenced, ignored (still silenced,
  no further mood hit — kicking a silent troll does nothing extra). Otherwise:
  an offended/cursing response (troll-speak), `mood -= 20` (floor 0), logs a
  `kick` action, and sets `silenced_until = now + 1 hour` — for that hour the
  troll ignores `/play`, `/feed`, AND skips any autonomous mischief that
  would have fired.
- **`/feed`** — anyone. If silenced, ignored. Otherwise: an eating response,
  `feed_count += 1`, `health` reset toward 100, `mood += 5` (cap 100),
  `last_fed_at = now`, logs a `feed` action. If `feed_count` just crossed a
  stage threshold (20 / 50 / 90, cumulative — see Growth below), also posts
  a separate "grew up" announcement and advances `stage`.

## Growth and weight

- Stage 1→2 at 20 cumulative feedings, 2→3 at 50 (20+30), 3→4 at 90
  (20+30+40). `stage` is derived from `feed_count` via these thresholds,
  not tracked as independent state that could desync.
- Weight: `30 + min(feed_count, 90) / 90 * 370` kg, rounded, plus a small
  ±3kg random jitter applied only at display time in `/troll` (not stored) —
  purely cosmetic liveliness, matches how `tg-bot`'s `/patient` temperature
  is similarly randomized fresh on every read rather than persisted.

## Health

Checked/updated once per hourly tick (the same timer mischief runs on):
- If `now - last_fed_at > neglect_threshold_hours` (or never fed): `health -=
  health_decay_per_hour` (floor 0).
- Otherwise: `health += health_regen_per_hour` (cap 100).

So regular feeding keeps health trending to 100 on its own; long neglect
actually drains it. `/feed` itself also gives an immediate bump on top,
per "Public commands" above.

## Mood and its effect on mischief

`mood` (0-100) only ever changes via `/play` (+10), `/feed` (+5), and
`/kick` (-20). It does not decay on its own. It affects which mischief
phrase pool gets picked (see below) but never blocks mischief from
happening on schedule.

## Autonomous mischief

Two independent triggers, both gated by `paused` and by the current hour
being outside `[sleep_start, sleep_end)`:
1. A `setInterval` matching `mischief_interval_hours`.
2. Every `mischief_message_trigger`-th message posted in the public chat
   (own counter, `message_count` on `troll_state`). Incremented on every
   ordinary text message from a human (excluding the troll bot's own posts
   and excluding `/`-command messages) — mirrors `tg-bot`'s own convention
   of not counting command invocations toward its analogous per-message
   counters.

At `sleep_start` (server hour crosses into the sleep window), if the troll
is awake, post one "falling asleep, snoring" line, then go quiet — no
further mischief-timer or message-trigger mischief fires until
`sleep_end`, even if the message-count threshold is hit during the night.

Mischief phrase selection: pick from a phrase pool based on `mood` and
`naughtiness` — low mood / high naughtiness skews toward meaner mischief
(stealing, insults); high mood / low naughtiness skews toward silly-harmless
mischief (jokes, running around). Phrases occasionally reference a specific
remembered user pulled from `troll_actions` (e.g., naming whoever last fed
or kicked it) for flavor. All mischief text is written directly in
troll-speak (see below) — not run through the live transformer.

## Troll-speak

Every troll-authored string (hand-written phrase pools AND the live
transformer used by `/troll_say`) follows the same accent: first/second/
plural personal pronouns become their possessive form (я/меня/мне/мной →
моя; ты/тебя/тебе/тобой → твоя; мы/нас/нам/нами → наша; вы/вас/вам/вами →
ваша), and verbs default to infinitive rather than conjugated form — e.g.
"Моя твоя не понимать."

Hand-written phrase pools (mischief, `/play`, `/kick`, `/feed`, growth/
sleep announcements) are authored directly in this style — no runtime
transform needed for those, since they're static strings picked from an
array.

### Admin broadcast: `/troll_say <text>`

Admin-chat-only. Runs the ADMIN'S plain-Russian `<text>` through a live,
best-effort transformer, then posts the result to the public chat
immediately (no preview/confirmation step) as the troll bot. Two-stage
transform:
1. **Pronouns** — reliable, regex word-boundary replacement per the mapping
   above, case-insensitive match with capitalization preserved on the
   replacement if the original was capitalized (start-of-sentence case).
2. **Verbs** — best-effort only: any word ending in a common personal
   verb suffix (-ешь, -ишь, -ет, -ит, -ем, -им, -ете, -ите, -ют, -ат, -ят,
   -ю, -у, checked longest-first) and long enough to plausibly be a verb
   has that suffix replaced with "-ть". This is a known-imperfect
   heuristic — it will occasionally mangle irregular verbs or unrelated
   words that happen to share an ending, and that's an accepted trade-off
   for a fun bot, not a bug to chase further.

## Out of scope / notes

- Single chat pair (one public + one admin), no multi-tenant support —
  matches `tg-bot`'s own existing single-chat scope.
- `/troll_say` has no preview/confirmation gate — sends immediately, per
  explicit user decision.
- No `/troll_reset` safety confirmation beyond it being admin-only and
  chat-gated — a full wipe (new troll from scratch, `troll_actions` memory
  cleared too) is intentionally one command away, mirroring how `tg-bot`'s
  own `/endvirus` has no extra confirmation step either.
- Weight/temperature-style cosmetic jitter is display-only, never persisted
  — consistent with the `tg-bot` precedent this design explicitly follows.
