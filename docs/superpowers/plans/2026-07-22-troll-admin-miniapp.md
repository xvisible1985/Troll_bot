# Troll Admin Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram Mini App admin panel for `troll-bot` — a second, independent Express process (`admin-server.js`) serving a small UI (status, settings sliders, phrase CRUD, relationships, troll_say) over the same `troll.db`, authenticated via Telegram's signed `initData` plus admin-chat membership.

**Architecture:** `admin-server.js` (Express, port 4100, own PM2 entry) + `admin-lib.js` (DB access + small pure helpers, deliberately duplicated from `bot.js` rather than shared — see Task 1's note) + `admin-auth.js` (initData verification + cached admin check) + a static frontend in `public/` (vanilla HTML/CSS/JS, no build step, no framework — see the note at the end of this header). One tiny addition to the existing `bot.js`: a `/troll_panel` command that opens the app via an inline `web_app` button.

**Tech Stack:** Express, Multer (photo upload for `/api/say`), the same `better-sqlite3`/`node-telegram-bot-api`/proxy-agent stack `bot.js` already uses. No test framework — verification via `node --check`, hand-tracing, and throwaway `node -e` scripts, matching this project's established convention.

**Note on frontend framework:** the design spec mentioned "a light framework (Vue via CDN)" as a possibility, but the mockup you approved (published as an Artifact and confirmed with "ок") is plain vanilla HTML/CSS/JS with no framework at all — this plan builds exactly that approved mockup, wired to real data. If you want Vue layered in later, that's a separate, later change; flagging this explicitly since it's a deviation from an earlier, more abstract preference in favor of the concrete thing you actually signed off on.

Full design: `docs/superpowers/specs/2026-07-22-troll-admin-miniapp-design.md`.

**IMPORTANT:** Do not run `admin-server.js` or `bot.js` against a real `.env`/token during development — verification is `node --check` plus static/throwaway-script checks only. The one exception is Task 7's final live smoke test, which is explicitly deploy-and-test-driven by you, not run by an agent.

---

### Task 1: `admin-lib.js` — DB access and duplicated pure helpers

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\package.json`
- Create: `c:\Users\123\Projects\troll-bot\admin-lib.js`

- [ ] **Step 1: Add `express` and `multer` to `package.json`**

Find this exact text:
```json
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "dotenv": "^16.0.0",
    "https-proxy-agent": "^5.0.1",
    "node-telegram-bot-api": "^0.66.0",
    "socks-proxy-agent": "^10.1.0"
  }
```
Replace with:
```json
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "dotenv": "^16.0.0",
    "express": "^4.21.0",
    "https-proxy-agent": "^5.0.1",
    "multer": "^1.4.5-lts.1",
    "node-telegram-bot-api": "^0.66.0",
    "socks-proxy-agent": "^10.1.0"
  }
```

- [ ] **Step 2: Run `npm install`**

From `c:\Users\123\Projects\troll-bot`: `npm install`
Expected: `express` and `multer` appear in `node_modules/`, `package-lock.json` updates, no errors.

- [ ] **Step 3: Create `admin-lib.js`**

```js
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'troll.db'));

// --- Settings ---
const DEFAULT_SETTINGS_KEYS = [
  'sleep_start', 'sleep_end', 'naughtiness', 'mischief_interval_hours',
  'mischief_message_trigger', 'health_decay_per_hour', 'health_regen_per_hour',
  'neglect_threshold_hours', 'paused', 'attitude_play_delta', 'attitude_feed_delta',
  'attitude_kick_delta', 'attitude_escalation_threshold',
];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM troll_settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO troll_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const result = {};
  for (const key of DEFAULT_SETTINGS_KEYS) {
    result[key] = getSetting(key);
  }
  return result;
}

// --- Growth (duplicated from bot.js — admin-server.js is a separate process
// that must NOT require('./bot.js') directly, since that file has top-level
// side effects: constructing a polling TelegramBot and starting the long-poll
// loop immediately on require, which would race the real troll-bot process
// exactly like the getUpdates 409 conflict this project hit earlier. These
// helpers are small, pure, and unlikely to drift — an accepted duplication
// rather than refactoring the already-deployed, working bot.js just to share
// code with a new admin tool.) ---
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

function isSilenced(state) {
  return !!state.silenced_until && state.silenced_until * 1000 > Date.now();
}

function getActivityLine(state) {
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  const rows = db.prepare("SELECT text FROM troll_phrases WHERE category = 'activity_awake'").all();
  if (rows.length === 0) return 'бродит под мостом';
  return rows[Math.floor(Math.random() * rows.length)].text;
}

// --- Troll-speak transformer (duplicated from bot.js for the same reason) ---
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
  result = result.replace(/[а-яёА-ЯЁ]+/g, (word) => trollifyWord(word));
  return result;
}

