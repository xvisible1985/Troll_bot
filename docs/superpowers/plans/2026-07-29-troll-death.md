# Troll Death/Unconsciousness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the troll's `health` hits 0, it falls unconscious (all normal
interactions disabled, a public "💀 Добить" button appears), and either
recovers on its own via the existing hourly health tick or is permanently
killed (same effect as `/troll_reset`) by whoever presses the button.

**Architecture:** Single new nullable column (`unconscious_since`) on the
existing `troll_state` singleton row. One new shared helper
(`syncUnconsciousState`) centralizes the enter/wake transition and is called
from the two places health can change (`performKick`, the hourly tick in
`backgroundTick`). Five existing functions (`performPlay`, `performFeed`,
`performTease`, `performBoobs`, `performKick`) get an early-return guard.
One new function (`performKill`) reuses `/troll_reset`'s exact delete logic
and is wired into the existing `callback_query` dispatcher. All changes are
in `bot.js` — this bot is a single-file process by convention (`admin-lib.js`/
`admin-server.js` are the separate admin panel; nothing here touches them).

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test
framework in this repo (`package.json` has no `test` script) — verification
throughout is manual, against the running bot in a real Telegram test chat,
same as how the rest of this bot has always been verified.

**Spec:** `docs/superpowers/specs/2026-07-29-troll-death-design.md`

---

### Task 1: Schema migration — `unconscious_since` column

**Files:**
- Modify: `bot.js:289-291`

- [ ] **Step 1: Add the column migration**

Find this existing block (bot.js:289-291):

```js
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN regen_sleep_ticks_applied INTEGER NOT NULL DEFAULT 0');
} catch {}
```

Add immediately after it:

```js
// Unconscious state: set the moment health first hits 0 (see
// syncUnconsciousState below), cleared either when the hourly health tick
// heals it back above 0 or when the troll is killed (troll_state is
// deleted entirely at that point, so this column just goes with it).
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN unconscious_since INTEGER');
} catch {}
```

- [ ] **Step 2: Verify the migration runs cleanly**

Run: `node -e "require('./bot.js')"` is not viable standalone (it connects to
Telegram and requires `.env`/`BOT_TOKEN`). Instead verify the SQL in
isolation:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\"CREATE TABLE troll_state (id INTEGER PRIMARY KEY CHECK (id = 1), health INTEGER NOT NULL DEFAULT 100)\");
db.exec('ALTER TABLE troll_state ADD COLUMN unconscious_since INTEGER');
console.log(db.prepare('PRAGMA table_info(troll_state)').all());
"
```

Expected: prints column info including `{ name: 'unconscious_since', type: 'INTEGER', notnull: 0, ... }` with no error.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat(troll): add unconscious_since column for death mechanic"
```

---

### Task 2: `syncUnconsciousState` helper + shared reply text

**Files:**
- Modify: `bot.js` (insert after the `STAGE_HEALTH_REGEN_KEYS` block, currently bot.js:1277-1282)

- [ ] **Step 1: Locate the insertion point**

Find (bot.js:1276-1282):

```js
const STAGE_NAMES = { 1: 'малыш', 2: 'молодой', 3: 'взрослый', 4: 'старый' };
const STAGE_HEALTH_REGEN_KEYS = {
  1: 'health_regen_baby',
  2: 'health_regen_young',
  3: 'health_regen_adult',
  4: 'health_regen_old',
};
```

- [ ] **Step 2: Insert the helper and shared reply constant right after it**

