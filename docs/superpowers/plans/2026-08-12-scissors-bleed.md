# Rusty Scissors (Bleed + Finger-Sever) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third real, stealable weapon — "ржавые ножницы" (rusty scissors, ×1.25 damage, starting owner `AliyaKuzAli`) — to the already-live real-weapons system, with two scissors-only extra effects on any successful hit: a 20-minute bleed (1 HP/min, 5-minute 50/50 roll to stop early) and a 5% chance to narrate a severed finger.

**Architecture:** Scissors reuse every piece of the existing bat/axe infrastructure (`WEAPON_DEFS`, `pickWeaponForAttacker`, `maybeStealWeapon`, the seed/lazy-resolution mechanism) unchanged — this plan only adds a `scissors` entry and seed row, plus a new `applyBleed(userId, chatId)` helper (duplicated per-repo like the other weapon helpers) and a new scissors-only conditional block at each of the 6 existing weapon call sites. The actual bleed processing — 1 HP/minute, the 5-minute stop-roll, natural expiry — runs in exactly one place: a new dedicated `bleedTick` interval in **tg-bot only** (troll-bot never ticks bleed itself, it only starts/refreshes one via `applyBleed` over its existing `tgBotDb` connection, same as every other cross-process write in that file).

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is manual (`node --check` for syntax, `node -e` scripts against isolated in-memory DBs), same as every other plan in these two repos.

**Spec:** `docs/superpowers/specs/2026-08-12-scissors-bleed-design.md`

**Sequencing:** Tasks 1-2 (data model in each repo) must land before Tasks 3-9 (the 6 call-site wirings + `/me` display), since every later task calls `applyBleed`/checks `weapon.key === 'scissors'`. Tasks 3-9 are otherwise independent of each other. Task 10 is manual verification after everything else.

---

### Task 1: tg-bot — scissors weapon definition, bleed columns, `applyBleed` helper

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:253-257` (bleed columns via ALTER)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:281-299` (scissors seed row)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:790-797` (`WEAPON_DEFS.scissors`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:895-911` (`applyBleed` helper, right after `maybeStealWeapon`)

- [ ] **Step 1: Add the three bleed columns to `user_health`**

Find (bot.js:249-258):

```js
// Energy: separate resource from health, spent 1-per-swing on /kick (and
// troll-bot's /fight, via its own cross-process connection to this same
// table), regenerating 1 per 20 minutes up to max_energy. Same
// ALTER-since-table-already-existed idiom as hidden_until above.
for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 10'], ['max_energy', 'INTEGER NOT NULL DEFAULT 10'], ['last_energy_regen_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Critical-hit injuries from "Драка" (see troll-bot) — one of 'arm' | 'leg'
```

Replace with:

```js
// Energy: separate resource from health, spent 1-per-swing on /kick (and
// troll-bot's /fight, via its own cross-process connection to this same
// table), regenerating 1 per 20 minutes up to max_energy. Same
// ALTER-since-table-already-existed idiom as hidden_until above.
for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 10'], ['max_energy', 'INTEGER NOT NULL DEFAULT 10'], ['last_energy_regen_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Bleed, from the rusty scissors real weapon (see WEAPON_DEFS.scissors and
// applyBleed below) — bleed_until is when it naturally ends, bleed_chat_id
// is where the dedicated bleedTick (see far below) announces ticks/stops
// for this user, last_bleed_stop_attempt_at gates the 5-minute 50/50 roll
// to end it early. Same ALTER idiom as energy/hidden_until above.
for (const [column, def] of [['bleed_until', 'INTEGER'], ['bleed_chat_id', 'INTEGER'], ['last_bleed_stop_attempt_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
  } catch {}
}
// Critical-hit injuries from "Драка" (see troll-bot) — one of 'arm' | 'leg'
```

- [ ] **Step 2: Add the scissors seed row**

Find (bot.js:281-299):

```js
// Real, stealable weapons (see WEAPON_DEFS below and, in the sibling
// troll-bot repo, docs/superpowers/specs/2026-08-07-real-weapons-design.md)
// — two rows, seeded once to their named starting owners by username. owner_user_id
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
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
```

