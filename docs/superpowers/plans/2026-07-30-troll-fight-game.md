# «Драка» Fight Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace troll-bot's `/kick` with a "Драка" fight mini-game against a human who now has a real health stat (built in tg-bot), complete with critical-hit injuries that block fighting and add passive chat effects.

**Architecture:** tg-bot (`c:\Users\123\Projects\tg-bot`) owns two new tables in its existing `mutes.db` — `user_health` and `injuries` — plus a new hourly/daily regen job (its first-ever background timer) and two small additions to its existing message handler and mute-reply logic. troll-bot (`c:\Users\123\Projects\troll-bot`) reads and writes those same tables through its existing `tgBotDb` cross-process connection (the same one already used for `troll_smell`), and replaces `performKick` with a new `performFight` that runs a single human-swing/troll-counter-swing exchange per press (repeat presses continue the brawl one hit at a time, instead of one press resolving three rounds at once) using the existing `rollTrollTryResult` dice engine (extended to expose its raw roll for the crit check).

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`, two independent long-polling processes sharing one SQLite file. No test framework in either repo — verification throughout is manual (direct `node -e` scripts against `mutes.db`/`troll.db`), same as every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-07-30-troll-fight-game-design.md`

**Sequencing:** Tasks 1-5 are tg-bot only and must be deployed before Tasks 6-11 (troll-bot) can be tested end-to-end — troll-bot writes into tables that don't exist until tg-bot creates them.

---

## Part 1 — tg-bot (`c:\Users\123\Projects\tg-bot`)

### Task 1: `user_health` / `injuries` / `health_regen_state` tables

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:223-229`

- [ ] **Step 1: Add the three new tables right after `virus_quarantine`**

Find (bot.js:223-229):

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS virus_quarantine (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    expires_at INTEGER NOT NULL
  )
`);

// --- Animal definitions ---
```

Replace with:

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS virus_quarantine (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    expires_at INTEGER NOT NULL
  )
`);

// Health for every chat participant (global per user_id, not per-chat —
// one health total across every chat this bot serves). Written here by the
// regen job below and the mute-reply branch; also written directly by
// troll-bot's "Драка" game via the same cross-process connection pattern
// already used for troll_smell (see troll-bot's bot.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS user_health (
    user_id INTEGER PRIMARY KEY,
    health INTEGER NOT NULL DEFAULT 100,
    max_health INTEGER NOT NULL DEFAULT 100,
    last_regen_at INTEGER
  )
`);
// Critical-hit injuries from "Драка" (see troll-bot) — one of 'arm' | 'leg'
// | 'head', always exactly one at a time (a fresh crit overwrites), lazily
// expired 24h after being set (checked at read time, same idiom as mutes/
// troll_smell rather than a separate cleanup job).
db.exec(`
  CREATE TABLE IF NOT EXISTS injuries (
    user_id INTEGER PRIMARY KEY,
    injury_type TEXT NOT NULL,
    injured_until INTEGER NOT NULL
  )
`);
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

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the tables exist in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\"CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100, last_regen_at INTEGER)\");
db.exec(\"CREATE TABLE injuries (user_id INTEGER PRIMARY KEY, injury_type TEXT NOT NULL, injured_until INTEGER NOT NULL)\");
db.exec(\"CREATE TABLE health_regen_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_full_restore_date TEXT)\");
console.log('OK');
"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add user_health/injuries/health_regen_state tables for the fight game"
```

---

### Task 2: 0-health mute reply — "находится в отключке" variant

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js:1163-1169`

- [ ] **Step 1: Branch the mute-deletion reply on `muted_by_name`**

Find (bot.js:1163-1169):

```js
  if (isMuted(msg.from.id)) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const row = db.prepare('SELECT expires_at FROM mutes WHERE user_id = ?').get(msg.from.id);
    const until = row ? formatExpire(row.expires_at) : '';
    bot.sendMessage(msg.chat.id, `${msg.from.first_name}, вы замучены ${until}`, threadOpts(msg)).catch(() => {});
    return;
  }