```js

// Shared by every direct interaction (/play, /feed, /kick, /tease, /boobs)
// while the troll is unconscious — see syncUnconsciousState below for how
// that state is entered/exited.
const UNCONSCIOUS_REPLY = 'Он без сознания, ему уже не помочь так — либо ждите, либо добейте.';

// Centralized health=0 transition. Called right after anything that can
// move health to or away from the floor: performKick's -5 hit, and the
// hourly health tick in backgroundTick. Keeps the "just died" / "just woke
// up" announcements in one place instead of duplicated at every call site.
// Returns 'entered' | 'woke' | null so callers can react (e.g. performKick
// skips its usual flavor-text reply if this just knocked the troll out).
function syncUnconsciousState(chatId) {
  const state = db.prepare('SELECT health, unconscious_since FROM troll_state WHERE id = 1').get();
  if (!state) return null;
  if (state.health === 0 && !state.unconscious_since) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE troll_state SET unconscious_since = ?, regen_sleep_started_at = NULL WHERE id = 1').run(now);
    bot.sendMessage(chatId, 'Тролль потерял сознание от полученных ран! Кто-то должен решить его судьбу...', {
      reply_markup: {
        inline_keyboard: [[{ text: '💀 Добить', callback_data: 'troll_kill' }]],
      },
    }).catch(() => {});
    return 'entered';
  }
  if (state.health > 0 && state.unconscious_since) {
    db.prepare('UPDATE troll_state SET unconscious_since = NULL WHERE id = 1').run();
    bot.sendMessage(chatId, 'Тролль очнулся и снова бродит под мостом.').catch(() => {});
    return 'woke';
  }
  return null;
}
```

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(troll): add syncUnconsciousState transition helper"
```

---

### Task 3: Reorder `backgroundTick` — hourly tick always runs, unconscious skips autonomous behavior

**Files:**
- Modify: `bot.js:2086-2138` (the `backgroundTick` function, top portion)

- [ ] **Step 1: Replace the top of `backgroundTick`**

Find this exact block (bot.js:2086-2138):

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

  // Regen sleep: below the health threshold, the troll retreats for a fixed
  // nap that trades weight for a much faster recovery than the hourly tick
  // above (see handleRegenSleepTick). Independent of `paused` — like the
  // health tick itself, this is about the troll's own wellbeing, not a
  // shalость — and gated by its own cooldown so it can't chain back-to-back.
  const regenSleepCooldownSeconds = getSettingNumber('regen_sleep_cooldown_hours') * 3600;
  if (
    state.health < getSettingNumber('regen_sleep_health_threshold') &&
    (!state.last_regen_sleep_at || now - state.last_regen_sleep_at >= regenSleepCooldownSeconds)
  ) {
    db.prepare('UPDATE troll_state SET regen_sleep_started_at = ?, regen_sleep_ticks_applied = 0 WHERE id = 1').run(now);
    bot.sendMessage(state.chat_id, 'Моя совсем устать... здоровье совсем плохой... моя пойти спать под мост регенерировать...').catch(() => {});
    return;
  }
```

Replace it with:

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

  // Health tick runs unconditionally now — before the night check and
  // before the unconscious short-circuit below. It used to sit after the
  // night check, which meant it silently never ran overnight; it's also
  // the only thing that can heal an unconscious troll back to consciousness
  // (see syncUnconsciousState), so it can't be gated behind either state.
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
    syncUnconsciousState(state.chat_id);
  }

  // Re-read rather than trust the `state` fetched at the top of this
  // function — the health tick just above may have flipped it either way.
  const unconsciousNow = db.prepare('SELECT unconscious_since FROM troll_state WHERE id = 1').get();
  if (unconsciousNow.unconscious_since) return;

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

  // Regen sleep: below the health threshold, the troll retreats for a fixed
  // nap that trades weight for a much faster recovery than the hourly tick
  // above (see handleRegenSleepTick). Independent of `paused` — like the
  // health tick itself, this is about the troll's own wellbeing, not a
  // shalость — and gated by its own cooldown so it can't chain back-to-back.
  const regenSleepCooldownSeconds = getSettingNumber('regen_sleep_cooldown_hours') * 3600;
  if (
    state.health < getSettingNumber('regen_sleep_health_threshold') &&
    (!state.last_regen_sleep_at || now - state.last_regen_sleep_at >= regenSleepCooldownSeconds)
  ) {
    db.prepare('UPDATE troll_state SET regen_sleep_started_at = ?, regen_sleep_ticks_applied = 0 WHERE id = 1').run(now);
    bot.sendMessage(state.chat_id, 'Моя совсем устать... здоровье совсем плохой... моя пойти спать под мост регенерировать...').catch(() => {});
    return;
  }
```

Everything below this block (`resolvePoopGameIfDue(state, now);` onward, through the end of the function) is unchanged — leave it exactly as-is.

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the reordering by reading the diff**

Run: `git diff bot.js`
Expected: the health-tick block now appears before the `night` check, a new
`unconsciousNow` re-read + early return sits between them, and everything
from `regenSleepCooldownSeconds` down is unchanged (no accidental deletions).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "fix(troll): run hourly health tick regardless of night/unconscious state"
```

---

### Task 4: Guard `performPlay`, `performFeed`, `performTease`, `performBoobs`

**Files:**
- Modify: `bot.js` (four functions, see exact anchors below)

- [ ] **Step 1: Guard `performPlay`**

Find (bot.js:1497-1505):