module.exports = {
  db,
  DEFAULT_SETTINGS_KEYS,
  getSetting,
  setSetting,
  getAllSettings,
  STAGE_NAMES,
  getStage,
  getWeight,
  moodWord,
  isSilenced,
  getActivityLine,
  trollify,
};
```

- [ ] **Step 4: Verify**

Run: `node --check admin-lib.js` — expect no output.

Then, from `c:\Users\123\Projects\troll-bot` (this touches the real `troll.db` the actual `bot.js` also uses — that's fine, it's read/write, not schema-creating, and this project's `troll.db` is gitignored local dev data, not shared with anyone):
```bash
node -e "
const lib = require('./admin-lib');
console.log(lib.getStage(19), lib.getStage(20), lib.getStage(89), lib.getStage(90));
console.log(lib.getWeight(0), lib.getWeight(90));
console.log(lib.moodWord(80), lib.moodWord(10));
console.log(lib.trollify('Ты меня обидел.'));
console.log(Object.keys(lib.getAllSettings()));
"
```
Expected: `1 2 3 4`, `30 400`, `весёлый злой`, `Твоя моя обидел.`, and an array of the 13 setting keys (values will be `undefined` for any key not yet present in whatever `troll.db` happens to exist locally — that's fine, this is just confirming the function runs and returns the right shape, not asserting real values).

- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json admin-lib.js
git commit -m "feat(admin): add admin-lib.js with DB access and duplicated pure helpers"
```

---

### Task 2: `admin-auth.js` — initData verification and admin-chat check

**Files:** Create `c:\Users\123\Projects\troll-bot\admin-auth.js`

- [ ] **Step 1: Create the file**

```js
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const proxy = process.env.PROXY_URL;

let agent;
if (proxy) {
  const agentOpts = { keepAlive: true, keepAliveMsecs: 60000, maxSockets: 5, maxFreeSockets: 3 };
  agent = proxy.startsWith('socks') ? new SocksProxyAgent(proxy, agentOpts) : new HttpsProxyAgent(proxy, agentOpts);
}

// polling: false — this process only ever calls one-off REST methods
// (getChatMember), never getUpdates, so there is no risk of racing the real
// troll-bot process's poll loop the way two concurrent getUpdates callers
// would (the 409 conflict this project hit earlier was specifically that).
const bot = new TelegramBot(BOT_TOKEN, { polling: false, request: { agent } });

// Telegram's documented Mini App initData verification algorithm.
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

const adminCache = new Map();
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function isAdmin(userId) {
  const cached = adminCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < ADMIN_CACHE_TTL_MS) {
    return cached.isAdmin;
  }
  let result = false;
  try {
    const member = await bot.getChatMember(ADMIN_CHAT_ID, userId);
    result = ['creator', 'administrator'].includes(member.status);
  } catch {
    result = false;
  }
  adminCache.set(userId, { isAdmin: result, checkedAt: Date.now() });
  return result;
}

async function requireAdmin(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data');
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const allowed = await isAdmin(user.id);
  if (!allowed) return res.status(403).json({ error: 'not an admin' });
  req.telegramUser = user;
  next();
}

module.exports = { bot, verifyInitData, isAdmin, requireAdmin };
```

- [ ] **Step 2: Verify**

Run: `node --check admin-auth.js` — expect no output.

- [ ] **Step 3: Throwaway self-consistency test for `verifyInitData`**

This is a **self-consistency** check only — it constructs and signs a fake payload with `verifyInitData`'s own algorithm and confirms the function accepts what it itself considers validly signed, and rejects tampering. It does **not** prove compatibility with Telegram's real client-signed `initData` — that can only be confirmed by actually opening the deployed Mini App from Telegram, which is Task 7's live smoke test. Do not skip Task 7's live check on the assumption this static test already proved it.

```bash
node -e "
process.env.BOT_TOKEN = 'fake-token-for-test';
process.env.ADMIN_CHAT_ID = '123';
const crypto = require('crypto');
const { verifyInitData } = require('./admin-auth');

function sign(params, botToken) {
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(\`\${k}=\${v}\`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  return crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

const user = JSON.stringify({ id: 42, first_name: 'Test' });
const params = new URLSearchParams({ user, auth_date: String(Math.floor(Date.now() / 1000)) });
const hash = sign(params, 'fake-token-for-test');
params.set('hash', hash);
const goodInitData = params.toString();

const result = verifyInitData(goodInitData);
console.log('valid signature accepted:', result && result.id === 42);

const tampered = goodInitData.replace('Test', 'Hax0r');
console.log('tampered payload rejected:', verifyInitData(tampered) === null);

const oldParams = new URLSearchParams({ user, auth_date: String(Math.floor(Date.now() / 1000) - 90000) });
oldParams.set('hash', sign(oldParams, 'fake-token-for-test'));
console.log('stale auth_date (>24h) rejected:', verifyInitData(oldParams.toString()) === null);
"
```
Expected: `valid signature accepted: true`, `tampered payload rejected: true`, `stale auth_date (>24h) rejected: true`.

- [ ] **Step 4: Manual verification (static only)**
1. Confirm `requireAdmin` returns `401` before ever calling `isAdmin`/Telegram if `verifyInitData` fails — no wasted API call for an already-invalid request.
2. Confirm the admin cache is keyed by `userId`, not by anything request-specific, so repeated calls from the same admin within 5 minutes skip the `getChatMember` call entirely.

- [ ] **Step 5: Commit**
```bash
git add admin-auth.js
git commit -m "feat(admin): add initData verification and cached admin-chat membership check"
```

---

### Task 3: `admin-server.js` — Express app and API routes

**Files:** Create `c:\Users\123\Projects\troll-bot\admin-server.js`

- [ ] **Step 1: Create the file**

