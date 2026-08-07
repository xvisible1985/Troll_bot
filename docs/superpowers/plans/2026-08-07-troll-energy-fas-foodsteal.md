# Troll Energy, Fas Fix, Food-Steal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared "troll energy" resource (max 20, +1/20min) that gates every autonomous attack the troll throws; make "Тролль Фас" actually land hits once a minute until that energy runs out; and replace the baby-stage "grab a breast and suckle" self-feeding action with a grown-troll "steal food by force" action (3 real swings, food-steal narration on any hit).

**Architecture:** Everything lives in `c:\Users\123\Projects\troll-bot\bot.js` plus its two settings-registry mirrors (`admin-lib.js`, `public/app.js`). One new resource (`energy`/`max_energy`/`last_energy_regen_at` on `troll_state`) is spent by three existing/new attack triggers (`triggerFasAttack`, `triggerDrunkAttack`, the new `triggerFoodSteal`) through one shared helper (`spendTrollEnergy`). A key precondition: `backgroundTick`'s own `setInterval` currently fires every 5 minutes (`BACKGROUND_TICK_MS`), which makes a genuine 1-minute Fas cadence physically impossible without shortening it — Task 3 drops it to 1 minute; every other autonomous timer in the file already gates itself with its own `now - lastAt >= X` check, so ticking the outer loop more often is safe.

**Tech Stack:** Node.js, `better-sqlite3`, `node-telegram-bot-api`. No test framework — verification is manual (`node --check` for syntax, `node -e` scripts against `troll.db`), same as every other plan in this repo.

**Spec:** `docs/superpowers/specs/2026-08-07-troll-energy-fas-foodsteal-design.md`

**Sequencing:** Tasks 1-5 are ordered (each builds on the previous) and must all land before Task 6's end-to-end verification.

---

### Task 1: Troll energy — schema, settings, regen tick, spend helper

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:384-388` (schema)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:599-604` (settings)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1365-1367` (helper, right after `logAction`)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2816-2827` (regen tick, right after the hourly health tick)
- Modify: `c:\Users\123\Projects\troll-bot\admin-lib.js:26` (settings mirror)
- Modify: `c:\Users\123\Projects\troll-bot\public\app.js:84` and `:137` (label/range mirrors)

- [ ] **Step 1: Add the three new `troll_state` columns**

Find (bot.js:382-388):

```js
// Targeted trolling window from "Тролль Фас" (see below) — troll_fas_until
// gates the window itself, troll_fas_target_user_id records who.
for (const column of ['troll_fas_until', 'troll_fas_target_user_id']) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} INTEGER`);
  } catch {}
}
```

Replace with:

```js
// Targeted trolling window from "Тролль Фас" (see below) — troll_fas_until
// gates the window itself, troll_fas_target_user_id records who.
for (const column of ['troll_fas_until', 'troll_fas_target_user_id']) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} INTEGER`);
  } catch {}
}
// Troll's own energy — the shared resource spent by every autonomous
// attack it throws (Тролль Фас, drunk club, food-steal — see
// spendTrollEnergy below and triggerFasAttack/triggerDrunkAttack/
// triggerFoodSteal). Regenerates 1 per energy_regen_minutes independent of
// paused/silenced (see backgroundTick), same idiom as the hourly health
// tick.
for (const [column, def] of [['energy', 'INTEGER NOT NULL DEFAULT 20'], ['max_energy', 'INTEGER NOT NULL DEFAULT 20'], ['last_energy_regen_at', 'INTEGER']]) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} ${def}`);
  } catch {}
}
```

- [ ] **Step 2: Add the `energy_regen_minutes` setting**

`fas_attack_interval_minutes` (the last key before the closing brace) stays
put for now — Task 3 removes it once nothing references it anymore, so the
file never passes through a state where code reads a setting that isn't in
`DEFAULT_SETTINGS`.

Find (bot.js:599-604):

```js
  // "Тролль Фас" (see getFasTargetInfo/triggerFasAttack) now also throws an
  // actual attack at the target every fas_attack_interval_minutes for as
  // long as the (unchanged, 30-minute) fas window is running.
  fas_attack_interval_minutes: '5',
};
```

Replace with:

```js
  // "Тролль Фас" (see getFasTargetInfo/triggerFasAttack) now also throws an
  // actual attack at the target every fas_attack_interval_minutes for as
  // long as the (unchanged, 30-minute) fas window is running.
  fas_attack_interval_minutes: '5',
  // Troll's own energy regen (see spendTrollEnergy) — +1 every N minutes,
  // capped at max_energy, shared by every autonomous attack.
  energy_regen_minutes: '20',
};
```

- [ ] **Step 3: Add the `spendTrollEnergy` helper**

Find (bot.js:1365-1367):

```js
function logAction(userId, username, action) {
  db.prepare('INSERT INTO troll_actions (user_id, username, action) VALUES (?, ?, ?)').run(userId, username, action);
}
```

Replace with:

```js
function logAction(userId, username, action) {
  db.prepare('INSERT INTO troll_actions (user_id, username, action) VALUES (?, ?, ?)').run(userId, username, action);
}