Replace with:

```js
// Real, stealable weapons (see WEAPON_DEFS below and, in the sibling
// troll-bot repo, docs/superpowers/specs/2026-08-07-real-weapons-design.md)
// — three rows, seeded once to their named starting owners by username. owner_user_id
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
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
db.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
```

- [ ] **Step 3: Add the `WEAPON_DEFS.scissors` entry**

Find (bot.js:790-797):

```js
// Static per-weapon flavor/multiplier for the two real, stealable weapons
// (see weapon_ownership above for who currently holds them). Duplicated
// identically in troll-bot's bot.js — same idiom as PVP_WEAPONS/
// FIGHT_WEAPONS already being duplicated per-repo.
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
```

Replace with:

```js
// Static per-weapon flavor/multiplier for the three real, stealable
// weapons (see weapon_ownership above for who currently holds them).
// Duplicated identically in troll-bot's bot.js — same idiom as
// PVP_WEAPONS/FIGHT_WEAPONS already being duplicated per-repo. Scissors
// alone also cause bleed + a chance of a severed finger — see applyBleed
// below and every call site's `weapon.key === 'scissors'` check (see
// docs/superpowers/specs/2026-08-12-scissors-bleed-design.md).
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
};
```

- [ ] **Step 4: Add the `applyBleed` helper right after `maybeStealWeapon`**

Find (bot.js:900-911):

```js
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

Replace with:

```js
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

// Starts (or refreshes) a 20-minute bleed on a scissors hit — see the
// dedicated bleedTick further below for how it's actually processed (1
// HP/min, 5-min 50/50 stop-roll, natural expiry). Always overwrites
// bleed_until on every call, so a fresh scissors hit while already
// bleeding just resets the clock rather than stacking. bleed_chat_id is
// stored purely so bleedTick knows where to announce ticks/stops for this
// user.
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

// Separate cooldown map from pvpCooldowns — /hide gates how often you can
// re-trigger your OWN hiding, not how often you can attack.
const hideCooldowns = new Map();
```

- [ ] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Verify the schema and `applyBleed` in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, seed_username TEXT, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT)\`);
db.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100, bleed_until INTEGER, bleed_chat_id INTEGER, last_bleed_stop_attempt_at INTEGER)\`);
db.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)\").run();

const WEAPON_DEFS = {
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
};
function applyBleed(userId, chatId) {
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  db.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

console.log('seed row:', db.prepare('SELECT * FROM weapon_ownership').all());
console.log('scissors def:', WEAPON_DEFS.scissors);

db.prepare('INSERT INTO user_health (user_id, health) VALUES (42, 100)').run();
applyBleed(42, 555);
console.log('after applyBleed:', db.prepare('SELECT bleed_until, bleed_chat_id FROM user_health WHERE user_id = 42').get());
const now = Math.floor(Date.now()/1000);
console.log('bleed_until is ~20min from now:', db.prepare('SELECT bleed_until FROM user_health WHERE user_id = 42').get().bleed_until - now);

// Refresh: calling it again while already bleeding just resets the clock.
applyBleed(42, 555);
console.log('after second applyBleed (still ~20min out, not stacked):', db.prepare('SELECT bleed_until FROM user_health WHERE user_id = 42').get().bleed_until - now);
"
```