```js
require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  db, getSetting, setSetting, getAllSettings, DEFAULT_SETTINGS_KEYS,
  STAGE_NAMES, getStage, getWeight, moodWord, getActivityLine, trollify,
} = require('./admin-lib');
const { bot, requireAdmin } = require('./admin-auth');

const PORT = 4100;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const api = express.Router();
api.use(requireAdmin);

api.get('/status', (req, res) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return res.json({ exists: false });
  res.json({
    exists: true,
    health: state.health,
    mood: state.mood,
    moodWord: moodWord(state.mood),
    weight: getWeight(state.feed_count),
    stage: getStage(state.feed_count),
    stageName: STAGE_NAMES[getStage(state.feed_count)],
    activity: getActivityLine(state),
    paused: getSetting('paused') === '1',
  });
});

api.get('/settings', (req, res) => {
  res.json(getAllSettings());
});

api.put('/settings', (req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    if (!DEFAULT_SETTINGS_KEYS.includes(key)) continue;
    setSetting(key, value);
  }
  res.json(getAllSettings());
});

api.get('/phrases', (req, res) => {
  const rows = db.prepare('SELECT id, category, text FROM troll_phrases ORDER BY category, id').all();
  res.json(rows);
});

api.post('/phrases', (req, res) => {
  const { category, text } = req.body || {};
  if (!category || !text) return res.status(400).json({ error: 'category and text required' });
  const info = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)').run(category, text);
  res.json({ id: info.lastInsertRowid, category, text });
});

api.put('/phrases/:id', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const info = db.prepare('UPDATE troll_phrases SET text = ? WHERE id = ?').run(text, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ id: Number(req.params.id), text });
});

api.delete('/phrases/:id', (req, res) => {
  const info = db.prepare('DELETE FROM troll_phrases WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

api.post('/pause', (req, res) => {
  setSetting('paused', '1');
  res.json({ paused: true });
});

api.post('/resume', (req, res) => {
  setSetting('paused', '0');
  res.json({ paused: false });
});

api.post('/reset', (req, res) => {
  db.exec('DELETE FROM troll_state');
  db.exec('DELETE FROM troll_actions');
  res.json({ ok: true });
});

api.get('/relationships', (req, res) => {
  const rows = db.prepare('SELECT * FROM troll_relationships ORDER BY last_seen_at DESC').all();
  res.json(rows);
});

api.put('/relationships/:userId', (req, res) => {
  const { attitude } = req.body || {};
  if (typeof attitude !== 'number') return res.status(400).json({ error: 'attitude must be a number' });
  const clamped = Math.max(-100, Math.min(100, Math.round(attitude)));
  const info = db.prepare('UPDATE troll_relationships SET attitude = ? WHERE user_id = ?').run(clamped, req.params.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ userId: Number(req.params.userId), attitude: clamped });
});

api.post('/say', upload.single('photo'), async (req, res) => {
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return res.status(404).json({ error: 'no troll yet' });
  const text = (req.body && req.body.text) || '';
  if (!text) return res.status(400).json({ error: 'text required' });
  const caption = trollify(text);
  try {
    if (req.file) {
      await bot.sendPhoto(state.chat_id, req.file.buffer, { caption });
    } else {
      await bot.sendMessage(state.chat_id, caption);
    }
    res.json({ ok: true, sent: caption });
  } catch (err) {
    res.status(502).json({ error: 'telegram send failed', detail: err.message });
  }
});

app.use('/api', api);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Админ-панель слушает на 127.0.0.1:${PORT}`);
});
```

- [ ] **Step 2: Verify**

Run: `node --check admin-server.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**

Do NOT run `admin-server.js` live yet (no real `.env`/token locally, and `public/` doesn't exist until Task 4 — `express.static` pointing at a missing directory is harmless, but there's nothing to serve yet either way).