// Shared energy pool for every autonomous attack the troll throws (Тролль
// Фас, drunk club, food-steal) — 1 spent per swing, regenerating on its own
// tick in backgroundTick. Same null-means-empty shape as tg-bot's own
// player-side consumeEnergy.
function spendTrollEnergy() {
  const row = db.prepare(
    'UPDATE troll_state SET energy = energy - 1 WHERE id = 1 AND energy > 0 RETURNING energy'
  ).get();
  return row ? row.energy : null;
}
```

- [ ] **Step 4: Add the regen tick right after the hourly health tick**

Find (bot.js:2816-2827):

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

  // Troll's own energy regen (see spendTrollEnergy) — independent of
  // paused/silenced, same rationale as the health tick above: this is the
  // troll's own vitality, not a shalость that can be paused.
  const energyRegenSeconds = getSettingNumber('energy_regen_minutes') * 60;
  if (!state.last_energy_regen_at || now - state.last_energy_regen_at >= energyRegenSeconds) {
    db.prepare('UPDATE troll_state SET energy = MIN(max_energy, energy + 1), last_energy_regen_at = ? WHERE id = 1').run(now);
  }
```

- [ ] **Step 5: Mirror the new setting in `admin-lib.js`**

`fas_attack_interval_minutes` stays in this list for now too — Task 3 removes
it there once the code stops reading it.

Find (admin-lib.js:26):

```js
  'drunk_attack_interval_minutes', 'fas_attack_interval_minutes',
];
```

Replace with:

```js
  'drunk_attack_interval_minutes', 'fas_attack_interval_minutes', 'energy_regen_minutes',
];
```

- [ ] **Step 6: Mirror the label and range in `public/app.js`**

Find (public/app.js:83-84):

```js
  drunk_attack_interval_minutes: 'Бухалово: интервал удара дубинкой в запое, мин',
  fas_attack_interval_minutes: 'Тролль Фас: интервал попыток удара, мин',
};
```

Replace with:

```js
  drunk_attack_interval_minutes: 'Бухалово: интервал удара дубинкой в запое, мин',
  fas_attack_interval_minutes: 'Тролль Фас: интервал попыток удара, мин',
  energy_regen_minutes: 'Энергия тролля: восстановление 1 ед. раз в N мин',
};
```

Find (public/app.js:136-137):

```js
  drunk_attack_interval_minutes: [5, 120, 5],
  fas_attack_interval_minutes: [1, 30, 1],
};
```

Replace with:

```js
  drunk_attack_interval_minutes: [5, 120, 5],
  fas_attack_interval_minutes: [1, 30, 1],
  energy_regen_minutes: [5, 60, 5],
};
```

- [ ] **Step 7: Verify with a syntax check**

