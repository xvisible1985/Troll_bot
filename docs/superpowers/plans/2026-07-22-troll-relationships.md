# Troll Relationships & Attitude System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the troll a persistent per-person "attitude" (-100..+100) that automatically shifts from `/play`/`/feed`/`/kick`, and that skews targeted mischief toward disliked people, both in frequency (weighted selection) and severity (tier escalation).

**Architecture:** One new SQLite table (`troll_relationships`), four new admin-tunable settings, two new helper functions (`noticeUser`, `adjustAttitude`) wired into the three interactive commands and the message handler, and a weighted-selection/tier-escalation change inside the existing `triggerMischief` targeted branch.

**Tech Stack:** Same as the rest of `troll-bot` — Node.js, `better-sqlite3`, no test framework (verification via `node --check` + hand-tracing + throwaway `node -e` scripts, discarded after use).

Full design: `docs/superpowers/specs/2026-07-22-troll-relationships-design.md`.

**IMPORTANT:** Do not run `node bot.js` directly (no real `.env` exists in the local dev copy of this repo — that's expected; verification uses `node --check` and short-lived `node -e "require('./bot.js')"` runs against the local throwaway `troll.db`, which is safe and already the established pattern for this project). Never touch the production server directly — deployment is handled by the user afterward.

---

### Task 1: Schema and settings

**Files:** Modify `c:\Users\123\Projects\troll-bot\bot.js` (two insertion points)

- [ ] **Step 1: Add the `troll_relationships` table**

Find this exact text:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    text TEXT NOT NULL
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
```
Replace with:
```js
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    text TEXT NOT NULL
  )
`);
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
  sleep_start: '0',
  sleep_end: '8',
  naughtiness: '5',
  mischief_interval_hours: '1',
  mischief_message_trigger: '50',
  health_decay_per_hour: '2',
  health_regen_per_hour: '1',
  neglect_threshold_hours: '6',
  paused: '0',
  attitude_play_delta: '5',
  attitude_feed_delta: '8',
  attitude_kick_delta: '-15',
  attitude_escalation_threshold: '-30',
};
```

(This also adds the four new settings to `DEFAULT_SETTINGS` in the same edit, since they're adjacent in the file — `/troll_settings` and `/troll_set` already iterate `DEFAULT_SETTINGS`'s keys generically, so both commands automatically pick up the four new keys with no further code changes.)

- [ ] **Step 2: Verify**

Run: `node --check bot.js` — expect no output.

Then, from `c:\Users\123\Projects\troll-bot`:
```bash
rm -f troll.db
timeout 3 node -e "require('./bot.js')" || true
node -e "
const db = require('better-sqlite3')('troll.db');
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='troll_relationships'\").get());
console.log(db.prepare('SELECT * FROM troll_settings WHERE key LIKE \'attitude_%\' ORDER BY key').all());
"
rm -f troll.db
```
Expected: the table exists, and all 4 `attitude_*` settings show with the exact default values above (note `attitude_kick_delta` is the string `'-15'`, a negative number stored as text like every other setting).

- [ ] **Step 3: Commit**
```bash
git add bot.js
git commit -m "feat(relationships): add troll_relationships table and attitude tuning settings"
```

---

### Task 2: `noticeUser` and `adjustAttitude` helpers

**Files:** Modify `bot.js` (one insertion point)

- [ ] **Step 1: Add the helpers**

Find this exact text:
```js
function logAction(userId, username, action) {
  db.prepare('INSERT INTO troll_actions (user_id, username, action) VALUES (?, ?, ?)').run(userId, username, action);
}

// --- Growth ---
```
Replace with:
```js
function logAction(userId, username, action) {
  db.prepare('INSERT INTO troll_actions (user_id, username, action) VALUES (?, ?, ?)').run(userId, username, action);
}

// --- Relationships ---
// Called anywhere the troll "notices" someone — any ordinary message in its
// home chat, or /play, /feed, /kick (even from someone who only ever uses
// commands and never sends plain messages). Upserts so username/first_name
// stay current if the person renames themselves; attitude starts at 0
// (neutral) and is never touched here — only adjustAttitude moves it.
function noticeUser(userId, username, firstName) {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT 1 FROM troll_relationships WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare('UPDATE troll_relationships SET username = ?, first_name = ?, last_seen_at = ? WHERE user_id = ?').run(username, firstName, now, userId);
  } else {
    db.prepare('INSERT INTO troll_relationships (user_id, username, first_name, attitude, last_seen_at) VALUES (?, ?, ?, 0, ?)').run(userId, username, firstName, now);
  }
}

function adjustAttitude(userId, delta) {
  db.prepare('UPDATE troll_relationships SET attitude = MAX(-100, MIN(100, attitude + ?)) WHERE user_id = ?').run(delta, userId);
}

// --- Growth ---
```