Expected:
- `seed row:` one row, `scissors`/`AliyaKuzAli`/`human`/`null`/`null`.
- `scissors def:` `{ name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' }`
- `after applyBleed:` `{ bleed_until: <timestamp>, bleed_chat_id: 555 }`
- `bleed_until is ~20min from now:` a number very close to `1200` (20*60)
- `after second applyBleed (still ~20min out, not stacked):` also very close to `1200`, not `2400`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: add rusty scissors weapon + bleed data model (AliyaKuzAli)"
```

---

### Task 2: troll-bot — mirror scissors weapon, bleed columns, `applyBleed`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:63-71` (bleed columns via `tgBotDb` ALTER)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:72-88` (scissors seed row)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:93-100` (`WEAPON_DEFS.scissors`)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:213-225` (`applyBleed` helper, right after `maybeStealWeapon`)

- [ ] **Step 1: Add the three bleed columns to `user_health` via `tgBotDb`**

Find (bot.js:63-72):

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
  // Real, stealable weapons (see WEAPON_DEFS below and, in this same repo,
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
  // Bleed, from the rusty scissors real weapon (see WEAPON_DEFS.scissors
  // and applyBleed below) — bleed_until is when it naturally ends,
  // bleed_chat_id is where tg-bot's own dedicated bleedTick announces
  // ticks/stops for this user (troll-bot never ticks bleed itself, only
  // starts/refreshes it here), last_bleed_stop_attempt_at gates the
  // 5-minute 50/50 roll to end it early. Same ALTER idiom as energy above.
  for (const [column, def] of [['bleed_until', 'INTEGER'], ['bleed_chat_id', 'INTEGER'], ['last_bleed_stop_attempt_at', 'INTEGER']]) {
    try {
      tgBotDb.exec(`ALTER TABLE user_health ADD COLUMN ${column} ${def}`);
    } catch {}
  }
  // Real, stealable weapons (see WEAPON_DEFS below and, in this same repo,
```

- [ ] **Step 2: Add the scissors seed row**

Find (bot.js:72-88, note these line numbers now shift by +7 after Step 1 — match by content):

```js
  // Real, stealable weapons (see WEAPON_DEFS below and, in this same repo,
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
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
```

Replace with:

```js
  // Real, stealable weapons (see WEAPON_DEFS below and, in this same repo,
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
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('bat', 'ANOKI5', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('axe', 'InternalFun', 'human', NULL, NULL)").run();
  tgBotDb.prepare("INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)").run();
```

- [ ] **Step 3: Add the `WEAPON_DEFS.scissors` entry**

Find (bot.js:93-100):

```js
// Static per-weapon flavor/multiplier for the two real, stealable weapons
// (see weapon_ownership above for who currently holds them). Duplicated
// identically in tg-bot's bot.js — same idiom as FIGHT_WEAPONS/PVP_WEAPONS
// already being duplicated per-repo.
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
};
```

Replace with:

```js
// Static per-weapon flavor/multiplier for the three real, stealable
// weapons (see weapon_ownership above for who currently holds them).
// Duplicated identically in tg-bot's bot.js — same idiom as
// FIGHT_WEAPONS/PVP_WEAPONS already being duplicated per-repo. Scissors
// alone also cause bleed + a chance of a severed finger — see applyBleed
// below and every call site's `weapon.key === 'scissors'` check (see
// docs/superpowers/specs/2026-08-12-scissors-bleed-design.md).
const WEAPON_DEFS = {
  bat: { name: 'бита', instrumental: 'битой', accusative: 'биту', multiplier: 1.5, emoji: '🏏' },
  axe: { name: 'топор', instrumental: 'топором', accusative: 'топор', multiplier: 2.5, emoji: '🪓' },
  scissors: { name: 'ножницы', instrumental: 'ножницами', accusative: 'ножницы', multiplier: 1.25, emoji: '✂️' },
};
```

- [ ] **Step 4: Add the `applyBleed` helper right after `maybeStealWeapon`**

Find (bot.js:213-226):

```js
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

Replace with:

```js
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

