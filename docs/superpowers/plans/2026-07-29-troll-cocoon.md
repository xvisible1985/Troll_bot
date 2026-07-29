# Troll Cocoon/Transformation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-toggled "cocoon" state that fully freezes the troll (every command/button/autonomous behavior inert), shows an all-time activity-stats caption on the `/troll` card while cocooned, and — once, the first time it's turned off — permanently doubles the troll's max health (100→200, fully healed) and its live health decay/regen rates.

**Architecture:** Three new nullable/flag columns on the existing `troll_state` singleton row (`cocoon_started_at`, `max_health`, `has_transformed`). A single early-return at the top of `backgroundTick` freezes all autonomous behavior; the five direct-interaction functions (`performPlay/Feed/Kick/Tease/Boobs`) each get an early guard, same shape as their existing `regen_sleep_started_at` checks. Two new `admin-server.js` endpoints (mirroring the existing `/pause`/`/resume` pair) flip the state and carry the one-time upgrade logic. Every place that hardcodes health's ceiling as `100` becomes `max_health` — in `bot.js`, `card.js`, and the admin panel (`public/app.js`).

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`, Express (admin API), vanilla JS admin panel (`public/app.js`), `@napi-rs/canvas` (`card.js`). No test framework in this repo — verification throughout is manual, against a running test bot/chat, same as every other plan in `docs/superpowers/plans/`.

**Spec:** `docs/superpowers/specs/2026-07-29-troll-cocoon-design.md`

---

### Task 1: Schema migration — `cocoon_started_at`, `max_health`, `has_transformed`

**Files:**
- Modify: `bot.js:296-298`

- [ ] **Step 1: Add the three column migrations**

Find this existing block (bot.js:296-298):

```js
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN regen_sleep_ticks_applied INTEGER NOT NULL DEFAULT 0');
} catch {}
```

Add immediately after it:

```js
// Cocoon/transformation: cocoon_started_at gates the full freeze (see
// backgroundTick and the perform* guards below) — NULL means normal life.
// max_health replaces the old hardcoded 100 ceiling everywhere health is
// clamped; it only ever changes (100 -> 200) once, the first time the
// troll emerges from the cocoon, guarded by has_transformed so a second
// cocoon cycle later doesn't double it again.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN cocoon_started_at INTEGER');
} catch {}
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN max_health INTEGER NOT NULL DEFAULT 100');
} catch {}
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN has_transformed INTEGER NOT NULL DEFAULT 0');
} catch {}
```

- [ ] **Step 2: Verify the migration runs cleanly in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\"CREATE TABLE troll_state (id INTEGER PRIMARY KEY CHECK (id = 1), health INTEGER NOT NULL DEFAULT 100)\");
db.exec('ALTER TABLE troll_state ADD COLUMN cocoon_started_at INTEGER');
db.exec('ALTER TABLE troll_state ADD COLUMN max_health INTEGER NOT NULL DEFAULT 100');
db.exec('ALTER TABLE troll_state ADD COLUMN has_transformed INTEGER NOT NULL DEFAULT 0');
console.log(db.prepare('PRAGMA table_info(troll_state)').all().map(c => c.name));
"
```

Expected: prints an array including `cocoon_started_at`, `max_health`, `has_transformed`, no error.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(troll): add cocoon/transformation schema columns"
```

---

### Task 2: Double the default health decay/regen settings

**Files:**
- Modify: `bot.js:395-399`

- [ ] **Step 1: Update `DEFAULT_SETTINGS`**

Find (bot.js:395-399):

```js
  health_decay_per_hour: '2',
  health_regen_baby: '1',
  health_regen_young: '2',
  health_regen_adult: '5',
  health_regen_old: '3',
```

Replace with:

```js
  health_decay_per_hour: '4',
  health_regen_baby: '2',
  health_regen_young: '4',
  health_regen_adult: '10',
  health_regen_old: '6',
```

This only affects a brand-new `troll.db` that has never seeded these keys
before (`INSERT OR IGNORE`, a few lines below this block) — it does **not**
change the already-running production troll's current settings. That live
doubling happens in Task 6, at the moment of the one-time transformation.

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(troll): double default health decay/regen settings for the 0-200 scale"
```