Run: `node --check bot.js && node --check admin-lib.js && node --check public/app.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Verify the regen math in isolation**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE troll_state (id INTEGER PRIMARY KEY CHECK (id = 1), energy INTEGER NOT NULL DEFAULT 20, max_energy INTEGER NOT NULL DEFAULT 20, last_energy_regen_at INTEGER)');
db.prepare('INSERT INTO troll_state (id, energy, max_energy, last_energy_regen_at) VALUES (1, 5, 20, ?)').run(Math.floor(Date.now()/1000) - 1200);
function spendTrollEnergy() {
  const row = db.prepare('UPDATE troll_state SET energy = energy - 1 WHERE id = 1 AND energy > 0 RETURNING energy').get();
  return row ? row.energy : null;
}
console.log('spend from 5:', spendTrollEnergy());
db.prepare('UPDATE troll_state SET energy = 0').run();
console.log('spend from 0:', spendTrollEnergy());
const now = Math.floor(Date.now()/1000);
db.prepare('UPDATE troll_state SET energy = MIN(max_energy, energy + 1), last_energy_regen_at = ? WHERE id = 1').run(now);
console.log('after regen tick:', db.prepare('SELECT energy FROM troll_state WHERE id = 1').get());
"
```
Expected: `spend from 5: 4`, `spend from 0: null`, `after regen tick: { energy: 1 }`.

- [ ] **Step 9: Commit**

```bash
git add bot.js admin-lib.js public/app.js
git commit -m "feat: add shared troll energy resource (max 20, +1/20min)"
```

---

