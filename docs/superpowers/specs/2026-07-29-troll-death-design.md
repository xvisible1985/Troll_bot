# Troll death — design

## Purpose

Give the troll a real failure state. When `health` reaches 0, the troll falls
unconscious instead of just sitting at a health floor forever. While
unconscious, every normal interaction is disabled and the chat gets a single
"💀 Добить" (finish him off) button, available to anyone. If someone presses
it, the troll dies permanently — same effect as the existing admin-only
`/troll_reset`, just triggered from the chat and narrated publicly. If nobody
presses it, the troll can recover on his own through the same passive health
tick that already exists — no new recovery mechanic.

## Current behavior this builds on

- `troll_state.health` is an 0–100 stat, always written through
  `MAX(0, health - x)` / `MIN(100, health + x)` — it already floors at 0, it
  just currently has no meaning once it gets there.
- An hourly tick in `backgroundTick` (bot.js:2112-2123) either decays health
  (if `satiety < 30`) or regenerates it (stage-based rate:
  `health_regen_baby/young/adult/old`), then decays satiety.
- **Existing gap this design also fixes:** that hourly tick never runs at
  night. `backgroundTick` returns early at the night check (bot.js:2101-2110),
  before it reaches the health tick. Health regen/decay should run every hour
  regardless of whether the troll is asleep — this was already surprising
  before the death mechanic, and would otherwise mean an unconscious troll at
  night never recovers either.
- `regen_sleep` (health < 50 forced nap, its own faster recovery) is a
  separate, pre-existing mechanic and is unaffected by this design except
  that entering unconscious should cancel it if somehow still running.
- `/troll_reset` (admin-only, bot.js:2367-2373) is the existing "kill the
  troll" primitive: `DELETE FROM troll_state`, `DELETE FROM troll_actions`,
  `DELETE FROM troll_learned_phrases`. `troll_relationships`, gifs/stickers,
  and `troll_settings` are untouched. Death reuses this exact reset.

## Data model change

```sql
ALTER TABLE troll_state ADD COLUMN unconscious_since INTEGER; -- NULL = conscious
```

Same pattern as the existing `regen_sleep_started_at` / `silenced_until`
columns — a nullable timestamp doubles as both the flag and "since when".

## State transitions

### Entering unconscious

Checked in the two places that reduce `health`:

- The hourly health-tick decay branch in `backgroundTick`.
- `performKick`'s `-5` health hit.

After either write, re-read `health`. If it is now `0` and
`unconscious_since IS NULL`:

- `UPDATE troll_state SET unconscious_since = ?, regen_sleep_started_at = NULL WHERE id = 1`
  (clears any in-progress regen sleep defensively — see note above; in
  practice the two shouldn't overlap since regen sleep only ever raises
  health).
- Broadcast to the chat: an unconscious announcement plus the kill keyboard
  (see below).

### While unconscious

- `backgroundTick`: skip mischief / hunger-grab / begging / auto-eat / poop /
  pee / regen-sleep-entry for this tick — same early-return shape already
  used for `regen_sleep_started_at`, added alongside it near the top of
  `backgroundTick`. The hourly health tick itself is **not** skipped (see
  the night-tick fix above — same reordering covers both).
- `performPlay` / `performFeed` / `performKick` / `performTease` /
  `performBoobs`: each gets an early check, mirroring the existing
  `regen_sleep_started_at` check in `performKick`. Reply with a single
  shared line (e.g. "Он без сознания, ему уже не помочь так — либо
  ждите, либо добейте.") and do not touch any stats.
- The poop mini-game candidate tracking in the plain `message` handler is
  unaffected either way (it only matters while `poop_game_ends_at` is set,
  which can't happen while unconscious since `triggerPoop` is skipped).

### Recovering (nobody finishes him off)

The hourly health tick (now unconditional — see above) is the only thing
that heals him. When it runs while `unconscious_since IS NOT NULL` and the
regen branch applies (`satiety >= 30`) and pushes `health` above 0:

- `UPDATE troll_state SET unconscious_since = NULL WHERE id = 1`.
- Broadcast a "woke up" message. Normal behavior resumes on the next tick.

If satiety stays below 30, the decay branch keeps firing (a no-op at the 0
floor) and he never recovers on his own — starvation deaths need to be
finished off or wait until someone/something raises satiety, but feeding is
blocked while unconscious, so in practice a starvation-triggered unconscious
troll stays unconscious until killed. This is accepted as-is (see Q&A below).

### Death (kill button pressed)

New `callback_query` branch, `troll_kill`:

- No-op if `unconscious_since IS NULL` (stale button after he already
  recovered or was already killed — Telegram can't retract old inline
  keyboards reliably, so this guard matters).
- Otherwise: same three deletes as `/troll_reset`
  (`troll_state`, `troll_actions`, `troll_learned_phrases`), then announce
  the death publicly, naming whoever pressed the button
  (`actorName(query.from)`).
- Answer the callback query same as all the others.
- Afterwards the chat is in the same state as after `/troll_reset` or before
  the troll ever existed: `/troll_here` (admin-only) is required to bring a
  new troll into the chat.

## Kill button

Reuses the existing inline-keyboard/`callback_query` pattern
(`TROLL_ACTION_KEYBOARD`, bot.js:1397-1411 and the dispatch at bot.js:1790).
The unconscious broadcast message carries its own keyboard:

```js
{
  reply_markup: {
    inline_keyboard: [[{ text: '💀 Добить', callback_data: 'troll_kill' }]],
  },
}
```

No permission check on who can press it — same as every other troll button
today, anyone in the chat can click it.

## Explicitly out of scope

- No admin setting to enable/disable this feature — it always applies once
  health can reach 0, same as every other stat-driven behavior in the bot.
- No new phrase categories in `troll_phrases` for unconscious/wake/death
  lines — these are one-off narrative events, hardcoded strings, same
  precedent as the existing `regen_sleep` messages.
- No changes to `troll_relationships`, gifs/stickers, or `troll_settings` on
  death — matches `/troll_reset`'s existing scope exactly.
- No partial-recovery / mercy-feed mechanic — confirmed with the user that
  the only two ways out of unconscious are the existing passive hourly tick
  or the kill button.

## Testing

No automated test suite exists for this bot (manual/production testing via
the deployed instance). Verification will be manual: drive `health` to 0
via repeated `/kick` in a test chat, confirm the button appears, confirm
other commands are inert while unconscious, confirm pressing the button
resets state and requires `/troll_here`, and confirm a second, separate run
where health is allowed to regen back above 0 without pressing the button.
