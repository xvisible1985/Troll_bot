# Real Weapons (bat + axe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two named, stealable "real" weapons — a bat (`@Anoki5`, ×1.5 damage) and an axe (`@InternelFun`, ×2.5 damage) — that boost damage and override the cosmetic weapon flavor text wherever a crit (roll ≥90) can currently land, across both `tg-bot`'s `/kick` and `troll-bot`'s `/fight`/autonomous attacks. Any crit against a weapon holder has a 5% chance to transfer the weapon to whoever landed it, human or troll.

**Architecture:** One new table, `weapon_ownership`, lives in tg-bot's `mutes.db` (the DB troll-bot already cross-reads/writes for `user_health`/`injuries` via its `tgBotDb` connection). Both bots create it defensively at startup (same dual-create idiom already used for `troll_smell`/`user_health`) and each keeps its own duplicated copy of a `WEAPON_DEFS` constant (static per-weapon flavor/multiplier) plus three helpers — `getWeaponsFor`, `pickWeaponForAttacker`, `maybeStealWeapon` — the same duplication pattern already used for `getUserHealth`/`applyInjury`/`damageHuman`. `pickWeaponForAttacker` is a drop-in replacement for every existing `pick(FIGHT_WEAPONS)`/`pick(PVP_WEAPONS)` call: it returns a real weapon (text + multiplier) if the attacker holds one, otherwise the existing cosmetic random pick with multiplier 1 — so behavior is unchanged for anyone who never touches a real weapon.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is manual (`node --check` for syntax, `node -e` scripts against isolated in-memory DBs), same as every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-08-07-real-weapons-design.md`

**Sequencing:** Task 1 (tg-bot data model) and Task 2 (troll-bot data model) must land before Tasks 3-8 (the call sites), since every call site uses the helpers those two tasks define. Tasks 3-8 are independent of each other and can land in any order. Task 9 is end-to-end verification after everything else.

---

### Task 1: tg-bot — `weapon_ownership` table, `WEAPON_DEFS`, and the three shared helpers

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:269-280` (schema)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:764-769` (WEAPON_DEFS, right after the existing PvP consts)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:834-847` (helpers, right after `checkPvpCooldown`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1452-1458` (lazy owner-username resolution)

- [x] **Step 1: Add the `weapon_ownership` table + seed rows**

Find (bot.js:269-281):

```js
// Singleton row gating the once-daily 04:00 full health restore (see the
// regen job below) — same CHECK (id = 1) singleton idiom troll-bot uses for
// troll_state, just here so the restore doesn't refire every tick during
// the 04:00 hour.
db.exec(`
  CREATE TABLE IF NOT EXISTS health_regen_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_full_restore_date TEXT
  )
`);
db.prepare('INSERT OR IGNORE INTO health_regen_state (id, last_full_restore_date) VALUES (1, NULL)').run();

// --- Animal definitions ---
```

Replace with:

```js
// Singleton row gating the once-daily 04:00 full health restore (see the
// regen job below) — same CHECK (id = 1) singleton idiom troll-bot uses for
// troll_state, just here so the restore doesn't refire every tick during
// the 04:00 hour.
db.exec(`
  CREATE TABLE IF NOT EXISTS health_regen_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_full_restore_date TEXT
  )
`);
db.prepare('INSERT OR IGNORE INTO health_regen_state (id, last_full_restore_date) VALUES (1, NULL)').run();

// Real, stealable weapons (see WEAPON_DEFS below and
// docs/superpowers/specs/2026-08-07-real-weapons-design.md) — two rows,
// seeded once to their named starting owners by username. owner_user_id
// stays NULL until that username is seen in chat (see the message handler
// below); after that, and after any steal, owner_user_id/owner_username
// are always the live current holder. Same dual-create idiom as
// troll_smell/user_health above — troll-bot creates this table too, so
// deploy order between the two bots doesn't matter.
db.exec(`
  CREATE TABLE IF NOT EXISTS weapon_ownership (
    weapon_key TEXT PRIMARY KEY,
    seed_username TEXT,
    owner_type TEXT NOT NULL DEFAULT 'human',
    owner_user_id INTEGER,
    owner_username TEXT
  )
`);
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'Anoki5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternelFun', 'human', NULL, NULL)").run();

// --- Animal definitions ---
```

- [x] **Step 2: Add the `WEAPON_DEFS` constant**

Find (bot.js:762-769):

```js
const PVP_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const PVP_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
const PVP_INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};
```

Replace with:

```js
const PVP_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const PVP_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
const PVP_INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};

// Static per-weapon flavor/multiplier for the two real, stealable weapons
// (see weapon_ownership above for who currently holds them). Duplicated
// identically in troll-bot's bot.js — same idiom as PVP_WEAPONS/
// FIGHT_WEAPONS already being duplicated per-repo.
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
```

- [x] **Step 3: Add the three shared weapon helpers**

Find (bot.js:834-847):

```js
function checkPvpCooldown(userId) {
  const last = pvpCooldowns.get(userId);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < PVP_COOLDOWN_MS) return Math.ceil((PVP_COOLDOWN_MS - elapsed) / 1000);
  pvpCooldowns.set(userId, Date.now());
  return 0;
}

// Separate cooldown map from pvpCooldowns — /hide gates how often you can
// re-trigger your OWN hiding, not how often you can attack.
const hideCooldowns = new Map();
```

Replace with:

```js
function checkPvpCooldown(userId) {
  const last = pvpCooldowns.get(userId);
  const elapsed = last ? Date.now() - last : Infinity;
  if (elapsed < PVP_COOLDOWN_MS) return Math.ceil((PVP_COOLDOWN_MS - elapsed) / 1000);
  pvpCooldowns.set(userId, Date.now());
  return 0;
}

// Weapon keys currently held by a given owner — 0, 1, or 2 rows (a holder
// can end up with both over time via maybeStealWeapon). ownerUserId is
// ignored for ownerType 'troll' (there's only ever one troll).
function getWeaponsFor(ownerType, ownerUserId) {
  return ownerType === 'troll'
    ? db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll'").all()
    : db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?").all(ownerUserId);
}

// Picks the weapon for one swing: a real one if the attacker holds any
// (random pick if they hold both), otherwise a random cosmetic word from
// fallbackWeapons with multiplier 1 — today's flavor-only behavior,
// unchanged for anyone who's never touched a real weapon. Returns
// { key, text, multiplier } — key is null for the cosmetic fallback.
function pickWeaponForAttacker(ownerType, ownerUserId, fallbackWeapons) {
  const owned = getWeaponsFor(ownerType, ownerUserId);
  if (owned.length > 0) {
    const key = pick(owned.map(row => row.weapon_key));
    const def = WEAPON_DEFS[key];
    return { key, text: def.instrumental, multiplier: def.multiplier };
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}

// 5% chance to steal the target's currently-held real weapon after a crit
// lands on them — call this right after every applyInjury(...) against a
// human. attacker is {type:'human', userId, username, firstName} or
// {type:'troll'}. Returns the stolen weapon_key, or null if nothing was
// stolen (missed the 5% roll, or the target didn't hold a real weapon).
function maybeStealWeapon(targetUserId, attacker) {
  if (Math.random() >= 0.05) return null;
  const row = db.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?").get(targetUserId);
  if (!row) return null;
  if (attacker.type === 'troll') {
    db.prepare("UPDATE weapon_ownership SET owner_type = 'troll', owner_user_id = NULL, owner_username = NULL WHERE weapon_key = ?").run(row.weapon_key);
  } else {
    db.prepare("UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?").run(attacker.userId, attacker.username || attacker.firstName, row.weapon_key);
  }
  return row.weapon_key;
}

// Separate cooldown map from pvpCooldowns — /hide gates how often you can
// re-trigger your OWN hiding, not how often you can attack.
const hideCooldowns = new Map();
```

- [x] **Step 4: Lazily resolve `@Anoki5`/`@InternelFun` to their user id**

Find (bot.js:1452-1458):

```js
bot.on('message', async (msg) => {
  if (msg.from?.is_bot) return;
  // must run first, unconditionally — otherwise muted/fisher/molchun users' messages never enter the recency buffer, breaking cough-targeting later
  const virusNick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const virusPriorRecent = getVirusRecent(msg.chat.id);
  pushVirusRecent(msg.chat.id, { userId: msg.from.id, username: virusNick });
  rememberMessageAuthor(msg.chat.id, msg.message_id, { userId: msg.from.id, username: virusNick, threadId: msg.message_thread_id });
```

Replace with:

```js
bot.on('message', async (msg) => {
  if (msg.from?.is_bot) return;
  // One-time weapon-owner resolution: fires at most once per weapon key —
  // once owner_user_id is non-null this UPDATE touches 0 rows every time
  // after (steals overwrite owner_user_id directly, they don't null it
  // back out). Must run unconditionally, before any early return below, so
  // a muted/fisher/molchun @Anoki5 or @InternelFun still gets linked up.
  if (msg.from.username) {
    db.prepare("UPDATE weapon_ownership SET owner_user_id = ?, owner_username = ? WHERE seed_username = ? AND owner_user_id IS NULL").run(msg.from.id, msg.from.username, msg.from.username);
  }
  // must run first, unconditionally — otherwise muted/fisher/molchun users' messages never enter the recency buffer, breaking cough-targeting later
  const virusNick = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const virusPriorRecent = getVirusRecent(msg.chat.id);
  pushVirusRecent(msg.chat.id, { userId: msg.from.id, username: virusNick });
  rememberMessageAuthor(msg.chat.id, msg.message_id, { userId: msg.from.id, username: virusNick, threadId: msg.message_thread_id });
```

