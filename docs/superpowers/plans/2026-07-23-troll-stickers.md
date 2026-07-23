# Troll Stickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the troll send stickers (imported whole-pack-at-a-time via the admin panel) alongside or instead of its text phrases, at every existing category-driven reaction point.

**Architecture:** One new table (`troll_stickers`), a `pickSticker`/`sendCategoryReply` pair of helpers in `bot.js` wired into the play/kick/feed/mischief call sites, a small set of `/api/stickers*` endpoints in `admin-server.js` (list/import/update/delete/image-proxy) backed by a new `fetchTelegramFile` helper in `admin-auth.js`, and a new "Стикеры" tab in the existing frontend.

**Tech Stack:** Same as the rest of this project — no new dependencies (`bot.getStickerSet`/`getFileLink`/`sendSticker` are already available in the installed `node-telegram-bot-api`). No test framework — `node --check` + hand-tracing + throwaway `node -e` scripts.

Full design: `docs/superpowers/specs/2026-07-23-troll-stickers-design.md`.

**IMPORTANT:** Do not run `bot.js`/`admin-server.js` against a real `.env`/token during development — verification uses `node --check`, static reasoning, and short-lived `node -e "require(...)"` runs against the local throwaway `troll.db`, matching this project's established pattern.

---

### Task 1: Schema and sending logic in `bot.js`

**Files:** Modify `c:\Users\123\Projects\troll-bot\bot.js` (schema + helpers + 7 call sites across `performPlay`/`performKick`/`performFeed`/`triggerMischief`)

- [ ] **Step 1: Add the `troll_stickers` table**

Find this exact text:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_relationships (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    attitude INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER DEFAULT (strftime('%s','now')),
    last_seen_at INTEGER
  )
`);

const DEFAULT_SETTINGS = {
```
Replace with:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_relationships (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    attitude INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER DEFAULT (strftime('%s','now')),
    last_seen_at INTEGER
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_stickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL UNIQUE,
    category TEXT,
    has_own_text INTEGER NOT NULL DEFAULT 0,
    emoji TEXT,
    added_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

const DEFAULT_SETTINGS = {
```

- [ ] **Step 2: Add `pickSticker` and `sendCategoryReply` helpers**

Find this exact text:
```js
function pickPhrase(category, fallback) {
  const phrases = getPhrases(category);
  return phrases.length > 0 ? pick(phrases) : fallback;
}

function isSilenced(state) {
```
Replace with:
```js
function pickPhrase(category, fallback) {
  const phrases = getPhrases(category);
  return phrases.length > 0 ? pick(phrases) : fallback;
}

// Stickers are peers of a category's text phrases, not a separate system —
// same category names, picked with a flat 50% chance whenever that category
// would otherwise just send text. A sticker whose artwork already has the
// joke baked in (has_own_text) is sent alone; otherwise the usual text
// phrase still follows, prefixed with actorLabel exactly like it already
// was for play/kick/feed (actorLabel is null for mischief, which has no
// attribution to begin with).
function pickSticker(category) {
  const rows = db.prepare('SELECT file_id, has_own_text FROM troll_stickers WHERE category = ?').all(category);
  if (rows.length === 0) return null;
  const row = rows[Math.floor(Math.random() * rows.length)];
  return { fileId: row.file_id, hasOwnText: !!row.has_own_text };
}

function sendCategoryReply(chatId, category, fallback, actorLabel) {
  const sticker = Math.random() < 0.5 ? pickSticker(category) : null;
  if (sticker) {
    bot.sendSticker(chatId, sticker.fileId).catch(() => {});
    if (sticker.hasOwnText) return;
  }
  const phrase = pickPhrase(category, fallback);
  bot.sendMessage(chatId, actorLabel ? `${actorLabel} → ${phrase}` : phrase).catch(() => {});
}

function isSilenced(state) {
```

- [ ] **Step 3: Wire into `performPlay`'s asleep branch**

Find this exact text:
```js
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    bot.sendMessage(chatId, `${actorName(from)} → ${pickPhrase('woken_angry', 'Твоя разбудить моя! Моя злой!')}`);
    return;
  }
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
```
Replace with:
```js
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReply(chatId, 'woken_angry', 'Твоя разбудить моя! Моя злой!', actorName(from));
    return;
  }
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
```

- [ ] **Step 4: Wire into `performPlay`'s normal branch**

Find this exact text:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_play_delta'));
  bot.sendMessage(chatId, `${actorName(from)} → ${pickPhrase('play', 'Моя рада играть с твоя!')}`);
}
```
Replace with:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_play_delta'));
  sendCategoryReply(chatId, 'play', 'Моя рада играть с твоя!', actorName(from));
}
```

- [ ] **Step 5: Wire into `performKick`**

Find this exact text:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
  bot.sendMessage(chatId, `${actorName(from)} → ${pickPhrase('kick', 'Твоя злой! Моя обижаться!')}`);
}
```
Replace with:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
  sendCategoryReply(chatId, 'kick', 'Твоя злой! Моя обижаться!', actorName(from));
}
```

- [ ] **Step 6: Wire into `performFeed`'s asleep branch**

Find this exact text:
```js
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    bot.sendMessage(chatId, `${actorName(from)} → ${pickPhrase('woken_angry', 'Твоя разбудить моя! Моя злой!')}`);
    return;
  }
  const newFeedCount = state.feed_count + 1;