---

### Task 3: Widen the admin panel's health decay/regen sliders

**Files:**
- Modify: `public/app.js:78-82`

- [ ] **Step 1: Widen the slider ranges**

Find (public/app.js:78-82):

```js
  health_decay_per_hour: [0, 10, 1],
  health_regen_baby: [0, 10, 1],
  health_regen_young: [0, 10, 1],
  health_regen_adult: [0, 10, 1],
  health_regen_old: [0, 10, 1],
```

Replace with:

```js
  health_decay_per_hour: [0, 20, 1],
  health_regen_baby: [0, 20, 1],
  health_regen_young: [0, 20, 1],
  health_regen_adult: [0, 20, 1],
  health_regen_old: [0, 20, 1],
```

Without this, the new doubled default for `health_regen_adult` (10) would
sit exactly at the old slider ceiling (10) with no headroom to increase it
further from the panel.

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat(troll): widen health decay/regen slider ranges to 0-20"
```

---

### Task 4: Freeze autonomous behavior — `backgroundTick` early return

**Files:**
- Modify: `bot.js:2163-2176`

- [ ] **Step 1: Add the cocoon short-circuit at the very top of `backgroundTick`**

Find (bot.js:2163-2176):

```js
function backgroundTick() {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return;

  const now = Math.floor(Date.now() / 1000);

  // Regen sleep overrides everything else while it's running — no night
  // check, no mischief/hunger/eat/poop/pee this tick. It only ends here
  // (naturally) or via a /kick (see performKick) — see the eligibility
  // check further down for how it starts.
  if (state.regen_sleep_started_at) {
    handleRegenSleepTick(state, now);
    return;
  }
```

Replace with:

```js
function backgroundTick() {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return;

  const now = Math.floor(Date.now() / 1000);

  // Cocoon overrides absolutely everything, even regen sleep — the troll
  // is in full stasis, admin-controlled only (see admin-server.js's
  // /cocoon-enter and /cocoon-exit). Every cooldown/tick timestamp just
  // stays frozen and resumes from real elapsed time once the cocoon ends,
  // same as if the whole process had been down for that period.
  if (state.cocoon_started_at) return;

  // Regen sleep overrides everything else while it's running — no night
  // check, no mischief/hunger/eat/poop/pee this tick. It only ends here
  // (naturally) or via a /kick (see performKick) — see the eligibility
  // check further down for how it starts.
  if (state.regen_sleep_started_at) {
    handleRegenSleepTick(state, now);
    return;
  }
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(troll): freeze backgroundTick entirely while cocooned"
```

---

### Task 5: Freeze direct interactions — guard the five `perform*` functions

**Files:**
- Modify: `bot.js` (five functions — exact anchors below)

- [ ] **Step 1: Add the shared cocoon reply constant**

Find (bot.js:1491-1494):

```js
// Shared by every non-kick direct interaction while regen_sleep_started_at
// is set (see backgroundTick/handleRegenSleepTick) — the troll doesn't wake
// for anything except a landed kick, it just snores through it.
const REGEN_SLEEP_SNORE_REPLY = '*тихо похрапывает под мостом, восстанавливая силы*';
```

Add immediately after it:

```js

// Shared by every direct interaction while cocoon_started_at is set (see
// backgroundTick's freeze and admin-server.js's /cocoon-enter/-exit) — takes
// priority over every other guard (is_asleep, regen_sleep_started_at), since
// the cocoon is a total stasis, not just another sleep state.
const COCOON_REPLY = '🥚 Тролль сейчас в коконе, ему не до тебя...';
```

- [ ] **Step 2: Guard `performPlay`**

Find (bot.js:1515-1522):

```js
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

Replace with:

```js
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.cocoon_started_at) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

- [ ] **Step 3: Guard `performKick`**

Find (bot.js:1540-1547, the top of the function):

```js
async function performKick(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'kick')) return;
  const now = Math.floor(Date.now() / 1000);
  noticeUser(from.id, from.username, from.first_name);

```

Replace with:

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

```

- [ ] **Step 4: Guard `performFeed`**

Find (bot.js:1648-1655):

```js
function performFeed(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

Replace with:

```js
function performFeed(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.cocoon_started_at) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

- [ ] **Step 5: Guard `performTease`**

Find (bot.js:1694-1701):

```js
function performTease(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

Replace with:

```js
function performTease(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.cocoon_started_at) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

- [ ] **Step 6: Guard `performBoobs`**

Find (bot.js:1720-1727):

```js
function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

Replace with:

```js
function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  if (state.cocoon_started_at) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
```

- [ ] **Step 7: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add bot.js
git commit -m "feat(troll): block play/feed/kick/tease/boobs while cocooned"
```

---

### Task 6: Admin endpoints — `POST /api/cocoon-enter` and `POST /api/cocoon-exit`

**Files:**
- Modify: `admin-server.js:150-158`

- [ ] **Step 1: Add the two endpoints right after `/resume`**

Find (admin-server.js:150-158):

```js
api.post('/pause', (req, res) => {
  setSetting('paused', '1');
  res.json({ paused: true });
});

api.post('/resume', (req, res) => {
  setSetting('paused', '0');
  res.json({ paused: false });
});

api.post('/reset', (req, res) => {
```

Replace with:

```js
api.post('/pause', (req, res) => {
  setSetting('paused', '1');
  res.json({ paused: true });
});

api.post('/resume', (req, res) => {
  setSetting('paused', '0');
  res.json({ paused: false });
});

api.post('/cocoon-enter', (req, res) => {
  const state = db.prepare('SELECT cocoon_started_at, chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return res.status(404).json({ error: 'no troll yet' });
  if (!state.cocoon_started_at) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE troll_state SET cocoon_started_at = ? WHERE id = 1').run(now);
    bot.sendMessage(state.chat_id, '🥚 Тролль сворачивается в кокон и начинает перерождение...').catch(() => {});
  }
  res.json({ cocoon: true });
});

// On the FIRST ever exit (has_transformed still 0), this also applies a
// one-time permanent upgrade: max_health 100 -> 200 (fully healed), and the
// troll's current (not just default) health decay/regen settings doubled to
// match the new scale. A later cocoon cycle just toggles cocoon_started_at
// with no further upgrade — has_transformed makes sure of that.
api.post('/cocoon-exit', (req, res) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return res.status(404).json({ error: 'no troll yet' });
  if (state.cocoon_started_at) {
    db.prepare('UPDATE troll_state SET cocoon_started_at = NULL WHERE id = 1').run();
    bot.sendMessage(state.chat_id, '🦋 Тролль вышел из кокона!').catch(() => {});
    if (!state.has_transformed) {
      for (const key of ['health_decay_per_hour', 'health_regen_baby', 'health_regen_young', 'health_regen_adult', 'health_regen_old']) {
        setSetting(key, String(Number(getSetting(key)) * 2));
      }
      db.prepare('UPDATE troll_state SET max_health = 200, health = 200, has_transformed = 1 WHERE id = 1').run();
    }
  }
  res.json({ cocoon: false });
});

api.post('/reset', (req, res) => {
```

- [ ] **Step 2: Add `cocoon` and `maxHealth` to `/status`**

Find (admin-server.js:36-52):

```js
api.get('/status', (req, res) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return res.json({ exists: false });
  res.json({
    exists: true,
    health: state.health,
    mood: state.mood,
    moodWord: moodWord(state.mood),
    satiety: state.satiety,
    satietyWord: satietyWord(state.satiety),
    weight: state.weight,
    stage: state.stage,
    stageName: STAGE_NAMES[state.stage],
    activity: getActivityLine(state),
    paused: getSetting('paused') === '1',
  });
});
```

Replace with:

```js
api.get('/status', (req, res) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return res.json({ exists: false });
  res.json({
    exists: true,
    health: state.health,
    maxHealth: state.max_health,
    mood: state.mood,
    moodWord: moodWord(state.mood),
    satiety: state.satiety,
    satietyWord: satietyWord(state.satiety),
    weight: state.weight,
    stage: state.stage,
    stageName: STAGE_NAMES[state.stage],
    activity: getActivityLine(state),
    paused: getSetting('paused') === '1',
    cocoon: !!state.cocoon_started_at,
  });
});
```

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check admin-server.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify the settings-doubling logic in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\"CREATE TABLE troll_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)\");
db.prepare('INSERT INTO troll_settings VALUES (?, ?)').run('health_regen_adult', '7');
function getSetting(key) { const row = db.prepare('SELECT value FROM troll_settings WHERE key = ?').get(key); return row ? row.value : undefined; }
function setSetting(key, value) { db.prepare('INSERT OR REPLACE INTO troll_settings (key, value) VALUES (?, ?)').run(key, String(value)); }
setSetting('health_regen_adult', String(Number(getSetting('health_regen_adult')) * 2));
console.log(getSetting('health_regen_adult'));
"
```

Expected: `14` (confirms doubling a live, admin-tuned value — not just the
default — works as intended).

- [ ] **Step 5: Commit**

```bash
git add admin-server.js
git commit -m "feat(troll): add /cocoon-enter and /cocoon-exit admin endpoints"
```

---

### Task 7: All-time stats caption helper (`buildAllTimeStatsCaption`)

**Files:**
- Modify: `bot.js` (insert right before the `/troll` handler, currently starting at `bot.onText(/\/troll\b/`)

- [ ] **Step 1: Add the helper function**

Find (bot.js):

```js
bot.onText(/\/troll\b/, async (msg) => {
```

Insert immediately before it:

```js
// All-time activity totals, shown as the /troll photo's caption only while
// cocooned (see backgroundTick's freeze and admin-server.js's /cocoon-enter/
// -exit) — same category set as admin-server.js's per-stage report, just
// scoped to the troll's whole life (since born_at, not stage_started_at)
// and without the per-person breakdown, since this is a quick glance during
// stasis, not an audit. Admin-server.js is a separate process and can't
// require this file (see admin-lib.js's file-level comment on why), so this
// is intentionally a standalone duplicate of that aggregation shape rather
// than a shared function.
function buildAllTimeStatsCaption(state) {
  const since = state.born_at || 0;
  const rows = db.prepare(
    'SELECT action, COUNT(*) AS n FROM troll_actions WHERE created_at >= ? GROUP BY action'
  ).all(since);
  const totals = {};
  for (const row of rows) totals[row.action] = row.n;
  const totalFor = (action) => totals[action] || 0;
  const feedTotal = totalFor('feed') + totalFor('feed_overeat');
  return [
    '📊 Статистика за всю жизнь:',
    `🎮 Игр: ${totalFor('play')}`,
    `🍗 Кормлений: ${feedTotal} (перекормлено: ${totalFor('feed_overeat')})`,
    `👢 Пинков: ${totalFor('kick')}`,
    `😈 Дразнилок: ${totalFor('tease')}`,
    `🍈 Показов сиськи: ${totalFor('boobs')}`,
    `😏 Огрызнулся: ${totalFor('snapped_at')}`,
    `🎯 Дотроллил: ${totalFor('mischief_targeted')}`,
    `💦 Описал: ${totalFor('pee_target')}`,
    `💩 В какашку попали: ${totalFor('poop_victim')}`,
    `📖 Выучено фраз: ${totalFor('teach')}`,
    `— — —`,
    `💩 Покакал: ${totalFor('poop')}`,
    `💦 Пописал: ${totalFor('pee')}`,
    `🍽️ Поел сам: ${totalFor('self_eat')}`,
  ].join('\n');
}

bot.onText(/\/troll\b/, async (msg) => {
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(troll): add all-time stats caption helper for the cocooned /troll card"
```

---

### Task 8: `max_health` replaces the hardcoded `100` health ceiling

**Files:**
- Modify: `bot.js:1565` (regen-sleep landed-kick), `bot.js:2151` (`handleRegenSleepTick`), `bot.js:2189-2198` (hourly tick), `bot.js:1426-1465` (`/troll` command — now includes the caption helper added in Task 7 right above it), `card.js:260`

- [ ] **Step 1: Regen-sleep landed-kick branch in `performKick`**

Find (bot.js:1565):

```js
      'UPDATE troll_state SET regen_sleep_started_at = NULL, regen_sleep_ticks_applied = 0, last_regen_sleep_at = ?, health = MAX(0, MIN(100, health + ?) - 5), mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1'
```

Replace with:

```js
      'UPDATE troll_state SET regen_sleep_started_at = NULL, regen_sleep_ticks_applied = 0, last_regen_sleep_at = ?, health = MAX(0, MIN(max_health, health + ?) - 5), mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1'
```

- [ ] **Step 2: `handleRegenSleepTick`'s per-tick regen**

Find (bot.js:2151):

```js
      'UPDATE troll_state SET health = MIN(100, health + ?), weight = MAX(?, weight - ?), regen_sleep_ticks_applied = ? WHERE id = 1'
```

Replace with:

```js
      'UPDATE troll_state SET health = MIN(max_health, health + ?), weight = MAX(?, weight - ?), regen_sleep_ticks_applied = ? WHERE id = 1'
```

- [ ] **Step 3: `backgroundTick`'s hourly regen branch**

Find (bot.js:2189-2198):

```js
  if (!state.last_health_tick_at || now - state.last_health_tick_at >= 3600) {
    const decay = getSettingNumber('health_decay_per_hour');
    const regen = getSettingNumber(STAGE_HEALTH_REGEN_KEYS[state.stage] || 'health_regen_baby');
    const satietyDecay = getSettingNumber('satiety_decay_per_hour');
    // Health only decays from being hungry (satiety < 30) now — no more
    // separate "hasn't been fed in N hours" neglect timer.
    if (state.satiety < 30) {
      db.prepare('UPDATE troll_state SET health = MAX(0, health - ?), satiety = MAX(0, satiety - ?), last_health_tick_at = ? WHERE id = 1').run(decay, satietyDecay, now);
    } else {
      db.prepare('UPDATE troll_state SET health = MIN(100, health + ?), satiety = MAX(0, satiety - ?), last_health_tick_at = ? WHERE id = 1').run(regen, satietyDecay, now);
    }
  }
```

Replace with:

```js
  if (!state.last_health_tick_at || now - state.last_health_tick_at >= 3600) {
    const decay = getSettingNumber('health_decay_per_hour');
    const regen = getSettingNumber(STAGE_HEALTH_REGEN_KEYS[state.stage] || 'health_regen_baby');
    const satietyDecay = getSettingNumber('satiety_decay_per_hour');
    // Health only decays from being hungry (satiety < 30) now — no more
    // separate "hasn't been fed in N hours" neglect timer.
    if (state.satiety < 30) {
      db.prepare('UPDATE troll_state SET health = MAX(0, health - ?), satiety = MAX(0, satiety - ?), last_health_tick_at = ? WHERE id = 1').run(decay, satietyDecay, now);
    } else {
      db.prepare('UPDATE troll_state SET health = MIN(max_health, health + ?), satiety = MAX(0, satiety - ?), last_health_tick_at = ? WHERE id = 1').run(regen, satietyDecay, now);
    }
  }
```

- [ ] **Step 4: `/troll` command — pass `maxHealth` into the card, wire in the caption, and fix the text fallback**

Find (bot.js:1426-1465, the whole handler):

```js
bot.onText(/\/troll\b/, async (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id) return;
  const relRow = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(msg.from.id);
  const attitude = relRow ? relRow.attitude : 0;
  const activity = getActivityLine(state);

  // Rendered fresh per call (attitude is per-viewer, activity/stats change
  // constantly) — falls back to the old plain-text card if canvas ever
  // fails to render (e.g. a native-binary hiccup on the server), so /troll
  // never breaks outright.
  try {
    const buffer = await renderTrollCard({
      health: state.health,
      satiety: state.satiety,
      satietyWord: satietyWord(state.satiety),
      mood: state.mood,
      moodWord: moodWord(state.mood),
      attitude,
      attitudeWord: attitudeWord(attitude),
      stageName: STAGE_NAMES[state.stage],
      weight: state.weight,
      activity,
    });
    await bot.sendPhoto(msg.chat.id, buffer, TROLL_ACTION_KEYBOARD);
  } catch (err) {
    console.error('troll card render failed, falling back to text:', err.message);
    const lines = [
      `❤️ Здоровье: ${state.health}/100`,
      `🍖 Сытость: ${state.satiety}/100 (${satietyWord(state.satiety)})`,
      `⚖️ Вес: ${state.weight} кг`,
      `😊 Настроение: ${moodWord(state.mood)}`,
      `🌱 Стадия: ${STAGE_NAMES[state.stage]}`,
      `🎭 Занятие: ${activity}`,
      `🤝 Отношение к тебе: ${attitudeWord(attitude)} (${attitude > 0 ? '+' : ''}${attitude})`,
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), TROLL_ACTION_KEYBOARD);
  }
});
```

Replace with:

```js
bot.onText(/\/troll\b/, async (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id) return;
  const relRow = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(msg.from.id);
  const attitude = relRow ? relRow.attitude : 0;
  const activity = getActivityLine(state);
  const cocoonCaption = state.cocoon_started_at ? buildAllTimeStatsCaption(state) : null;

  // Rendered fresh per call (attitude is per-viewer, activity/stats change
  // constantly) — falls back to the old plain-text card if canvas ever
  // fails to render (e.g. a native-binary hiccup on the server), so /troll
  // never breaks outright.
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
    });
    const photoOptions = cocoonCaption ? { ...TROLL_ACTION_KEYBOARD, caption: cocoonCaption } : TROLL_ACTION_KEYBOARD;
    await bot.sendPhoto(msg.chat.id, buffer, photoOptions);
  } catch (err) {
    console.error('troll card render failed, falling back to text:', err.message);
    const lines = [
      `❤️ Здоровье: ${state.health}/${state.max_health}`,
      `🍖 Сытость: ${state.satiety}/100 (${satietyWord(state.satiety)})`,
      `⚖️ Вес: ${state.weight} кг`,
      `😊 Настроение: ${moodWord(state.mood)}`,
      `🌱 Стадия: ${STAGE_NAMES[state.stage]}`,
      `🎭 Занятие: ${activity}`,
      `🤝 Отношение к тебе: ${attitudeWord(attitude)} (${attitude > 0 ? '+' : ''}${attitude})`,
    ];
    if (cocoonCaption) lines.push('', cocoonCaption);
    bot.sendMessage(msg.chat.id, lines.join('\n'), TROLL_ACTION_KEYBOARD);
  }
});
```

- [ ] **Step 5: `card.js`'s health bar — use `data.maxHealth` instead of a literal `100`**

Find (card.js:260):

```js
  barRow('heart', COLORS.health, 'Здоровье', `${data.health}/100`, data.health, 100, false);