### Task 2: Show energy on the `/troll` status card

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1822-1839`

- [ ] **Step 1: Add the energy line to both the photo caption and the text fallback**

Find (bot.js:1822-1839):

```js
      lust: state.char_lust,
      sobriety: state.char_sobriety,
    });
    const photoOptions = cocoonCaption ? { ...TROLL_ACTION_KEYBOARD, caption: cocoonCaption } : TROLL_ACTION_KEYBOARD;
    await bot.sendPhoto(msg.chat.id, buffer, photoOptions);
  } catch (err) {
    console.error('troll card render failed, falling back to text:', err.message);
    const lines = [
      `❤️ Здоровье: ${state.health}/${state.max_health}`,
      `🍖 Сытость: ${state.satiety}/100 (${satietyWord(state.satiety)})`,
      `🍺 Трезвость: ${state.char_sobriety}/100`,
      `💋 Похоть: ${state.char_lust}/100`,
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

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: show troll energy on the /troll status card"
```

---

### Task 3: Fix + rework "Тролль Фас" — fixed 1-minute cadence, energy-gated

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2749` (tick interval)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2353` (order announcement)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2555-2578` (`triggerFasAttack`)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2914-2923` (backgroundTick gate)

- [ ] **Step 1: Drop `BACKGROUND_TICK_MS` from 5 minutes to 1 minute**

A 1-minute Fas cadence is physically impossible while the outer tick itself
only runs every 5 minutes. Every other autonomous timer in this file already
gates itself with its own `now - lastAt >= X` comparison, so running the
outer loop more often only makes those more precise — it changes nothing
else.

Find (bot.js:2749):

```js
const BACKGROUND_TICK_MS = 5 * 60 * 1000;
```

Replace with:

```js
// Dropped from 5 minutes so "Тролль Фас" (see triggerFasAttack) can land a
// real attack every minute — every other timer below already gates itself
// with its own now-vs-lastAt check, so ticking more often just makes those
// more precise, it doesn't change their cadence.
const BACKGROUND_TICK_MS = 60 * 1000;
```

- [ ] **Step 2: Update the order-confirmation message**

Find (bot.js:2353):

```js
  bot.sendMessage(msg.chat.id, `🐕 ${actorName(msg.from)} скомандовал троллю "Фас!" на ${targetName} — 30 минут не будет покоя, и раз в ${getSettingNumber('fas_attack_interval_minutes')} мин тролль будет пытаться ударить!`).catch(() => {});
```

Replace with:

```js
  bot.sendMessage(msg.chat.id, `🐕 ${actorName(msg.from)} скомандовал троллю "Фас!" на ${targetName} — 30 минут не будет покоя, тролль будет бить раз в минуту, пока не кончится энергия!`).catch(() => {});
```

- [ ] **Step 3: Spend energy per swing in `triggerFasAttack`**

Find (bot.js:2555-2562):

```js
function triggerFasAttack(chatId, state, now) {
  if (!tgBotDb) return;
  const targetInfo = getFasTargetInfo(state);
  if (!targetInfo) return;
  const target = targetInfo.entry;
  const name = getMentionName(target);
  db.prepare('UPDATE troll_state SET last_fas_attack_at = ? WHERE id = 1').run(now);
  logAction(target.userId, target.username || target.firstName, 'fas_attack');
```

Replace with:

```js
function triggerFasAttack(chatId, state, now) {
  if (!tgBotDb) return;
  const targetInfo = getFasTargetInfo(state);
  if (!targetInfo) return;
  // No energy: this minute's attack is skipped, same "quietly retry next
  // tick" idiom as a missing target — the order itself keeps running until
  // troll_fas_until expires.
  if (spendTrollEnergy() === null) return;
  const target = targetInfo.entry;
  const name = getMentionName(target);
  db.prepare('UPDATE troll_state SET last_fas_attack_at = ? WHERE id = 1').run(now);
  logAction(target.userId, target.username || target.firstName, 'fas_attack');
```

- [ ] **Step 4: Fix the backgroundTick gate to a fixed 60-second cadence**

Find (bot.js:2914-2923):

```js
    // "Тролль Фас" periodic attack (see triggerFasAttack) — separate
    // cooldown from every other autonomous action, only while the (30-
    // minute) fas window is running.
    const fasAttackIntervalSeconds = getSettingNumber('fas_attack_interval_minutes') * 60;
    if (
      state.troll_fas_until && state.troll_fas_until > now &&
      (!state.last_fas_attack_at || now - state.last_fas_attack_at >= fasAttackIntervalSeconds)
    ) {
      triggerFasAttack(state.chat_id, state, now);
    }
```

Replace with:

```js
    // "Тролль Фас" periodic attack (see triggerFasAttack) — fixed 1-minute
    // cadence (no longer a tunable setting), gated by the troll's own
    // energy inside triggerFasAttack itself, only while the (30-minute) fas
    // window is running.
    if (
      state.troll_fas_until && state.troll_fas_until > now &&
      (!state.last_fas_attack_at || now - state.last_fas_attack_at >= 60)
    ) {
      triggerFasAttack(state.chat_id, state, now);
    }
```

- [ ] **Step 5: Remove the now-unused `fas_attack_interval_minutes` setting**

Nothing reads this setting anymore after Step 4 — remove it from all three
registries.

Find (bot.js:599-606):

```js
  // "Тролль Фас" (see getFasTargetInfo/triggerFasAttack) now also throws an
  // actual attack at the target every fas_attack_interval_minutes for as
  // long as the (unchanged, 30-minute) fas window is running.
  fas_attack_interval_minutes: '5',
  // Troll's own energy regen (see spendTrollEnergy) — +1 every N minutes,
  // capped at max_energy, shared by every autonomous attack.
  energy_regen_minutes: '20',
};
```

Replace with:

```js
  // Troll's own energy regen (see spendTrollEnergy) — +1 every N minutes,
  // capped at max_energy, shared by every autonomous attack.
  energy_regen_minutes: '20',
};
```

Find (admin-lib.js:26):

```js
  'drunk_attack_interval_minutes', 'fas_attack_interval_minutes', 'energy_regen_minutes',
];
```

Replace with:

```js
  'drunk_attack_interval_minutes', 'energy_regen_minutes',
];
```

Find (public/app.js — the labels block):

```js
  drunk_attack_interval_minutes: 'Бухалово: интервал удара дубинкой в запое, мин',
  fas_attack_interval_minutes: 'Тролль Фас: интервал попыток удара, мин',
  energy_regen_minutes: 'Энергия тролля: восстановление 1 ед. раз в N мин',
};
```

Replace with:

```js
  drunk_attack_interval_minutes: 'Бухалово: интервал удара дубинкой в запое, мин',
  energy_regen_minutes: 'Энергия тролля: восстановление 1 ед. раз в N мин',
};
```

Find (public/app.js — the ranges block):

```js
  drunk_attack_interval_minutes: [5, 120, 5],
  fas_attack_interval_minutes: [1, 30, 1],
  energy_regen_minutes: [5, 60, 5],
};
```

Replace with:

```js
  drunk_attack_interval_minutes: [5, 120, 5],
  energy_regen_minutes: [5, 60, 5],
};
```

- [ ] **Step 6: Verify with a syntax check**

Run: `node --check bot.js && node --check admin-lib.js && node --check public/app.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Confirm no leftover references to the removed setting**

