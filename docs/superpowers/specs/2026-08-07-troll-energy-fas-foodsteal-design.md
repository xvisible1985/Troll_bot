# Троллья энергия, чинка "Тролль Фас", замена сосания груди

## Purpose

Three related changes to the troll's own attack behavior, requested together:
a new shared "energy" resource that gates every autonomous attack the troll
throws, a rework of "Тролль Фас" so it reliably lands hits once a minute
until that energy runs out (replacing a per-N-minute timer that was
observed to announce the order but never actually connect), and retiring
the baby-stage "grab a breast and suckle" self-feeding action in favor of a
grown-troll "steal food by force" action (three real swings at a random
player, narrated as a food theft on any hit landing).

## New resource: troll energy

`troll_state` gains three columns, same idiom as every other per-troll
stat/cooldown pair already in the schema:

- `energy INTEGER NOT NULL DEFAULT 20`
- `max_energy INTEGER NOT NULL DEFAULT 20`
- `last_energy_regen_at INTEGER`

New setting `energy_regen_minutes` (default `20`, range `[5,60,5]`) added to
`bot.js` `DEFAULT_SETTINGS`, `admin-lib.js` `DEFAULT_SETTINGS_KEYS`, and
`public/app.js` `SETTING_LABELS`/`SETTING_RANGES`.

Regen happens in `backgroundTick`, mirroring the existing hourly
health-tick block: every `energy_regen_minutes` minutes,
`energy = MIN(max_energy, energy + 1)`. Runs unconditionally (like the
health tick and regen-sleep check), independent of `paused`/`isSilenced` —
this is the troll's own vitality regenerating, not a shalость that can be
paused.

New helper, same shape as the existing player-side `consumeEnergy`:

```js
function spendTrollEnergy() {
  const row = db.prepare(
    'UPDATE troll_state SET energy = energy - 1 WHERE id = 1 AND energy > 0 RETURNING energy'
  ).get();
  return row ? row.energy : null;
}
```

This is a **shared resource across all three autonomous troll attacks** —
`triggerFasAttack`, `triggerDrunkAttack`, and the new `triggerFoodSteal`
each call `spendTrollEnergy()` immediately before every individual swing.
A `null` return means that swing (and, for the 3-swing food-steal sequence,
every remaining swing in the same trigger call) is skipped — same "quietly
fizzles, no message" idiom already used when an autonomous trigger can't
find a target.

The status card (`/troll`) gets a new line showing `⚡ Энергия: N/max` —
otherwise this number is invisible to everyone. Same place other stat
lines live in the card-building function.

## Fix + rework: "Тролль Фас"

Current behavior (`triggerFasAttack`, gated in `backgroundTick` by
`fas_attack_interval_minutes`, default 5) already contains a real
swing/damage/crit sequence, but attacks were observed to silently not
land despite the "не будет покоя" announcement — in practice the trigger
was firing but silently no-opping on some tick precondition. Rather than
chase that specific miss, the interval model itself changes:

- `fas_attack_interval_minutes` setting is deleted (from `bot.js`
  `DEFAULT_SETTINGS`, `admin-lib.js`, and `public/app.js`) and the
  `backgroundTick` gate hardcodes a fixed 60-second cadence instead.
- Each of those per-minute swings now costs 1 troll energy via
  `spendTrollEnergy()` before swinging. If energy is 0, that minute's
  attack is skipped — the order doesn't cancel, it just sits idle until
  either energy regenerates (`energy_regen_minutes` ticks) or the 30-minute
  `troll_fas_until` window itself expires, whichever comes first. No change
  to how the window is started/extended/mama-exempted.
- The order-confirmation message changes from naming the old interval
  setting to: "раз в минуту, пока не кончится энергия тролля".

## Replace: hungry breastfeeding -> food steal

`triggerHungryGrab` (grab-then-suckle from a random recent participant,
restoring satiety only if the second suckle roll also succeeds) is
replaced by `triggerFoodSteal`. Trigger conditions are unchanged: fires
from the same `hunger_action_interval_minutes` cooldown when
`satiety < 30`, falls back to `triggerBegging` when no recent target
exists (identical to today).

New behavior once a target is picked (`pickMischiefTarget()`, same
weighting as today):

- Three swings in a row, each shaped exactly like `triggerFasAttack`'s
  single swing: random weapon + body part, `rollTrollTryResult`, real
  damage via `damageHuman` on a hit, roll >= 90 triggers the same
  crit/injury path. Each swing spends 1 troll energy first; running out
  mid-sequence ends the loop early (fewer than 3 attempts resolve, already-
  landed hits still count).
- If **at least one** of the attempted swings landed, send one more
  message narrating the troll stealing food from the target (new
  stage-aware phrase category `food_steal_action`, `{user}`-templated,
  same pool style as `hunger_grab_action` before it) and restore satiety by
  the renamed setting `satiety_foodsteal_gain` (straight rename of
  `satiety_suckle_gain`, same default value, updated everywhere it's
  referenced: `bot.js`, `admin-lib.js`, `public/app.js`).
- Logged via `logAction(target.userId, ..., 'food_steal')` once per trigger
  call (unconditionally, matching how `fas_attack`/`drunk_attack` log
  regardless of whether the swing landed) — a new line in
  `buildAllTimeStatsCaption` alongside the other counters.

Removed: `hunger_grab_action` and `hunger_suckle_action` phrase categories
and their entries. `triggerBegging`/`hunger_beg` are untouched.

## Testing

No automated test suite. Verify manually against the running troll:

- Set `satiety` below 30 with a recent chat participant present, wait for
  the hunger-action cooldown, and confirm up to 3 damage messages land
  (with a real health before->after change) followed by a food-steal
  narration line and a satiety bump, all only if at least one swing hit.
  Confirm the sequence stops early if `energy` is manually set to 0 or 1
  beforehand.
- Command "Тролль Фас" on someone the troll adores, confirm the new
  wording, and confirm real damage messages appear roughly once a minute
  for as long as `energy` stays above 0 — then manually zero `energy` and
  confirm attacks pause without cancelling the order, resuming after one
  `energy_regen_minutes` tick.
- Confirm `energy` regenerates by 1 every `energy_regen_minutes` and caps
  at `max_energy`, independent of `paused`.
- Confirm the drunk club attack (`triggerDrunkAttack`) also now consumes
  troll energy and pauses the same way when it hits 0.
- Confirm `/troll` shows the new energy line, and `/api/settings` (or the
  admin panel) shows `energy_regen_minutes` and `satiety_foodsteal_gain`
  but no longer shows `fas_attack_interval_minutes`.