1. Confirm every route under `api.*` sits after `api.use(requireAdmin)`, so all of them require a valid, admin-verified request — re-read the file top to bottom to confirm no route is accidentally registered on `app` directly (bypassing the router's auth middleware) instead of on `api`.
2. Confirm `/api/settings` PUT only writes keys that are in `DEFAULT_SETTINGS_KEYS` (ignores anything else in the request body) — so a malformed or malicious request body can't write arbitrary keys into `troll_settings`.
3. Confirm `/api/say`'s photo path uses `req.file.buffer` (in-memory, from `multer.memoryStorage()`) directly as the `sendPhoto` argument — `node-telegram-bot-api` accepts a `Buffer` directly for file-upload parameters, no temp file needed.

- [ ] **Step 4: Commit**
```bash
git add admin-server.js
git commit -m "feat(admin): add Express admin-server.js with the full API surface"
```

---

### Task 4: Frontend markup and styles

**Files:**
- Create: `c:\Users\123\Projects\troll-bot\public\index.html`
- Create: `c:\Users\123\Projects\troll-bot\public\style.css`

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Тролль под мостом</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="topbar-row">
      <div class="troll-badge">🧌</div>
      <div class="troll-title">
        <h1 class="display">Тролль под мостом</h1>
        <div class="sub" id="troll-sub">загрузка…</div>
      </div>
    </div>
    <div class="status-chips" id="status-chips"></div>
  </div>

  <nav class="tabs" role="tablist">
    <button class="tab-btn active" data-tab="status">Статус</button>
    <button class="tab-btn" data-tab="settings">Настройки</button>
    <button class="tab-btn" data-tab="phrases">Фразы</button>
    <button class="tab-btn" data-tab="relationships">Отношения</button>
    <button class="tab-btn" data-tab="say">Сказать</button>
  </nav>

  <main>
    <section class="panel active" id="panel-status"></section>
    <section class="panel" id="panel-settings"></section>
    <section class="panel" id="panel-phrases"></section>
    <section class="panel" id="panel-relationships"></section>
    <section class="panel" id="panel-say"></section>
  </main>
</div>
<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/style.css`**

```css
:root {
  --stone: #ece7da;
  --stone-dim: #ddd6c4;
  --ink: #20241f;
  --moss: #5c7a52;
  --moss-deep: #465e3e;
  --lichen: #9caf77;
  --amber: #c97c3d;
  --amber-deep: #a35f28;
  --slate: #6b7268;

  --bg: var(--stone);
  --bg-raised: #f6f3ea;
  --bg-sunken: var(--stone-dim);
  --text: var(--ink);
  --text-muted: var(--slate);
  --border: #d8d1bd;
  --accent: var(--moss);
  --accent-deep: var(--moss-deep);
  --accent-contrast: #f6f3ea;
  --positive: var(--lichen);
  --warning: var(--amber);
  --warning-deep: var(--amber-deep);
  --shadow: 0 1px 2px rgba(32, 36, 31, 0.06), 0 4px 14px rgba(32, 36, 31, 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181c16;
    --bg-raised: #21261e;
    --bg-sunken: #14170f;
    --text: #e9e6d8;
    --text-muted: #9aa08e;
    --border: #343a2c;
    --accent: #8bab7a;
    --accent-deep: #b6cba3;
    --accent-contrast: #14170f;
    --positive: #b6cba3;
    --warning: #e0a05c;
    --warning-deep: #f0c090;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}
:root[data-theme="dark"] {
  --bg: #181c16; --bg-raised: #21261e; --bg-sunken: #14170f;
  --text: #e9e6d8; --text-muted: #9aa08e; --border: #343a2c;
  --accent: #8bab7a; --accent-deep: #b6cba3; --accent-contrast: #14170f;
  --positive: #b6cba3; --warning: #e0a05c; --warning-deep: #f0c090;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
}
:root[data-theme="light"] {
  --bg: var(--stone); --bg-raised: #f6f3ea; --bg-sunken: var(--stone-dim);
  --text: var(--ink); --text-muted: var(--slate); --border: #d8d1bd;
  --accent: var(--moss); --accent-deep: var(--moss-deep); --accent-contrast: #f6f3ea;
  --positive: var(--lichen); --warning: var(--amber); --warning-deep: var(--amber-deep);
  --shadow: 0 1px 2px rgba(32, 36, 31, 0.06), 0 4px 14px rgba(32, 36, 31, 0.06);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; overflow-x: hidden; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
.display { font-family: Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }

.app { max-width: 480px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); }

.topbar { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); padding: 14px 16px 10px; }
.topbar-row { display: flex; align-items: center; gap: 12px; }
.troll-badge {
  width: 44px; height: 44px; border-radius: 12px;
  background: linear-gradient(160deg, var(--moss) 0%, var(--moss-deep) 100%);
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; flex-shrink: 0; box-shadow: var(--shadow);
}
.troll-title { flex: 1; min-width: 0; }
.troll-title h1 { font-family: Iowan Old Style, Palatino Linotype, Georgia, serif; font-size: 19px; letter-spacing: 0.01em; margin: 0; line-height: 1.2; }
.troll-title .sub { font-size: 12.5px; color: var(--text-muted); margin-top: 2px; letter-spacing: 0.01em; }
.status-chips { display: flex; gap: 6px; margin-top: 12px; overflow-x: auto; padding-bottom: 2px; }
.chip { display: flex; align-items: center; gap: 5px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px 5px 8px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
.chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--positive); }
.chip.warn .dot { background: var(--warning); }
.chip b { font-weight: 600; }

.tabs { display: flex; gap: 4px; padding: 10px 12px; overflow-x: auto; background: var(--bg); border-bottom: 1px solid var(--border); position: sticky; top: 84px; z-index: 4; }
.tab-btn { appearance: none; border: 1px solid transparent; background: transparent; color: var(--text-muted); font-size: 13px; font-weight: 600; padding: 7px 12px; border-radius: 999px; white-space: nowrap; cursor: pointer; letter-spacing: 0.01em; }
.tab-btn.active { background: var(--accent); color: var(--accent-contrast); }
.tab-btn:not(.active):hover { background: var(--bg-raised); color: var(--text); }
.tab-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

main { flex: 1; padding: 16px 16px 40px; }
.panel { display: none; }
.panel.active { display: block; animation: fade 0.18s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }

.card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 14px; padding: 16px; box-shadow: var(--shadow); }
.card + .card { margin-top: 12px; }
.eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-muted); font-weight: 600; margin: 0 0 10px; }

.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stat { background: var(--bg-sunken); border-radius: 10px; padding: 10px 12px; }
.stat .label { font-size: 11.5px; color: var(--text-muted); }
.stat .value { font-size: 18px; font-weight: 700; margin-top: 2px; }
.bar-track { height: 6px; background: var(--border); border-radius: 999px; margin-top: 8px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: var(--accent); }
.activity-line { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border); font-size: 13.5px; color: var(--text-muted); display: flex; gap: 8px; align-items: flex-start; }