```

Replace with:

```js
  barRow('heart', COLORS.health, 'Здоровье', `${data.health}/${data.maxHealth}`, data.health, data.maxHealth, false);
```

- [ ] **Step 6: Verify with syntax checks**

```bash
node --check bot.js
node --check card.js
```
Expected: no output, exit code 0 for both.

- [ ] **Step 7: Commit**

```bash
git add bot.js card.js
git commit -m "feat(troll): use max_health instead of a hardcoded 100 health ceiling"
```

---

### Task 9: Reflect cocoon in `getActivityLine` (both copies)

**Files:**
- Modify: `bot.js:1396-1408`, `admin-lib.js:68-82`

- [ ] **Step 1: `bot.js`'s copy**

Find (bot.js:1396-1408):

```js
function getActivityLine(state) {
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.regen_sleep_started_at) {
    return 'спит под мостом и восстанавливается — лучше не будить';
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  return pickPhraseForStage('activity_awake', state.stage, 'бродит под мостом');
}
```

Replace with:

```js
function getActivityLine(state) {
  if (state.cocoon_started_at) {
    return 'в коконе, перерождается — полная стазис';
  }
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.regen_sleep_started_at) {
    return 'спит под мостом и восстанавливается — лучше не будить';
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  return pickPhraseForStage('activity_awake', state.stage, 'бродит под мостом');
}
```

- [ ] **Step 2: `admin-lib.js`'s duplicate copy**

Find (admin-lib.js:68-82):

```js
function getActivityLine(state) {
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.regen_sleep_started_at) {
    return 'спит под мостом и восстанавливается — лучше не будить';
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  const rows = db.prepare("SELECT text FROM troll_phrases WHERE category = 'activity_awake'").all();
  if (rows.length === 0) return 'бродит под мостом';
  return rows[Math.floor(Math.random() * rows.length)].text;
}
```

Replace with:

```js
function getActivityLine(state) {
  if (state.cocoon_started_at) {
    return 'в коконе, перерождается — полная стазис';
  }
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.regen_sleep_started_at) {
    return 'спит под мостом и восстанавливается — лучше не будить';
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  const rows = db.prepare("SELECT text FROM troll_phrases WHERE category = 'activity_awake'").all();
  if (rows.length === 0) return 'бродит под мостом';
  return rows[Math.floor(Math.random() * rows.length)].text;
}
```

- [ ] **Step 3: Verify with syntax checks**

```bash
node --check bot.js
node --check admin-lib.js
```
Expected: no output, exit code 0 for both.

- [ ] **Step 4: Commit**

```bash
git add bot.js admin-lib.js
git commit -m "feat(troll): reflect cocoon state in getActivityLine"
```

---

### Task 10: Admin panel — status chip, toggle button, dynamic health display

**Files:**
- Modify: `public/app.js:112-177` (the `loadStatus` function)

- [ ] **Step 1: Add the cocoon chip and fix the health chip/stat-grid to use `maxHealth`**

Find (public/app.js:123-129):

```js
  sub.textContent = data.stageName;
  chips.innerHTML = `
    <div class="chip"><span class="dot"></span>здоровье <b class="mono">${data.health}</b></div>
    <div class="chip${data.satiety < 50 ? ' warn' : ''}"><span class="dot"></span>сытость <b class="mono">${data.satiety}</b></div>
    <div class="chip"><span class="dot"></span>настроение <b>${data.moodWord}</b></div>
    ${data.paused ? '<div class="chip warn"><span class="dot"></span>шалости на паузе</div>' : ''}
  `;
