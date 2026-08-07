# Real Weapons (bat + axe) — design

## Purpose

Introduce two named, stealable "real" weapons that boost damage, on top of
the existing purely-cosmetic weapon flavor text shared by both bots
(`PVP_WEAPONS` in tg-bot's `/kick`, `FIGHT_WEAPONS` in troll-bot's `/fight`
and the troll's autonomous attacks). `@Anoki5` starts holding a bat (×1.5
damage), `@InternelFun` starts holding an axe (×2.5 damage). Any successful
crit (roll ≥90, the same roll that already triggers `applyInjury`) landed
against a weapon holder has a 5% chance to transfer that weapon to whoever
just landed the crit — human or troll.

## Data model

New table in tg-bot's `mutes.db` (the DB troll-bot already cross-reads/
writes for `user_health`/`injuries` via its `tgBotDb` connection — same
home, same access pattern):

```sql
CREATE TABLE IF NOT EXISTS weapon_ownership (
  weapon_key TEXT PRIMARY KEY,               -- 'bat' | 'axe'
  seed_username TEXT,                        -- original named owner ('Anoki5'/'InternelFun')
  owner_type TEXT NOT NULL DEFAULT 'human',  -- 'human' | 'troll'
  owner_user_id INTEGER,
  owner_username TEXT
)
```

Seeded at startup in both bots via `INSERT OR IGNORE`:
`('bat', 'Anoki5', 'human', NULL, NULL)`, `('axe', 'InternelFun', 'human', NULL, NULL)`.

`owner_user_id` starts `NULL` until the named user is resolved (see below).
After the first resolution, and after any steal, `owner_user_id`/
`owner_username` are always the live current holder — `seed_username` is
never read again after the initial resolution; it's just a breadcrumb of
who the weapon started with.

Static weapon characteristics (display name, grammatical forms, multiplier,
emoji) are **not** in the DB — they're a JS constant duplicated in both
`bot.js` files, the same way `FIGHT_WEAPONS`/`PVP_WEAPONS`/`INJURY_TYPES`
are already duplicated per-repo:

```js
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
```

## Owner resolution (tg-bot only — troll-bot never needs to resolve, only read/write the shared table)

In tg-bot's existing generic `bot.on('message', ...)` handler: if
`msg.from.username` matches some row's `seed_username` and that row's
`owner_user_id` is still `NULL`, backfill `owner_user_id`/`owner_username`
from the message. This fires at most once per weapon (once `owner_user_id`
is non-null, the condition never matches again — steals overwrite the
owner columns directly, they don't null them out first).

## Weapon lookup and swing resolution

New shared helper (duplicated per-repo, same pattern as `getUserHealth`/
`applyInjury`/`damageHuman` already are — troll-bot's copy reads/writes via
`tgBotDb`, tg-bot's copy reads/writes its local `db`):

```js
function getWeaponsFor(ownerType, ownerUserId) {
  return db.prepare(
    ownerType === 'troll'
      ? "SELECT weapon_key FROM weapon_ownership WHERE owner_type='troll'"
      : "SELECT weapon_key FROM weapon_ownership WHERE owner_type='human' AND owner_user_id=?"
  ).all(ownerType === 'human' ? ownerUserId : undefined);
}
```

Before rolling to-hit, the attacker's weapons are looked up. If the list is
non-empty, one is picked at random via the existing `pick()` helper and its
`instrumental` form replaces the random `PVP_WEAPONS`/`FIGHT_WEAPONS` pick
in the swing/dodge narration text. If empty, behavior is unchanged (random
cosmetic weapon, multiplier ×1). A holder of both weapons swings one or the
other at random each time, never both at once.

On a successful hit: `dmg = Math.round(rawDmg * (weapon ? WEAPON_DEFS[weapon].multiplier : 1))`.
The 50/50 hit roll and the ≥90 crit threshold are unaffected by weapon
ownership — the multiplier only scales the final damage number.

## Applies to (5 call sites)

- tg-bot `/kick` — attacker-side human weapon
- troll-bot `/fight` — human's swing at the troll (human weapon) **and**
  the troll's counter-swing (troll weapon)
- troll-bot "Тролль Фас", drunk club attack, food-steal — troll weapon,
  since the troll's weapon boosts every attack it throws, not just `/fight`

## Steal

New shared helper (duplicated per-repo, same read/write split as above):

```js
function maybeStealWeapon(targetUserId, attacker) {
  // attacker: {type:'human', userId, username, firstName} | {type:'troll'}
  if (Math.random() >= 0.05) return null;
  const row = db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type='human' AND owner_user_id=?").get(targetUserId);
  if (!row) return null;
  if (attacker.type === 'troll') {
    db.prepare("UPDATE weapon_ownership SET owner_type='troll', owner_user_id=NULL, owner_username=NULL WHERE weapon_key=?").run(row.weapon_key);
  } else {
    db.prepare("UPDATE weapon_ownership SET owner_type='human', owner_user_id=?, owner_username=? WHERE weapon_key=?").run(attacker.userId, attacker.username || attacker.firstName, row.weapon_key);
  }
  return row.weapon_key;
}
```

Called immediately after every existing `applyInjury(...)` call against a
human (there are 5: `/kick`, `/fight`'s troll counter-swing, "Тролль Фас",
drunk club attack, food-steal). On a non-null return, an extra chat message
narrates the transfer using `WEAPON_DEFS[key]`:
`{emoji} {атакующий} отобрал {accusative} у {цель} и теперь бьёт им сам!`
(troll-as-attacker: `"Тролль отобрал ..."`). No gendered verb forms — always
"отобрал", a neutral default.

## Display

- tg-bot `/me`: if `getWeaponsFor('human', userId)` is non-empty, one line
  per held weapon: `{emoji} Ты держишь {name}: урон ×{multiplier}`.
- troll-bot `/troll` status card (photo caption + text fallback): if the
  troll holds ≥1 weapon, one line per weapon:
  `{emoji} Тролль вооружён: {name} (урон ×{multiplier})`.

## Edge cases

- No race conditions: `better-sqlite3` is synchronous and Node is
  single-threaded, so there's no window for two crits to resolve a steal
  concurrently.
- Target has no weapon: `maybeStealWeapon` returns `null` immediately after
  the `SELECT`, nothing else changes — existing crit/injury message is
  unaffected.
- A holder (human or troll) can end up owning both weapons simultaneously
  (steal both from two different victims over time) — each swing picks one
  at random, as above.
- `seed_username` is dead weight after the first resolution — never read
  again, including across steals.
- Weapon ownership is independent of health/mute state — a steal still
  applies even if the same hit that landed the crit also reduces the
  target's health to 0 and mutes them.

## Testing

No test framework in either repo (consistent with every other plan here).
Verification is manual:
- `node --check` on both `bot.js` files.
- `node -e` scripts against a scratch copy of `weapon_ownership` to verify
  seeding, lazy username resolution, the multiplier math, and steal
  ownership transfer (both human→human and human→troll) in isolation.
- Manual smoke test against the live bots after deploy (deploy is handled
  by the user via GitHub, same as every other feature in this repo) —
  `/kick`, `/fight`, and forcing a crit (by repeatedly attacking, or via a
  temporary `db.prepare(...)` roll override) to confirm steal + narration
  + `/me`/`/troll` display all fire correctly.