.setting-row { padding: 12px 0; }
.setting-row + .setting-row { border-top: 1px solid var(--border); }
.setting-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; gap: 8px; }
.setting-name { font-size: 13.5px; font-weight: 600; }
.setting-value { font-size: 13px; color: var(--accent-deep); font-weight: 700; flex-shrink: 0; }
input[type="range"] { width: 100%; accent-color: var(--accent); height: 20px; }

.category { border-bottom: 1px solid var(--border); }
.category:last-child { border-bottom: none; }
.category-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 2px; cursor: pointer; gap: 10px; }
.category-head .name { font-size: 13.5px; font-weight: 600; }
.category-head .count { font-size: 11.5px; color: var(--text-muted); background: var(--bg-sunken); padding: 2px 8px; border-radius: 999px; }
.category-head .chevron { color: var(--text-muted); transition: transform 0.15s; font-size: 12px; }
.category.open .chevron { transform: rotate(90deg); }
.category-body { display: none; padding: 0 2px 12px; }
.category.open .category-body { display: block; }
.phrase-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; font-size: 13px; }
.phrase-item .text { flex: 1; line-height: 1.4; }
.phrase-item .icon-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 4px; font-size: 13px; flex-shrink: 0; }
.phrase-item .icon-btn:hover { color: var(--accent-deep); }
.add-phrase-row { display: flex; gap: 8px; margin-top: 8px; }
.add-phrase-row input { flex: 1; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-sunken); color: var(--text); }
.btn { appearance: none; border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; background: var(--accent); color: var(--accent-contrast); }
.btn:hover { background: var(--accent-deep); }
.btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
.btn.ghost:hover { background: var(--bg-sunken); }

.person-row { display: flex; align-items: center; gap: 10px; padding: 11px 0; cursor: pointer; }
.person-row + .person-row { border-top: 1px solid var(--border); }
.avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--bg-sunken); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: var(--text-muted); flex-shrink: 0; }
.person-main { flex: 1; min-width: 0; }
.person-name { font-size: 13.5px; font-weight: 600; }
.person-meta { font-size: 11.5px; color: var(--text-muted); margin-top: 1px; }
.attitude-wrap { width: 96px; flex-shrink: 0; }
.attitude-bar { height: 6px; border-radius: 999px; background: var(--border); position: relative; overflow: hidden; }
.attitude-bar .mid-tick { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--text-muted); opacity: 0.4; }
.attitude-bar .fill { position: absolute; top: 0; bottom: 0; border-radius: 999px; }
.attitude-num { font-size: 11px; text-align: right; margin-top: 3px; font-weight: 700; }

textarea { width: 100%; min-height: 84px; font-size: 13.5px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-sunken); color: var(--text); font-family: inherit; resize: vertical; }
.attach-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12.5px; color: var(--text-muted); }
.say-actions { display: flex; justify-content: flex-end; margin-top: 12px; }

::-webkit-scrollbar { height: 0; width: 0; }
```

- [ ] **Step 3: Verify**

Since these are static files with no JS logic, verification is visual/manual only: open `public/index.html` directly in a browser (double-click, or `file://` URL — no server needed for this check) and confirm the top bar, empty tab strip, and card styling render without console errors (the tabs won't switch yet, and no data will load — that's `app.js`, Task 5).

- [ ] **Step 4: Commit**
```bash
git add public/index.html public/style.css
git commit -m "feat(admin): add frontend markup and styles (from the approved mockup)"
```

---

### Task 5: Frontend logic — `public/app.js`

**Files:** Create `c:\Users\123\Projects\troll-bot\public\app.js`

- [ ] **Step 1: Create the file**

```js
const initData = window.Telegram?.WebApp?.initData || '';
if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ 'X-Telegram-Init-Data': initData }, options.headers || {});
  const res = await fetch('/api' + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

const SETTING_LABELS = {
  naughtiness: 'Вредность',
  mischief_message_trigger: 'Шалость раз в N сообщений',
  mischief_interval_hours: 'Интервал шалости, ч',
  sleep_start: 'Засыпает в (час)',
  sleep_end: 'Просыпается в (час)',
  neglect_threshold_hours: 'Забвение до упадка, ч',
  health_decay_per_hour: 'Упадок здоровья/ч',
  health_regen_per_hour: 'Восстановление здоровья/ч',
  attitude_play_delta: 'Отношение: /play',
  attitude_feed_delta: 'Отношение: /feed',
  attitude_kick_delta: 'Отношение: /kick',
  attitude_escalation_threshold: 'Порог озлобления',
};
const SETTING_RANGES = {
  naughtiness: [1, 10, 1],
  mischief_message_trigger: [10, 200, 10],
  mischief_interval_hours: [1, 12, 1],
  sleep_start: [0, 23, 1],
  sleep_end: [0, 23, 1],
  neglect_threshold_hours: [1, 24, 1],
  health_decay_per_hour: [0, 10, 1],
  health_regen_per_hour: [0, 10, 1],
  attitude_play_delta: [0, 20, 1],
  attitude_feed_delta: [0, 20, 1],
  attitude_kick_delta: [-40, 0, 1],
  attitude_escalation_threshold: [-100, 0, 5],
};

async function loadStatus() {
  const data = await apiFetch('/status');
  const sub = document.getElementById('troll-sub');
  const chips = document.getElementById('status-chips');
  const panel = document.getElementById('panel-status');
  if (!data.exists) {
    sub.textContent = 'тролля ещё нет';
    chips.innerHTML = '';
    panel.innerHTML = '<div class="card">Тролля ещё нет — призови его командой /troll_here в публичном чате.</div>';
    return;
  }
  sub.textContent = data.stageName;
  chips.innerHTML = `
    <div class="chip"><span class="dot"></span>здоровье <b class="mono">${data.health}</b></div>
    <div class="chip"><span class="dot"></span>настроение <b>${data.moodWord}</b></div>
    ${data.paused ? '<div class="chip warn"><span class="dot"></span>шалости на паузе</div>' : ''}
  `;
  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Сейчас</p>
      <div class="stat-grid">
        <div class="stat"><div class="label">Здоровье</div><div class="value mono">${data.health}/100</div>
          <div class="bar-track"><div class="bar-fill" style="width:${data.health}%"></div></div></div>
        <div class="stat"><div class="label">Вес</div><div class="value mono">${data.weight} кг</div></div>
        <div class="stat"><div class="label">Настроение</div><div class="value">${data.moodWord}</div></div>
        <div class="stat"><div class="label">Стадия</div><div class="value">${data.stageName}</div></div>
      </div>
      <div class="activity-line"><span>💤</span><span>${data.activity}</span></div>
    </div>
    <div class="card">
      <p class="eyebrow">Быстрые действия</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" id="btn-pause">${data.paused ? '▶ Возобновить' : '⏸ Пауза шалостей'}</button>
        <button class="btn ghost" id="btn-reset">↺ Полный сброс</button>
      </div>
    </div>
  `;
  document.getElementById('btn-pause').addEventListener('click', async () => {
    await apiFetch(data.paused ? '/resume' : '/pause', { method: 'POST' });
    loadStatus();
  });
  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Точно сбросить тролля полностью?')) return;
    await apiFetch('/reset', { method: 'POST' });
    loadStatus();
  });
}