```

Replace with:

```js
  sub.textContent = data.stageName;
  chips.innerHTML = `
    <div class="chip"><span class="dot"></span>здоровье <b class="mono">${data.health}/${data.maxHealth}</b></div>
    <div class="chip${data.satiety < 50 ? ' warn' : ''}"><span class="dot"></span>сытость <b class="mono">${data.satiety}</b></div>
    <div class="chip"><span class="dot"></span>настроение <b>${data.moodWord}</b></div>
    ${data.paused ? '<div class="chip warn"><span class="dot"></span>шалости на паузе</div>' : ''}
    ${data.cocoon ? '<div class="chip warn"><span class="dot"></span>тролль в коконе</div>' : ''}
  `;
```

- [ ] **Step 2: Fix the health stat-grid entry and bar-fill width**

Find (public/app.js:134-135):

```js
        <div class="stat"><div class="label">❤️ Здоровье</div><div class="value mono">${data.health}/100</div>
          <div class="bar-track"><div class="bar-fill" style="width:${data.health}%"></div></div></div>
```

Replace with:

```js
        <div class="stat"><div class="label">❤️ Здоровье</div><div class="value mono">${data.health}/${data.maxHealth}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * data.health / data.maxHealth)}%"></div></div></div>
```

- [ ] **Step 3: Add the cocoon toggle button next to the pause button**

Find (public/app.js:150-156):

```js
    <div class="card">
      <p class="eyebrow">Быстрые действия</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" id="btn-pause">${data.paused ? '▶ Возобновить' : '⏸ Пауза шалостей'}</button>
        <button class="btn ghost" id="btn-reset">↺ Полный сброс</button>
      </div>
    </div>