- [x] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 6: Verify the schema and helper logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, seed_username TEXT, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT)\`);
db.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'Anoki5', 'human', NULL, NULL)\").run();
db.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternelFun', 'human', NULL, NULL)\").run();

const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getWeaponsFor(ownerType, ownerUserId) {
  return ownerType === 'troll'
    ? db.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll'\").all()
    : db.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?\").all(ownerUserId);
}
function pickWeaponForAttacker(ownerType, ownerUserId, fallbackWeapons) {
  const owned = getWeaponsFor(ownerType, ownerUserId);
  if (owned.length > 0) {
    const key = pick(owned.map(row => row.weapon_key));
    const def = WEAPON_DEFS[key];
    return { key, text: def.instrumental, multiplier: def.multiplier };
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}
function maybeStealWeapon(targetUserId, attacker) {
  if (Math.random() >= 0.05) return null;
  const row = db.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?\").get(targetUserId);
  if (!row) return null;
  if (attacker.type === 'troll') {
    db.prepare(\"UPDATE weapon_ownership SET owner_type = 'troll', owner_user_id = NULL, owner_username = NULL WHERE weapon_key = ?\").run(row.weapon_key);
  } else {
    db.prepare(\"UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?\").run(attacker.userId, attacker.username || attacker.firstName, row.weapon_key);
  }
  return row.weapon_key;
}

console.log('seed rows:', db.prepare('SELECT * FROM weapon_ownership').all());
console.log('no-weapon fallback:', pickWeaponForAttacker('human', 999, ['палкой']));

db.prepare(\"UPDATE weapon_ownership SET owner_user_id = 111, owner_username = 'InternelFun' WHERE weapon_key = 'axe'\").run();
console.log('real weapon pick:', pickWeaponForAttacker('human', 111, ['палкой']));

const realRandom = Math.random;
Math.random = () => 0.01;
console.log('forced steal human->human:', maybeStealWeapon(111, { type: 'human', userId: 222, username: 'thief' }));
console.log('owner after steal:', db.prepare(\"SELECT * FROM weapon_ownership WHERE weapon_key = 'axe'\").get());
console.log('forced steal human->troll:', maybeStealWeapon(222, { type: 'troll' }));
console.log('owner after troll steal:', db.prepare(\"SELECT * FROM weapon_ownership WHERE weapon_key = 'axe'\").get());
Math.random = () => 0.9;
console.log('missed roll (0.9 >= 0.05):', maybeStealWeapon(999, { type: 'human', userId: 1 }));
Math.random = realRandom;
"
```

Expected:
- `seed rows:` two rows, `bat`/`Anoki5`/`human`/`null`/`null` and `axe`/`InternelFun`/`human`/`null`/`null`.
- `no-weapon fallback:` `{ key: null, text: 'палкой', multiplier: 1 }`
- `real weapon pick:` `{ key: 'axe', text: 'топором', multiplier: 2.5 }`
- `forced steal human->human:` `axe`
- `owner after steal:` `owner_type: 'human', owner_user_id: 222, owner_username: 'thief'`
- `forced steal human->troll:` `axe`
- `owner after troll steal:` `owner_type: 'troll', owner_user_id: null, owner_username: null`
- `missed roll (0.9 >= 0.05):` `null`

- [x] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: add real-weapon ownership table + helpers (bat/axe, steal-ready)"
```

---

### Task 2: troll-bot — mirror the `weapon_ownership` table, `WEAPON_DEFS`, and the three shared helpers

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:63-74` (schema, inside the `tgBotDb` try block)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:74-76` (WEAPON_DEFS, right after the `tgBotDb` try/catch)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:138-151` (helpers, right after `damageHuman`)

- [x] **Step 1: Add the `weapon_ownership` table + seed rows to the `tgBotDb` try block**

Find (bot.js:63-74):

```js
  // Energy: separate resource from health, spent 1-per-swing on /fight and
  // /kick, regenerating 1 per 20 minutes up to max_energy. Added via ALTER
  // (not the CREATE TABLE above) since user_health already existed on
  // deployed installs before this — same idiom as hidden_until in tg-bot.
  for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 10'], ['max_energy', 'INTEGER NOT NULL DEFAULT 10'], ['last_energy_regen_at', 'INTEGER']]) {
    try {
      tgBotDb.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
    } catch {}
  }
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}
```

Replace with:

```js
  // Energy: separate resource from health, spent 1-per-swing on /fight and
  // /kick, regenerating 1 per 20 minutes up to max_energy. Added via ALTER
  // (not the CREATE TABLE above) since user_health already existed on
  // deployed installs before this — same idiom as hidden_until in tg-bot.
  for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 10'], ['max_energy', 'INTEGER NOT NULL DEFAULT 10'], ['last_energy_regen_at', 'INTEGER']]) {
    try {
      tgBotDb.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
    } catch {}
  }
  // Real, stealable weapons (see WEAPON_DEFS below and
  // docs/superpowers/specs/2026-08-07-real-weapons-design.md) — same
  // dual-create idiom as user_health/injuries above, tg-bot creates this
  // table too so deploy order between the two bots doesn't matter.
  // owner_type 'troll' rows have owner_user_id/owner_username NULL — there's
  // only ever one troll, so no id is needed to identify it.
  tgBotDb.exec(`
    CREATE TABLE IF NOT EXISTS weapon_ownership (
      weapon_key TEXT PRIMARY KEY,
      seed_username TEXT,
      owner_type TEXT NOT NULL DEFAULT 'human',
      owner_user_id INTEGER,
      owner_username TEXT
    )
  `);
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'Anoki5', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternelFun', 'human', NULL, NULL)").run();
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}
```

- [x] **Step 2: Add the `WEAPON_DEFS` constant right after the `tgBotDb` setup block**

Find (bot.js — the lines immediately following the block edited in Step 1):

```js
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}

function markSmelly(userId, durationSeconds, reason) {
```

Replace with:

```js
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}

// Static per-weapon flavor/multiplier for the two real, stealable weapons
// (see weapon_ownership above for who currently holds them). Duplicated
// identically in tg-bot's bot.js — same idiom as FIGHT_WEAPONS/PVP_WEAPONS
// already being duplicated per-repo.
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};

function markSmelly(userId, durationSeconds, reason) {
```

- [x] **Step 3: Add the three shared weapon helpers right after `damageHuman`**

Find (bot.js:138-151):

```js
function damageHuman(userId, chatId, username, damage) {
  if (!tgBotDb) return null;
  getUserHealth(userId);
  const row = tgBotDb.prepare('UPDATE user_health SET health = MAX(0, health - ?) WHERE user_id = ? RETURNING health').get(damage, userId);
  if (row.health === 0) {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    tgBotDb.prepare(
      'INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, 0, ?, ?)'
    ).run(userId, chatId, username, 'драка', expiresAt);
  }
  return row.health;
}

let agent;
```