// Starts (or refreshes) a 20-minute bleed on a scissors hit — processed
// entirely by tg-bot's own dedicated bleedTick (troll-bot never ticks
// bleed itself, only starts/refreshes it here via tgBotDb, same as every
// other cross-process write in this file). Always overwrites bleed_until
// on every call, so a fresh scissors hit while already bleeding just
// resets the clock rather than stacking.
function applyBleed(userId, chatId) {
  if (!tgBotDb) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  tgBotDb.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

let agent;
```

- [ ] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Verify the mirrored schema + `applyBleed` in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const tgBotDb = new Database(':memory:');
tgBotDb.exec(\`CREATE TABLE weapon_ownership (weapon_key TEXT PRIMARY KEY, seed_username TEXT, owner_type TEXT NOT NULL DEFAULT 'human', owner_user_id INTEGER, owner_username TEXT)\`);
tgBotDb.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, bleed_until INTEGER, bleed_chat_id INTEGER, last_bleed_stop_attempt_at INTEGER)\`);
tgBotDb.prepare(\"INSERT OR IGNORE INTO weapon_ownership (weapon_key, seed_username, owner_type, owner_user_id, owner_username) VALUES ('scissors', 'AliyaKuzAli', 'human', NULL, NULL)\").run();

function applyBleed(userId, chatId) {
  if (!tgBotDb) return;
  const until = Math.floor(Date.now() / 1000) + 20 * 60;
  tgBotDb.prepare('UPDATE user_health SET bleed_until = ?, bleed_chat_id = ? WHERE user_id = ?').run(until, chatId, userId);
}

console.log('seed row:', tgBotDb.prepare('SELECT * FROM weapon_ownership').all());
tgBotDb.prepare('INSERT INTO user_health (user_id, health) VALUES (42, 100)').run();
applyBleed(42, 555);
console.log('after applyBleed via tgBotDb:', tgBotDb.prepare('SELECT bleed_until, bleed_chat_id FROM user_health WHERE user_id = 42').get());
"
```

Expected:
- `seed row:` one row, `scissors`/`AliyaKuzAli`/`human`/`null`/`null`.
- `after applyBleed via tgBotDb:` `{ bleed_until: <timestamp ~20min out>, bleed_chat_id: 555 }`

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat: mirror rusty scissors weapon + bleed data model into troll-bot"
```

---

### Task 3: tg-bot — wire scissors into `/kick`

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1039-1045` (`/kick`, right after the damage message)

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find:

```js
  await bot.sendMessage(
    msg.chat.id,
    `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
    threadOpts(msg)
  ).catch(() => {});

  if (roll >= 90) {
```

Replace with:

```js
  await bot.sendMessage(
    msg.chat.id,
    `💥 Урон ${targetLabel}: ${dmg} (${targetHealthBefore.health} -> ${targetHealthAfter})`,
    threadOpts(msg)
  ).catch(() => {});

  if (weapon.key === 'scissors') {
    applyBleed(target.id, msg.chat.id);
    await bot.sendMessage(msg.chat.id, `🩸 ${targetLabel} начинает истекать кровью от ржавых ножниц!`, threadOpts(msg)).catch(() => {});
    if (Math.random() < 0.05) {
      await bot.sendMessage(msg.chat.id, `✂️ ${actorLabel} случайно отчекрыжил ${targetLabel} палец ржавыми ножницами!`, threadOpts(msg)).catch(() => {});
    }
  }

  if (roll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into /kick"
```

---

### Task 4: tg-bot — `bleedTick` interval + `/me` display

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:2032-2034` (new `bleedTick`, right after `healthRegenTick`'s `setInterval`)
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:918-944` (`/me`, add bleed status line)

- [ ] **Step 1: Add the `bleedTick` interval**

Find:

```js
setInterval(healthRegenTick, HEALTH_REGEN_TICK_MS);

console.log('Бот запущен...');
```

Replace with:

```js
setInterval(healthRegenTick, HEALTH_REGEN_TICK_MS);

// Bleed tick (see applyBleed and every `weapon.key === 'scissors'` call
// site) — 1-minute granularity because the mechanic itself is 1 HP/minute,
// much finer than healthRegenTick's 10-minute cadence, so it needs its own
// interval rather than piggybacking on that one. Every user currently
// bleeding, every minute: if the 20-minute window already elapsed, clear
// it and announce a natural stop; else if they're already at 0 health,
// skip entirely (no point re-spamming a downed target); else deduct 1 HP
// via damageHuman (which already handles the 0-health-mutes floor for
// free) and announce it, then — at most once per 5 minutes, tracked via
// last_bleed_stop_attempt_at — roll a 50/50 to end the bleed early.
const BLEED_TICK_MS = 60 * 1000;
function bleedTick() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all();
    for (const row of rows) {
      if (row.bleed_until <= now) {
        db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(row.user_id);
        bot.sendMessage(row.bleed_chat_id, '🩸 Кровотечение остановилось само.').catch(() => {});
        continue;
      }
      if (row.health === 0) continue;
      const before = row.health;
      const after = damageHuman(row.user_id, row.bleed_chat_id, null, 1);
      bot.sendMessage(row.bleed_chat_id, `🩸 Кровотечение: -1 хп (${before} -> ${after})`).catch(() => {});
      if (!row.last_bleed_stop_attempt_at || now - row.last_bleed_stop_attempt_at >= 300) {
        if (Math.random() < 0.5) {
          db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL, last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
          bot.sendMessage(row.bleed_chat_id, '🩸 Кровотечение остановилось.').catch(() => {});
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

console.log('Бот запущен...');
```

- [ ] **Step 2: Show active bleed on `/me`**

Find (bot.js:918-944):

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

  const bleedRow = db.prepare('SELECT bleed_until FROM user_health WHERE user_id = ?').get(msg.from.id);
  if (bleedRow && bleedRow.bleed_until && bleedRow.bleed_until * 1000 > Date.now()) {
    const minutesLeft = Math.ceil((bleedRow.bleed_until - Math.floor(Date.now() / 1000)) / 60);
    lines.push(`🩸 Истекаешь кровью: ещё ~${minutesLeft} мин`);
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

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify `bleedTick`'s logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100, bleed_until INTEGER, bleed_chat_id INTEGER, last_bleed_stop_attempt_at INTEGER)\`);
db.exec(\`CREATE TABLE mutes (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, username TEXT, muted_by INTEGER, muted_by_name TEXT, expires_at INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')))\`);

function damageHuman(userId, chatId, username, damage) {
  db.prepare('INSERT OR IGNORE INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  const row = db.prepare('UPDATE user_health SET health = MAX(0, health - ?) WHERE user_id = ? RETURNING health').get(damage, userId);
  if (row.health === 0) {
    const expiresAt = Math.floor(Date.now()/1000) + 30*60;
    db.prepare('INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, 0, ?, ?)').run(userId, chatId, username, 'драка', expiresAt);
  }
  return row.health;
}

const now = Math.floor(Date.now()/1000);
db.prepare('INSERT INTO user_health (user_id, health, bleed_until, bleed_chat_id) VALUES (1, 50, ?, 999)').run(now - 10);
db.prepare('INSERT INTO user_health (user_id, health, bleed_until, bleed_chat_id) VALUES (2, 50, ?, 999)').run(now + 600);
db.prepare('INSERT INTO user_health (user_id, health, bleed_until, bleed_chat_id) VALUES (3, 0, ?, 999)').run(now + 600);

function bleedTickOnce() {
  const rows = db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all();
  const events = [];
  for (const row of rows) {
    if (row.bleed_until <= now) {
      db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL WHERE user_id = ?').run(row.user_id);
      events.push({user: row.user_id, event: 'natural_stop'});
      continue;
    }
    if (row.health === 0) { events.push({user: row.user_id, event: 'skipped_downed'}); continue; }
    const before = row.health;
    const after = damageHuman(row.user_id, row.bleed_chat_id, null, 1);
    events.push({user: row.user_id, event: 'tick', before, after});
    if (!row.last_bleed_stop_attempt_at || now - row.last_bleed_stop_attempt_at >= 300) {
      if (Math.random() < 0.5) {
        db.prepare('UPDATE user_health SET bleed_until = NULL, bleed_chat_id = NULL, last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
        events.push({user: row.user_id, event: 'stop_roll_success'});
      } else {
        db.prepare('UPDATE user_health SET last_bleed_stop_attempt_at = ? WHERE user_id = ?').run(now, row.user_id);
        events.push({user: row.user_id, event: 'stop_roll_fail'});
      }
    }
  }
  return events;
}

const realRandom = Math.random;
Math.random = () => 0.9;
console.log(JSON.stringify(bleedTickOnce()));
console.log('user1 (expired, was untouched by damage):', db.prepare('SELECT bleed_until, health FROM user_health WHERE user_id=1').get());
console.log('user2 (ticked, stop-roll failed since forced 0.9 >= 0.5):', db.prepare('SELECT bleed_until, health, last_bleed_stop_attempt_at FROM user_health WHERE user_id=2').get());
console.log('user3 (skipped, still 0 health, bleed_until untouched):', db.prepare('SELECT bleed_until, health FROM user_health WHERE user_id=3').get());
Math.random = realRandom;
"
```

Expected:
- Events JSON: `[{\"user\":1,\"event\":\"natural_stop\"},{\"user\":2,\"event\":\"tick\",\"before\":50,\"after\":49},{\"user\":2,\"event\":\"stop_roll_fail\"},{\"user\":3,\"event\":\"skipped_downed\"}]`
- `user1 ...:` `{ bleed_until: null, health: 50 }`
- `user2 ...:` `{ bleed_until: <still ~10min out>, health: 49, last_bleed_stop_attempt_at: <now> }`
- `user3 ...:` `{ bleed_until: <still ~10min out>, health: 0 }`

(NOTE for the implementer: the controller already hand-ran this exact script — plus a second one forcing `Math.random` low to confirm the stop-roll-success branch clears `bleed_until`/`bleed_chat_id` and sets `last_bleed_stop_attempt_at` — against a real repo, and both matched expected output exactly. If your run doesn't match, the bug is almost certainly in how `bleedTick` itself was written in Step 1, not in this script.)

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add bleedTick + show active bleed on /me"
```

---

### Task 5: troll-bot — wire scissors into `performFight`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2136-2138` (troll's counter-swing branch only)

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find:

```js
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollSwing.roll >= 90) {
```

Replace with:

```js
    const humanHealth = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${challengerHealth.health} -> ${humanHealth})`).catch(() => {});
    if (trollWeapon.key === 'scissors') {
      applyBleed(from.id, chatId);
      await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
      }
    }
    if (trollSwing.roll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into /fight"
```

---

### Task 6: troll-bot — wire scissors into `triggerFasAttack`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2717-2726`

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find (note this exact text, up to and including the `pickWeaponForAttacker` call with `FIGHT_WEAPONS`, is what disambiguates this from the near-identical block in `triggerDrunkAttack` below — match on the full snippet, not just the last 3 lines):

```js
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
```

Replace with:

```js
  const weapon = pickWeaponForAttacker('troll', null, FIGHT_WEAPONS);
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} ${weapon.text} ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (swing.roll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into \"Тролль Фас\""
```

---

### Task 7: troll-bot — wire scissors into `triggerDrunkAttack`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2647-2656`

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find (the `pickWeaponForAttacker(..., ['дубинкой'])` fallback — not `FIGHT_WEAPONS` — is what disambiguates this from `triggerFasAttack`'s otherwise-identical block above):

```js
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
```

Replace with:

```js
  const weapon = pickWeaponForAttacker('troll', null, ['дубинкой']);
  const bodyPart = pick(FIGHT_BODY_PARTS);
  const swing = rollTrollTryResult(`ударить ${name} ${weapon.text} ${bodyPart}`);
  bot.sendMessage(chatId, swing.text).catch(() => {});
  if (!swing.success) return;
  const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
  const before = getUserHealth(target.userId);
  const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
  bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
  if (weapon.key === 'scissors') {
    applyBleed(target.userId, chatId);
    bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
    if (Math.random() < 0.05) {
      bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
    }
  }
  if (swing.roll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into the drunk club attack"
```

---

### Task 8: troll-bot — wire scissors into `triggerFoodSteal`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2852-2856` (inside the 3-swing loop)

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find:

```js
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
    const before = getUserHealth(target.userId);
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (swing.roll >= 90) {
```

Replace with:

```js
    const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
    const before = getUserHealth(target.userId);
    const after = damageHuman(target.userId, chatId, target.username || target.firstName, dmg);
    await bot.sendMessage(chatId, `💥 Урон ${name}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
    if (weapon.key === 'scissors') {
      applyBleed(target.userId, chatId);
      await bot.sendMessage(chatId, `🩸 ${name} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
      if (Math.random() < 0.05) {
        await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${name} палец ржавыми ножницами!`).catch(() => {});
      }
    }
    if (swing.roll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into food-steal"
```

---

### Task 9: troll-bot — wire scissors into `performDrink`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2330-2334` (inside the beatdown branch's 3-swing loop)

- [ ] **Step 1: Insert the bleed + finger-sever block between the damage message and the crit check**

Find:

```js
      const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
      const before = getUserHealth(from.id);
      const after = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
      await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
      if (critRoll >= 90) {
```

Replace with:

```js
      const dmg = Math.round((Math.floor(Math.random() * 20) + 1) * weapon.multiplier);
      const before = getUserHealth(from.id);
      const after = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
      await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
      if (weapon.key === 'scissors') {
        applyBleed(from.id, chatId);
        await bot.sendMessage(chatId, `🩸 ${actorName(from)} начинает истекать кровью от ржавых ножниц!`).catch(() => {});
        if (Math.random() < 0.05) {
          await bot.sendMessage(chatId, `✂️ Тролль случайно отчекрыжил ${actorName(from)} палец ржавыми ножницами!`).catch(() => {});
        }
      }
      if (critRoll >= 90) {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: wire rusty scissors bleed/finger-sever into performDrink's beatdown branch"
```

---

### Task 10: End-to-end manual verification

**Files:** none (verification only, against the running bots — deploy is the user's own GitHub-based flow)

- [ ] **Step 1: Confirm the seed row and lazy resolution**

```bash
node -e "
const db = require('better-sqlite3')('mutes.db', {readonly: true});
console.log(db.prepare('SELECT * FROM weapon_ownership').all());
"
```

Expected: three rows, including `scissors`/`AliyaKuzAli`. `owner_user_id` becomes non-null the first time `AliyaKuzAli` sends any message after deploy.

- [ ] **Step 2: Confirm scissors deal ×1.25 damage and show correct flavor text**

Once resolved, have `AliyaKuzAli` `/kick` someone (or `/fight` the troll if she doesn't hold it — whoever currently holds scissors). Expected: swing message says "ножницами" instead of a random cosmetic word, and on a successful hit the damage number is 1.25× the usual 1-20 roll (rounded).

- [ ] **Step 3: Confirm bleed starts, ticks every minute, and can stop early or naturally**

After a successful scissors hit, expected: an immediate `🩸 ... начинает истекать кровью от ржавых ножниц!` message, then roughly once a minute a `🩸 Кровотечение: -1 хп (...)` message from `bleedTick`, and `/me` for the victim shows `🩸 Истекаешь кровью: ещё ~N мин`. Over the following 20 minutes, expect either an early `🩸 Кровотечение остановилось.` (roughly 50/50 every 5 minutes) or, if it runs the full course, `🩸 Кровотечение остановилось само.` — confirm via:

```bash
node -e "
const db = require('better-sqlite3')('mutes.db', {readonly: true});
console.log(db.prepare('SELECT user_id, health, bleed_until, bleed_chat_id, last_bleed_stop_attempt_at FROM user_health WHERE bleed_until IS NOT NULL').all());
"
```

- [ ] **Step 4: Confirm the finger-sever flavor message can fire**

Over several scissors hits (5% per hit, so expect roughly 1 in 20), confirm a `✂️ ... отчекрыжил ... палец ржавыми ножницами!` message appears, and that it has no effect on `/me`, health, or the existing arm/leg/head injury system — purely narrative.

- [ ] **Step 5: Confirm scissors work identically once stolen by the troll**

Force or wait for a crit against the scissors holder to trigger the existing 5% weapon-steal roll; once the troll holds scissors, confirm "Тролль Фас"/drunk attack/food-steal/`/drink`'s beatdown all show ×1.25 damage, "ножницами" in the flavor text, and can still trigger bleed/finger-sever against their target.

- [ ] **Step 6: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here. If it did, commit those fixes individually with a description of what was wrong, following the same commit-message style as the tasks above.