async function loadSettings() {
  const settings = await apiFetch('/settings');
  const panel = document.getElementById('panel-settings');
  const rows = Object.keys(SETTING_LABELS).map((key) => {
    const [min, max, step] = SETTING_RANGES[key];
    const value = Number(settings[key]);
    return `
      <div class="setting-row">
        <div class="setting-head">
          <span class="setting-name">${SETTING_LABELS[key]}</span>
          <span class="setting-value mono" data-out="${key}">${value}</span>
        </div>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-key="${key}">
      </div>
    `;
  }).join('');
  panel.innerHTML = `<div class="card">${rows}</div>`;
  panel.querySelectorAll('input[type=range]').forEach((input) => {
    input.addEventListener('input', () => {
      panel.querySelector(`[data-out="${input.dataset.key}"]`).textContent = input.value;
    });
    input.addEventListener('change', async () => {
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [input.dataset.key]: input.value }),
      });
    });
  });
}

async function loadPhrases() {
  const phrases = await apiFetch('/phrases');
  const byCategory = {};
  for (const row of phrases) {
    (byCategory[row.category] = byCategory[row.category] || []).push(row);
  }
  const panel = document.getElementById('panel-phrases');
  const categoryBlocks = Object.keys(byCategory).sort().map((category) => {
    const items = byCategory[category].map((row) => `
      <div class="phrase-item" data-id="${row.id}">
        <span class="text">${row.text}</span>
        <button class="icon-btn btn-edit">✎</button>
        <button class="icon-btn btn-del">✕</button>
      </div>
    `).join('');
    return `
      <div class="category">
        <div class="category-head">
          <span class="name">${category}</span>
          <span style="display:flex; align-items:center; gap:8px;">
            <span class="count">${byCategory[category].length}</span>
            <span class="chevron">›</span>
          </span>
        </div>
        <div class="category-body">
          ${items}
          <div class="add-phrase-row">
            <input type="text" placeholder="Новая фраза для ${category}…" class="new-phrase-input">
            <button class="btn btn-add">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  panel.innerHTML = `<div class="card">${categoryBlocks}</div>`;

  panel.querySelectorAll('.category-head').forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  });
  panel.querySelectorAll('.category').forEach((categoryEl) => {
    const category = categoryEl.querySelector('.name').textContent;
    categoryEl.querySelector('.btn-add').addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = categoryEl.querySelector('.new-phrase-input');
      if (!input.value.trim()) return;
      await apiFetch('/phrases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text: input.value.trim() }),
      });
      loadPhrases();
    });
    categoryEl.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = e.target.closest('.phrase-item').dataset.id;
        await apiFetch('/phrases/' + id, { method: 'DELETE' });
        loadPhrases();
      });
    });
    categoryEl.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = e.target.closest('.phrase-item');
        const id = item.dataset.id;
        const current = item.querySelector('.text').textContent;
        const next = prompt('Новый текст фразы:', current);
        if (next === null || next.trim() === '') return;
        await apiFetch('/phrases/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: next.trim() }),
        });
        loadPhrases();
      });
    });
  });
}

async function loadRelationships() {
  const people = await apiFetch('/relationships');
  const panel = document.getElementById('panel-relationships');
  if (people.length === 0) {
    panel.innerHTML = '<div class="card">Тролль пока никого не заметил.</div>';
    return;
  }
  const rows = people.map((p) => {
    const name = p.username ? '@' + p.username : p.first_name;
    const initial = (p.first_name || p.username || '?')[0].toUpperCase();
    const positive = p.attitude >= 0;
    const barWidth = Math.abs(p.attitude) / 2;
    const barStyle = positive
      ? `left:50%; width:${barWidth}%; background:var(--positive);`
      : `right:50%; width:${barWidth}%; background:var(--warning);`;
    const seenDate = p.last_seen_at ? new Date(p.last_seen_at * 1000).toLocaleDateString('ru-RU') : '—';
    return `
      <div class="person-row" data-user-id="${p.user_id}">
        <div class="avatar">${initial}</div>
        <div class="person-main">
          <div class="person-name">${name}</div>
          <div class="person-meta">видели: ${seenDate}</div>
        </div>
        <div class="attitude-wrap">
          <div class="attitude-bar"><div class="mid-tick"></div><div class="fill" style="${barStyle}"></div></div>
          <div class="attitude-num" style="color:${positive ? 'var(--positive)' : 'var(--warning-deep)'}">${p.attitude > 0 ? '+' : ''}${p.attitude}</div>
        </div>
      </div>
    `;
  }).join('');
  panel.innerHTML = `<div class="card">${rows}</div>`;
  panel.querySelectorAll('.person-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const userId = row.dataset.userId;
      const next = prompt('Новое отношение (-100..100):');
      if (next === null || Number.isNaN(Number(next))) return;
      await apiFetch('/relationships/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attitude: Number(next) }),
      });
      loadRelationships();
    });
  });
}

function renderSay() {
  const panel = document.getElementById('panel-say');
  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Сказать от лица тролля</p>
      <textarea id="say-input" placeholder="Напиши обычным языком…"></textarea>
      <div class="attach-row">
        <span>📎</span>
        <input type="file" id="say-photo" accept="image/*">
      </div>
      <div class="say-actions"><button class="btn" id="say-send">Отправить в чат</button></div>
      <div id="say-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  document.getElementById('say-send').addEventListener('click', async () => {
    const text = document.getElementById('say-input').value.trim();
    const photoInput = document.getElementById('say-photo');
    const status = document.getElementById('say-status');
    if (!text) return;
    const formData = new FormData();
    formData.append('text', text);
    if (photoInput.files[0]) formData.append('photo', photoInput.files[0]);
    status.textContent = 'Отправка…';
    try {
      const res = await fetch('/api/say', { method: 'POST', headers: { 'X-Telegram-Init-Data': initData }, body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ошибка');
      status.textContent = 'Отправлено: ' + data.sent;
      document.getElementById('say-input').value = '';
      photoInput.value = '';
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });
}

async function init() {
  try {
    await loadStatus();
    await loadSettings();
    await loadPhrases();
    await loadRelationships();
    renderSay();
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">Ошибка доступа: ${err.message}</div>`;
  }
}
init();
```

- [ ] **Step 2: Verify**

Run: `node --check public/app.js` — expect no output (this only checks JS syntax validity; it doesn't execute the browser-only parts like `fetch`/`document`, which is fine — full behavioral verification happens in Task 7's live smoke test).

- [ ] **Step 3: Manual verification (static only)**
1. Confirm every mutating call (`PUT /settings`, `POST/PUT/DELETE /phrases*`, `POST /pause|resume|reset`, `PUT /relationships/:id`, `POST /say`) re-fetches and re-renders its own tab afterward (`loadStatus()`, `loadPhrases()`, etc.), so the UI never shows stale data after an edit.
2. Confirm `apiFetch` always attaches `X-Telegram-Init-Data`, and that the one exception — `/api/say`'s photo upload — manually attaches the same header on its own raw `fetch` call (since it needs `FormData`, not `apiFetch`'s JSON-oriented wrapper) rather than silently skipping auth.

- [ ] **Step 4: Commit**
```bash
git add public/app.js
git commit -m "feat(admin): wire the frontend to the real API"
```

---

### Task 6: `/troll_panel` command in `bot.js`

**Files:** Modify `c:\Users\123\Projects\troll-bot\bot.js` (two insertion points)

- [ ] **Step 1: Add the command**

Find this exact text:
```js
bot.onText(/\/troll_say ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  const caption = trollify(match[1]);
  const photoSizes = msg.reply_to_message?.photo;
  if (photoSizes && photoSizes.length > 0) {
    const fileId = photoSizes[photoSizes.length - 1].file_id;
    bot.sendPhoto(state.chat_id, fileId, { caption });
  } else {
    bot.sendMessage(state.chat_id, caption);
  }
});