Replace with:

```js
function damageHuman(userId, chatId, username, damage) {
  if (!tgBotDb) return null;
  getUserHealth(userId);
  const row = tgBotDb.prepare('UPDATE user_health SET health = MAX(0, health - ?) WHERE user_id = ? RETURNING health').get(damage, userId);
  if (row.health === 0) {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    tgBotDb.prepare(
      'INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, 0, ?, ?)'
    ).run(userId, chatId, username, 'драка', expiresAt);
  }
  return row.health;
}

// Weapon keys currently held by a given owner — 0, 1, or 2 rows (a holder
// can end up with both over time via maybeStealWeapon). ownerUserId is
// ignored for ownerType 'troll'. Returns [] if tgBotDb is down, same
// fail-safe shape as the other cross-process helpers above.
function getWeaponsFor(ownerType, ownerUserId) {
  if (!tgBotDb) return [];
  return ownerType === 'troll'
    ? tgBotDb.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll'").all()
    : tgBotDb.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?").all(ownerUserId);
}

// Picks the weapon for one swing: a real one if the attacker holds any
// (random pick if they hold both), otherwise a random cosmetic word from
// fallbackWeapons with multiplier 1 — today's flavor-only behavior,
// unchanged for anyone who's never touched a real weapon. Returns
// { key, text, multiplier } — key is null for the cosmetic fallback.
function pickWeaponForAttacker(ownerType, ownerUserId, fallbackWeapons) {
  const owned = getWeaponsFor(ownerType, ownerUserId);
  if (owned.length > 0) {
    const key = pick(owned.map(row => row.weapon_key));
    const def = WEAPON_DEFS[key];
    return { key, text: def.instrumental, multiplier: def.multiplier };
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}

// 5% chance to steal the target's currently-held real weapon after a crit
// lands on them — call this right after every applyInjury(...) against a
// human (four call sites in this file: performFight's troll counter-swing,
// triggerFasAttack, triggerDrunkAttack, triggerFoodSteal). attacker is
// {type:'human', userId, username, firstName} or {type:'troll'} — in this
// file it's always {type:'troll'}, since every crit troll-bot itself
// throws comes from the troll. Returns the stolen weapon_key, or null if
// nothing was stolen (missed the 5% roll, tgBotDb is down, or the target
// didn't hold a real weapon).
function maybeStealWeapon(targetUserId, attacker) {
  if (!tgBotDb) return null;
  if (Math.random() >= 0.05) return null;
  const row = tgBotDb.prepare("SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?").get(targetUserId);
  if (!row) return null;
  if (attacker.type === 'troll') {
    tgBotDb.prepare("UPDATE weapon_ownership SET owner_type = 'troll', owner_user_id = NULL, owner_username = NULL WHERE weapon_key = ?").run(row.weapon_key);
  } else {
    tgBotDb.prepare("UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?").run(attacker.userId, attacker.username || attacker.firstName, row.weapon_key);
  }
  return row.weapon_key;
}

let agent;
```