```

Replace with:

```js
  if (isMuted(msg.from.id)) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const row = db.prepare('SELECT expires_at, muted_by_name FROM mutes WHERE user_id = ?').get(msg.from.id);
    // Knocked out by "Драка" (0 health) gets its own flavor line instead of
    // the normal admin-mute message — same underlying mute mechanism either
    // way, see muteUser/isMuted above.
    if (row && row.muted_by_name === 'драка') {
      bot.sendMessage(msg.chat.id, `😵 ${msg.from.first_name} находится в отключке...`, threadOpts(msg)).catch(() => {});
      return;
    }
    const until = row ? formatExpire(row.expires_at) : '';
    bot.sendMessage(msg.chat.id, `${msg.from.first_name}, вы замучены ${until}`, threadOpts(msg)).catch(() => {});
    return;
  }
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: distinct mute reply for Драка knockouts vs normal mutes"
```

---

### Task 3: Injury passive chat effects — leg "хромает" + head nonsense

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (top-level, near `smellMessageCounts`, and inside the main `bot.on('message', ...)` handler right after the smell block)

- [ ] **Step 1: Add the leg-limp counter and head-nonsense phrase pool**

Find (bot.js, right before the smell-handling `bot.on('message', ...)` — search for `const smellMessageCounts = new Map();`):

```js
const smellMessageCounts = new Map();
```

Add immediately after it:

```js

// Leg-injury "хромает" throttle (see troll-bot's "Драка" game, which writes
// to the injuries table) — identical in-memory-counter shape to
// smellMessageCounts above: every 3rd message while the leg injury is
// active gets the limp line, reset when the injury clears.
const limpMessageCounts = new Map();

// Head-injury nonsense replies — flat per-message chance (see the injuries
// check below), not a counter like leg's, since "sometimes talks nonsense"
// reads as a dice roll rather than a fixed cadence.
const HEAD_INJURY_CHANCE = 0.25;
const HEAD_INJURY_PHRASES = [
  'Ты вообще о чём?',
  'Моя видеть единорога, извини, что?',
  'Погоди, а где мои носки?',
  'Кажется, только что была вспышка света... или нет?',
  'Стоп, а мы вообще о чём говорили?',
  'Ой, голова кружится... что твоя сказать?',
  'Мимо. Полностью мимо.',
  'Твоя такое говорить, а моя видеть только звёздочки.',
];
```

- [ ] **Step 2: Add the injury-effects block right after the smell block in the message handler**

Find (bot.js — the closing of the smell `if (smellRow) { ... }` block, followed by the fisher-trigger comment):

```js
      }
    }
  }

  // Auto-fisher trigger
```

Replace with:

```js
      }
    }
  }

  // Injury passive effects (see troll-bot's "Драка" game, which writes to
  // the injuries table on a critical hit) — lazily expired here the same
  // way troll_smell/mutes already are, not a separate cleanup job.
  const injuryRow = db.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(msg.from.id);
  if (injuryRow) {
    if (injuryRow.injured_until * 1000 < Date.now()) {
      db.prepare('DELETE FROM injuries WHERE user_id = ?').run(msg.from.id);
      limpMessageCounts.delete(msg.from.id);
    } else if (injuryRow.injury_type === 'leg') {
      const limpCount = (limpMessageCounts.get(msg.from.id) || 0) + 1;
      limpMessageCounts.set(msg.from.id, limpCount);
      if (limpCount % 3 === 0) {
        bot.sendMessage(msg.chat.id, `🦵 ${msg.from.first_name} хромает...`, threadOpts(msg)).catch(() => {});
      }
    } else if (injuryRow.injury_type === 'head' && Math.random() < HEAD_INJURY_CHANCE) {
      const nonsense = HEAD_INJURY_PHRASES[Math.floor(Math.random() * HEAD_INJURY_PHRASES.length)];
      bot.sendMessage(msg.chat.id, nonsense, { reply_to_message_id: msg.message_id, ...threadOpts(msg) }).catch(() => {});
    }
  }

  // Auto-fisher trigger
```

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: leg/head injury passive chat effects (хромает + nonsense replies)"
```

---

### Task 4: Health regen job — hourly trickle + daily 04:00 full restore

**Files:**
- Modify: `c:\Users\123\Projects\tg-bot\bot.js` (end of file, right before the final `console.log('Бот запущен...')`)

- [ ] **Step 1: Add the regen function and its interval**

Find (bot.js, the very last line):

```js
console.log('Бот запущен...');
```

Replace with:

```js
// Health regen — this bot's first background timer (no existing setInterval
// to mirror; troll-bot's own backgroundTick is the loose stylistic
// reference: one self-contained function, called on a fixed interval).
// Runs every 10 minutes: (1) hourly +10 trickle, prorated by elapsed time
// and capped at max_health, for anyone below it; (2) once daily at 04:00
// server time, a full restore to max_health for everyone, guarded by
// health_regen_state.last_full_restore_date so it only fires once per
// calendar day rather than on every tick during the 04:00 hour.
const HEALTH_REGEN_PER_HOUR = 10;
const HEALTH_REGEN_TICK_MS = 10 * 60 * 1000;

function healthRegenTick() {
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare('SELECT user_id, health, max_health, last_regen_at FROM user_health WHERE health < max_health').all();
  for (const row of rows) {
    const elapsedSeconds = row.last_regen_at ? now - row.last_regen_at : 3600;
    const gain = Math.floor((elapsedSeconds / 3600) * HEALTH_REGEN_PER_HOUR);
    if (gain > 0) {
      db.prepare('UPDATE user_health SET health = MIN(max_health, health + ?), last_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const regenState = db.prepare('SELECT last_full_restore_date FROM health_regen_state WHERE id = 1').get();
  const hour = new Date().getHours();
  if (hour === 4 && regenState.last_full_restore_date !== today) {
    db.prepare('UPDATE user_health SET health = max_health, last_regen_at = ? WHERE health < max_health').run(now);
    db.prepare('UPDATE health_regen_state SET last_full_restore_date = ? WHERE id = 1').run(today);
  }
}
setInterval(healthRegenTick, HEALTH_REGEN_TICK_MS);

console.log('Бот запущен...');
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the trickle-regen math in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE user_health (user_id INTEGER PRIMARY KEY, health INTEGER NOT NULL DEFAULT 100, max_health INTEGER NOT NULL DEFAULT 100, last_regen_at INTEGER)');
const now = Math.floor(Date.now() / 1000);
db.prepare('INSERT INTO user_health (user_id, health, max_health, last_regen_at) VALUES (1, 50, 100, ?)').run(now - 3600);
const row = db.prepare('SELECT user_id, health, max_health, last_regen_at FROM user_health WHERE health < max_health').get();
const elapsedSeconds = now - row.last_regen_at;
const gain = Math.floor((elapsedSeconds / 3600) * 10);
db.prepare('UPDATE user_health SET health = MIN(max_health, health + ?), last_regen_at = ? WHERE user_id = ?').run(gain, now, row.user_id);
console.log(db.prepare('SELECT health FROM user_health WHERE user_id = 1').get());
"
```
Expected: `{ health: 60 }` (50 + 10 for the one elapsed hour).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: hourly health regen trickle + daily 04:00 full restore"
```

---

### Task 5: tg-bot manual verification (before moving to troll-bot)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the tables exist on a real `mutes.db`**

```bash
node -e "
const db = require('better-sqlite3')('mutes.db', {readonly: true});
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_health','injuries','health_regen_state')\").all());
"
```
Expected: all three table names listed.

- [ ] **Step 2: Confirm the 0-health mute variant**

```bash
node -e "
const db = require('better-sqlite3')('mutes.db');
db.prepare('INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, 0, ?, ?)').run(999999, 0, 'test', 'драка', Math.floor(Date.now()/1000) + 1800);
"
```
Then send a message from that test user in the chat (or simulate) and confirm the reply is "😵 ... находится в отключке..." not the normal mute text. Clean up afterward:
```bash
node -e "require('better-sqlite3')('mutes.db').prepare('DELETE FROM mutes WHERE user_id = 999999').run();"
```

- [ ] **Step 3: Confirm leg/head injury effects manually**

```bash
node -e "
const db = require('better-sqlite3')('mutes.db');
db.prepare('INSERT OR REPLACE INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?)').run(YOUR_TEST_USER_ID, 'leg', Math.floor(Date.now()/1000) + 3600);
"
```
Send 3 messages as that user and confirm "🦵 ... хромает..." appears on the 3rd. Repeat with `'head'` and confirm occasional nonsense replies over several messages. Clean up: `DELETE FROM injuries WHERE user_id = YOUR_TEST_USER_ID`.

- [ ] **Step 4: Confirm the regen tick doesn't error against the live process**

```bash
pm2 logs tg-bot --lines 20 --nostream
```
Expected: no new errors after the deploy + restart.

---

## Part 2 — troll-bot (`c:\Users\123\Projects\troll-bot`)

### Task 6: Expose the raw roll from `rollTrollTryResult`

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1490-1495`

- [ ] **Step 1: Add `roll` to the returned object**