```js
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

Replace with:

```js
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.unconscious_since) {
    bot.sendMessage(chatId, UNCONSCIOUS_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

- [ ] **Step 2: Guard `performFeed`**

Find (bot.js:1613-1621):

```js
function performFeed(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

Replace with:

```js
function performFeed(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.unconscious_since) {
    bot.sendMessage(chatId, UNCONSCIOUS_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

- [ ] **Step 3: Guard `performTease`**

Find (bot.js:1655-1663):

```js
function performTease(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

Replace with:

```js
function performTease(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.unconscious_since) {
    bot.sendMessage(chatId, UNCONSCIOUS_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
```

- [ ] **Step 4: Guard `performBoobs`**

Find (bot.js:1677-1681):

```js
function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  noticeUser(from.id, from.username, from.first_name);
```

Replace with:

```js
function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  if (state.unconscious_since) {
    bot.sendMessage(chatId, UNCONSCIOUS_REPLY).catch(() => {});
    return;
  }
  noticeUser(from.id, from.username, from.first_name);
```

- [ ] **Step 5: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat(troll): block play/feed/tease/boobs while unconscious"
```

---

### Task 5: Guard `performKick` and trigger the transition on its health hit

**Files:**
- Modify: `bot.js:1518-1594` (the `performKick` function)

- [ ] **Step 1: Add the unconscious guard near the top**

Find (bot.js:1518-1524):

```js
async function performKick(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'kick')) return;
  const now = Math.floor(Date.now() / 1000);
  noticeUser(from.id, from.username, from.first_name);

  // Regen sleep in progress: a kick only wakes him early and banks whatever
```

Replace with:

```js
async function performKick(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'kick')) return;
  const now = Math.floor(Date.now() / 1000);
  noticeUser(from.id, from.username, from.first_name);

  if (state.unconscious_since) {
    await bot.sendMessage(chatId, UNCONSCIOUS_REPLY).catch(() => {});
    return;
  }

  // Regen sleep in progress: a kick only wakes him early and banks whatever
```

- [ ] **Step 2: Call `syncUnconsciousState` after the health-reducing write and skip the flavor reply if it just knocked him out**

Find (bot.js:1576-1594, the tail of the function):

```js
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

Replace with:

```js
  const silencedUntil = now + 60 * 60;
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), health = MAX(0, health - 5), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(from.id, from.username || from.first_name, 'kick');
  const oldAttitude2 = adjustAttitude(from.id, getSettingNumber('attitude_kick_delta'));
  checkEnemyDeclaration(chatId, from, oldAttitude2);

  // This kick may have been the one that dropped health to exactly 0 — if
  // so, the unconscious announcement (with the kill button) replaces the
  // usual kick flavor reply and the hide roll below never runs.
  if (syncUnconsciousState(chatId) === 'entered') return;

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

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(troll): trigger unconsciousness from a fatal kick"
```

---

### Task 6: `performKill` + wire the `troll_kill` button

**Files:**
- Modify: `bot.js` (insert `performKill` after `performBoobs`, currently ending bot.js:1694; modify the `callback_query` handler at bot.js:1790-1800)

- [ ] **Step 1: Add `performKill` right after `performBoobs`**

Find (bot.js:1690-1694, the end of `performBoobs`):

```js
  const category = BOOBS_CATEGORY_BY_STAGE[state.stage] || 'boobs_baby';
  db.prepare('UPDATE troll_state SET char_lust = MIN(100, char_lust + 8) WHERE id = 1').run();
  logAction(from.id, from.username || from.first_name, 'boobs');
  sendCategoryReply(chatId, mamaCategoryOverride(state, from.id, category), 'Моя видеть еда!', actorName(from), from.id);
}
```

Add immediately after the closing `}`:

```js

// Finishes off an unconscious troll — same reset /troll_reset performs
// (see that command further down: wipes troll_state/troll_actions/
// troll_learned_phrases, leaves relationships/gifs/stickers/settings alone),
// just triggered from the public "💀 Добить" button instead of the admin
// command, and narrated with who did it. Guarding on unconscious_since
// (rather than a cooldown) is what makes a stale second press on an old
// button a no-op — once troll_state is deleted, the SELECT below returns
// nothing and the second call returns immediately.
function performKill(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!state.unconscious_since) return;
  db.exec('DELETE FROM troll_state');
  db.exec('DELETE FROM troll_actions');
  db.exec('DELETE FROM troll_learned_phrases');
  bot.sendMessage(chatId, `${actorName(from)} добил тролля. Тролль умер. Используй /troll_here, чтобы призвать нового.`).catch(() => {});
}
```

- [ ] **Step 2: Wire it into the `callback_query` dispatcher**

Find (bot.js:1790-1800):

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
  else if (query.data === 'troll_kick') performKick(chatId, query.from);
  else if (query.data === 'troll_tease') performTease(chatId, query.from);
  else if (query.data === 'troll_boobs') performBoobs(chatId, query.from);
  else if (query.data === 'troll_kill') performKill(chatId, query.from);
  else return;
  bot.answerCallbackQuery(query.id).catch(() => {});
});
```

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat(troll): add performKill and wire the troll_kill button"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only, against a real test deployment)

This bot has no automated test suite, and the mechanics here (health ticks,
Telegram callback buttons, multi-hour cooldowns) don't fit a quick unit test
even if one existed — verify by running the actual bot against a test chat
(or the real one, if that's what's available) with `troll.db` freely
editable, the same way every other feature in this codebase has been
verified.

- [ ] **Step 1: Force health to exactly 0 and confirm the transition**

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare('UPDATE troll_state SET health = 5, satiety = 10 WHERE id = 1').run();
console.log(db.prepare('SELECT health, satiety, unconscious_since FROM troll_state WHERE id = 1').get());
"
```

Then either wait for the next hourly tick (satiety < 30 → decay branch →
health hits 0), or for a faster manual check, set health directly to 0 and
trigger `syncUnconsciousState` by sending a `/kick` (which calls it
unconditionally after its own write, regardless of whether this particular
kick was the one that zeroed it):

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare('UPDATE troll_state SET health = 0 WHERE id = 1').run();
"
```

Send `/kick` in the test chat. Expected: the bot posts the "потерял
сознание" message with a single "💀 Добить" inline button, and
`unconscious_since` is now non-null:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT health, unconscious_since FROM troll_state WHERE id = 1').get());
"
```

- [ ] **Step 2: Confirm normal interactions are inert while unconscious**

Send `/play`, `/feed`, `/tease`, `/boobs`, `/kick` in the test chat.
Expected: each replies with `UNCONSCIOUS_REPLY` ("Он без сознания, ему уже не
помочь так — либо ждите, либо добейте.") and none of them change `mood`,
`health`, `satiety`, or `weight` — re-run the `SELECT` from Step 1 to confirm
the row is unchanged apart from `unconscious_since`.

- [ ] **Step 3: Confirm autonomous behavior is paused**

Wait one `BACKGROUND_TICK_MS` cycle (5 minutes) and confirm no mischief,
eat/poop/pee, or hunger message appears in the chat while unconscious.

- [ ] **Step 4: Confirm the kill button works**

Click "💀 Добить" in the test chat. Expected: a public "добил тролля" message
naming the clicker, and `troll_state` is now empty:

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT COUNT(*) FROM troll_state').get());
console.log(db.prepare('SELECT COUNT(*) FROM troll_actions').get());
console.log(db.prepare('SELECT COUNT(*) FROM troll_learned_phrases').get());
console.log(db.prepare('SELECT COUNT(*) FROM troll_relationships').get());
"
```

Expected: `troll_state`, `troll_actions`, `troll_learned_phrases` counts are
all 0; `troll_relationships` is untouched (count unchanged from before the
kill).

- [ ] **Step 5: Confirm `/troll_here` is required afterward**

Send any of `/play`, `/feed`, `/troll` in the test chat. Expected: no
response (no `troll_state` row for any handler to match against). Then
send `/troll_here` as an admin. Expected: "В деревне появился детёныш
тролля..." and a fresh `troll_state` row at full health.

- [ ] **Step 6: Confirm passive self-recovery (no kill press)**

Repeat Step 1 to get back to `unconscious_since` set, but this time set
`satiety` high enough that the regen branch applies instead of decay:

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare('UPDATE troll_state SET health = 0, satiety = 80, unconscious_since = strftime(\'%s\',\'now\') WHERE id = 1').run();
"
```

Wait for the next hourly tick (or temporarily lower `health_decay_per_hour`/
adjust `last_health_tick_at` in the admin panel to force it sooner). Expected:
health rises above 0, the bot posts "Тролль очнулся и снова бродит под
мостом.", `unconscious_since` is cleared, and normal commands/autonomous
behavior resume on the next tick.

- [ ] **Step 7: Confirm the night-sleep tick fix**

With the troll conscious and asleep (`is_asleep = 1`), lower `satiety` below
30 and set `last_health_tick_at` to more than an hour ago:

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare(\"UPDATE troll_state SET is_asleep = 1, satiety = 10, last_health_tick_at = strftime('%s','now') - 4000 WHERE id = 1\").run();
console.log(db.prepare('SELECT health FROM troll_state WHERE id = 1').get());
"
```

Wait one background tick cycle, then re-run the `SELECT`. Expected: `health`
has decreased by `health_decay_per_hour`, confirming the tick now runs even
while asleep (before this change, it would not have moved at all).

- [ ] **Step 8: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here.
If it did, commit those fixes individually with a description of what was
wrong, following the same commit-message style as the tasks above.