- [x] **Step 4: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 5: Verify the mirrored schema + logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const tgBotDb = new Database(':memory:');
tgBotDb.exec(\`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, seed_username TEXT, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT)\`);
tgBotDb.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'Anoki5', 'human', NULL, NULL)\").run();
tgBotDb.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternelFun', 'human', NULL, NULL)\").run();

const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getWeaponsFor(ownerType, ownerUserId) {
  if (!tgBotDb) return [];
  return ownerType === 'troll'
    ? tgBotDb.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'troll'\").all()
    : tgBotDb.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?\").all(ownerUserId);
}
function pickWeaponForAttacker(ownerType, ownerUserId, fallbackWeapons) {
  const owned = getWeaponsFor(ownerType, ownerUserId);
  if (owned.length > 0) {
    const key = pick(owned.map(row => row.weapon_key));
    const def = WEAPON_DEFS[key];
    return { key, text: def.instrumental, multiplier: def.multiplier };
  }
  return { key: null, text: pick(fallbackWeapons), multiplier: 1 };
}
function maybeStealWeapon(targetUserId, attacker) {
  if (!tgBotDb) return null;
  if (Math.random() >= 0.05) return null;
  const row = tgBotDb.prepare(\"SELECT weapon_key FROM weapon_ownership WHERE owner_type = 'human' AND owner_user_id = ?\").get(targetUserId);
  if (!row) return null;
  if (attacker.type === 'troll') {
    tgBotDb.prepare(\"UPDATE weapon_ownership SET owner_type = 'troll', owner_user_id = NULL, owner_username = NULL WHERE weapon_key = ?\").run(row.weapon_key);
  } else {
    tgBotDb.prepare(\"UPDATE weapon_ownership SET owner_type = 'human', owner_user_id = ?, owner_username = ? WHERE weapon_key = ?\").run(attacker.userId, attacker.username || attacker.firstName, row.weapon_key);
  }
  return row.weapon_key;
}

console.log('troll starts unarmed:', pickWeaponForAttacker('troll', null, ['дубинкой']));

tgBotDb.prepare(\"UPDATE weapon_ownership SET owner_type = 'troll', owner_user_id = NULL, owner_username = NULL WHERE weapon_key = 'bat'\").run();
console.log('troll now armed with the bat:', pickWeaponForAttacker('troll', null, ['дубинкой']));

const realRandom = Math.random;
Math.random = () => 0.01;
console.log('forced troll->human steal (troll currently has no axe):', maybeStealWeapon(555, { type: 'human', userId: 555, username: 'somebody' }));
Math.random = realRandom;
"
```

Expected:
- `troll starts unarmed:` `{ key: null, text: 'дубинкой', multiplier: 1 }`
- `troll now armed with the bat:` `{ key: 'bat', text: 'битой', multiplier: 1.5 }`
- `forced troll->human steal (troll currently has no axe):` `null` (target user 555 doesn't own the axe, so there's nothing to steal even though the roll would have succeeded)

- [x] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: mirror real-weapon ownership table + helpers into troll-bot"
```

---

### Task 3: tg-bot — wire real weapons into `/kick`, show them on `/me`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:946-978` (`/kick`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:848-869` (`/me`)

- [x] **Step 1: Wire the multiplier, weapon narration, and steal-check into `/kick`**

Find (bot.js:946-978):

```js
  consumeEnergy(msg.from.id);

  const weapon = pick(PVP_WEAPONS);
  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= 50;
  const outcome = success ? '✅ удачно' : '❌ неудачно';
  await bot.sendMessage(
    msg.chat.id,
    `${actorLabel} — ударить ${targetLabel} ${weapon} ${bodyPart} ${outcome}: ${roll}/100`,
    threadOpts(msg)
  ).catch(() => {});
  if (!success) return;

  const targetHealthBefore = getUserHealth(target.id);
  const dmg = Math.floor(Math.random() * 20) + 1;
  const targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
  await bot.sendMessage(
    msg.chat.id,
    `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
    threadOpts(msg)
  ).catch(() => {});

  if (roll >= 90) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
  }
});
```

Replace with:

```js
  consumeEnergy(msg.from.id);

  const weapon = pickWeaponForAttacker('human', msg.from.id, PVP_WEAPONS);
  const bodyPart = pick(PVP_BODY_PARTS);
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= 50;
  const outcome = success ? '✅ удачно' : '❌ неудачно';
  await bot.sendMessage(
    msg.chat.id,
    `${actorLabel} — ударить ${targetLabel} ${weapon.text} ${bodyPart} ${outcome}: ${roll}/100`,
    threadOpts(msg)
  ).catch(() => {});
  if (!success) return;

  const targetHealthBefore = getUserHealth(target.id);
  const rawDmg = Math.floor(Math.random() * 20) + 1;
  const dmg = Math.round(rawDmg * weapon.multiplier);
  const targetHealthAfter = damageHuman(target.id, msg.chat.id, target.username || target.firstName, dmg);
  await bot.sendMessage(
    msg.chat.id,
    `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
    threadOpts(msg)
  ).catch(() => {});

  if (roll >= 90) {
    const injuryType = pick(['arm', 'leg', 'head']);
    const healHours = applyInjury(target.id, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    await bot.sendMessage(
      msg.chat.id,
      `🤕 Критический удар! ${targetLabel} получить травму: ${injuryName} (на ${healHours} ч).`,
      threadOpts(msg)
    ).catch(() => {});
    const stolenKey = maybeStealWeapon(target.id, { type: 'human', userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      await bot.sendMessage(
        msg.chat.id,
        `${stolenDef.emoji} ${actorLabel} отобрал ${stolenDef.accusative} у ${targetLabel} и теперь бьёт ${stolenDef.instrumental} сам!`,
        threadOpts(msg)
      ).catch(() => {});
    }
  }
});
```

- [x] **Step 2: Show held weapons on `/me`**

Find (bot.js:848-869):

```js
bot.onText(/\/me\b/, (msg) => {
  const health = getUserHealth(msg.from.id);
  const lines = [
    `❤️ Твоё здоровье: ${health.health}/${health.max_health}`,
    `⚡ Энергия: ${health.energy}/${health.max_energy}`,
  ];

  const injuryRow = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(msg.from.id);
  if (injuryRow && injuryRow.injured_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM injuries WHERE user_id = ?').run(msg.from.id);
  } else if (injuryRow) {
    const injuryName = injuryRow.injury_type === 'arm' ? 'рука' : injuryRow.injury_type === 'leg' ? 'нога' : 'голова';
    lines.push(`🤕 Травма: ${injuryName} (осталось ${formatExpire(injuryRow.injured_until)})`);
  }

  const healthRow = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (healthRow && healthRow.hidden_until && healthRow.hidden_until * 1000 > Date.now()) {
    lines.push(`🫥 Прячешься от драк (осталось ${formatExpire(healthRow.hidden_until)})`);
  }

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});
```

Replace with:

```js
bot.onText(/\/me\b/, (msg) => {
  const health = getUserHealth(msg.from.id);
  const lines = [
    `❤️ Твоё здоровье: ${health.health}/${health.max_health}`,
    `⚡ Энергия: ${health.energy}/${health.max_energy}`,
  ];

  const injuryRow = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(msg.from.id);
  if (injuryRow && injuryRow.injured_until * 1000 < Date.now()) {
    db.prepare('DELETE FROM injuries WHERE user_id = ?').run(msg.from.id);
  } else if (injuryRow) {
    const injuryName = injuryRow.injury_type === 'arm' ? 'рука' : injuryRow.injury_type === 'leg' ? 'нога' : 'голова';
    lines.push(`🤕 Травма: ${injuryName} (осталось ${formatExpire(injuryRow.injured_until)})`);
  }

  for (const row of getWeaponsFor('human', msg.from.id)) {
    const def = WEAPON_DEFS[row.weapon_key];
    lines.push(`${def.emoji} Ты держишь ${def.name}: урон ×${def.multiplier}`);
  }

  const healthRow = db.prepare('SELECT hidden_until FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (healthRow && healthRow.hidden_until && healthRow.hidden_until * 1000 > Date.now()) {
    lines.push(`🫥 Прячешься от драк (осталось ${formatExpire(healthRow.hidden_until)})`);
  }

  bot.sendMessage(msg.chat.id, lines.join('\n'), threadOpts(msg)).catch(() => {});
});
```

- [x] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: wire real weapons into /kick (damage, narration, steal), show on /me"
```

---

### Task 4: troll-bot — wire real weapons into `/fight` (human swing + troll counter-swing)

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2021-2058` (`performFight`)

- [x] **Step 1: Replace the weapon picks, damage math, and add the steal-check**

Find (bot.js:2021-2058):

```js
  consumeEnergy(from.id);

  let trollHealth = state.health;

  // Human's swing at the troll.
  const humanWeapon = pick(FIGHT_WEAPONS);
  const humanTarget = pick(FIGHT_BODY_PARTS);
  const humanSwing = rollTrollTryResult(`увернуться от удара ${actorName(from)} ${humanWeapon} ${humanTarget}`);
  await bot.sendMessage(chatId, humanSwing.text).catch(() => {});
  if (!humanSwing.success) {
    const dmg = Math.floor(Math.random() * 10) + 1;
    db.prepare('UPDATE troll_state SET health = MAX(0, health - ?) WHERE id = 1').run(dmg);
    trollHealth = db.prepare('SELECT health FROM troll_state WHERE id = 1').get().health;
    await bot.sendMessage(chatId, `💥 Урон троллю: ${dmg} (${state.health} -> ${trollHealth})`).catch(() => {});
  }

  logAction(from.id, from.username || from.first_name, 'fight');

  // Troll doesn't get a counter-swing if the human's hit just knocked it
  // to 0 — nothing left to swing back with.
  if (trollHealth === 0) return;

  // Troll's counter-swing at the human.
  const trollWeapon = pick(FIGHT_WEAPONS);
  const trollTarget = pick(FIGHT_BODY_PARTS);
  const trollSwing = rollTrollTryResult(`ударить ${actorName(from)} ${trollWeapon} ${trollTarget}`);
  await bot.sendMessage(chatId, trollSwing.text).catch(() => {});
  if (trollSwing.success) {
    const dmg = Math.floor(Math.random() * 20) + 1;
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollSwing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(from.id, injuryType);
      await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова'} (на ${healHours} ч).`).catch(() => {});
    }
  }
}
```

Replace with:

```js
  consumeEnergy(from.id);

  let trollHealth = state.health;

  // Human's swing at the troll — a real weapon (if held) both replaces the
  // random flavor word and scales the damage below; falls back to the
  // normal cosmetic FIGHT_WEAPONS pick (multiplier 1) otherwise.
  const humanWeapon = pickWeaponForAttacker('human', from.id, FIGHT_WEAPONS);
  const humanTarget = pick(FIGHT_BODY_PARTS);
  const humanSwing = rollTrollTryResult(`увернуться от удара ${actorName(from)} ${humanWeapon.text} ${humanTarget}`);
  await bot.sendMessage(chatId, humanSwing.text).catch(() => {});
  if (!humanSwing.success) {
    const dmg = Math.round((Math.floor(Math.random() * 10) + 1) * humanWeapon.multiplier);
    db.prepare('UPDATE troll_state SET health = MAX(0, health - ?) WHERE id = 1').run(dmg);
    trollHealth = db.prepare('SELECT health FROM troll_state WHERE id = 1').get().health;
    await bot.sendMessage(chatId, `💥 Урон троллю: ${dmg} (${state.health} -> ${trollHealth})`).catch(() => {});
  }

  logAction(from.id, from.username || from.first_name, 'fight');

  // Troll doesn't get a counter-swing if the human's hit just knocked it
  // to 0 — nothing left to swing back with.
  if (trollHealth === 0) return;

  // Troll's counter-swing at the human — same real-weapon substitution as
  // above, using whatever the troll itself currently holds (see
  // maybeStealWeapon below for how it gets one in the first place).
  const trollWeapon = pickWeaponForAttacker('troll', null, FIGHT_WEAPONS);
  const trollTarget = pick(FIGHT_BODY_PARTS);
  const trollSwing = rollTrollTryResult(`ударить ${actorName(from)} ${trollWeapon.text} ${trollTarget}`);
  await bot.sendMessage(chatId, trollSwing.text).catch(() => {});
  if (trollSwing.success) {
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * trollWeapon.multiplier);
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollSwing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(from.id, injuryType);
      await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова'} (на ${healHours} ч).`).catch(() => {});
      const stolenKey = maybeStealWeapon(from.id, { type: 'troll' });
      if (stolenKey) {
        const stolenDef = WEAPON_DEFS[stolenKey];
        await bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${actorName(from)} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
      }
    }
  }
}
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire real weapons into /fight (human swing + troll counter-swing)"
```

---

### Task 5: troll-bot — wire real weapons into "Тролль Фас"

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2609-2624` (`triggerFasAttack`)