Find (bot.js:1490-1495):

```js
function rollTrollTryResult(action) {
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= 50;
  const outcome = success ? '✅ удачно' : '❌ неудачно';
  return { success, text: `Тролль — ${action} ${outcome}: ${roll}/100` };
}
```

Replace with:

```js
function rollTrollTryResult(action) {
  const roll = Math.floor(Math.random() * 101);
  const success = roll >= 50;
  const outcome = success ? '✅ удачно' : '❌ неудачно';
  // roll is exposed (not just success/text) so callers can react to how
  // strong a hit was — currently only "Драка"'s critical-hit check (roll
  // >= 90) reads it; every existing caller already destructures only
  // {success, text} or calls rollTrollTry (text-only), so adding this key
  // doesn't change anything for them.
  return { success, text: `Тролль — ${action} ${outcome}: ${roll}/100`, roll };
}
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: expose the raw dice roll from rollTrollTryResult"
```

---

### Task 7: Defensive `user_health`/`injuries` table creation in troll-bot's `tgBotDb` block

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:26-45`

- [ ] **Step 1: Add the two tables to the existing defensive-creation try block**

Find (bot.js:26-45):

```js
let tgBotDb = null;
try {
  tgBotDb = new Database(process.env.TG_BOT_DB_PATH || path.join(__dirname, '..', 'tg-bot', 'mutes.db'));
  tgBotDb.pragma('busy_timeout = 5000');
  tgBotDb.exec(`
    CREATE TABLE IF NOT EXISTS troll_smell (
      user_id INTEGER PRIMARY KEY,
      marked_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL
    )
  `);
  // Distinguishes the poop-trap mark (tg-bot plays it as an ironic "smells
  // of violets" line) from the plain pee-target mark ("smells of troll
  // pee") — see markSmelly below and tg-bot's reply logic. Separate ALTER
  // since the column didn't exist when troll_smell was first deployed.
  try {
    tgBotDb.exec("ALTER TABLE troll_smell ADD COLUMN reason TEXT NOT NULL DEFAULT 'pee'");
  } catch {}
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}
```

Replace with:

```js
let tgBotDb = null;
try {
  tgBotDb = new Database(process.env.TG_BOT_DB_PATH || path.join(__dirname, '..', 'tg-bot', 'mutes.db'));
  tgBotDb.pragma('busy_timeout = 5000');
  tgBotDb.exec(`
    CREATE TABLE IF NOT EXISTS troll_smell (
      user_id INTEGER PRIMARY KEY,
      marked_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL
    )
  `);
  // Distinguishes the poop-trap mark (tg-bot plays it as an ironic "smells
  // of violets" line) from the plain pee-target mark ("smells of troll
  // pee") — see markSmelly below and tg-bot's reply logic. Separate ALTER
  // since the column didn't exist when troll_smell was first deployed.
  try {
    tgBotDb.exec("ALTER TABLE troll_smell ADD COLUMN reason TEXT NOT NULL DEFAULT 'pee'");
  } catch {}
  // "Драка" fight game (see performFight below) — same defensive dual-create
  // pattern as troll_smell above, so deploy order between the two bots
  // doesn't matter. tg-bot owns these tables (its own regen job/message
  // handler read and write them too); troll-bot only reads/writes damage
  // and injuries through this same connection.
  tgBotDb.exec(`
    CREATE TABLE IF NOT EXISTS user_health (
      user_id INTEGER PRIMARY KEY,
      health INTEGER NOT NULL DEFAULT 100,
      max_health INTEGER NOT NULL DEFAULT 100,
      last_regen_at INTEGER
    )
  `);
  tgBotDb.exec(`
    CREATE TABLE IF NOT EXISTS injuries (
      user_id INTEGER PRIMARY KEY,
      injury_type TEXT NOT NULL,
      injured_until INTEGER NOT NULL
    )
  `);
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: defensively create user_health/injuries tables from troll-bot too"
```

---

### Task 8: Cross-bot health/injury helper functions

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js` (insert right after `markSmelly`, currently ending around line 54)

- [ ] **Step 1: Add the four helper functions right after `markSmelly`**

Find (bot.js — the end of `markSmelly`, search for this exact closing):

```js
function markSmelly(userId, durationSeconds, reason) {
  if (!tgBotDb) return;
  const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
  tgBotDb.prepare(
    'INSERT INTO troll_smell (user_id, marked_at, expires_at, reason) VALUES (?, strftime(\'%s\',\'now\'), ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET marked_at = strftime(\'%s\',\'now\'), expires_at = excluded.expires_at, reason = excluded.reason'
  ).run(userId, expiresAt, reason);
}
```

Add immediately after it:

```js

// Lazily-expiring injury lookup for the "Драка" game — mirrors markSmelly's
// cross-process style. Returns 'arm' | 'leg' | 'head' | null.
function getUserInjury(userId) {
  if (!tgBotDb) return null;
  const row = tgBotDb.prepare('SELECT injury_type, injured_until FROM injuries WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (row.injured_until * 1000 < Date.now()) {
    tgBotDb.prepare('DELETE FROM injuries WHERE user_id = ?').run(userId);
    return null;
  }
  return row.injury_type;
}

// Called only after a troll hit lands with roll >= 90 (see performFight) —
// always overwrites any existing injury with a fresh one and a fresh 24h
// timer, no stacking multiple injuries at once.
function applyInjury(userId, injuryType) {
  if (!tgBotDb) return;
  const injuredUntil = Math.floor(Date.now() / 1000) + 24 * 3600;
  tgBotDb.prepare(
    'INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET injury_type = excluded.injury_type, injured_until = excluded.injured_until'
  ).run(userId, injuryType, injuredUntil);
}

// Reads (and lazily creates, at the 100/100 default) a challenger's health
// row. Returns null only if tgBotDb itself is unavailable.
function getUserHealth(userId) {
  if (!tgBotDb) return null;
  const row = tgBotDb.prepare('SELECT health, max_health FROM user_health WHERE user_id = ?').get(userId);
  if (row) return row;
  tgBotDb.prepare('INSERT INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  return { health: 100, max_health: 100 };
}

// Applies fight damage, floors at 0, and — if it reaches exactly 0 — mutes
// the human for 30 minutes via tg-bot's own mutes table. troll-bot can't
// call tg-bot's muteUser() across processes, so this duplicates its exact
// INSERT shape (same precedent as markSmelly writing troll_smell directly).
// Returns the human's health after damage, or null if tgBotDb is down.
function damageHuman(userId, chatId, username, damage) {
  if (!tgBotDb) return null;
  getUserHealth(userId);
  tgBotDb.prepare('UPDATE user_health SET health = MAX(0, health - ?) WHERE user_id = ?').run(damage, userId);
  const row = tgBotDb.prepare('SELECT health FROM user_health WHERE user_id = ?').get(userId);
  if (row.health === 0) {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    tgBotDb.prepare(
      'INSERT OR REPLACE INTO mutes (user_id, chat_id, username, muted_by, muted_by_name, expires_at) VALUES (?, ?, ?, 0, ?, ?)'
    ).run(userId, chatId, username, 'драка', expiresAt);
  }
  return row.health;
}
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: add cross-bot health/injury helper functions for Драка"
```

---

### Task 9: `performFight` — one exchange per press

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1735-1829` (replaces the entire `performKick` function)

- [ ] **Step 1: Replace `performKick` with `performFight`**

Find the entire existing `performKick` function (bot.js:1735-1829 — the exact text is long; search for `async function performKick(chatId, from) {` and select through its closing `}` right before the blank line that precedes `// Shared by performFeed's normal/overeating branches...` or whatever comment follows it in the current file):

```js
async function performKick(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'kick')) return;
  const now = Math.floor(Date.now() / 1000);
  noticeUser(from.id, from.username, from.first_name);

  if (state.cocoon_started_at) {
    await bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }

  // Regen sleep in progress: a kick now rolls the same dodge chance as an
  // awake kick instead of always landing. A dodge leaves the nap running
  // completely untouched — just a sleepy insult, no state change. A landed
  // kick still wakes him early and banks whatever regen ticks already
  // accrued (see handleRegenSleepTick in backgroundTick), but now on top of
  // that applies the same mood/health/silence penalty as a normal landed
  // kick — being asleep no longer makes getting kicked free.
  if (state.regen_sleep_started_at) {
    const sleepDodgeRoll = rollTrollTryResult(`увернуться от пинка ${actorName(from)}`);
    if (sleepDodgeRoll.success) {
      await bot.sendMessage(chatId, '*всхрапывает* Твоя идти на хуй!! *и дальше спит*').catch(() => {});
      return;
    }
    const ticksApplied = state.regen_sleep_ticks_applied;
    const weightLost = getSettingNumber('regen_sleep_weight_loss_per_tick') * ticksApplied;
    const healthGained = getSettingNumber('regen_sleep_health_per_tick') * ticksApplied;
    const sleepSilencedUntil = now + 60 * 60;
    db.prepare(
      'UPDATE troll_state SET regen_sleep_started_at = NULL, regen_sleep_ticks_applied = 0, last_regen_sleep_at = ?, health = MAX(0, MIN(max_health, health + ?) - 5), mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1'
    ).run(now, healthGained, sleepSilencedUntil);
    logAction(from.id, from.username || from.first_name, 'kick');
    const oldAttitudeSleep = adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
    checkEnemyDeclaration(chatId, from, oldAttitudeSleep);
    await bot.sendMessage(
      chatId,
      `Ай! Твоя разбудить моя пинком! Моя успеть похудеть на ${weightLost}кг и восстановить ${healthGained} здоровье, но твоя пинок совсем испортить моя настроение!`
    ).catch(() => {});
    return;
  }

  // Global hide lockout: troll successfully hid after 2 kicks within an
  // hour (see below) — /kick does nothing for anyone until it expires.
  if (state.kick_locked_until && state.kick_locked_until > now) {
    await bot.sendMessage(chatId, 'Тролль спрятался и не даётся пнуть! Попробуй позже.').catch(() => {});
    return;
  }

  // Per-user cooldown: this specific attacker dodged-and-got-blocked
  // recently (see below) — Telegram can't hide an inline button for just
  // one person in a shared message, so this is enforced functionally: the
  // button/command still shows for them, it just no-ops with a message.
  const rel = db.prepare('SELECT kick_blocked_until FROM troll_relationships WHERE user_id = ?').get(from.id);
  if (rel && rel.kick_blocked_until && rel.kick_blocked_until > now) {
    await bot.sendMessage(chatId, `${actorName(from)}, тролль прячется от тебя! Попробуй позже.`).catch(() => {});
    return;
  }

  const dodgeRoll = rollTrollTryResult(`увернуться от пинка ${actorName(from)}`);
  await bot.sendMessage(chatId, dodgeRoll.text).catch(() => {});

  if (dodgeRoll.success) {
    // Dodged: no mood/health hit, but the attempt itself still sours the
    // relationship, earns a comeback, and costs the attacker their kick
    // button for an hour.
    const oldAttitude1 = adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
    checkEnemyDeclaration(chatId, from, oldAttitude1);
    logAction(from.id, from.username || from.first_name, 'snapped_at');
    if (!maybeSendFuckReaction(chatId, from.id)) {
      await sendCategoryReplyForStage(chatId, resolveTeaseCategory(from.id), state.stage, 'Твоя не попасть в моя!', actorName(from), from.id);
    }
    db.prepare('UPDATE troll_relationships SET kick_blocked_until = ? WHERE user_id = ?').run(now + 3600, from.id);
    return;
  }

  const silencedUntil = now + 60 * 60;
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), health = MAX(0, health - 5), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(from.id, from.username || from.first_name, 'kick');
  const oldAttitude2 = adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
  checkEnemyDeclaration(chatId, from, oldAttitude2);
  await sendCategoryReplyForStage(chatId, 'kick', state.stage, 'Твоя злой! Моя обижаться!', actorName(from), from.id);

  // 2 landed kicks within an hour: the troll tries to hide from everyone.
  const recentKicks = db.prepare(
    "SELECT COUNT(*) AS n FROM troll_actions WHERE action = 'kick' AND created_at >= ?"
  ).get(now - 3600).n;
  if (recentKicks >= 2) {
    const hideRoll = rollTrollTryResult('спрятаться от всех пинков');
    await bot.sendMessage(chatId, hideRoll.text).catch(() => {});
    if (hideRoll.success) {
      db.prepare('UPDATE troll_state SET kick_locked_until = ? WHERE id = 1').run(now + 3600);
    }
  }
}
```

Replace the entire block above with:

```js
const FIGHT_WEAPONS = ['палкой', 'сковородкой', 'веткой', 'ботинком', 'подушкой', 'зонтиком', 'веслом', 'шваброй', 'рыбой', 'кулаком'];
const FIGHT_BODY_PARTS = ['по голове', 'по спине', 'по ноге', 'по руке', 'по животу', 'по попе', 'по лбу', 'в бок'];
const INJURY_TYPES = ['arm', 'leg', 'head'];
const INJURY_REFUSAL_TEXT = {
  arm: 'твоя рука ещё болит, не до драки!',
  leg: 'твоя нога ещё болит, не до драки!',
  head: 'твоя голова ещё болит, не до драки!',
};

// Replaces the old /kick — ONE exchange per press: the human swings first
// (troll rolls to dodge), then the troll swings back (troll rolls to land
// a hit). Not a 3-round loop — press "⚔️ Драка" again (subject to the
// normal cooldown) to keep brawling one hit at a time. Both sides use the
// same rollTrollTryResult 50/50 engine that kick-dodging already used, just
// with different action text depending on who's "attempting" what. No
// attitude change either way (see design spec) — this is mutual gameplay,
// not an unwanted attack, so attitude_kick_delta/checkEnemyDeclaration
// don't apply here at all.
async function performFight(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  noticeUser(from.id, from.username, from.first_name);

  if (!tgBotDb) {
    await bot.sendMessage(chatId, 'Драка временно недоступна.').catch(() => {});
    return;
  }

  // Injury and 0-health checks come before the cooldown is spent — you
  // shouldn't burn your fight cooldown on an attempt that was never going
  // to start (see design spec's "no cooldown/health touched" requirement).
  const injury = getUserInjury(from.id);
  if (injury) {
    await bot.sendMessage(chatId, `${actorName(from)}, ${INJURY_REFUSAL_TEXT[injury]}`).catch(() => {});
    return;
  }
  const challengerHealth = getUserHealth(from.id);
  if (challengerHealth.health === 0) {
    await bot.sendMessage(chatId, `${actorName(from)}, твоя в отключке, какая драка!`).catch(() => {});
    return;
  }

  if (!checkCommandCooldown(from.id, 'fight')) return;

  if (state.cocoon_started_at) {
    await bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at) {
    await bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }

  let trollHealth = state.health;

  // Human's swing at the troll.
  const humanWeapon = pick(FIGHT_WEAPONS);
  const humanTarget = pick(FIGHT_BODY_PARTS);
  const humanSwing = rollTrollTryResult(`увернуться от удара ${actorName(from)} ${humanWeapon} ${humanTarget}`);
  await bot.sendMessage(chatId, humanSwing.text).catch(() => {});
  if (!humanSwing.success) {
    const dmg = Math.floor(Math.random() * 10) + 1;
    trollHealth = Math.max(0, trollHealth - dmg);
    db.prepare('UPDATE troll_state SET health = ? WHERE id = 1').run(trollHealth);
    await bot.sendMessage(chatId, `💥 Урон троллю: ${dmg} (осталось ${trollHealth}/${state.max_health})`).catch(() => {});
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
    const humanMaxHealth = challengerHealth.max_health;
    await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (осталось ${humanHealth}/${humanMaxHealth})`).catch(() => {});
    if (trollSwing.roll >= 90) {
      const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
      applyInjury(from.id, injuryType);
      await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова'} (на сутки).`).catch(() => {});
    }
  }
}
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: replace performKick with the one-exchange Драка fight game"
```

---

### Task 10: Wire "⚔️ Драка" into the button, command, and callback dispatcher

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js` (three spots: `TROLL_ACTION_KEYBOARD`, `/kick` onText, `callback_query` dispatcher)