```

Replace with:

```js
    <div class="card">
      <p class="eyebrow">Быстрые действия</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" id="btn-pause">${data.paused ? '▶ Возобновить' : '⏸ Пауза шалостей'}</button>
        <button class="btn ghost" id="btn-cocoon">${data.cocoon ? '🦋 Вывести из кокона' : '🥚 Кокон'}</button>
        <button class="btn ghost" id="btn-reset">↺ Полный сброс</button>
      </div>
    </div>
```

- [ ] **Step 4: Wire the new button's click handler**

Find (public/app.js:169-172):

```js
  document.getElementById('btn-pause').addEventListener('click', async () => {
    await apiFetch(data.paused ? '/resume' : '/pause', { method: 'POST' });
    loadStatus();
  });
```

Add immediately after it:

```js
  document.getElementById('btn-cocoon').addEventListener('click', async () => {
    await apiFetch(data.cocoon ? '/cocoon-exit' : '/cocoon-enter', { method: 'POST' });
    loadStatus();
  });
```

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(troll): add cocoon toggle and dynamic max-health display to admin panel"
```

---

### Task 11: Manual end-to-end verification

**Files:** none (verification only, against a running test bot + admin panel)

No automated test suite exists for this bot — verify against a real running
instance, same as every other plan in this repo.