// --- Admin commands: phrase management ---
```
Replace with:
```js
bot.onText(/\/troll_say ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  const caption = trollify(match[1]);
  const photoSizes = msg.reply_to_message?.photo;
  if (photoSizes && photoSizes.length > 0) {
    const fileId = photoSizes[photoSizes.length - 1].file_id;
    bot.sendPhoto(state.chat_id, fileId, { caption });
  } else {
    bot.sendMessage(state.chat_id, caption);
  }
});

bot.onText(/\/troll_panel\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  bot.sendMessage(msg.chat.id, 'Панель управления троллем:', {
    reply_markup: {
      inline_keyboard: [[{ text: '🧌 Открыть панель', web_app: { url: 'https://nordheimunion.ru/troll-admin' } }]],
    },
  });
});

// --- Admin commands: phrase management ---
```

- [ ] **Step 2: Add it to the admin help text**

Find this exact text:
```js
  '/troll_phrase_del <ID> — удалить фразу',
].join('\n');
```
Replace with:
```js
  '/troll_phrase_del <ID> — удалить фразу',
  '/troll_panel — открыть веб-панель управления (кнопкой)',
].join('\n');
```

- [ ] **Step 3: Verify**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 4: Manual verification (static only)**
1. Confirm `/troll_panel` is gated by `isAdminChat`, matching every other admin-only command in this file.
2. Confirm the `web_app` button's URL is the exact path this plan reserved (`https://nordheimunion.ru/troll-admin`) — if you end up choosing a different path segment at deploy time, this line (and the nginx `location` block in Task 7) both need to match it.