- [ ] **Step 1: Relabel the button**

Find (bot.js:1535-1549):

```js
const TROLL_ACTION_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🎮 Играть', callback_data: 'troll_play' },
        { text: '🍗 Покормить', callback_data: 'troll_feed' },
        { text: '👢 Пнуть', callback_data: 'troll_kick' },
      ],
      [
        { text: '😈 Дразнить', callback_data: 'troll_tease' },
        { text: '🍈 Сиська', callback_data: 'troll_boobs' },
      ],
    ],
  },
};
```

Replace with:

```js
const TROLL_ACTION_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🎮 Играть', callback_data: 'troll_play' },
        { text: '🍗 Покормить', callback_data: 'troll_feed' },
        { text: '⚔️ Драка', callback_data: 'troll_fight' },
      ],
      [
        { text: '😈 Дразнить', callback_data: 'troll_tease' },
        { text: '🍈 Сиська', callback_data: 'troll_boobs' },
      ],
    ],
  },
};
```

- [ ] **Step 2: Replace the `/kick` command with `/fight`**

Find (bot.js:1960-1962):

```js
bot.onText(/\/kick\b/, (msg) => {
  performKick(msg.chat.id, msg.from);
});
```

Replace with:

```js
bot.onText(/\/fight\b/, (msg) => {
  performFight(msg.chat.id, msg.from);
});
```