```bash
grep -n "fas_attack_interval_minutes" bot.js admin-lib.js public/app.js
```
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add bot.js admin-lib.js public/app.js
git commit -m "fix: Тролль Фас now lands a real attack every minute, gated by troll energy"
```

---

### Task 4: Drunk club attack also spends troll energy

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2501-2504`

- [ ] **Step 1: Spend energy before swinging**

Find (bot.js:2501-2504):

```js
function triggerDrunkAttack(chatId, now) {
  if (!tgBotDb) return;
  const targetInfo = pickMischiefTarget();
  if (!targetInfo) return;
```

Replace with:

```js
function triggerDrunkAttack(chatId, now) {
  if (!tgBotDb) return;
  const targetInfo = pickMischiefTarget();
  if (!targetInfo) return;
  // No energy: skip this tick's club swing, same "quietly retry next tick"
  // idiom as a missing target (see triggerFasAttack).
  if (spendTrollEnergy() === null) return;
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check bot.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add bot.js
git commit -m "feat: drunk club attack also spends shared troll energy"
```

---

### Task 5: Replace hungry breastfeeding with food-steal

**Files:**
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:719-733` (phrase seed pool)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1201-1210` (new phrase array + seed call, placed next to `LUST_ACTION_PHRASES`)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1263` (seed call site)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:1782` (all-time stats caption)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2641-2669` (`triggerHungryGrab` -> `triggerFoodSteal`)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:2861-2869` (backgroundTick call site)
- Modify: `c:\Users\123\Projects\troll-bot\bot.js:547` (setting rename)
- Modify: `c:\Users\123\Projects\troll-bot\admin-lib.js:13` (setting rename)
- Modify: `c:\Users\123\Projects\troll-bot\public\app.js:50` and `:103` (label/range rename)

- [ ] **Step 1: Remove the two dead phrase categories from the first-run seed**

Find (bot.js:719-733):

```js
  hunger_beg: [
    'Моя кушать хотеть! Кто-нибудь покормить моя, а?',
    'Моя живот урчать совсем... дать моя поесть!',
    'Твоя есть еда? Моя очень-очень кушать хотеть!',
  ],
  hunger_grab_action: [
    'вцепиться в сиську {user} от голод',
    'впиться в грудь {user}, требуя еда',
    'вцепиться в {user}, искать еда',
  ],
  hunger_suckle_action: [
    'пососать молоко у {user}',
    'высосать молоко из {user}',
    'напиться молоко у {user}',
  ],
  self_eat: [
```

Replace with:

```js
  hunger_beg: [
    'Моя кушать хотеть! Кто-нибудь покормить моя, а?',
    'Моя живот урчать совсем... дать моя поесть!',
    'Твоя есть еда? Моя очень-очень кушать хотеть!',
  ],
  self_eat: [
```

- [ ] **Step 2: Add the new food-steal phrase pool next to `LUST_ACTION_PHRASES`**

Find (bot.js:1197-1211):

```js
// High-lust autonomous action (see triggerLustAction) — plain Russian,
// third-person, asterisk-wrapped like the mischief pools above. Only ever
// fires against someone who loves the troll back (see pickLustTarget), so
// the tone is embarrassed/smitten rather than predatory.
const LUST_ACTION_PHRASES = [
  'подглядеть за {user} из-за кустов и подрочить, покраснев от стыда',
  'украдкой пробраться за {user} и передёрнуть от нахлынувших чувств',
  'спрятаться за мостом, разглядывая {user}, и облегчить себя, никого не стесняясь',
  'засмотреться на {user} и удовлетворить себя тут же под мостом',
  'проследить за {user} до самого дома и передёрнуть от волнения',
  'подсмотреть за {user} в бинокль и не сдержаться',
  'притаиться в тени, глядя на {user}, и решить свои неотложные дела',
  'покраснеть, глядя на {user}, и уединиться под мостом на минутку',
];
```