- [ ] **Step 2: Verify**

Run: `node --check bot.js` — expect no output.

Manual verification (static only) — hand-trace, don't run live yet (Task 3 wires these in, so calling them in isolation now wouldn't reflect real usage):
1. Confirm `noticeUser` upserts (checks existence first) rather than blindly `INSERT OR REPLACE`-ing, which would reset `attitude` back to 0 and `first_seen_at` to now on every single message — that would defeat the whole point of a persistent, accumulating attitude value.
2. Confirm `adjustAttitude`'s `MAX(-100, MIN(100, attitude + ?))` clamps correctly in both directions — e.g. an already-capped +100 plus another `+8` stays at 100; an already-capped -100 plus another `-15` stays at -100.

- [ ] **Step 3: Commit**
```bash
git add bot.js
git commit -m "feat(relationships): add noticeUser and adjustAttitude helpers"
```

---

### Task 3: Wire noticing and attitude changes into /play, /kick, /feed, and the message handler

**Files:** Modify `bot.js` (four insertion points)

- [ ] **Step 1: `/play`**

Find this exact text:
```js
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'play');
  bot.sendMessage(msg.chat.id, pickPhrase('play', 'Моя рада играть с твоя!'));
});
```
Replace with:
```js
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'play');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_play_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('play', 'Моя рада играть с твоя!'));
});
```

- [ ] **Step 2: `/kick`**

Find this exact text:
```js
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'kick');
  bot.sendMessage(msg.chat.id, pickPhrase('kick', 'Твоя злой! Моя обижаться!'));
});
```
Replace with:
```js
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'kick');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_kick_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('kick', 'Твоя злой! Моя обижаться!'));
});
```

- [ ] **Step 3: `/feed`**

Find this exact text:
```js
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'feed');
  bot.sendMessage(msg.chat.id, pickPhrase('feed', 'Ням-ням, спасибо твоя!'));
  if (newStage > oldStage) {
```
Replace with:
```js
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'feed');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_feed_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('feed', 'Ням-ням, спасибо твоя!'));
  if (newStage > oldStage) {
```

- [ ] **Step 4: Message handler**

Find this exact text:
```js
  pushRecentMessage({ userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  const newCount = state.message_count + 1;
```
Replace with:
```js
  pushRecentMessage({ userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  const newCount = state.message_count + 1;
```

- [ ] **Step 5: Verify**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 6: Manual verification (static only)**
1. Confirm none of the three commands' early-return branches (no state, wrong chat, silenced, or the asleep-angry branch) reach the new `noticeUser`/`adjustAttitude` calls — they must sit strictly after those guards, in the normal success path only, matching the design's "a no-op interaction doesn't notice or adjust attitude."
2. Confirm the message handler's `noticeUser` call sits after the same `if (!state || msg.chat.id !== state.chat_id) return;` guard `pushRecentMessage` already relies on, and is NOT gated by the later `paused`/`isSilenced`/`isNightNow` check further down (that check only guards the mischief *trigger*, not the counting/noticing that happens for every qualifying message — same reasoning as why `message_count` itself isn't gated by it either).
3. Confirm `getSettingNumber('attitude_kick_delta')` correctly returns a negative number (`Number('-15')` is `-15`), so `adjustAttitude(msg.from.id, getSettingNumber('attitude_kick_delta'))` actually decreases attitude, not increases it.

- [ ] **Step 7: Commit**
```bash
git add bot.js
git commit -m "feat(relationships): notice users and adjust attitude on /play, /feed, /kick, and ordinary messages"
```

---

### Task 4: Weighted target selection and tier escalation in `triggerMischief`

**Files:** Modify `bot.js` (two insertion points)

- [ ] **Step 1: Add `pickMischiefTarget`**

Find this exact text:
```js
function getMentionName(entry) {
  return entry.username ? `@${entry.username}` : entry.firstName;
}
```
Replace with:
```js
function getMentionName(entry) {
  return entry.username ? `@${entry.username}` : entry.firstName;
}

// Weighted pick from recentMessages: the more a person is disliked, the more
// likely they are to be chosen as a mischief target (weight = 100 - attitude),
// floored at 10 so even a beloved (+100) person can still occasionally be
// picked, never dropping to zero chance.
function pickMischiefTarget() {
  const candidates = recentMessages.map((entry) => {
    const row = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(entry.userId);
    const attitude = row ? row.attitude : 0;
    const weight = Math.max(10, 100 - attitude);
    return { entry, attitude, weight };
  });
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}
```

- [ ] **Step 2: Use it in `triggerMischief`, with tier escalation for disliked targets**