- [ ] **Step 5: Commit**
```bash
git add bot.js
git commit -m "feat(admin): add /troll_panel command to open the Mini App"
```

---

### Task 7: Deploy — nginx, PM2, and full live smoke test

**Files:** None (server configuration + manual verification only — entirely user-driven, matching this project's established deploy pattern)

- [ ] **Step 1: Add the nginx location block**

On the server, edit `/etc/nginx/sites-enabled/nordheimunion.ru` and add, inside the existing `server { listen 443 ssl; ... }` block, alongside the existing `/umami` location:
```nginx
    location /troll-admin {
        proxy_pass         http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
```
Then:
```bash
nginx -t && systemctl reload nginx
```

(`nginx -t` validates the config before reloading — if it reports an error, fix it before reloading, don't reload a broken config.)

- [ ] **Step 2: Deploy the code**

```bash
cd /root/troll-bot
git pull origin master
npm ci --production
```

- [ ] **Step 3: Register the new PM2 process**

```bash
pm2 start admin-server.js --name troll-admin
pm2 restart troll-bot --update-env
pm2 save
pm2 logs troll-admin --lines 20 --nostream
```
Expected: `Админ-панель слушает на 127.0.0.1:4100` with no errors. Also check `pm2 logs troll-bot --lines 10 --nostream` shows a clean restart (no new errors from the `/troll_panel` addition).

- [ ] **Step 4: Full live smoke test**

1. In the admin chat, run `/troll_panel` — confirm a message appears with an "🧌 Открыть панель" button.
2. Tap it — confirm the Mini App opens inside Telegram (not a separate browser) and the **Статус** tab loads real data (not stuck on "загрузка…" or an auth error). This is the step that actually validates `verifyInitData`'s compatibility with Telegram's real signing — if this fails with a 401, the algorithm needs debugging (Task 2's self-consistency test only proved internal consistency, not real-world compatibility).
3. **Настройки** — move a slider (e.g. naughtiness), release it, then reopen the panel fresh — confirm the new value persisted (i.e. `PUT /settings` actually wrote through).
4. **Фразы** — expand a category, add a new phrase, edit one, delete one — confirm each round-trips (reflected immediately, and still there after a fresh reload).
5. **Отношения** — confirm people already known to the troll (from real chat activity) show up with plausible attitude values; tap one and manually override its number — confirm it sticks.
6. **Сказать** — send a short phrase with no photo, confirm it arrives in the public chat in troll-speak; then send one with a photo attached, confirm the photo arrives with a troll-speak caption.
7. From a **non-admin** Telegram account (or by temporarily testing with a user not in the admin chat, if available) — confirm the panel shows an access error rather than real data, validating the `403` path actually blocks non-admins in practice, not just in code review.
8. Back in the admin chat: `/troll_settings` — confirm any value changed via the panel's sliders shows up correctly through the existing chat command too (both surfaces read the same `troll_settings` table, so they must agree).

- [ ] **Step 5: Report back**

No commit needed for this task — it's server configuration and live verification only, matching every other deploy step in this project.

---

## Self-Review Notes

- **Spec coverage:** architecture/hosting (Task 7's nginx + PM2 steps), auth (Task 2), full API surface (Task 3), frontend matching the approved mockup (Tasks 4-5), `/troll_panel` opener (Task 6) — every section of the design doc maps to a task. The design doc's "Out of scope" items (no change to troll-bot's own behavior beyond the one opener command, no multi-admin locking, no historical charts) are correctly absent from every task.
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output. The one deliberately-flagged deviation (vanilla JS instead of the earlier "Vue via CDN" idea) is called out explicitly in the plan header, not silently substituted.
- **Type/name consistency:** `admin-lib.js`'s exports (`db`, `getSetting`, `setSetting`, `getAllSettings`, `DEFAULT_SETTINGS_KEYS`, `STAGE_NAMES`, `getStage`, `getWeight`, `moodWord`, `isSilenced`, `getActivityLine`, `trollify`) are each defined once (Task 1) and imported with matching names in `admin-server.js` (Task 3) with no typos. `admin-auth.js`'s exports (`bot`, `verifyInitData`, `isAdmin`, `requireAdmin`) likewise match their one usage site in Task 3. Every `/api/*` path referenced by `public/app.js` (Task 5) matches a route actually registered in `admin-server.js` (Task 3) — cross-checked path-by-path: `/status`, `/settings` (GET+PUT), `/phrases` (GET+POST) and `/phrases/:id` (PUT+DELETE), `/pause`, `/resume`, `/reset`, `/relationships` (GET) and `/relationships/:userId` (PUT), `/say` (POST) — all present on both sides.
- **Duplication called out, not hidden:** `admin-lib.js`'s pure helpers deliberately duplicate logic already in `bot.js`, with an explicit code comment and a note in this plan's architecture section explaining why (avoiding `require('./bot.js')`'s side effects, and avoiding touching the already-deployed, working bot.js just to extract a shared module) — a conscious trade-off, not an oversight.