Replace with:

```js
// High-lust autonomous action (see triggerLustAction) — plain Russian,
// third-person, asterisk-wrapped like the mischief pools above. Only ever
// fires against someone who loves the troll back (see pickLustTarget), so
// the tone is embarrassed/smitten rather than predatory.
const LUST_ACTION_PHRASES = [
  'подглядеть за {user} из-за кустов и подрочить, покраснев от стыда',
  'украдкой пробраться за {user} и передёрнуть от нахлынувших чувств',
  'спрятаться за мостом, разглядывая {user}, и облегчить себя, никого не стесняясь',
  'засмотреться на {user} и удовлетворить себя тут же под мостом',
  'проследить за {user} до самого дома и передёрнуть от волнения',
  'подсмотреть за {user} в бинокль и не сдержаться',
  'притаиться в тени, глядя на {user}, и решить свои неотложные дела',
  'покраснеть, глядя на {user}, и уединиться под мостом на минутку',
];

// Grown-troll replacement for the old "grab a breast and suckle" hunger
// action (see triggerFoodSteal) — plain Russian, third-person, asterisk-
// wrapped like the mischief/lust pools above. Narrates the closing line
// after at least one of the 3 swings in the sequence lands.
const FOOD_STEAL_ACTION_PHRASES = [
  'вырвать еду прямо из рук {user} и заглотить, не жуя',
  'силой отжать перекус у {user}',
  'выхватить кусок у {user} и умять его в один присест',
  'отобрать еду у {user}, не оставив и крошки',
  'зажать {user} у моста и отжать всю еду подчистую',
];
```

- [ ] **Step 3: Register the new category with `seedPhrasesIfMissing`**

Find (bot.js:1263):

```js
seedPhrasesIfMissing('lust_action', LUST_ACTION_PHRASES);
```

Replace with:

```js
seedPhrasesIfMissing('lust_action', LUST_ACTION_PHRASES);
seedPhrasesIfMissing('food_steal_action', FOOD_STEAL_ACTION_PHRASES);
```

- [ ] **Step 4: Add a stats-caption line for the new action**

Find (bot.js:1782):

```js
    `🍽️ Поел сам: ${totalFor('self_eat')}`,
```

Replace with:

```js
    `🍽️ Поел сам: ${totalFor('self_eat')}`,
    `🥊 Отжал еду силой: ${totalFor('food_steal')}`,
```

- [ ] **Step 5: Rename `satiety_suckle_gain` -> `satiety_foodsteal_gain` (bot.js default)**

Find (bot.js:547):

```js
  satiety_suckle_gain: '20',
```

Replace with:

```js
  satiety_foodsteal_gain: '20',
```

- [ ] **Step 6: Rename the setting in `admin-lib.js`**

Find (admin-lib.js:13):

```js
  'satiety_decay_per_hour', 'satiety_feed_gain', 'satiety_suckle_gain', 'hunger_action_interval_minutes',
```

Replace with:

```js
  'satiety_decay_per_hour', 'satiety_feed_gain', 'satiety_foodsteal_gain', 'hunger_action_interval_minutes',
```

- [ ] **Step 7: Rename the label and range in `public/app.js`**

Find (public/app.js:50):

```js
  satiety_suckle_gain: 'Сытость от сосания молока',
```

Replace with:

```js
  satiety_foodsteal_gain: 'Сытость от отжатой еды',
```

Find (public/app.js:103):

```js
  satiety_suckle_gain: [5, 50, 5],
```

Replace with:

```js
  satiety_foodsteal_gain: [5, 50, 5],
```

- [ ] **Step 8: Replace `triggerHungryGrab` with `triggerFoodSteal`**

Find (bot.js:2641-2669):

