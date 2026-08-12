# Rusty Scissors — bleed + finger-sever design

## Purpose

Add a third real, stealable weapon to the existing real-weapons system
(`docs/superpowers/specs/2026-08-07-real-weapons-design.md`, live in
production): "ржавые ножницы" (rusty scissors), starting with `AliyaKuzAli`,
damage ×1.25. Unlike the bat/axe (pure damage multiplier), scissors carry
two extra effects, both scissors-only — they do **not** generalize to other
weapons or bare-fisted hits:

1. **Bleed:** any successful hit with scissors starts (or refreshes) a
   20-minute bleed on the victim — 1 HP lost per minute, with an automatic
   50/50 roll every 5 minutes to stop it early. Independent of crit.
2. **Finger-sever:** a 5% chance on any successful hit (independent of
   crit, independent of the bleed roll) to sever the victim's finger —
   narrated in chat only, no mechanical effect, no interaction with the
   existing arm/leg/head injury system.

Both apply everywhere the existing weapon system already reaches: tg-bot's
`/kick`, and troll-bot's `performFight` (troll's counter-swing only),
`triggerFasAttack`, `triggerDrunkAttack`, `triggerFoodSteal`, and
`performDrink`'s beatdown branch — the same 6 sites already wired for
weapon-multiplier damage and the existing crit-only weapon-steal.

## Weapon definition

New `WEAPON_DEFS` entry, duplicated in both repos exactly like `bat`/`axe`:

```js
scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' }
```

Seed row (same dual-create idiom as the other two): `('scissors',
'AliyaKuzAli', 'human', NULL, NULL)`. Resolved to `AliyaKuzAli`'s
`user_id` (`6271054637`) the same lazy, one-time way as the existing two
weapons — first message from that exact username fills in `owner_user_id`.

Note: `AliyaKuzAli` is currently troll-bot's `mama_user_id` — troll-bot's
own autonomous attacks (Тролль Фас, drunk club, food-steal) never target
mama, so in practice she'll wield scissors as an attacker (via `/kick`,
`/fight`, or if the troll steals them from her and then she's hit by
someone else), not receive bleed/finger-sever from the troll's unprompted
attacks against herself.

## Bleed: data model and tick

Three new columns on `user_health` (tg-bot's table; troll-bot mirrors via
its existing `tgBotDb` ALTER-loop dual-create idiom, same as `energy`/
`hidden_until` already are):

```sql
ALTER TABLE user_health ADD COLUMN bleed_until INTEGER
ALTER TABLE user_health ADD COLUMN bleed_chat_id INTEGER
ALTER TABLE user_health ADD COLUMN last_bleed_stop_attempt_at INTEGER
```

`bleed_chat_id` exists purely so the periodic tick (below) knows which
chat to announce bleed events in — it's set alongside `bleed_until` at
hit-time, when `chatId` is already in scope at the call site.

**Starting/refreshing a bleed** — one shared helper per repo (tg-bot uses
`db`, troll-bot uses `tgBotDb`, guarded `if (!tgBotDb) return;` like its
siblings):

```js
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}
```

Called unconditionally on any successful scissors hit — a fresh hit while
already bleeding simply resets the 20-minute clock (overwrites
`bleed_until`), matching "the wound reopened," not stacking damage.

**The tick** lives **only in tg-bot** — troll-bot never processes bleed
itself, it only calls `applyBleed` (same as tg-bot) to start/refresh one.
This keeps a single source of truth: whichever human is bleeding, tg-bot's
own `user_health` row and tg-bot's own interval are what actually deduct
HP and roll to stop it, regardless of which bot's attack started it.

New dedicated interval, same idiom as the existing `healthRegenTick`
(`c:\Users\123\Projects\tg-bot\bot.js`, `HEALTH_REGEN_TICK_MS`), but at
1-minute granularity — the existing 10-minute health-regen tick is too
coarse for a 1-HP-per-minute mechanic:

```js
const BLEED_TICK_MS = 60 * 1000;
function bleedTick() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all();
    for (const row of rows) {
      if (row.bleed_until <= now) {
        db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(row.user_id);
        bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение остановилось само.`).catch(() => {});
        continue;
      }
      if (row.health === 0) continue; // already down — no pile-on spam
      const before = row.health;
      const after = damageHuman(row.user_id, row.bleed_chat_id, null, 1);
      bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение: -1 хп (${before} -> ${after})`).catch(() => {});
      if (!row.last_bleed_stop_attempt_at || now - row.last_bleed_stop_attempt_at >= 300) {
        const stopped = Math.random() < 0.5;
        if (stopped) {
          db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL, last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
          bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение остановилось.`).catch(() => {});
        } else {
          db.prepare('UPDATE user_health SET last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
        }
      }
    }
  } catch (err) {
    console.error('bleedTick failed:', err.message);
  }
}
setInterval(bleedTick, BLEED_TICK_MS);
```

(Illustrative — the plan will pin exact line numbers against the real
file. `damageHuman(userId, chatId, username, damage)`'s `username` param
is only used if this exact tick is what brings health to 0, to write the
mute row — `mutes.username` has no `NOT NULL` constraint, so passing
`null` from the tick, where no live `username` is at hand, is safe; it
just means a bleed-triggered knockout's mute row has a blank username
where every other knockout path already had one in scope.)

50% stop chance is a default pick (matching the game's existing 50/50 hit
rolls elsewhere) — not specified by the request, flagged here for the
user's final sign-off during spec review.

## Finger-sever

Purely narrative — no state, no table, no interaction with the existing
`INJURY_TYPES` (arm/leg/head) system. On every successful scissors hit,
independently of the bleed application above:

```js
if (Math.random() < 0.05) {
  bot.sendMessage(chatId, `✂️ ${attackerLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`).catch(() => {});
}
```

Wording/labels adapt per call site the same way the existing steal
announcement already does (`actorLabel`/`targetLabel` in tg-bot's `/kick`,
`Тролль`/`actorName(from)` or `name` in troll-bot's five sites).

## Display

`/me` (tg-bot) gains one more conditional line, alongside the existing
injury/hidden-status lines: if `bleed_until > now`, show `🩸 Истекаешь
кровью: ещё ~N мин` (computed from `bleed_until - now`, rounded up to
whole minutes). No change to troll-bot's `/troll` card — bleeding is a
human status, unrelated to the troll's own state.

## Edge cases

- **Already-downed target:** the four autonomous troll-bot sites
  (Тролль Фас, drunk attack, food-steal, `/drink` beatdown) already skip
  the swing entirely if `getUserHealth(target.userId).health === 0`, so
  bleed/finger-sever code is never reached there against a downed target.
  `/kick` and `/fight` have no such pre-check today (pre-existing,
  out of scope) — hitting an already-downed target there still "succeeds"
  and `damageHuman` just holds at 0 and re-extends the mute, same as it
  already does for every other weapon; `applyBleed` would still be called
  in that case (bleed_until refreshes), but `bleedTick` explicitly skips
  any row where `health === 0` this cycle, so it never chat-spams a
  downed target — the refreshed `bleed_until` just quietly counts down
  unused until the target's health recovers.
- **Weapon changes hands:** the `weapon.key === 'scissors'` check doesn't
  care who's swinging — if the troll steals scissors, its own attacks
  gain bleed/finger-sever the same way bat/axe already gained the damage
  multiplier when stolen. No special-casing needed.
- **Stacks with crit:** a scissors hit that's also a crit (roll ≥90)
  independently triggers the existing arm/leg/head injury and the
  existing 5% weapon-steal roll, on top of bleed (always) and
  finger-sever (5%) — all four are independent checks, can all fire on
  the same swing.
- **Repeat hits while bleeding:** `applyBleed` unconditionally overwrites
  `bleed_until`/`bleed_chat_id` — the clock always restarts fresh from
  the newest hit, never stacks or extends beyond 20 minutes from now.

## Testing

Same manual-verification convention as every other plan in these two
repos — no test framework. `node --check` for syntax, `node -e` scripts
against isolated in-memory DBs for the tick/bleed-helper logic (seed a
row with `bleed_until` in the past → tick clears it and announces;
seed one in the future with `health` at 0 → tick skips it; seed one due
for a stop-roll → force `Math.random` to verify both branches), and a
final manual end-to-end smoke test against the live bots after deploy —
deploy remains the user's own GitHub-based flow.
