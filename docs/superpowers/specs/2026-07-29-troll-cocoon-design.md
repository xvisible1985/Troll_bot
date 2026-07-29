# Troll cocoon/transformation — design

## Purpose

An admin-only "pause everything" state ("кокон") for the troll, plus a
one-time stat upgrade (100 → 200 max health, matching regen/decay rates
doubled) the first time the troll emerges from it. While cocooned, nothing
about the troll changes or responds — no commands, no buttons, no autonomous
behavior. The `/troll` card keeps its normal look (portrait + bars) but gets
an extra caption with the troll's all-time activity totals, since that's the
only thing worth looking at while he's otherwise inert.

This is unrelated to the separate "more mature/teen personality" content
request (new tease/mischief phrases) — that's its own piece of work, added
directly to an existing stage's phrase pool, not gated behind this mechanic
at all (confirmed with the user).

## Data model

```sql
ALTER TABLE troll_state ADD COLUMN cocoon_started_at INTEGER; -- NULL = normal life
ALTER TABLE troll_state ADD COLUMN max_health INTEGER NOT NULL DEFAULT 100;
ALTER TABLE troll_state ADD COLUMN has_transformed INTEGER NOT NULL DEFAULT 0;
```

Same nullable-timestamp idiom already used for `regen_sleep_started_at`.
`max_health` replaces every hardcoded `100` ceiling used for the `health`
stat specifically (not mood/satiety/attitude/etc. — those stay capped at
100). `has_transformed` guards the one-time stat upgrade described below so
toggling the cocoon a second time later doesn't re-apply it.

## Freezing (`cocoon_started_at` set)

- `backgroundTick`: a new early `return` at the very top, before even the
  `regen_sleep_started_at` check — nothing runs: no health/satiety tick, no
  night-sleep toggle, no autonomous mischief/hunger/eat/poop/pee, no regen
  sleep. Time is fully suspended for the troll; all the cooldown timestamps
  (`last_health_tick_at`, `last_mischief_at`, etc.) stay frozen at whatever
  they were and simply resume from real elapsed time once the cocoon ends —
  the same as if the bot process itself had been down for that period. This
  can produce a one-time "catch-up" tick right after emergence (e.g. an
  overdue mischief or hunger action firing immediately); that's accepted as
  a minor, harmless quirk rather than something to special-case away.
- `performPlay` / `performFeed` / `performKick` / `performTease` /
  `performBoobs`: each gets an early check (same shape as the existing
  `is_asleep`/`regen_sleep_started_at` guards), replying with a shared line
  — "🥚 Тролль сейчас в коконе, ему не до тебя..." — and touching no stats,
  no `troll_actions` log entry.
- The `/troll` card's buttons keep showing (no change to
  `TROLL_ACTION_KEYBOARD`) — pressing one just routes into the same guarded
  `perform*` function and gets the same frozen reply. This matches the
  user's "kнопки тоже не будут работать" (still visible, just inert).
- Admin-only commands (`/troll_here`, `/troll_reset`, `/troll_poop`, the
  settings/stage panel endpoints) are **not** gated — the cocoon is itself an
  admin action, and admin override tools should keep working regardless.

## Admin toggle

Two new endpoints in `admin-server.js`, mirroring the existing `/pause` +
`/resume` pair:

- `POST /api/cocoon-enter` — no-op if already cocooned; otherwise sets
  `cocoon_started_at = now` and posts to the public chat: "🥚 Тролль
  сворачивается в кокон и начинает перерождение...".
- `POST /api/cocoon-exit` — no-op if not currently cocooned; otherwise
  clears `cocoon_started_at`, posts "🦋 Тролль вышел из кокона!", and then —
  **only if `has_transformed` is still 0** — applies the one-time upgrade
  (see below) and sets `has_transformed = 1`.

`GET /api/status` gains `cocoon: !!state.cocoon_started_at` and
`maxHealth: state.max_health` in its response.

### Admin panel UI (`public/app.js`)

- A status chip when cocooned: `<div class="chip warn">тролль в коконе</div>`
  (same pattern as the existing `paused` chip).
- A button next to "⏸ Пауза шалостей" in the "Быстрые действия" card:
  `🥚 Кокон` / `🦋 Вывести из кокона` (label swaps like `btn-pause` already
  does), POSTing to `/cocoon-enter` or `/cocoon-exit` and reloading status.