- [ ] **Step 1: Confirm entering the cocoon freezes everything**

In the admin panel, click "🥚 Кокон". Expected: the public chat gets "🥚
Тролль сворачивается в кокон и начинает перерождение...", and the status
panel shows the "тролль в коконе" chip.

Send `/play`, `/feed`, `/kick`, `/tease`, `/boobs` in the test chat. Expected:
every one replies with "🥚 Тролль сейчас в коконе, ему не до тебя..." and
none of them change any stat:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT health, mood, satiety, weight FROM troll_state WHERE id = 1').get());
"
```

Run it before and after sending the commands above — the numbers must be
identical.

- [ ] **Step 2: Confirm autonomous behavior is paused**

Wait one `BACKGROUND_TICK_MS` cycle (5 minutes) and confirm no mischief,
hunger, eat/poop/pee, or night-sleep message appears in the chat while
cocooned.

- [ ] **Step 3: Confirm the `/troll` card shows the all-time caption**

Send `/troll`. Expected: the same portrait/bars as always, plus a caption
below the photo listing all-time totals (plays, feeds, kicks, etc.) — cross
check a couple of numbers against:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare(\"SELECT action, COUNT(*) AS n FROM troll_actions GROUP BY action\").all());
"
```

- [ ] **Step 4: Confirm first-time exit applies the one-time upgrade**

