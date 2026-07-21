# Troll Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a brand-new, standalone Telegram bot ("troll-bot") implementing the virtual-pet troll feature described in the design spec — its own repo, its own bot account, single public chat + single admin chat.

**Architecture:** A single-file bot (`bot.js`), mirroring the existing `tg-bot` project's established conventions exactly (same long-polling + SOCKS/HTTPS-proxy setup, same `update_id` dedupe wrapper, same `better-sqlite3` single-row-table pattern, same "no test framework — throwaway `node` assert scripts for pure functions, manual smoke test for the rest" testing approach). The file is built up incrementally across tasks, each one appending a self-contained section.

**Tech Stack:** Node.js, `node-telegram-bot-api`, `better-sqlite3`, `dotenv`, `https-proxy-agent`, `socks-proxy-agent` — identical dependency set to `tg-bot` (minus `tesseract.js`/`axios`/`tunnel`, which `tg-bot` doesn't actually use for anything this bot needs).

Full design: `docs/superpowers/specs/2026-07-21-troll-bot-design.md`.

**IMPORTANT for every task below:** This is a brand-new bot account — there is no shared production token to worry about yet, but once Task 2 lands and a real `.env` exists, do NOT run `node bot.js` with a real `BOT_TOKEN` unless explicitly told to (the same "don't run a second live poller against a real token" caution that applies to `tg-bot` will apply here too, once this bot is actually deployed). Every task's own verification section says explicitly whether running the bot live is safe for that task.

---

### Task 1: Project scaffolding

**Files:**
- Create: `c:\Users\123\Projects\troll-bot\package.json`
- Create: `c:\Users\123\Projects\troll-bot\.gitignore`
- Create: `c:\Users\123\Projects\troll-bot\.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "troll-bot",
  "version": "1.0.0",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js"
  },
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "dotenv": "^16.0.0",
    "https-proxy-agent": "^5.0.1",
    "node-telegram-bot-api": "^0.66.0",
    "socks-proxy-agent": "^10.1.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.env
troll.db
```

- [ ] **Step 3: Create `.env.example`**

```
BOT_TOKEN=
PROXY_URL=
ADMIN_CHAT_ID=
```

- [ ] **Step 4: Install dependencies**

Run (from `c:\Users\123\Projects\troll-bot`): `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore .env.example package-lock.json
git commit -m "chore: scaffold troll-bot project"
```

(Do NOT add `.env` — it doesn't exist yet and is gitignored anyway; the real token/proxy/admin-chat-id only get filled in at deploy time, in Task 9.)

---

### Task 2: Bootstrap — polling/proxy setup, schema, auth helpers

**Files:**
- Create: `c:\Users\123\Projects\troll-bot\bot.js`

- [ ] **Step 1: Create `bot.js` with the full bootstrap section**

```js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Database = require('better-sqlite3');

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);

let agent;
if (proxy) {
  // keepAlive is essential: the low-powered proxy server drops ~half of fresh
  // SOCKS+Reality handshakes under concurrency, so reuse one warm tunnel
  // connection instead of a new handshake per call. Mirrors tg-bot's own
  // proxy setup on the same server/network path.
  const agentOpts = { keepAlive: true, keepAliveMsecs: 60000, maxSockets: 5, maxFreeSockets: 3 };
  if (proxy.startsWith('socks')) {
    agent = new SocksProxyAgent(proxy, agentOpts);
  } else {
    agent = new HttpsProxyAgent(proxy, agentOpts);
  }
}

// autoStart: false — this file drives its own polling loop (see the bottom
// of this file), so the library's own internal poller must stay off to
// avoid two independent pollers racing on the same token (the exact bug
// tg-bot hit and fixed the same way).
const bot = new TelegramBot(token, { polling: { autoStart: false }, request: { agent } });

// Dedupe by update_id — same rationale as tg-bot: a flaky proxy tunnel can
// cause the same update to be delivered and processed twice.
const seenUpdateIds = new Set();
const seenUpdateQueue = [];
const MAX_SEEN_UPDATES = 500;
const originalProcessUpdate = bot.processUpdate.bind(bot);
bot.processUpdate = (update) => {
  if (update.update_id != null) {
    if (seenUpdateIds.has(update.update_id)) {
      console.log('duplicate update skipped:', update.update_id);
      return;
    }
    seenUpdateIds.add(update.update_id);
    seenUpdateQueue.push(update.update_id);
    if (seenUpdateQueue.length > MAX_SEEN_UPDATES) {
      seenUpdateIds.delete(seenUpdateQueue.shift());
    }
  }
  return originalProcessUpdate(update);
};

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason?.message || reason);
});

// --- Auth helpers ---
// isAdminChat: gates the settings/admin commands (/troll_set, /troll_say,
// etc.) — these only work when invoked FROM the separate admin chat.
function isAdminChat(msg) {
  return msg.chat.id === ADMIN_CHAT_ID;
}

// isTelegramAdmin: gates /troll_here specifically — that command is run IN
// the public chat, so it checks the CALLER's Telegram chat-admin status
// there, not which chat it's in.
async function isTelegramAdmin(msg) {
  try {
    const member = await bot.getChatMember(msg.chat.id, msg.from.id);
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

// --- SQLite ---
const db = new Database('troll.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    chat_id INTEGER NOT NULL,
    feed_count INTEGER NOT NULL DEFAULT 0,
    mood INTEGER NOT NULL DEFAULT 50,
    health INTEGER NOT NULL DEFAULT 100,
    message_count INTEGER NOT NULL DEFAULT 0,
    silenced_until INTEGER,
    last_fed_at INTEGER,
    is_asleep INTEGER NOT NULL DEFAULT 0,
    last_health_tick_at INTEGER,
    last_mischief_at INTEGER,
    born_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    action TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const DEFAULT_SETTINGS = {
  sleep_start: '0',
  sleep_end: '8',
  naughtiness: '5',
  mischief_interval_hours: '1',
  mischief_message_trigger: '50',
  health_decay_per_hour: '2',
  health_regen_per_hour: '1',
  neglect_threshold_hours: '6',
  paused: '0',
};
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO troll_settings (key, value) VALUES (?, ?)').run(key, value);
}

console.log('Тролль-бот: схема готова.');
```

(Note: unlike the design doc's data-model table, this schema has no `stage` column — `stage` is always derived from `feed_count` via a `getStage()` helper added in Task 3, never stored independently, which is a stricter reading of the design doc's own "not tracked as independent state that could desync" note. It also adds three columns beyond the design doc's table — `is_asleep`, `last_health_tick_at`, `last_mischief_at` — needed so the background tick, added in Task 6, can correctly respect admin-configurable intervals at runtime rather than relying on a fixed `setInterval` delay chosen once at startup.)

- [ ] **Step 2: Verify the file parses and the schema is valid**

Run: `node --check bot.js` — expect no output.

Then run (this DOES touch the real `troll.db` file, which is fine — it's just schema creation, no Telegram connection): `node -e "require('./bot.js')"` and immediately check with `Ctrl+C is not needed since there's no polling started yet in this task — the process will just print 'Тролль-бот: схема готова.' and then hang waiting on nothing (no timers registered yet), so run it with a timeout`:

```bash
timeout 3 node -e "require('./bot.js')" || true
```

Expected output: `Тролль-бот: схема готова.` and the process exits after the timeout (no error). If `BOT_TOKEN` is empty (no real `.env` yet), `node-telegram-bot-api`'s constructor doesn't validate the token eagerly, so this is safe to run without a real token.

Then inspect the created database:
```bash
node -e "const db = require('better-sqlite3')('troll.db'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all()); console.log(db.prepare('SELECT * FROM troll_settings').all());"
```
Expected: prints the 3 table names (`troll_state`, `troll_actions`, `troll_settings`) and all 9 default settings rows.

- [ ] **Step 3: Delete the throwaway `troll.db` created by verification, so Task 3 starts clean**

```bash
rm troll.db
```

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: bootstrap polling/proxy setup and schema"
```

---

### Task 3: Pure helper functions (settings, trollify, weight/stage/mood)

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js` (append to the end)

- [ ] **Step 1: Write a throwaway verification script for `trollify()` BEFORE adding it to bot.js**

Create `C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\troll-trollify-check.js`:

```js
const assert = require('assert');

// \b is defined relative to \w ([A-Za-z0-9_], ASCII-only) in JS regex, so it
// never matches at the edge of a Cyrillic word — a naive \bты\b would never
// fire on real Russian text. Use lookaround against an explicit Cyrillic
// class instead, which gives the same "whole word only" semantics correctly.
const CYR = 'а-яёА-ЯЁ';
function wordRegex(word) {
  return new RegExp(`(?<![${CYR}])${word}(?![${CYR}])`, 'gi');
}

const PRONOUN_MAP = [
  [wordRegex('мной'), 'моя'], [wordRegex('мною'), 'моя'], [wordRegex('меня'), 'моя'], [wordRegex('мне'), 'моя'], [wordRegex('я'), 'моя'],
  [wordRegex('тобой'), 'твоя'], [wordRegex('тобою'), 'твоя'], [wordRegex('тебя'), 'твоя'], [wordRegex('тебе'), 'твоя'], [wordRegex('ты'), 'твоя'],
  [wordRegex('нами'), 'наша'], [wordRegex('нас'), 'наша'], [wordRegex('нам'), 'наша'], [wordRegex('мы'), 'наша'],
  [wordRegex('вами'), 'ваша'], [wordRegex('вас'), 'ваша'], [wordRegex('вам'), 'ваша'], [wordRegex('вы'), 'ваша'],
];

const VERB_ENDINGS = ['ишь', 'ешь', 'ует', 'ают', 'яют', 'ите', 'ете', 'ют', 'ят', 'ат', 'ем', 'им', 'ет', 'ит', 'ю', 'у'];

function trollifyWord(word) {
  const lower = word.toLowerCase();
  for (const ending of VERB_ENDINGS) {
    if (lower.length > ending.length + 2 && lower.endsWith(ending)) {
      return word.slice(0, word.length - ending.length) + 'ть';
    }
  }
  return word;
}

function trollify(text) {
  let result = text;
  for (const [pattern, replacement] of PRONOUN_MAP) {
    result = result.replace(pattern, (match) => {
      const isCapitalized = match[0] !== match[0].toLowerCase() && match[0] === match[0].toUpperCase();
      return isCapitalized ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
    });
  }
  result = result.split(/(\s+)/).map((token) => (/^[а-яё]+$/i.test(token) ? trollifyWord(token) : token)).join('');
  return result;
}

// Verb-ending heuristic in isolation
assert.strictEqual(trollifyWord('видишь'), 'видть'); // crude strip-and-append-"ть"; NOT linguistically correct ("видеть") — accepted imperfection, not a bug
assert.strictEqual(trollifyWord('играю'), 'играть');
assert.strictEqual(trollifyWord('стол'), 'стол'); // no matching ending, unchanged

// Pronoun substitution, case preserved on first letter
assert.strictEqual(trollify('Ты меня обидел'), 'Твоя моя обидел');
assert.strictEqual(trollify('я хочу кушать'), 'моя хочть кушать'); // known-imperfect: "хочу" ends in "у" and gets mangled to "хочть" — accepted trade-off, not a bug
assert.strictEqual(trollify('мы вас понимаем'), 'наша ваша ' + trollifyWord('понимаем'));
console.log('OK');
```

Run: `node "C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\troll-trollify-check.js"` — expect `OK`.

**IMPORTANT — Cyrillic and `\b` don't mix in JS regex.** `\b` is defined relative to `\w` (`[A-Za-z0-9_]`, ASCII-only) — Cyrillic letters are never `\w`, so `\b` never matches at a Cyrillic word's edge. A `\bты\b`-style pattern silently never matches real Russian text at all. `PRONOUN_MAP` above uses lookaround against an explicit Cyrillic character class instead, which gives the same "whole word only" semantics but actually works.

- [ ] **Step 2: Append the real helpers to `bot.js`**

Find this exact text (the last line of `bot.js` so far):
```js
console.log('Тролль-бот: схема готова.');
```
Replace with:
```js
console.log('Тролль-бот: схема готова.');

// --- Settings ---
function getSetting(key) {
  const row = db.prepare('SELECT value FROM troll_settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

function getSettingNumber(key) {
  return Number(getSetting(key));
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO troll_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// --- Misc helpers ---
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isSilenced(state) {
  return !!state.silenced_until && state.silenced_until * 1000 > Date.now();
}

function logAction(userId, username, action) {
  db.prepare('INSERT INTO troll_actions (user_id, username, action) VALUES (?, ?, ?)').run(userId, username, action);
}

// --- Growth ---
const STAGE_NAMES = { 1: 'малыш', 2: 'подросток', 3: 'молодой', 4: 'взрослый' };

function getStage(feedCount) {
  if (feedCount >= 90) return 4;
  if (feedCount >= 50) return 3;
  if (feedCount >= 20) return 2;
  return 1;
}

function getWeight(feedCount) {
  const capped = Math.min(feedCount, 90);
  return Math.round(30 + (capped / 90) * 370);
}

function moodWord(mood) {
  if (mood >= 70) return 'весёлый';
  if (mood >= 40) return 'нормальный';
  if (mood >= 15) return 'грустный';
  return 'злой';
}

// --- Troll-speak transformer ---
// \b is defined relative to \w ([A-Za-z0-9_], ASCII-only) in JS regex, so it
// never matches at the edge of a Cyrillic word — a naive \bты\b would never
// fire on real Russian text. Use lookaround against an explicit Cyrillic
// class instead, which gives the same "whole word only" semantics correctly.
const CYR = 'а-яёА-ЯЁ';
function wordRegex(word) {
  return new RegExp(`(?<![${CYR}])${word}(?![${CYR}])`, 'gi');
}

const PRONOUN_MAP = [
  [wordRegex('мной'), 'моя'], [wordRegex('мною'), 'моя'], [wordRegex('меня'), 'моя'], [wordRegex('мне'), 'моя'], [wordRegex('я'), 'моя'],
  [wordRegex('тобой'), 'твоя'], [wordRegex('тобою'), 'твоя'], [wordRegex('тебя'), 'твоя'], [wordRegex('тебе'), 'твоя'], [wordRegex('ты'), 'твоя'],
  [wordRegex('нами'), 'наша'], [wordRegex('нас'), 'наша'], [wordRegex('нам'), 'наша'], [wordRegex('мы'), 'наша'],
  [wordRegex('вами'), 'ваша'], [wordRegex('вас'), 'ваша'], [wordRegex('вам'), 'ваша'], [wordRegex('вы'), 'ваша'],
];

const VERB_ENDINGS = ['ишь', 'ешь', 'ует', 'ают', 'яют', 'ите', 'ете', 'ют', 'ят', 'ат', 'ем', 'им', 'ет', 'ит', 'ю', 'у'];

function trollifyWord(word) {
  const lower = word.toLowerCase();
  for (const ending of VERB_ENDINGS) {
    if (lower.length > ending.length + 2 && lower.endsWith(ending)) {
      return word.slice(0, word.length - ending.length) + 'ть';
    }
  }
  return word;
}

// Known-imperfect on purpose: pronoun substitution is reliable, but the verb
// heuristic will occasionally mangle irregular verbs or unrelated words that
// share a common personal-verb ending. Accepted trade-off per design doc.
function trollify(text) {
  let result = text;
  for (const [pattern, replacement] of PRONOUN_MAP) {
    result = result.replace(pattern, (match) => {
      const isCapitalized = match[0] !== match[0].toLowerCase() && match[0] === match[0].toUpperCase();
      return isCapitalized ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
    });
  }
  result = result.split(/(\s+)/).map((token) => (/^[а-яё]+$/i.test(token) ? trollifyWord(token) : token)).join('');
  return result;
}
```

- [ ] **Step 3: Verify the file parses, then re-run the throwaway script one more time**

Run: `node --check bot.js` — expect no output.
Run again: `node "C:\Users\123\AppData\Local\Temp\claude\c--Users-123-Projects-tg-bot\fb13a5cf-d68f-43bd-88e1-98535e0cd127\scratchpad\troll-trollify-check.js"` — expect `OK`.

- [ ] **Step 4: Manual verification (static only)**
1. Confirm the real `trollify`/`trollifyWord`/`PRONOUN_MAP`/`VERB_ENDINGS` in `bot.js` are character-for-character identical to what the throwaway script verified.
2. Confirm `getStage(19)===1`, `getStage(20)===2`, `getStage(49)===2`, `getStage(50)===3`, `getStage(89)===3`, `getStage(90)===4` by hand-tracing the thresholds (20/50/90 cumulative, matching the design doc's 20+30+40 spec).
3. Confirm `getWeight(0)===30`, `getWeight(90)===400`, `getWeight(45)===` `Math.round(30 + 0.5*370) = 215`.

- [ ] **Step 5: Commit**

```bash
git add bot.js
git commit -m "feat: add settings, growth, and troll-speak transformer helpers"
```

---

### Task 4: `/troll_here` and `/troll` commands

**Files:**
- Modify: `bot.js` (append to the end)

- [ ] **Step 1: Append the commands**

Find this exact text (the last lines of `bot.js` so far — the end of the `trollify` function):
```js
  result = result.split(/(\s+)/).map((token) => (/^[а-яё]+$/i.test(token) ? trollifyWord(token) : token)).join('');
  return result;
}
```
Replace with:
```js
  result = result.split(/(\s+)/).map((token) => (/^[а-яё]+$/i.test(token) ? trollifyWord(token) : token)).join('');
  return result;
}

// --- Public commands: summon and status ---
bot.onText(/\/troll_here\b/, async (msg) => {
  if (!await isTelegramAdmin(msg)) return;
  const existing = db.prepare('SELECT 1 FROM troll_state WHERE id = 1').get();
  if (existing) {
    return bot.sendMessage(msg.chat.id, 'Тролль уже тут. Если хочешь начать заново — /troll_reset в админ-чате.');
  }
  db.prepare(
    'INSERT INTO troll_state (id, chat_id, feed_count, mood, health, message_count) VALUES (1, ?, 0, 50, 100, 0)'
  ).run(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'В деревне появился детёныш тролля и поселился под мостом!');
});

bot.onText(/\/troll\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  const lines = [
    `Здоровье: ${state.health}/100`,
    `Вес: ${getWeight(state.feed_count)} кг`,
    `Настроение: ${moodWord(state.mood)}`,
    `Стадия: ${STAGE_NAMES[getStage(state.feed_count)]}`,
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `bot.js` live yet — there's no real `.env` with a valid token/proxy until Task 9.

1. Confirm `isTelegramAdmin` (Task 2) and `getWeight`/`getStage`/`moodWord`/`STAGE_NAMES` (Task 3) are all referenced correctly.
2. Hand-trace: calling `/troll_here` twice — first call creates the row and announces; second call finds the existing row and refuses with the `/troll_reset` pointer, matching the design doc's explicit "never silently overwrites" requirement.
3. Hand-trace: `/troll` before any `/troll_here` — `state` is `undefined`, correctly shows the "тролля ещё нет" message instead of crashing on `state.health`.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add /troll_here and /troll commands"
```

---

### Task 5: `/play`, `/kick`, `/feed` commands

**Files:**
- Modify: `bot.js` (append to the end)

- [ ] **Step 1: Append the phrase pools and commands**

Find this exact text (the end of the `/troll` command from Task 4):
```js
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});
```
Replace with:
```js
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// --- Public commands: play / kick / feed ---
const PLAY_PHRASES = [
  'Моя мурчать от радость! Твоя хороший друг.',
  'Моя любить, когда твоя играть с моя!',
  'Моя довольный, твоя добрый.',
];

const KICK_PHRASES = [
  'Ай! Твоя злой! Моя обижаться на твоя!',
  'За что твоя моя бить?! Твоя плохой совсем!',
  'Моя злиться на твоя! Твоя уходить!',
];

const FEED_PHRASES = [
  'Ням-ням! Моя кушать вкусно, спасибо твоя!',
  'Моя расти большой от твоя еда!',
  'Моя сытый теперь, твоя хороший.',
];

bot.onText(/\/play\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || isSilenced(state)) return;
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'play');
  bot.sendMessage(msg.chat.id, pick(PLAY_PHRASES));
});

bot.onText(/\/kick\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || isSilenced(state)) return;
  const silencedUntil = Math.floor(Date.now() / 1000) + 60 * 60;
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'kick');
  bot.sendMessage(msg.chat.id, pick(KICK_PHRASES));
});