```
Replace with:
```js
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReply(chatId, 'woken_angry', 'Твоя разбудить моя! Моя злой!', actorName(from));
    return;
  }
  const newFeedCount = state.feed_count + 1;
```

- [ ] **Step 7: Wire into `performFeed`'s normal branch**

Find this exact text:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_feed_delta'));
  bot.sendMessage(chatId, `${actorName(from)} → ${pickPhrase('feed', 'Ням-ням, спасибо твоя!')}`);
  if (newStage > oldStage) {
```
Replace with:
```js
  adjustAttitude(from.id, getSettingNumber('attitude_feed_delta'));
  sendCategoryReply(chatId, 'feed', 'Ням-ням, спасибо твоя!', actorName(from));
  if (newStage > oldStage) {
```

- [ ] **Step 8: Wire into `triggerMischief`'s targeted-phrase branch**

Find this exact text:
```js
    if (Math.random() < 0.5) {
      const template = pickPhrase(TARGETED_PHRASE_TIER_CATEGORIES[effectiveTier], 'подмигнул {user}');
      bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, target)}*`).catch(() => {});
    } else {
```
Replace with:
```js
    if (Math.random() < 0.5) {
      const phraseCategory = TARGETED_PHRASE_TIER_CATEGORIES[effectiveTier];
      const sticker = Math.random() < 0.5 ? pickSticker(phraseCategory) : null;
      if (sticker) bot.sendSticker(chatId, sticker.fileId).catch(() => {});
      if (!sticker || !sticker.hasOwnText) {
        const template = pickPhrase(phraseCategory, 'подмигнул {user}');
        bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, target)}*`).catch(() => {});
      }
    } else {
```

(The `/try`-style action branch in the `else` right after this is untouched — stickers don't apply to `targeted_action_*`, per the design.)

- [ ] **Step 9: Wire into the detached/generic mischief branch**

Find this exact text:
```js
  const action = pickPhrase(MISCHIEF_TIER_CATEGORIES[tier], 'шалит тихонько под мостом');
  let phrase = `*${action}*`;
  if (Math.random() < 0.3) {
    const rememberedUser = maybeRememberedUser();
    if (rememberedUser) phrase += ` (твоя как ${rememberedUser}, твоя тоже моя помнить!)`;
  }
  bot.sendMessage(chatId, phrase).catch(() => {});
}
```
Replace with:
```js
  const mischiefCategory = MISCHIEF_TIER_CATEGORIES[tier];
  const sticker = Math.random() < 0.5 ? pickSticker(mischiefCategory) : null;
  if (sticker) bot.sendSticker(chatId, sticker.fileId).catch(() => {});
  if (!sticker || !sticker.hasOwnText) {
    const action = pickPhrase(mischiefCategory, 'шалит тихонько под мостом');
    let phrase = `*${action}*`;
    if (Math.random() < 0.3) {
      const rememberedUser = maybeRememberedUser();
      if (rememberedUser) phrase += ` (твоя как ${rememberedUser}, твоя тоже моя помнить!)`;
    }
    bot.sendMessage(chatId, phrase).catch(() => {});
  }
}
```

- [ ] **Step 10: Verify**

Run: `node --check bot.js` — expect no output.

Then, from `c:\Users\123\Projects\troll-bot`:
```bash
rm -f troll.db
timeout 3 node -e "require('./bot.js')" || true
node -e "
const db = require('better-sqlite3')('troll.db');
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='troll_stickers'\").get());
"
rm -f troll.db
```
Expected: the table exists (prints `{ name: 'troll_stickers' }`), no errors during the `require`.

- [ ] **Step 11: Manual verification (static only)**
1. Confirm every call site above has a category with ZERO registered stickers (true for any fresh `troll_stickers` table) behaves byte-for-byte like before: `pickSticker` returns `null` for an empty category, so `sendCategoryReply`/the two inline branches always fall through to exactly the same `pickPhrase(...)`/`bot.sendMessage(...)` calls that existed before this task — re-read `pickSticker` and confirm the empty-array early return.
2. Confirm the `/try`-style action branch (the `else` in Step 8's context) and `activity_awake` (used only inside `getActivityLine`, never touched by this task) are untouched.
3. Confirm `sendCategoryReply`'s `actorLabel` parameter is passed as `null`-equivalent (i.e., omitted / falsy) nowhere in this task — every one of its 4 call sites (play ×2, kick, feed) passes `actorName(from)`, matching the pre-existing attribution behavior exactly.

- [ ] **Step 12: Commit**
```bash
git add bot.js
git commit -m "feat(stickers): add troll_stickers table and wire sticker-or-text sending into play/kick/feed/mischief"
```

---

### Task 2: Sticker management API (`admin-auth.js`, `admin-server.js`)

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\admin-auth.js` (add `fetchTelegramFile`)
- Modify: `c:\Users\123\Projects\troll-bot\admin-server.js` (add 5 routes)

- [ ] **Step 1: Add `fetchTelegramFile` to `admin-auth.js`**

Find this exact text:
```js
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
```
Replace with:
```js
const crypto = require('crypto');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
```

Find this exact text:
```js
module.exports = { bot, verifyInitData, isAdmin, requireAdmin };
```
Replace with:
```js
// Streams a Telegram-hosted file (a sticker's image bytes) back to whoever
// calls this, through the SAME proxy agent used for every other Bot API
// call — needed since api.telegram.org is blocked from Russia. Never expose
// the raw getFileLink URL to a browser: it embeds the bot token.
function fetchTelegramFile(fileId) {
  return bot.getFileLink(fileId).then((fileLink) => new Promise((resolve, reject) => {
    https.get(fileLink, { agent }, (fileRes) => {
      resolve({ contentType: fileRes.headers['content-type'] || 'application/octet-stream', stream: fileRes });
    }).on('error', reject);
  }));
}

module.exports = { bot, verifyInitData, isAdmin, requireAdmin, fetchTelegramFile };
```

- [ ] **Step 2: Verify**

Run: `node --check admin-auth.js` — expect no output.

- [ ] **Step 3: Manual verification (static only)**
1. Confirm `agent` (the proxy agent constructed earlier in this same file) is in scope where `fetchTelegramFile` uses it — it's a module-level `let agent` already defined above, so yes.
2. Confirm this function returns a Promise resolving to `{ contentType, stream }`, where `stream` is the raw Node HTTP response object (a readable stream) — the caller (Task 3's route handler) will `.pipe()` it directly to the HTTP response, not buffer it into memory first.

- [ ] **Step 4: Commit**
```bash
git add admin-auth.js
git commit -m "feat(stickers): add fetchTelegramFile helper for proxying sticker images"
```

- [ ] **Step 5: Add the sticker routes to `admin-server.js`**

Find this exact text:
```js
const { bot, requireAdmin } = require('./admin-auth');
```
Replace with:
```js
const { bot, requireAdmin, fetchTelegramFile } = require('./admin-auth');
```

Find this exact text:
```js
api.get('/relationships', (req, res) => {
```
Replace with:
```js
api.get('/stickers', (req, res) => {
  const rows = db.prepare('SELECT id, category, has_own_text, emoji FROM troll_stickers ORDER BY category, id').all();
  res.json(rows);
});

api.post('/stickers/import', async (req, res) => {
  const { setName } = req.body || {};
  if (!setName) return res.status(400).json({ error: 'setName required' });
  try {
    const set = await bot.getStickerSet(setName);
    const insert = db.prepare('INSERT OR IGNORE INTO troll_stickers (file_id, emoji) VALUES (?, ?)');
    let added = 0;
    for (const sticker of set.stickers) {
      const info = insert.run(sticker.file_id, sticker.emoji || null);
      if (info.changes > 0) added += 1;
    }
    res.json({ total: set.stickers.length, added });
  } catch (err) {
    res.status(502).json({ error: 'telegram request failed', detail: err.message });
  }
});

api.put('/stickers/:id', (req, res) => {
  const current = db.prepare('SELECT category, has_own_text FROM troll_stickers WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'not found' });
  const { category, hasOwnText } = req.body || {};
  const newCategory = category !== undefined ? category : current.category;
  const newHasOwnText = hasOwnText !== undefined ? (hasOwnText ? 1 : 0) : current.has_own_text;
  db.prepare('UPDATE troll_stickers SET category = ?, has_own_text = ? WHERE id = ?').run(newCategory, newHasOwnText, req.params.id);
  res.json({ ok: true, category: newCategory, hasOwnText: !!newHasOwnText });
});

api.delete('/stickers/:id', (req, res) => {
  const info = db.prepare('DELETE FROM troll_stickers WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

api.get('/stickers/:id/image', async (req, res) => {
  const row = db.prepare('SELECT file_id FROM troll_stickers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  try {
    const { contentType, stream } = await fetchTelegramFile(row.file_id);
    res.set('Content-Type', contentType);
    stream.pipe(res);
  } catch (err) {
    res.status(502).end();
  }
});

api.get('/relationships', (req, res) => {
```

- [ ] **Step 6: Verify**

Run: `node --check admin-server.js` — expect no output.

- [ ] **Step 7: Manual verification (static only)**
1. Confirm `/stickers/import` uses `INSERT OR IGNORE` keyed on `file_id`'s `UNIQUE` constraint (from Task 1's schema), so re-importing the same pack twice reports `added: 0` the second time rather than erroring or duplicating rows.
2. Confirm `PUT /stickers/:id` does a read-then-write (fetches `current` first) so sending only `{ hasOwnText: true }` doesn't accidentally null out an already-set `category`, and vice versa.
3. Confirm `/stickers/:id/image` never sends `fileLink`/the bot token anywhere in the HTTP response — only `contentType` and piped image bytes.
4. Confirm all 5 new routes sit on the `api` router (after `api.use(requireAdmin)`, established earlier in the file), not on `app` directly — same auth requirement as every other `/api/*` route.

- [ ] **Step 8: Commit**
```bash
git add admin-server.js
git commit -m "feat(stickers): add sticker list/import/update/delete/image-proxy API routes"
```

---

### Task 3: Frontend — "Стикеры" tab

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\public\index.html` (add tab button + panel section)
- Modify: `c:\Users\123\Projects\troll-bot\public\app.js` (add `loadStickers`, category list constant, call it from `init`)

- [ ] **Step 1: Add the tab button and empty panel**

Find this exact text:
```html
    <button class="tab-btn" data-tab="relationships">Отношения</button>
    <button class="tab-btn" data-tab="say">Сказать</button>
  </nav>
```
Replace with:
```html
    <button class="tab-btn" data-tab="relationships">Отношения</button>
    <button class="tab-btn" data-tab="say">Сказать</button>
    <button class="tab-btn" data-tab="stickers">Стикеры</button>
  </nav>
```

Find this exact text:
```html
    <section class="panel" id="panel-say"></section>
  </main>
```
Replace with:
```html
    <section class="panel" id="panel-say"></section>
    <section class="panel" id="panel-stickers"></section>
  </main>
```

- [ ] **Step 2: Verify**

Visual check only — no JS to break yet: open `public/index.html` in a browser and confirm a 6th tab button "Стикеры" appears in the (horizontally-scrollable) tab strip. Clicking it won't show anything yet since `app.js` doesn't handle it until Step 3 below — that's expected at this point.

- [ ] **Step 3: Commit**
```bash
git add public/index.html
git commit -m "feat(stickers): add Стикеры tab markup"
```

- [ ] **Step 4: Add `loadStickers` to `public/app.js`**

Find this exact text:
```js
async function init() {
  try {
    await loadStatus();
    await loadSettings();
    await loadBotProfile();
    await loadPhrases();
    await loadRelationships();
    renderSay();
  } catch (err) {
```
Replace with:
```js
const STICKER_CATEGORIES = [
  'play', 'kick', 'feed',
  'mischief_mild', 'mischief_medium', 'mischief_mean',
  'targeted_phrase_mild', 'targeted_phrase_medium', 'targeted_phrase_mean',
  'woken_angry',
];

async function loadStickers() {
  const stickers = await apiFetch('/stickers');
  const panel = document.getElementById('panel-stickers');
  const byCategory = { '(без категории)': [] };
  for (const s of stickers) {
    const key = s.category || '(без категории)';
    (byCategory[key] = byCategory[key] || []).push(s);
  }
  const importCard = `
    <div class="card">
      <p class="eyebrow">Импорт пака</p>
      <p style="font-size:12px; color:var(--text-muted); margin:-4px 0 12px;">Короткое имя из ссылки вида t.me/addstickers/&lt;имя&gt;</p>
      <div class="add-phrase-row">
        <input type="text" id="sticker-set-name" placeholder="Имя пака">
        <button class="btn" id="sticker-import-btn">Импорт</button>
      </div>
      <div id="sticker-import-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  const categoryBlocks = Object.keys(byCategory).map((category) => {
    const items = byCategory[category].map((s) => `
      <div class="phrase-item" data-id="${s.id}" style="align-items:center;">
        <img src="/troll-admin/api/stickers/${s.id}/image" style="width:48px; height:48px; object-fit:contain; border-radius:8px; background:var(--bg-sunken);" alt="${s.emoji || ''}">
        <select class="sticker-category" style="flex:1; padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--bg-sunken); color:var(--text); font-size:12.5px;">
          <option value="">— без категории —</option>
          ${STICKER_CATEGORIES.map((c) => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <label style="font-size:11.5px; display:flex; align-items:center; gap:4px; white-space:nowrap;">
          <input type="checkbox" class="sticker-own-text" ${s.has_own_text ? 'checked' : ''}> текст
        </label>
        <button class="icon-btn sticker-del">✕</button>
      </div>
    `).join('');
    return `
      <div class="category open">
        <div class="category-head"><span class="name">${category}</span><span class="count">${byCategory[category].length}</span></div>
        <div class="category-body">${items}</div>
      </div>
    `;
  }).join('');
  panel.innerHTML = importCard + `<div class="card">${categoryBlocks}</div>`;

  document.getElementById('sticker-import-btn').addEventListener('click', async () => {
    const setName = document.getElementById('sticker-set-name').value.trim();
    const status = document.getElementById('sticker-import-status');
    if (!setName) return;
    status.textContent = 'Импортирую…';
    try {
      const result = await apiFetch('/stickers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setName }),
      });
      status.textContent = `Добавлено ${result.added} из ${result.total}.`;
      loadStickers();
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });

  panel.querySelectorAll('.phrase-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('.sticker-category').addEventListener('change', async (e) => {
      await apiFetch('/stickers/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: e.target.value || null }),
      });
      loadStickers();
    });
    item.querySelector('.sticker-own-text').addEventListener('change', async (e) => {
      await apiFetch('/stickers/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hasOwnText: e.target.checked }),
      });
    });
    item.querySelector('.sticker-del').addEventListener('click', async () => {
      await apiFetch('/stickers/' + id, { method: 'DELETE' });
      loadStickers();
    });
  });
}

async function init() {
  try {
    await loadStatus();
    await loadSettings();
    await loadBotProfile();
    await loadPhrases();
    await loadRelationships();
    renderSay();
    await loadStickers();
  } catch (err) {
```

- [ ] **Step 5: Verify**

Run: `node --check public/app.js` — expect no output.

- [ ] **Step 6: Manual verification (static only)**
1. Confirm `loadStickers` is called from `init()` (added at the end of the existing sequence, after `renderSay()`), and that adding it doesn't disturb the established rule from Task 5 of the Mini App plan (loadSettings must run before anything that shares its panel — not relevant here since stickers get their own panel, `#panel-stickers`, untouched by any other `load*` function).
2. Confirm every mutating action (category change, "own text" toggle, delete, import) re-fetches via `loadStickers()` afterward — same pattern as `loadPhrases`/`loadRelationships` already established — except the "own text" toggle, which deliberately does NOT reload (matches the existing precedent from the settings sliders: the checkbox's own state already reflects what was just saved, no round-trip needed to show it correctly).
3. Confirm the `<img>` `src` path is prefixed `/troll-admin/api/...`, matching the existing prefix convention every other endpoint call already uses in this file (established when the path-prefix bug was fixed earlier in this project) — a plain `/api/...` path here would 404 the same way the original static-file bug did.

- [ ] **Step 7: Commit**
```bash
git add public/app.js
git commit -m "feat(stickers): wire the Стикеры tab to the sticker API"
```

---

### Task 4: Deploy and live smoke test

**Files:** None — server-side deploy and manual verification only, matching this project's established pattern.

- [ ] **Step 1: Deploy**
```bash
cd /root/troll-bot
git pull origin master
pm2 restart troll-bot --update-env
pm2 restart troll-admin
```

- [ ] **Step 2: Live smoke test**
1. Open the panel, go to «Стикеры», paste a real sticker pack's short name (from a `t.me/addstickers/<name>` link), click «Импорт» — confirm it reports `Добавлено N из M` and the stickers appear grouped under «(без категории)» with visible previews (static webp stickers should render; animated/video ones may show a broken-image icon — expected per the design's noted limitation).
2. Assign a few stickers to categories (e.g. a couple to `play`, one to `mischief_mean`) and toggle "текст" on any that have their own baked-in phrase — confirm the change sticks after switching tabs and back.
3. In the actual chat: run `/play` repeatedly (a dozen or so times) — over enough tries, confirm you sometimes see a sticker (with or without a following text line, matching whether you marked it "own text"), and sometimes the old plain-text-only response, roughly 50/50.
4. Lower `mischief_message_trigger` via the panel's Settings tab temporarily (e.g. to 3) and chat for a bit to trigger mischief repeatedly — confirm stickers show up there too, for both the detached and targeted-phrase mischief paths.
5. Confirm a category with NO stickers assigned (most of them, initially) behaves exactly as before — plain text every time, no missing responses.

- [ ] **Step 3: Report back**

No commit needed — deploy/live-verification only.

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1), all listed send-integration points — `play`/`kick`/`feed` (×2 asleep/normal branches each) plus both mischief branches (Task 1) — sticker management API including the image proxy (Task 2), frontend tab (Task 3), deploy/smoke test (Task 4). `targeted_action_*` and `activity_awake` are explicitly confirmed untouched (Task 1 Step 11, Task 4 Step 5's control case).
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output.
- **Type/name consistency:** `pickSticker`, `sendCategoryReply`, `fetchTelegramFile` each defined once (Tasks 1-2) and referenced identically at every call site (Tasks 1-3). `STICKER_CATEGORIES` (frontend) intentionally excludes `targeted_action_*`/`activity_awake`, matching the design's explicit scope — not an oversight relative to the 12-name `PHRASE_CATEGORIES` used elsewhere for text phrases.
- **No regression when empty:** every new sticker call site is additive-only — `pickSticker` returning `null` (the case for every category until an admin actually imports and assigns something) reproduces the pre-existing text-only behavior exactly, byte for byte.