## One-time upgrade on first emergence (`has_transformed` was 0)

Applied inside `POST /api/cocoon-exit`, before setting the flag:

- `max_health = 200`, `health = 200` (fully healed on rebirth).
- Read and double the **current live values** (not just the defaults — the
  admin may have already tuned these) of `health_decay_per_hour`,
  `health_regen_baby`, `health_regen_young`, `health_regen_adult`,
  `health_regen_old` via `getSettingNumber`/`setSetting`, so the 0-200 scale
  drains/fills at the same relative pace as the old 0-100 scale did.
- `stage` is untouched — that stays a fully separate, manually-driven admin
  action, same as today.

### Everywhere the old hardcoded `100` health ceiling needs to become `max_health`

- `backgroundTick`'s hourly tick regen branch (`bot.js:2198`).
- `handleRegenSleepTick`'s per-tick regen (`bot.js:2151`).
- `performKick`'s regen-sleep landed-kick branch (`bot.js:1565`).
- The `/troll` text-fallback line (`bot.js:1455`: `${state.health}/100` →
  `${state.health}/${state.max_health}`).
- `card.js`'s health bar row (`card.js:260`) — takes `data.maxHealth` from
  the `renderTrollCard` call site instead of a literal `100`.
- `admin-server.js`'s `/status` response and `public/app.js`'s status chip
  and stat-grid (`app.js:125,134`) — both display text.
- `public/app.js`'s health bar-fill width (`app.js:135`), which today is
  literally `${data.health}%` (only correct because health and its ceiling
  both happened to be 0-100) — must become
  `${Math.round(100 * data.health / data.maxHealth)}%`.
- `public/app.js`'s `SETTING_RANGES` for the 5 health decay/regen sliders,
  currently `[0, 10, 1]` — widened to `[0, 20, 1]` so the newly-doubled
  defaults (and the live-doubled values after transformation) aren't pinned
  at the slider's ceiling with no headroom.

Decay/regen values that are **not** touched by this design (explicitly out
of scope, confirmed with the user): `regen_sleep_health_threshold` and
`regen_sleep_health_per_tick` stay as-is. This does mean regen sleep now
kicks in at 25% of max health instead of 50% after the upgrade — a tuning
detail the admin can adjust manually via the existing slider later, not
something this feature needs to solve.

## Card caption during cocoon

`/troll`'s image and bars render exactly as they do today (portrait, health/
satiety/mood/attitude) — no layout change, no new art asset (the user will
swap the uploaded portrait image by hand if they want a cocoon-specific
picture, using the existing upload flow). The only addition: when
`cocoon_started_at` is set, `bot.sendPhoto` gets a `caption` with the troll's
**all-time** (`created_at >= born_at`, not scoped to the current stage)
activity totals — reusing the exact category set and `totalFor`/`peopleFor`
grouping logic already built for the stage-change report
(`admin-server.js:59-103`): plays, feeds (+overeats +rejects), kicks, teases,
boobs, snapped-at, woke-troll, mischief-targeted, pee-targets, poop-victims,
teach-count, plus total poop/pee/self-eat counts.

## Explicitly out of scope

- The new "older/hormonal teen" phrase content (~50 lines) — separate spec,
  added directly to an existing stage's categories, not gated behind cocoon
  at all.
- Any change to `stage` as part of cocoon entry/exit.
- Scaling `regen_sleep_health_threshold`/`regen_sleep_health_per_tick`.
- Re-validating/updating `docs/superpowers/plans/2026-07-29-troll-death.md`
  for the new `max_health` column — that plan predates this design and its
  code snippets (and even its exact `old_string` line anchors, since later
  commits already shifted them) will need a re-sync pass before it's
  executed, regardless of this feature. Flagged here, not fixed here.

## Testing

No automated test suite (same as the rest of this bot) — manual verification
via a test chat: toggle cocoon on, confirm every command/button replies with
the frozen line and changes nothing; confirm `/troll` still renders with the
all-time caption; toggle off, confirm the rebirth message, `health`/
`max_health` both at 200, the 5 settings doubled from whatever they were
before, and that toggling cocoon on/off a second time does *not* double
anything again.