bot.onText(/\/feed\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || isSilenced(state)) return;
  const newFeedCount = state.feed_count + 1;
  const oldStage = getStage(state.feed_count);
  const newStage = getStage(newFeedCount);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE troll_state SET feed_count = ?, health = MIN(100, health + 30), mood = MIN(100, mood + 5), last_fed_at = ? WHERE id = 1'
  ).run(newFeedCount, now);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'feed');
  bot.sendMessage(msg.chat.id, pick(FEED_PHRASES));
  if (newStage > oldStage) {
    bot.sendMessage(msg.chat.id, `Тролль подрос! Теперь твоя видеть: ${STAGE_NAMES[newStage]}!`);
  }
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `bot.js` live.

1. Confirm `isSilenced`, `logAction`, `pick`, `getStage`, `STAGE_NAMES` (all Task 3) are referenced correctly.
2. Hand-trace `/kick`: sets `silenced_until` to now+1h and drops mood by 20 (floored at 0 via `MAX(0, ...)`) — confirm the SQL's `MAX`/`MIN` clamping matches the design doc's caps.
3. Hand-trace: while silenced (within that hour), `/play`, `/kick`, and `/feed` all hit the `if (!state || isSilenced(state)) return;` guard and do nothing — no response, no state change, matching "полностью игнорирует всё."
4. Hand-trace a feed that crosses a stage threshold, e.g. `state.feed_count = 19` → `newFeedCount = 20` → `oldStage = getStage(19) = 1`, `newStage = getStage(20) = 2` → `newStage > oldStage` → the extra "Тролль подрос!" message fires, naming stage 2 (`подросток`).
5. Confirm a feed that does NOT cross a threshold (e.g. `feed_count 5→6`) does NOT send the extra growth message (`oldStage === newStage`).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add /play, /kick, /feed commands with silence-on-kick"
```

---

### Task 6: Mischief phrase pools, sleep/wake, health tick, and the background timer

**Files:**
- Modify: `bot.js` (append to the end)

- [ ] **Step 1: Append mischief pools, `isNightNow`, `triggerMischief`, and the background tick**

Find this exact text (the end of the `/feed` command from Task 5):
```js
  if (newStage > oldStage) {
    bot.sendMessage(msg.chat.id, `Тролль подрос! Теперь твоя видеть: ${STAGE_NAMES[newStage]}!`);
  }
});
```
Replace with:
```js
  if (newStage > oldStage) {
    bot.sendMessage(msg.chat.id, `Тролль подрос! Теперь твоя видеть: ${STAGE_NAMES[newStage]}!`);
  }
});