- [x] **Step 1: Replace the weapon pick, damage math, and add the steal-check**

Find (bot.js:2609-2624):

```js
  if (getUserHealth(target.userId).health === 0) return;
  const weapon = pick(FIGHT_WEAPONS);
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} ${weapon} ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.floor(Math.random() * 20) + 1;
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
  }
}
```

Replace with:

```js
  if (getUserHealth(target.userId).health === 0) return;
  const weapon = pickWeaponForAttacker('troll', null, FIGHT_WEAPONS);
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} ${weapon.text} ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire real weapons into \"Тролль Фас\""
```

---

### Task 6: troll-bot — wire real weapons into the drunk club attack

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2545-2559` (`triggerDrunkAttack`)

- [x] **Step 1: Replace the fixed "дубинкой" pick, damage math, and add the steal-check**

Find (bot.js:2545-2559):

```js
  if (getUserHealth(target.userId).health === 0) return;
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} дубинкой ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.floor(Math.random() * 20) + 1;
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
  }
}
```

Replace with:

```js
  if (getUserHealth(target.userId).health === 0) return;
  // Falls back to the club ('дубинкой') if the troll holds no real weapon —
  // same pickWeaponForAttacker used everywhere else, just with a
  // single-item fallback pool instead of FIGHT_WEAPONS.
  const weapon = pickWeaponForAttacker('troll', null, ['дубинкой']);
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} ${weapon.text} ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (swing.roll >= 90) {
    const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
    const healHours = applyInjury(target.userId, injuryType);
    const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
    bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
    if (stolenKey) {
      const stolenDef = WEAPON_DEFS[stolenKey];
      bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
    }
  }
}
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire real weapons into the drunk club attack"
```

---

### Task 7: troll-bot — wire real weapons into food-steal

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2720-2746` (the 3-swing loop inside `triggerFoodSteal`)