```js
// Reuses pickMischiefTarget/getMentionName — same weighted "recent
// participant, more likely if disliked" targeting as regular targeted
// mischief. Falls back to begging if no one's spoken recently to grab at.
// Two chained rolls: grabbing on, then (only if that succeeds) actually
// suckling — only the second roll's success restores satiety, so a failed
// grab never pays off.
async function triggerHungryGrab(chatId, stage) {
  if (recentMessages.length === 0) return triggerBegging(chatId, stage);
  const targetInfo = pickMischiefTarget();
  // Also null if everyone who's spoken recently is mama (see
  // pickMischiefTarget) — same begging fallback as nobody having spoken at all.
  if (!targetInfo) return triggerBegging(chatId, stage);
  const target = getMentionName(targetInfo.entry);

  const grabTemplate = pickPhraseForStage('hunger_grab_action', stage, 'вцепиться в сиську {user} от голод');
  const grabAction = grabTemplate.replace(/\{user\}/g, target);
  const grabRoll = rollTrollTryResult(grabAction);
  await bot.sendMessage(chatId, grabRoll.text).catch(() => {});
  if (!grabRoll.success) return;

  const suckleTemplate = pickPhraseForStage('hunger_suckle_action', stage, 'пососать молоко у {user}');
  const suckleAction = suckleTemplate.replace(/\{user\}/g, target);
  const suckleRoll = rollTrollTryResult(suckleAction);
  await bot.sendMessage(chatId, suckleRoll.text).catch(() => {});
  if (suckleRoll.success) {
    const satietyGain = getSettingNumber('satiety_suckle_gain');
    db.prepare('UPDATE troll_state SET satiety = MIN(100, satiety + ?) WHERE id = 1').run(satietyGain);
  }
}
```

Replace with:

```js
// Reuses pickMischiefTarget/getMentionName — same weighted "recent
// participant, more likely if disliked" targeting as regular targeted
// mischief. Falls back to begging if no one's spoken recently to grab at.
// Grown-troll replacement for the old "grab a breast and suckle" action:
// up to 3 real swings (same weapon/bodyPart/roll/damage/crit shape as
// triggerFasAttack's single swing), each spending 1 troll energy first —
// running out mid-sequence just ends the loop early, already-landed hits
// still count. If at least one swing landed, a closing message narrates
// the troll stealing food from the target and satiety is restored.
async function triggerFoodSteal(chatId, stage) {
  if (recentMessages.length === 0) return triggerBegging(chatId, stage);
  const targetInfo = pickMischiefTarget();
  // Also null if everyone who's spoken recently is mama (see
  // pickMischiefTarget) — same begging fallback as nobody having spoken at all.
  if (!targetInfo) return triggerBegging(chatId, stage);
  const target = targetInfo.entry;
  const name = getMentionName(target);

  logAction(target.userId, target.username || target.firstName, 'food_steal');

  let anyHit = false;
  for (let i = 0; i < 3; i++) {
    if (spendTrollEnergy() === null) break;
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

  if (anyHit) {
    const stealTemplate = pickPhraseForStage('food_steal_action', stage, 'отжать еду у {user}');
    await bot.sendMessage(chatId, `*${stealTemplate.replace(/\{user\}/g, name)}*`).catch(() => {});
    const satietyGain = getSettingNumber('satiety_foodsteal_gain');
    db.prepare('UPDATE troll_state SET satiety = MIN(100, satiety + ?) WHERE id = 1').run(satietyGain);
  }
}
```

- [ ] **Step 9: Update the backgroundTick call site**

Find (bot.js:2861-2869):

```js
    const hungerIntervalSeconds = getSettingNumber('hunger_action_interval_minutes') * 60;
    if (!state.last_hunger_action_at || now - state.last_hunger_action_at >= hungerIntervalSeconds) {
      if (state.satiety < 30) {
        triggerHungryGrab(state.chat_id, state.stage);
        db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      } else if (state.satiety < 50) {
        triggerBegging(state.chat_id, state.stage);
        db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      }
    }
```

Replace with:

```js
    const hungerIntervalSeconds = getSettingNumber('hunger_action_interval_minutes') * 60;
    if (!state.last_hunger_action_at || now - state.last_hunger_action_at >= hungerIntervalSeconds) {
      if (state.satiety < 30) {
        triggerFoodSteal(state.chat_id, state.stage);
        db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      } else if (state.satiety < 50) {
        triggerBegging(state.chat_id, state.stage);
        db.prepare('UPDATE troll_state SET last_hunger_action_at = ? WHERE id = 1').run(now);
      }
    }
```

- [ ] **Step 10: Verify with a syntax check**

Run: `node --check bot.js && node --check admin-lib.js && node --check public/app.js`
Expected: no output, exit code 0.

- [ ] **Step 11: Confirm no leftover references to the old names**

```bash
grep -n "triggerHungryGrab\|hunger_grab_action\|hunger_suckle_action\|satiety_suckle_gain" bot.js admin-lib.js public/app.js
```
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add bot.js admin-lib.js public/app.js
git commit -m "feat: replace hungry breastfeeding with a 3-hit food-steal action"
```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only, against the running troll)

- [ ] **Step 1: Confirm energy shows up and regenerates**

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare('SELECT energy, max_energy, last_energy_regen_at FROM troll_state WHERE id = 1').get());
"
```
Expected: `energy` present, `<= max_energy` (20). Send `/troll` and confirm the
caption/text now shows `⚡ Энергия: N/20`.

- [ ] **Step 2: Confirm "Тролль Фас" actually lands hits now**

As someone the troll adores, reply "тролль фас" to a target's message.
Expected: the new wording ("раз в минуту, пока не кончится энергия"), then
roughly once a minute a real swing message plus (on a hit) a damage line
with a real before -> after health change. Confirm via:

```bash
node -e "
const db = require('better-sqlite3')('../tg-bot/mutes.db', {readonly: true});
console.log(db.prepare('SELECT health FROM user_health WHERE user_id = ?').get(YOUR_TEST_USER_ID));
"
```
Health should be dropping over successive minutes.

- [ ] **Step 3: Confirm energy exhaustion pauses Fas without cancelling it**

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare('UPDATE troll_state SET energy = 0 WHERE id = 1').run();
"
```
Expected: no further attack messages appear for up to `energy_regen_minutes`
minutes, then attacks resume once `energy` ticks back up to 1 — all without
a new "Фас" order being re-issued.

- [ ] **Step 4: Confirm the drunk club attack also respects energy**

Trigger drunk state (via `/drink`), zero `energy` again, and confirm no
club-attack messages appear until energy regenerates.

- [ ] **Step 5: Confirm food-steal fires on low satiety and stops early without energy**

```bash
node -e "
const db = require('better-sqlite3')('troll.db');
db.prepare('UPDATE troll_state SET satiety = 10, last_hunger_action_at = NULL, energy = 20 WHERE id = 1').run();
"
```
Have someone active in chat, wait for the hunger-action cooldown. Expected:
up to 3 damage messages with real health changes, then (only if at least one
hit) a food-steal narration line and a satiety bump. Repeat with `energy` set
to `1` beforehand and confirm the sequence stops after 1 swing instead of 3.

- [ ] **Step 6: Confirm settings surface correctly**

```bash
node -e "
const db = require('better-sqlite3')('troll.db', {readonly: true});
console.log(db.prepare(\"SELECT key, value FROM troll_settings WHERE key IN ('energy_regen_minutes','satiety_foodsteal_gain','fas_attack_interval_minutes','satiety_suckle_gain')\").all());
"
```
Expected: rows for `energy_regen_minutes` and `satiety_foodsteal_gain`; no
rows for the two old keys (or harmless leftover rows from before this
change — either way, `getSettingNumber` for the new keys must resolve via
`DEFAULT_SETTINGS`'s `INSERT OR IGNORE` seed). Confirm the admin panel
(`/troll-admin`) shows the new setting and no longer shows the old one.

- [ ] **Step 7: Final review commit (if any manual fixes were needed during verification)**

If verification surfaced no code changes, there is nothing to commit here.
If it did, commit those fixes individually with a description of what was
wrong, following the same commit-message style as the tasks above.