Before exiting, note the current settings:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
for (const k of ['health_decay_per_hour','health_regen_baby','health_regen_young','health_regen_adult','health_regen_old']) {
  console.log(k, db.prepare('SELECT value FROM troll_settings WHERE key = ?').get(k));
}
"
```

Click "🦋 Вывести из кокона" in the admin panel. Expected: public chat gets
"🦋 Тролль вышел из кокона!", commands work normally again, and:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT health, max_health, has_transformed FROM troll_state WHERE id = 1').get());
for (const k of ['health_decay_per_hour','health_regen_baby','health_regen_young','health_regen_adult','health_regen_old']) {
  console.log(k, db.prepare('SELECT value FROM troll_settings WHERE key = ?').get(k));
}
"
```

Expected: `health` and `max_health` both `200`, `has_transformed` is `1`,
and each of the 5 settings is exactly double what it was before this step.

- [ ] **Step 5: Confirm a second cocoon cycle does NOT re-apply the upgrade**

Click "🥚 Кокон" then "🦋 Вывести из кокона" again. Expected: the rebirth
chat messages post again (that's fine, it's just an announcement), but:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT health, max_health FROM troll_state WHERE id = 1').get());
"
```

`max_health` must still be `200`, not `400` — and the 5 settings from Step 4
must be unchanged from their already-doubled values.

- [ ] **Step 6: Confirm the health bar/number scale correctly in the admin panel**

With `health` somewhere below `max_health` (e.g. let an hour pass so decay
kicks in), open the admin panel's status tab. Expected: the health chip and
stat-grid show `<health>/200`, and the bar-fill width is proportional to
`health/200` (e.g. `health = 150` renders at 75% width, not 150%).

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here.
If it did, commit those fixes individually with a description of what was
wrong, following the same commit-message style as the tasks above.