// --- Autonomous mischief ---
const MISCHIEF_MILD = [
  'Моя пошутить над курица соседа. Куд-кудах!',
  'Моя бегать голый вокруг мост. Ой, весело!',
  'Моя рассказать смешной история рыба.',
];

const MISCHIEF_MEDIUM = [
  'Моя стащить чужой еда с стол. Ням!',
  'Моя спрятать твоя вещь под мост. Хи-хи.',
  'Моя измазать грязь чужой дверь.',
];

const MISCHIEF_MEAN = [
  'Моя украсть весь еда деревня! Твоя плохой, моя злой!',
  'Моя обозвать твоя всех плохими словами!',
  'Моя сломать что-то нарочно. Моя не жалеть!',
];

function pickMischiefPool(mood, naughtiness) {
  const score = naughtiness - Math.floor(mood / 20);
  if (score >= 7) return MISCHIEF_MEAN;
  if (score >= 4) return MISCHIEF_MEDIUM;
  return MISCHIEF_MILD;
}

function maybeRememberedUser() {
  const row = db.prepare('SELECT username FROM troll_actions ORDER BY RANDOM() LIMIT 1').get();
  return row ? row.username : null;
}

function triggerMischief(chatId) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const pool = pickMischiefPool(state.mood, getSettingNumber('naughtiness'));
  let phrase = pick(pool);
  if (Math.random() < 0.3) {
    const rememberedUser = maybeRememberedUser();
    if (rememberedUser) phrase += ` (твоя как ${rememberedUser}, твоя тоже моя помнить!)`;
  }
  db.prepare('UPDATE troll_state SET last_mischief_at = ? WHERE id = 1').run(Math.floor(Date.now() / 1000));
  bot.sendMessage(chatId, phrase).catch(() => {});
}