- [x] **Step 1: Replace the weapon pick, damage math, and add the steal-check inside the loop**

Find (bot.js:2720-2746):

```js
  let anyHit = false;
  let logged = false;
  for (let i = 0; i < 3; i++) {
    if (spendTrollEnergy() === null) break;
    if (!logged) {
      logAction(target.userId, target.username || target.firstName, 'food_steal');
      db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      logged = true;
    }
    if (getUserHealth(target.userId).health === 0) break;
    const weapon = pick(FIGHT_WEAPONS);
    const bodyPart = pick(FIGHT_BODY_PARTS);
    const swing = rollTrollTryResult(`ударить ${name} ${weapon} ${bodyPart}`);
    await bot.sendMessage(chatId, swing.text).catch(() => {});
    if (!swing.success) continue;
    anyHit = true;
    const dmg = Math.floor(Math.random() * 20) + 1;
    const before = getUserHealth(target.userId);
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
      const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
      await bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
    }
  }
```

Replace with:

```js
  let anyHit = false;
  let logged = false;
  for (let i = 0; i < 3; i++) {
    if (spendTrollEnergy() === null) break;
    if (!logged) {
      logAction(target.userId, target.username || target.firstName, 'food_steal');
      db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      logged = true;
    }
    if (getUserHealth(target.userId).health === 0) break;
    const weapon = pickWeaponForAttacker('troll', null, FIGHT_WEAPONS);
    const bodyPart = pick(FIGHT_BODY_PARTS);
    const swing = rollTrollTryResult(`ударить ${name} ${weapon.text} ${bodyPart}`);
    await bot.sendMessage(chatId, swing.text).catch(() => {});
    if (!swing.success) continue;
    anyHit = true;
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
    const before = getUserHealth(target.userId);
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (swing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      const healHours = applyInjury(target.userId, injuryType);
      const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
      await bot.sendMessage(chatId, `🤕 Критический удар! ${name} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
      const stolenKey = maybeStealWeapon(target.userId, { type: 'troll' });
      if (stolenKey) {
        const stolenDef = WEAPON_DEFS[stolenKey];
        await bot.sendMessage(chatId, `${stolenDef.emoji} Тролль отобрал ${stolenDef.accusative} у ${name} и теперь бьёт ${stolenDef.instrumental} сам!`).catch(() => {});
      }
    }
  }
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire real weapons into food-steal"
```

---

### Task 8: troll-bot — show the troll's held weapon on the `/troll` status card

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1832-1869` (`/troll` handler)

- [x] **Step 1: Build a weapon-lines list and splice it into both the photo caption and the text fallback**

Find (bot.js:1832-1869):

```js
  try {
    const buffer = await renderTrollCard({
      health: state.health,
      maxHealth: state.max_health,
      satiety: state.satiety,
      satietyWord: satietyWord(state.satiety),
      mood: state.mood,
      moodWord: moodWord(state.mood),
      attitude,
      attitudeWord: attitudeWord(attitude),
      stageName: STAGE_NAMES[state.stage],
      weight: state.weight,
      activity,
      lust: state.char_lust,
      sobriety: state.char_sobriety,
    });
    const energyLine = `⚡ Энергия: ${state.energy}/${state.max_energy}`;
    const caption = cocoonCaption ? `${energyLine}\n\n${cocoonCaption}` : energyLine;
    const photoOptions = { ...TROLL_ACTION_KEYBOARD, caption };
    await bot.sendPhoto(msg.chat.id, buffer, photoOptions);
  } catch (err) {
    console.error('troll card render failed, falling back to text:', err.message);
    const lines = [
      `❤️ Здоровье: ${state.health}/${state.max_health}`,
      `🍖 Сытость: ${state.satiety}/100 (${satietyWord(state.satiety)})`,
      `🍺 Трезвость: ${state.char_sobriety}/100`,
      `💋 Похоть: ${state.char_lust}/100`,
      `⚡ Энергия: ${state.energy}/${state.max_energy}`,
      `😊 Настроение: ${moodWord(state.mood)}`,
      `🤝 Отношение к тебе: ${attitudeWord(attitude)} (${attitude > 0 ? '+' : ''}${attitude})`,
      `⚖️ Вес: ${state.weight} кг`,
      `🌱 Стадия: ${STAGE_NAMES[state.stage]}`,
      `🎭 Занятие: ${activity}`,
    ];
    if (cocoonCaption) lines.push('', cocoonCaption);
    bot.sendMessage(msg.chat.id, lines.join('\n'), TROLL_ACTION_KEYBOARD);
  }
});
```