Find this exact text:
```js
  if (recentMessages.length > 0 && Math.random() < 0.5) {
    const target = getMentionName(pick(recentMessages));
    if (Math.random() < 0.5) {
      const template = pickPhrase(TARGETED_PHRASE_TIER_CATEGORIES[tier], 'подмигнул {user}');
      bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, target)}*`).catch(() => {});
    } else {
      const template = pickPhrase(TARGETED_ACTION_TIER_CATEGORIES[tier], 'подшутить над {user}');
      bot.sendMessage(chatId, `/try ${template.replace(/\{user\}/g, target)}`).catch(() => {});
    }
    return;
  }
```
Replace with:
```js
  if (recentMessages.length > 0 && Math.random() < 0.5) {
    const targetInfo = pickMischiefTarget();
    const target = getMentionName(targetInfo.entry);
    const escalationThreshold = getSettingNumber('attitude_escalation_threshold');
    const maxTier = STAGE_MAX_MISCHIEF_TIER[stage] ?? 2;
    const effectiveTier = targetInfo.attitude <= escalationThreshold ? Math.min(maxTier, tier + 1) : tier;
    if (Math.random() < 0.5) {
      const template = pickPhrase(TARGETED_PHRASE_TIER_CATEGORIES[effectiveTier], 'подмигнул {user}');
      bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, target)}*`).catch(() => {});
    } else {
      const template = pickPhrase(TARGETED_ACTION_TIER_CATEGORIES[effectiveTier], 'подшутить над {user}');
      bot.sendMessage(chatId, `/try ${template.replace(/\{user\}/g, target)}`).catch(() => {});
    }
    return;
  }
```

(`stage` is already computed earlier in `triggerMischief` — `const stage = getStage(state.feed_count);` — and reused here, not recomputed.)

- [ ] **Step 3: Verify**

Run: `node --check bot.js` — expect no output.

- [ ] **Step 4: Manual verification (static + throwaway script)**

Hand-trace the weighting: write a throwaway script (do not save it anywhere in the repo) that reproduces `pickMischiefTarget`'s formula in isolation and runs it many times to sanity-check the distribution skews as expected:
```bash
node -e "
function weightFor(attitude) { return Math.max(10, 100 - attitude); }
const candidates = [
  { name: 'hated', attitude: -100 },
  { name: 'neutral', attitude: 0 },
  { name: 'loved', attitude: 100 },
];
const counts = { hated: 0, neutral: 0, loved: 0 };
for (let i = 0; i < 100000; i++) {
  const weighted = candidates.map((c) => ({ ...c, weight: weightFor(c.attitude) }));
  const total = weighted.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const c of weighted) {
    roll -= c.weight;
    if (roll <= 0) { counts[c.name]++; break; }
  }
}
console.log(counts);
"
```
Expected: `hated` picked roughly 20x more often than `loved` (weight 200 vs weight 10), `neutral` (weight 100) roughly in between — exact ratios will vary run to run (it's random), but the ordering `hated > neutral > loved` by a wide margin should be unmistakable.

Also hand-trace tier escalation: `stage=3` (молодой, `maxTier=2`), `tier=0` (mild, from mood/naughtiness), target attitude `-50`, `attitude_escalation_threshold=-30` → `-50 <= -30` is true → `effectiveTier = min(2, 0+1) = 1` (medium) — confirms escalation bumps exactly one tier, not straight to mean. Then `stage=1` (малыш, `maxTier=0`), same target attitude `-50`, `tier=0` → `effectiveTier = min(0, 0+1) = 0` — confirms the stage cap still holds even under escalation (малыш never exceeds mild).

- [ ] **Step 5: Commit**
```bash
git add bot.js
git commit -m "feat(relationships): weight targeted-mischief victim selection and tier by attitude"
```

---

## Self-Review Notes

- **Spec coverage:** data model + settings (Task 1), notice/adjust helpers (Task 2), wiring into all four notice points (Task 3), weighted selection + tier escalation (Task 4) — matches every section of the design doc. The doc's explicitly-out-of-scope items (Mini App tab, a `/troll_*` command for viewing relationships) are correctly not present anywhere in this plan.
- **Placeholder scan:** no TBDs; every step has complete code or an exact command with expected output.
- **Type/name consistency:** `noticeUser`, `adjustAttitude`, `pickMischiefTarget`, `attitude_play_delta`/`attitude_feed_delta`/`attitude_kick_delta`/`attitude_escalation_threshold` are each defined once (Tasks 1/2/4) and referenced identically everywhere else (Task 3, Task 4). `stage`/`tier`/`maxTier` naming in Task 4's `triggerMischief` changes matches the existing surrounding code exactly (no renamed variables).
- **No behavior change outside the targeted branch:** the detached/generic mischief branch, the timer-vs-message-count trigger split, and every other command are untouched by this plan.