function isNightNow() {
  const hour = new Date().getHours();
  const start = getSettingNumber('sleep_start');
  const end = getSettingNumber('sleep_end');
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

const BACKGROUND_TICK_MS = 5 * 60 * 1000;

function backgroundTick() {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return;

  const night = isNightNow();
  if (night && !state.is_asleep) {
    db.prepare('UPDATE troll_state SET is_asleep = 1 WHERE id = 1').run();
    bot.sendMessage(state.chat_id, 'Моя засыпать под мост... *хрррр*...').catch(() => {});
    return;
  }
  if (!night && state.is_asleep) {
    db.prepare('UPDATE troll_state SET is_asleep = 0 WHERE id = 1').run();
  }
  if (night) return;

  const now = Math.floor(Date.now() / 1000);

  if (!state.last_health_tick_at || now - state.last_health_tick_at >= 3600) {
    const neglectHours = getSettingNumber('neglect_threshold_hours');
    const decay = getSettingNumber('health_decay_per_hour');
    const regen = getSettingNumber('health_regen_per_hour');
    const hoursSinceFed = state.last_fed_at ? (now - state.last_fed_at) / 3600 : Infinity;
    if (hoursSinceFed > neglectHours) {
      db.prepare('UPDATE troll_state SET health = MAX(0, health - ?), last_health_tick_at = ? WHERE id = 1').run(decay, now);
    } else {
      db.prepare('UPDATE troll_state SET health = MIN(100, health + ?), last_health_tick_at = ? WHERE id = 1').run(regen, now);
    }
  }

  if (getSetting('paused') !== '1' && !isSilenced(state)) {
    const intervalSeconds = getSettingNumber('mischief_interval_hours') * 3600;
    if (!state.last_mischief_at || now - state.last_mischief_at >= intervalSeconds) {
      triggerMischief(state.chat_id);
    }
  }
}

setInterval(backgroundTick, BACKGROUND_TICK_MS);
```

(`backgroundTick` runs every 5 minutes rather than trying to directly `setInterval` on the admin-configurable `mischief_interval_hours`/hourly-health values — a `setInterval` delay is fixed at creation time and wouldn't pick up later `/troll_set` changes. Instead, each 5-minute tick checks stored timestamps [`last_health_tick_at`, `last_mischief_at`] against the CURRENT setting values, so admin changes take effect on the next tick without restarting anything.)

- [ ] **Step 2: Verify the file parses**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `bot.js` live — `setInterval(backgroundTick, ...)` would start running against a fake/missing token's `bot.sendMessage` calls, which will just fail silently (caught by `.catch(() => {})` where present) but there's no reason to actually run it yet.

1. Confirm `pickMischiefPool`'s `score` formula: `naughtiness (1-10) - Math.floor(mood/20)` (mood 0-100 → 0-5) ranges roughly -5 to 10; `score>=7` → mean, `score>=4` → medium, else mild. Hand-trace: `naughtiness=5, mood=50` → `score = 5 - 2 = 3` → mild. `naughtiness=9, mood=10` → `score = 9 - 0 = 9` → mean.
2. Confirm the sleep-transition logic fires the "falling asleep" message exactly once (on the tick where `night` first becomes true while `is_asleep` was `0`), then `return`s immediately without also running health-tick/mischief logic that same tick — matching "one announcement, then quiet."
3. Confirm the wake-transition (`!night && state.is_asleep`) resets `is_asleep` to `0` and falls through to health/mischief logic THE SAME tick it wakes up (no `return` after the wake branch) — so health/mischief can resume immediately at `sleep_end`, not one tick late.
4. Confirm `isNightNow()` handles the default `sleep_start=0, sleep_end=8` case correctly (`start < end` branch: `hour >= 0 && hour < 8`), and would also handle a hypothetical wrap-around range like `sleep_start=22, sleep_end=6` via the `start > end` branch (`hour >= 22 || hour < 6`) if an admin ever configured it that way.
5. Confirm `getActiveVirusProcedureTypes`-style lazy-expiry isn't needed here — `isSilenced` just compares a timestamp, no cleanup required (matches `tg-bot`'s own `isMuted` pattern).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add mischief phrase pools, sleep/wake cycle, and background health/mischief tick"
```

---

### Task 7: Message-triggered mischief

**Files:**
- Modify: `bot.js` (append to the end)

- [ ] **Step 1: Append the message handler**

Find this exact text (the end of Task 6's addition):
```js
setInterval(backgroundTick, BACKGROUND_TICK_MS);
```
Replace with:
```js
setInterval(backgroundTick, BACKGROUND_TICK_MS);

// --- Message-triggered mischief ---
bot.on('message', (msg) => {
  if (msg.from?.is_bot) return;
  if (msg.text && msg.text.startsWith('/')) return;
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return;
  const newCount = state.message_count + 1;
  db.prepare('UPDATE troll_state SET message_count = ? WHERE id = 1').run(newCount);
  if (getSetting('paused') === '1' || isSilenced(state) || isNightNow()) return;
  const trigger = getSettingNumber('mischief_message_trigger');
  if (newCount % trigger === 0) {
    triggerMischief(msg.chat.id);
  }
});
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `bot.js` live.

1. Confirm command messages (`msg.text.startsWith('/')`) and the troll bot's own messages (`msg.from?.is_bot`) are excluded from incrementing `message_count`, matching the design doc's clarified note (added during spec self-review) that this counter mirrors `tg-bot`'s own convention of not counting commands.
2. Hand-trace: `message_count` at 49 → new message → `newCount = 50` → `50 % 50 === 0` → mischief fires (assuming not paused/silenced/night).
3. Confirm this counter increments even while the troll is asleep (the `if (... || isNightNow()) return;` guard only skips the MISCHIEF TRIGGER check, not the counter increment above it) — so a message sent right at `sleep_end` can immediately trigger mischief if it happens to land on a multiple of the trigger, rather than needing to "wait" for lost counts. Confirm this is intentional (the counter is a simple monotonic tally, not reset by sleep) and not a bug.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: trigger mischief on every Nth chat message"
```

---

### Task 8: Admin commands, then start polling

**Files:**
- Modify: `bot.js` (append to the end)

- [ ] **Step 1: Append the admin commands and the polling-loop start**

Find this exact text (the end of Task 7's addition):
```js
  if (newCount % trigger === 0) {
    triggerMischief(msg.chat.id);
  }
});
```
Replace with:
```js
  if (newCount % trigger === 0) {
    triggerMischief(msg.chat.id);
  }
});

// --- Admin commands (admin chat only) ---
bot.onText(/\/troll_set (\S+) (.+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const key = match[1];
  const value = match[2];
  if (!(key in DEFAULT_SETTINGS)) {
    return bot.sendMessage(msg.chat.id, `Неизвестная настройка: ${key}`);
  }
  setSetting(key, value);
  bot.sendMessage(msg.chat.id, `${key} = ${value}`);
});

bot.onText(/\/troll_settings\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const lines = Object.keys(DEFAULT_SETTINGS).map((key) => `${key} = ${getSetting(key)}`);
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/\/troll_pause\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  setSetting('paused', '1');
  bot.sendMessage(msg.chat.id, 'Шалости на паузе.');
});

bot.onText(/\/troll_resume\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  setSetting('paused', '0');
  bot.sendMessage(msg.chat.id, 'Шалости снова включены.');
});

bot.onText(/\/troll_reset\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  db.exec('DELETE FROM troll_state');
  db.exec('DELETE FROM troll_actions');
  bot.sendMessage(msg.chat.id, 'Тролль сброшен. Используй /troll_here в публичном чате, чтобы призвать нового.');
});

bot.onText(/\/troll_say ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  bot.sendMessage(state.chat_id, trollify(match[1]));
});

// --- Polling ---
let offset = undefined;

async function skipOldUpdates() {
  try {
    const updates = await Promise.race([
      bot.getUpdates({ offset: -1, limit: 1, timeout: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (updates.length > 0) offset = updates[updates.length - 1].update_id + 1;
  } catch {}
}

async function poll() {
  try {
    const params = { timeout: 0, limit: 10 };
    if (offset !== undefined) params.offset = offset;
    const updates = await Promise.race([
      bot.getUpdates(params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('poll timeout')), 5000))
    ]);
    for (const update of updates) {
      offset = update.update_id + 1;
      bot.processUpdate(update);
    }
  } catch (err) {
    if (err.message !== 'poll timeout') console.error('poll error:', err.message);
  }
  setTimeout(poll, 1000);
}
skipOldUpdates().then(() => poll());

console.log('Тролль-бот запущен...');
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `bot.js` live yet — Task 9 is the first task where a real token/proxy/admin-chat-id exists.

1. Confirm `/troll_set (\S+) (.+)` never accidentally matches `/troll_settings` (no space follows `troll_set` in that string, so the regex — which requires a literal space right after `troll_set` — cannot match it) and vice versa (`/troll_settings\b` requires the literal substring `settings`, which `/troll_set naughtiness 7` doesn't contain). Confirm by re-reading both patterns side by side.
2. Confirm `/troll_set` rejects unknown keys (checks `key in DEFAULT_SETTINGS`) rather than silently accepting typos that would never be read back by any `getSetting`/`getSettingNumber` call.
3. Confirm `/troll_reset` clears BOTH `troll_state` and `troll_actions` (memory wipe too, per the design doc), but leaves `troll_settings` untouched (admin-tuned settings should survive a troll reset, not revert to defaults) — re-read the two `DELETE` statements to confirm neither touches `troll_settings`.
4. Confirm the polling-loop code is verbatim identical in structure to `tg-bot`'s own (same `skipOldUpdates`/`poll`/timeout-race pattern), placed at the very end of the file, after every `bot.onText`/`bot.on` registration — matching where `tg-bot` starts its own polling.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: add admin commands (/troll_set, /troll_settings, /troll_pause, /troll_resume, /troll_reset, /troll_say) and start polling"
```

---

### Task 9: Create the real bot account, deploy, and full smoke test

**Files:** none (external setup + verification only)

- [ ] **Step 1: Create the troll's Telegram bot account**

In Telegram, message `@BotFather`:
1. `/newbot` → give it a display name (e.g. "Тролль под мостом") and a unique `@username` ending in `bot` (e.g. `dedo_troll_bot`).
2. BotFather replies with an API token — save it, you'll need it for `.env`.
3. `/setuserpic` → pick the same bot, upload a troll avatar image.
4. Add the new bot to the SAME public group `tg-bot` is already in (as a normal member — it needs to see messages, so if the group has "privacy mode" concerns, also send `@BotFather` → `/mybots` → pick the troll bot → **Bot Settings** → **Group Privacy** → **Turn off**, so it can see every message, not just commands addressed to it — required for the every-Nth-message mischief counter and the general message-count tracking to work).
5. Create or pick a second, separate chat (can be a private one-on-one chat with the bot, or a small private group with just the admins) to serve as the admin chat, and add the troll bot there too.
6. Get that admin chat's numeric ID — easiest way: temporarily add `console.log(update)` style debugging, OR message the admin chat once the bot is running locally with logging and read the `chat.id` from the console output, OR use a helper bot like `@getidsbot` in that chat.

- [ ] **Step 2: Fill in `.env` locally**

Create `c:\Users\123\Projects\troll-bot\.env` (gitignored, never committed):
```
BOT_TOKEN=<token from BotFather>
PROXY_URL=<same proxy value tg-bot's .env uses, if tg-bot needs one to reach Telegram from this network>
ADMIN_CHAT_ID=<numeric chat id of the admin chat>
```

- [ ] **Step 3: Push to GitHub**

Ask the user whether they want a GitHub remote created for `troll-bot` (mirroring `tg-bot`'s `xvisible1985/Try_bot` setup) before pushing — this is a brand-new repo with no existing remote, so `git push` needs an explicit remote URL the user provides or approves, unlike `tg-bot`'s existing-remote pushes used throughout this whole project so far.

- [ ] **Step 4: Deploy on the prod server (same server as tg-bot)**

```bash
git clone <troll-bot repo URL> ~/troll-bot
cd ~/troll-bot
npm ci --production
```
Create `.env` on the server the same way as Step 2 (with the real values). Then register it with PM2, the same process manager already running `tg-bot`:
```bash
pm2 start bot.js --name troll-bot
pm2 save
```

- [ ] **Step 5: Full manual playthrough in the real public + admin chats**

1. In the public chat: `/troll_here` (as a Telegram admin there) — confirm the arrival announcement.
2. `/troll` — confirm the status card (health 100, weight 30, "нормальный" or similar mood word, "малыш").
3. `/play`, then `/troll` again — confirm mood word improves.
4. `/kick` — confirm the offended/cursing response, then immediately `/play` again — confirm TOTAL silence (no response at all) for the next hour.
5. Wait out (or temporarily lower `neglect_threshold_hours`/shorten the silence via direct `UPDATE troll_state SET silenced_until = 0;` on the server for testing purposes only, not in production use) the silence window, then `/feed` repeatedly — confirm weight climbs and, once `feed_count` crosses 20, a "Тролль подрос!" message appears alongside the normal feed response.
6. In the admin chat: `/troll_settings` — confirm all 9 settings show their current values. `/troll_set naughtiness 10` — confirm the mischief messages start leaning meaner. `/troll_pause` — confirm autonomous mischief stops (background tick and message-trigger both silent) while `/play`/`/feed`/`/kick` keep working. `/troll_resume` — confirm mischief resumes.
7. `/troll_say привет я тебя вижу` in the admin chat — confirm the public chat receives a troll-speak-transformed version (pronouns swapped, verbs roughly infinitive-ified) from the troll bot's own account.
8. `/troll_reset` in the admin chat — confirm the public chat's troll state and memory are gone, and a fresh `/troll_here` works again.

- [ ] **Step 6: Report back**

No commit needed for this task beyond what Step 3 already covers — this is final live verification.

---

## Self-Review Notes

- **Spec coverage:** two chats + admin gate (Task 2), schema incl. settings defaults (Task 2), growth/weight/mood-word/troll-speak helpers (Task 3), summon/status (Task 4), play/kick/feed + silence (Task 5), sleep-wake/health/timer-mischief (Task 6), message-triggered mischief (Task 7), all 6 admin commands (Task 8), real bot account + deploy + full smoke test (Task 9) — every section of the design doc maps to a task.
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output. `.env` values in Task 9 are necessarily left as user-filled blanks (`<token from BotFather>` etc.) since only the user can create the real bot account and determine the real proxy/chat-id values — this is the one place literal placeholders are unavoidable, and it's clearly an external-action step, not a code step.
- **Type/name consistency:** `isAdminChat`, `isTelegramAdmin`, `getSetting`/`getSettingNumber`/`setSetting`, `pick`, `isSilenced`, `logAction`, `getStage`/`getWeight`/`moodWord`/`STAGE_NAMES`, `trollify`/`trollifyWord`, `pickMischiefPool`, `maybeRememberedUser`, `triggerMischief`, `isNightNow`, `backgroundTick` are each defined exactly once (Tasks 2/3/6) and referenced identically everywhere else (Tasks 4/5/6/7/8).
- **Spec deviation, called out explicitly:** dropped the `stage` column from the schema (Task 2's note) in favor of always deriving it from `feed_count` via `getStage()` — a stricter, simpler reading of the design doc's own "not tracked as independent state that could desync" line, not a contradiction of the documented behavior (every user-visible effect — `/troll`'s displayed stage, the "Тролль подрос!" announcement — is identical either way). Also added `is_asleep`/`last_health_tick_at`/`last_mischief_at` columns beyond the design doc's literal schema table, needed so the background tick can respect `/troll_set`-changed intervals at runtime; this is implementation detail in service of documented behavior, not new behavior.