Replace with:

```js
  const weaponLines = getWeaponsFor('troll', null).map(row => {
    const def = WEAPON_DEFS[row.weapon_key];
    return `${def.emoji} Тролль вооружён: ${def.name} (урон ×${def.multiplier})`;
  });

  try {
    const buffer = await renderTrollCard({
      health: state.health,
      maxHealth: state.max_health,
      satiety: state.satiety,
      satietyWord: satietyWord(state.satiety),
      mood: state.mood,
      moodWord: moodWord(state.mood),
      attitude,
      attitudeWord: attitudeWord(attitude),
      stageName: STAGE_NAMES[state.stage],
      weight: state.weight,
      activity,
      lust: state.char_lust,
      sobriety: state.char_sobriety,
    });
    const energyLine = `⚡ Энергия: ${state.energy}/${state.max_energy}`;
    const captionLines = [energyLine, ...weaponLines];
    if (cocoonCaption) captionLines.push('', cocoonCaption);
    const photoOptions = { ...TROLL_ACTION_KEYBOARD, caption: captionLines.join('\n') };
    await bot.sendPhoto(msg.chat.id, buffer, photoOptions);
  } catch (err) {
    console.error('troll card render failed, falling back to text:', err.message);
    const lines = [
      `❤️ Здоровье: ${state.health}/${state.max_health}`,
      `🍖 Сытость: ${state.satiety}/100 (${satietyWord(state.satiety)})`,
      `🍺 Трезвость: ${state.char_sobriety}/100`,
      `💋 Похоть: ${state.char_lust}/100`,
      `⚡ Энергия: ${state.energy}/${state.max_energy}`,
      ...weaponLines,
      `😊 Настроение: ${moodWord(state.mood)}`,
      `🤝 Отношение к тебе: ${attitudeWord(attitude)} (${attitude > 0 ? '+' : ''}${attitude})`,
      `⚖️ Вес: ${state.weight} кг`,
      `🌱 Стадия: ${STAGE_NAMES[state.stage]}`,
      `🎭 Занятие: ${activity}`,
    ];
    if (cocoonCaption) lines.push('', cocoonCaption);
    bot.sendMessage(msg.chat.id, lines.join('\n'), TROLL_ACTION_KEYBOARD);
  }
});
```

- [x] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [x] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: show troll's held weapon on the /troll status card"
```

---

### Task 9: End-to-end manual verification

**Files:** none (verification only, against the running bots — deploy is the user's own GitHub-based flow, not something this session triggers)

- [ ] **Step 1: Confirm the seed rows and lazy resolution on the live `mutes.db`**

```bash
node -e "
const db = require('better-sqlite3')('mutes.db', {readonly: true});
console.log(db.prepare('SELECT * FROM weapon_ownership').all());
"
```

Expected: two rows. `owner_user_id` for each becomes non-null the first time
`@Anoki5`/`@InternelFun` sends any message in the chat after deploy.

- [ ] **Step 2: Confirm `/kick` uses the real weapon and scales damage**

Once `@Anoki5`'s `owner_user_id` is resolved (Step 1), have someone else
`/kick` them repeatedly. Expected: the swing message says "битой" instead
of a random cosmetic word, and on a successful hit the damage number is
1.5× the usual 1-20 roll (rounded).

- [ ] **Step 3: Confirm a crit can steal the weapon, with an announcement**

Keep attacking until a roll ≥90 lands (or temporarily lower the crit
threshold / raise the steal chance in a scratch copy of the file to force
it, then revert). Expected: on the ~1-in-20 crit that also wins the 5% roll,
an extra `🏏 ... отобрал биту у ... и теперь бьёт битой сам!` message appears,
and a follow-up `/me` from the new holder shows `🏏 Ты держишь бита: урон
×1.5`. The old holder's `/me` no longer shows it.

- [ ] **Step 4: Confirm `/fight` applies both directions**

As the axe holder, `/fight` the troll — the human-swing damage-to-troll
line should be 2.5× the usual 1-10 roll. Force (or wait for) a troll crit
back — expected `/troll` now shows `🪓 Тролль вооружён: топор (урон ×2.5)`,
and subsequent Fas/drunk/food-steal attacks all show the axe's damage
scaling and narration too.

- [ ] **Step 5: Confirm settings/display surface correctly end-to-end**

`/me` (tg-bot) and `/troll` (troll-bot) both show the currently-armed
party correctly at every point during the above — nobody armed at the
start, one real human armed after Step 2, the troll armed after Step 4.

- [ ] **Step 6: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here.
If it did, commit those fixes individually with a description of what was
wrong, following the same commit-message style as the tasks above.