- [ ] **Step 3: Update the callback_query dispatcher**

Find (bot.js:2062-2072):

```js
bot.on('callback_query', (query) => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  if (query.data === 'troll_play') performPlay(chatId, query.from);
  else if (query.data === 'troll_feed') performFeed(chatId, query.from);
  else if (query.data === 'troll_kick') performKick(chatId, query.from);
  else if (query.data === 'troll_tease') performTease(chatId, query.from);
  else if (query.data === 'troll_boobs') performBoobs(chatId, query.from);
  else return;
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

Replace with:

```js
bot.on('callback_query', (query) => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  if (query.data === 'troll_play') performPlay(chatId, query.from);
  else if (query.data === 'troll_feed') performFeed(chatId, query.from);
  else if (query.data === 'troll_fight') performFight(chatId, query.from);
  else if (query.data === 'troll_tease') performTease(chatId, query.from);
  else if (query.data === 'troll_boobs') performBoobs(chatId, query.from);
  else return;
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

- [ ] **Step 4: Search for any other leftover reference to `performKick`, `troll_kick`, or `/kick` and remove/update it**

```bash
grep -n "performKick\|troll_kick\|/kick\\\\b" bot.js
```

Expected: no results. If anything shows up (e.g. a help-text line listing `/kick` as a command), update it to mention `/fight` instead, matching whatever style that line already uses.

- [ ] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat: wire up ⚔️ Драка button/command/callback, retire /kick"
```

---

### Task 11: End-to-end manual verification

**Files:** none (verification only, against both running bots)

Both bots must be deployed and restarted before this task (tg-bot's Tasks 1-4 and troll-bot's Tasks 6-10).

- [ ] **Step 1: Confirm the button and command both start a fight**

Send `/troll`, click "⚔️ Драка". Expected: one human-swing message (plus a
damage line if it landed), then one troll-counter-swing message (plus a
damage line if it landed) — unless the human's swing just knocked the
troll to 0, in which case there's no counter-swing at all. Click "⚔️ Драка"
again (once past the cooldown) to confirm it runs another single exchange,
not a repeat of the same round. Also try `/fight` directly.

- [ ] **Step 2: Confirm troll damage persists in `troll_state`**

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT health, max_health FROM troll_state WHERE id = 1').get());
"
```
Health should be lower than before the fight (unless every human swing missed).

- [ ] **Step 3: Confirm human damage persists in tg-bot's `mutes.db`**

```bash
node -e "
const db = require('better-sqlite3')('../tg-bot/mutes.db', {readonly: true});
console.log(db.prepare('SELECT * FROM user_health WHERE user_id = ?').get(YOUR_TEST_USER_ID));
"
```
Health should reflect the fight's outcome.

- [ ] **Step 4: Force a 0-health knockout and confirm the mute fires**

```bash
node -e "
const db = require('better-sqlite3')('../tg-bot/mutes.db');
db.prepare('UPDATE user_health SET health = 1 WHERE user_id = ?').run(YOUR_TEST_USER_ID);
"
```
Fight again until a troll hit lands. Expected: health reaches 0, a row
appears in `mutes` with `muted_by_name = 'драка'`, and the next message from
that user in tg-bot gets deleted with "😵 ... находится в отключке...".

- [ ] **Step 5: Force a critical hit and confirm the injury blocks fighting**

```bash
node -e "
const db = require('better-sqlite3')('../tg-bot/mutes.db');
db.prepare('INSERT OR REPLACE INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?)').run(YOUR_TEST_USER_ID, 'arm', Math.floor(Date.now()/1000) + 3600);
"
```
Click "⚔️ Драка" as that user. Expected: refusal message naming the arm,
no round starts, no cooldown consumed (try again immediately — same
refusal, not silence). Repeat with `'leg'` and `'head'` for their refusal
text, and confirm leg/head's passive chat effects (Task 3) still fire
independent of any fight attempt.

- [ ] **Step 6: Confirm no leftover `/kick` references**

```bash
grep -rn "performKick\|troll_kick" bot.js
```
Expected: no output.

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here.
If it did, commit those fixes individually with a description of what was
wrong, following the same commit-message style as the tasks above.
