require('dotenv').config();
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Database = require('better-sqlite3');
const { renderTrollCard } = require('./card');

const token = process.env.BOT_TOKEN;
const proxy = process.env.PROXY_URL;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);

// --- Cross-bot "smell" integration (separate process, sibling repo) ---
// tg-bot (a different, already-running bot on this server) owns mutes.db
// and reads this table to append a "smells of troll pee" reply to a marked
// user's messages. Both sides create the table defensively (order-of-deploy
// independent) and both set busy_timeout, since two Node processes writing
// the same SQLite file without it risk SQLITE_BUSY under rare contention.
//
// Wrapped in try/catch on purpose: this is a nice-to-have cross-bot feature,
// not core to the troll — if tg-bot's mutes.db isn't at the expected path
// (wrong directory layout, tg-bot not deployed, permissions, etc.) the whole
// troll-bot process must NOT crash over it. Set TG_BOT_DB_PATH in .env if
// the default sibling-directory guess (../tg-bot/mutes.db) is wrong.
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

function markSmelly(userId, durationSeconds, reason) {
  if (!tgBotDb) return;
  const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
  tgBotDb.prepare(
    'INSERT INTO troll_smell (user_id, marked_at, expires_at, reason) VALUES (?, strftime(\'%s\',\'now\'), ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET marked_at = strftime(\'%s\',\'now\'), expires_at = excluded.expires_at, reason = excluded.reason'
  ).run(userId, expiresAt, reason);
}

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
// always overwrites any existing injury with a fresh one, no stacking
// multiple injuries at once. Recovery time is rolled fresh each time (2-24h
// inclusive) instead of a flat 24h — returns the rolled hours so callers
// can state it in their own message.
function applyInjury(userId, injuryType) {
  if (!tgBotDb) return null;
  const healHours = Math.floor(Math.random() * 23) + 2;
  const injuredUntil = Math.floor(Date.now() / 1000) + healHours * 3600;
  tgBotDb.prepare(
    'INSERT INTO injuries (user_id, injury_type, injured_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET injury_type = excluded.injury_type, injured_until = excluded.injured_until'
  ).run(userId, injuryType, injuredUntil);
  return healHours;
}

// Reads (and lazily creates, at the 100/100 default) a challenger's health
// row. Returns null only if tgBotDb itself is unavailable.
function getUserHealth(userId) {
  if (!tgBotDb) return null;
  tgBotDb.prepare('INSERT OR IGNORE INTO user_health (user_id, health, max_health) VALUES (?, 100, 100)').run(userId);
  return tgBotDb.prepare('SELECT health, max_health, energy, max_energy FROM user_health WHERE user_id = ?').get(userId);
}

// Spends 1 energy for a /fight attempt — same resource tg-bot's /kick draws
// from (see tg-bot's own consumeEnergy). Returns remaining energy, or null
// if there wasn't any left (the row is guaranteed to exist by the
// getUserHealth call above, so null here unambiguously means "no energy").
function consumeEnergy(userId) {
  if (!tgBotDb) return null;
  getUserHealth(userId);
  const row = tgBotDb.prepare('UPDATE user_health SET energy = energy - 1 WHERE user_id = ? AND energy > 0 RETURNING energy').get(userId);
  return row ? row.energy : null;
}

// Applies fight damage, floors at 0, and — if it reaches exactly 0 — mutes
// the human for 30 minutes via tg-bot's own mutes table. troll-bot can't
// call tg-bot's muteUser() across processes, so this duplicates its exact
// INSERT shape (same precedent as markSmelly writing troll_smell directly).
// Returns the human's health after damage, or null if tgBotDb is down.
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

// Needed to detect "user replied directly to a message the troll sent" (the
// passive /teach path) — Telegram tells us reply_to_message.from, but we
// need our own id to compare against.
let botUserId = null;
bot.getMe().then((me) => { botUserId = me.id; }).catch((err) => {
  console.error('getMe failed, passive teach-by-reply will stay disabled:', err.message);
});

// Telegram's "/" autocomplete menu is a separate, persistent list that only
// changes via setMyCommands (or manually in BotFather) — it does NOT update
// itself just because new bot.onText handlers get added in code. Setting it
// here on every startup means new commands show up automatically after the
// next restart, instead of silently working-but-invisible until someone
// remembers to update BotFather by hand.
const PUBLIC_COMMANDS = [
  { command: 'troll', description: 'Статус тролля (здоровье, сытость, настроение, стадия)' },
  { command: 'play', description: 'Поиграть с тролем' },
  { command: 'feed', description: 'Покормить тролля' },
  { command: 'fight', description: 'Подраться с тролем' },
  { command: 'tease', description: 'Подразнить тролля' },
  { command: 'boobs', description: 'Показать тролю сиську' },
  { command: 'drink', description: 'Бухать с тролем' },
  { command: 'teach', description: 'Научить тролля фразе' },
  { command: 'troll_help', description: 'Список всех команд' },
];
const ADMIN_ONLY_COMMANDS = [
  { command: 'troll_here', description: 'Призвать тролля (одноразово)' },
  { command: 'troll_settings', description: 'Текущие настройки' },
  { command: 'troll_relationships', description: 'Отношения тролля ко всем' },
  { command: 'troll_declare_enemies', description: 'Объявить врагов задним числом' },
  { command: 'troll_set', description: 'Изменить настройку' },
  { command: 'troll_pause', description: 'Выключить шалости' },
  { command: 'troll_resume', description: 'Включить шалости' },
  { command: 'troll_reset', description: 'Полный сброс тролля' },
  { command: 'troll_poop', description: 'Заставить тролля покакать сейчас' },
  { command: 'troll_pee', description: 'Заставить тролля пописать сейчас' },
  { command: 'troll_say', description: 'Сказать текст от лица тролля' },
  { command: 'troll_phrases', description: 'Все реплики тролля по категориям' },
  { command: 'troll_phrase_add', description: 'Добавить фразу' },
  { command: 'troll_phrase_edit', description: 'Изменить фразу' },
  { command: 'troll_phrase_del', description: 'Удалить фразу' },
  { command: 'troll_panel', description: 'Открыть веб-панель управления' },
  { command: 'troll_gifs', description: 'Список гифок в пуле "фак"' },
  { command: 'troll_gif_del', description: 'Удалить гифку из пула' },
];
bot.setMyCommands(PUBLIC_COMMANDS).catch((err) => {
  console.error('setMyCommands (default scope) failed:', err.message);
});
bot.setMyCommands([...PUBLIC_COMMANDS, ...ADMIN_ONLY_COMMANDS], {
  scope: { type: 'chat', chat_id: ADMIN_CHAT_ID },
}).catch((err) => {
  console.error('setMyCommands (admin chat scope) failed:', err.message);
});

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
    stage INTEGER NOT NULL DEFAULT 1,
    satiety INTEGER NOT NULL DEFAULT 100,
    last_hunger_action_at INTEGER,
    char_appetite INTEGER NOT NULL DEFAULT 0,
    char_playfulness INTEGER NOT NULL DEFAULT 0,
    char_anger INTEGER NOT NULL DEFAULT 0,
    char_lust INTEGER NOT NULL DEFAULT 0,
    char_naughtiness INTEGER NOT NULL DEFAULT 0,
    weight INTEGER NOT NULL DEFAULT 30,
    born_at INTEGER DEFAULT (strftime('%s','now')),
    stage_started_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Weight used to be purely derived from feed_count (never decreased); now
// eating/pooping/peeing adjust it directly, so it has to be a real stored
// value. Backfills using the OLD formula on the one-time migration so an
// already-deployed troll's weight doesn't visibly jump on upgrade.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN weight INTEGER NOT NULL DEFAULT 30');
  db.exec(`
    UPDATE troll_state SET weight = CAST(30 + (MIN(feed_count, 90) / 90.0) * 370 AS INTEGER)
  `);
} catch {}
// Growth stage used to be derived live from feed_count; now it's an
// admin-controlled value set from the panel (see /api/stage), independent
// of feed_count. This migration only ever runs once, the moment the column
// is first added to an already-deployed troll.db — it backfills the stage
// an existing troll would have had under the old thresholds, so upgrading
// doesn't visibly reset anyone's troll back to малыш. On every later
// restart the ALTER throws immediately (column already exists) and this
// backfill is skipped, so it never overwrites an admin's later manual choice.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN stage INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    UPDATE troll_state SET stage = CASE
      WHEN feed_count >= 90 THEN 4
      WHEN feed_count >= 50 THEN 3
      WHEN feed_count >= 20 THEN 2
      ELSE 1
    END
  `);
} catch {}
// SQLite backfills NOT NULL DEFAULT values for existing rows on ADD COLUMN,
// so an already-deployed troll simply starts at satiety=100 — no backfill
// query needed like stage's above (which derived its initial value from
// feed_count instead of a flat default).
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN satiety INTEGER NOT NULL DEFAULT 100');
} catch {}
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN last_hunger_action_at INTEGER');
} catch {}
// Character traits (0-100, cumulative only — no decay, they reflect the
// troll's growing personality rather than a moment-to-moment stat). Each
// needs its own ALTER since SQLite only adds one column per statement.
for (const column of ['char_appetite', 'char_playfulness', 'char_anger', 'char_lust', 'char_naughtiness']) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  } catch {}
}
// "Трезвость" (sobriety) — the inverse of the other traits above: starts
// FULL and drains per "Бухать" session (see performDrink) instead of
// accumulating. Once it drops to/below sobriety_drunk_threshold, the troll
// actually goes drunk (drunk_until) and sobriety resets back to 100 — same
// "fires once, then resets" idiom as char_lust/triggerLustAction.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN char_sobriety INTEGER NOT NULL DEFAULT 100');
} catch {}
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN drunk_until INTEGER');
} catch {}
// Cooldown for the drunk-only autonomous club attack (see triggerDrunkAttack
// in backgroundTick) — separate timer from every other autonomous action.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN last_drunk_attack_at INTEGER');
} catch {}
// Cooldown for "Тролль Фас"'s own periodic attack (see triggerFasAttack) —
// separate timer from every other autonomous action.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN last_fas_attack_at INTEGER');
} catch {}
// Global kick lockout — set when the troll successfully hides after being
// kicked twice within an hour, back when /kick existed. Left in the schema
// for history; performFight (which replaced performKick) never reads or
// writes this column, so the lockout is now dead code.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN kick_locked_until INTEGER');
} catch {}
// Cooldown timestamps for the three autonomous digestion-cycle ticks (eat/
// poop/pee — see backgroundTick), plus the poop mini-game's "candidate
// window" end time. The candidate LIST itself stays in-memory (see
// poopGameCandidates below) — losing it on a rare mid-game restart just
// means that particular game quietly fizzles, not worth persisting for.
for (const column of ['last_eat_action_at', 'last_poop_action_at', 'last_pee_action_at', 'poop_game_ends_at']) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} INTEGER`);
  } catch {}
}
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
// Whoever is FIRST to reach attitude 100 becomes "mama" — permanent once
// set (see checkMamaPromotion), not re-evaluated if their attitude later
// drops back down.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN mama_user_id INTEGER');
} catch {}
// When the current stage started — lets the admin panel report "what
// happened this stage" (kicks/feeds/plays/etc. since this timestamp) right
// before switching to a new one. Backfilled to born_at on migration so an
// already-deployed troll gets a sensible starting point instead of NULL.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN stage_started_at INTEGER');
  db.exec('UPDATE troll_state SET stage_started_at = born_at');
} catch {}
// Regen sleep: when health drops below a threshold, the troll retreats for
// a fixed nap that trades weight for health in small ticks (see
// backgroundTick). regen_sleep_started_at gates "currently resting" and
// drives progress; last_regen_sleep_at gates the cooldown before the next
// one is allowed, set whether the nap finished naturally — performFight
// (which replaced performKick) no longer wakes the troll early, so this now
// only ever finishes naturally.
for (const column of ['regen_sleep_started_at', 'last_regen_sleep_at']) {
  try {
    db.exec(`ALTER TABLE troll_state ADD COLUMN ${column} INTEGER`);
  } catch {}
}
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN regen_sleep_ticks_applied INTEGER NOT NULL DEFAULT 0');
} catch {}
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
// Cooldown gate for the high-lust autonomous action (see triggerLustAction) —
// only stamped when the action actually fires (a qualifying target was
// found), so a lust-high-but-nobody-around tick doesn't block the next try.
try {
  db.exec('ALTER TABLE troll_state ADD COLUMN last_lust_action_at INTEGER');
} catch {}
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
    last_seen_at INTEGER,
    kick_blocked_until INTEGER,
    is_enemy INTEGER NOT NULL DEFAULT 0,
    gender TEXT
  )
`);
try {
  db.exec('ALTER TABLE troll_relationships ADD COLUMN kick_blocked_until INTEGER');
} catch {}
// Guessed from self-description in chat (see detectAndStoreGender) — 'male',
// 'female', or NULL (not yet guessed). Sticky once set, same as is_enemy.
try {
  db.exec("ALTER TABLE troll_relationships ADD COLUMN gender TEXT");
} catch {}
// Enemy status used to be purely live (attitude <= -100, lifted automatically
// if attitude recovered) — now it's permanent once earned, like mama. The
// backfill flags anyone already sitting at rock bottom at the moment this
// column is first added, so upgrading doesn't lose already-earned enemies.
try {
  db.exec('ALTER TABLE troll_relationships ADD COLUMN is_enemy INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE troll_relationships SET is_enemy = 1 WHERE attitude <= -100');
} catch {}
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
// Curated GIF pool (see maybeSendFuckReaction) — deliberately its own tiny
// table rather than reusing troll_stickers: GIFs are sent via
// bot.sendAnimation, not bot.sendSticker, so mixing the two file_id kinds
// in one table would need a "kind" column just to dispatch correctly.
// Populated by forwarding/sending an animation directly in the admin chat
// (see the message handler below) — there's no Telegram "GIF set" to bulk
// import the way sticker packs work for troll_stickers.
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_gifs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT 'fuck',
    added_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);
// Free-form lines taught by any user via /teach or by replying directly to
// the troll — later replayed verbatim at random to other users' messages.
// Deliberately uncurated (no category/moderation): the joke is the troll
// parroting whatever it once heard.
db.exec(`
  CREATE TABLE IF NOT EXISTS troll_learned_phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    taught_by_user_id INTEGER,
    taught_by_username TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

const DEFAULT_SETTINGS = {
  sleep_start: '0',
  sleep_end: '8',
  naughtiness: '5',
  mischief_interval_hours: '1',
  mischief_message_trigger: '50',
  health_decay_per_hour: '4',
  health_regen_baby: '2',
  health_regen_young: '4',
  health_regen_adult: '10',
  health_regen_old: '6',
  paused: '0',
  attitude_play_delta: '5',
  attitude_feed_delta: '8',
  attitude_kick_delta: '-15',
  attitude_escalation_threshold: '-30',
  satiety_decay_per_hour: '4',
  satiety_feed_gain: '10',
  satiety_suckle_gain: '20',
  hunger_action_interval_minutes: '30',
  attitude_feed_reject_delta: '-10',
  learned_phrase_reply_chance: '8',
  weight_gain_per_feed: '5',
  weight_loss_per_poop: '8',
  weight_loss_per_pee: '2',
  eat_action_interval_minutes: '45',
  poop_action_interval_minutes: '90',
  pee_action_interval_minutes: '60',
  poop_mood_gain: '8',
  command_cooldown_seconds: '60',
  attitude_fas_delta: '-5',
  regen_sleep_health_threshold: '50',
  regen_sleep_duration_minutes: '60',
  regen_sleep_tick_minutes: '10',
  regen_sleep_health_per_tick: '5',
  regen_sleep_weight_loss_per_tick: '1',
  regen_sleep_cooldown_hours: '2',
  frequent_arguer_kick_threshold: '5',
  frequent_arguer_window_hours: '24',
  frequent_arguer_fuck_chance: '40',
  // "Похотливость" — controls how fast the char_lust trait rises per /boobs
  // (see performBoobs). Default matches the old hardcoded +8 so behavior is
  // unchanged until an admin tunes it.
  lust_gain_per_boobs: '8',
  // High-lust autonomous action (see triggerLustAction in backgroundTick):
  // fires once char_lust exceeds this threshold, no more often than every
  // lust_action_interval_minutes, and only against someone who both loves
  // the troll (attitude >= 70, same tier as "Тролль Фас" eligibility) and
  // is a known female participant.
  lust_trigger_threshold: '80',
  lust_action_interval_minutes: '60',
  // Max /fight attempts a single person can make against the troll per
  // rolling 24h (see getFightAttemptsToday) — same window idiom as
  // frequent_arguer_window_hours above, just a separate counter.
  fight_daily_limit: '5',
  // "Бухать с тролем" (see performDrink) — outcome deltas and the sobriety/
  // drunk-debuff knobs. The 60/30/5/5 outcome split and the beating's 3x
  // 1-20 damage are fixed, same precedent as Драка's weapon/damage pools.
  mood_drink_good_delta: '15',
  attitude_drink_good_delta: '10',
  mood_drink_bad_delta: '15',
  mood_drink_friend_delta: '25',
  attitude_drink_friend_delta: '20',
  sobriety_loss_per_drink: '25',
  sobriety_drunk_threshold: '30',
  drunk_duration_minutes: '60',
  // While drunk (see isDrunk), the troll autonomously clubs a random known
  // person every drunk_attack_interval_minutes (see triggerDrunkAttack) —
  // same roll/damage/crit-injury rules as Драка's counter-swing, just with
  // a fixed "дубинка" weapon instead of the random pool.
  drunk_attack_interval_minutes: '20',
  // Troll's own energy regen (see spendTrollEnergy) — +1 every N minutes,
  // capped at max_energy, shared by every autonomous attack.
  energy_regen_minutes: '20',
};
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO troll_settings (key, value) VALUES (?, ?)').run(key, value);
}

// Factory-default phrases, seeded into troll_phrases only on first run (table
// empty) so admin edits/additions via /troll_phrase_* survive restarts and
// never get duplicated back in. {user} is a plain-text placeholder — targeted
// categories get it substituted with the target's @username/first name at
// send time, via a simple string replace, not a JS template literal.
const PHRASE_SEED = {
  play: [
    'Моя мурчать от радость! Твоя хороший друг.',
    'Моя любить, когда твоя играть с моя!',
    'Моя довольный, твоя добрый.',
  ],
  kick: [
    'Ай! Твоя злой! Моя обижаться на твоя!',
    'За что твоя моя бить?! Твоя плохой совсем!',
    'Моя злиться на твоя! Твоя уходить!',
  ],
  feed: [
    'Ням-ням! Моя кушать вкусно, спасибо твоя!',
    'Моя расти большой от твоя еда!',
    'Моя сытый теперь, твоя хороший.',
  ],
  // Action categories (mischief_*, targeted_phrase_*) are plain Russian, no
  // troll accent — sent wrapped in asterisks as a roleplay-style action line,
  // not as something the troll "says". Only actual dialogue (play/kick/feed/
  // woken_angry) stays in troll-speak.
  mischief_mild: [
    'пошутил над соседской курицей',
    'пробежался голышом вокруг моста',
    'рассказал смешную историю про рыбу',
  ],
  mischief_medium: [
    'стащил чужую еду со стола',
    'спрятал чью-то вещь под мостом',
    'измазал грязью чужую дверь',
  ],
  mischief_mean: [
    'украл всю еду в деревне',
    'обозвал всех плохими словами',
    'сломал что-то нарочно',
  ],
  targeted_phrase_mild: [
    'скорчил смешную рожицу перед {user}',
    'помахал ручкой {user} из-под моста',
    'пустил мыльные пузыри на {user}',
  ],
  targeted_phrase_medium: [
    'дёрнул {user} за ухо',
    'пощекотал {user} веточкой',
    'обрызгал {user} водой из лужи',
  ],
  targeted_phrase_mean: [
    'напугал {user} страшной рожей',
    'погнался за {user} с палкой',
    'обозвал {user} нехорошими словами',
  ],
  targeted_action_mild: [
    'показать язык {user}',
    'подмигнуть {user}',
    'спрятаться от {user} под мост',
  ],
  targeted_action_medium: [
    'спрятать телефон {user} под мост',
    'связать шнурки {user}',
    'подложить лягушку в карман {user}',
  ],
  targeted_action_mean: [
    'украсть носки у {user}',
    'облить водой {user} из-под моста',
    'столкнуть {user} в лужа',
  ],
  woken_angry: [
    'Ррррр! Кто будить моя?! Моя спать хотеть!',
    'Твоя разбудить моя! Моя очень злой сейчас!',
    'Не мешать моя спать! Уходи!',
  ],
  feed_reject: [
    'Твоя что, моя не видеть?! Моя сытый совсем! *кидает еда в твоя*',
    'Моя не хотеть больше кушать! *швыряет еда в твоя лицо*',
    'Убирать эта еда! Моя и так полный! *кидает в твоя*',
  ],
  feed_overeat: [
    'Ой-ой, моя объедаться! Живот болеть, но еда вкусно!',
    'Моя есть слишком много! Моя теперь толстый и довольный.',
    'Уф, моя переедать! Но спасибо твоя за еда!',
  ],
  tease: [
    'Твоя дразнить моя?! Моя не любить это!',
    'Прекратить дразнить моя, а то моя правда злиться!',
    'Моя злой на твоя за это!',
  ],
  boobs_baby: [
    'Ооо, еда! Твоя носить еда с собой?!',
    'Моя видеть кушать! Дай моя пробовать!',
    'Твоя показывать моя еда! Моя хотеть кушать!',
  ],
  boobs_teen: [
    'Э-э... моя не знать, куда смотреть... но моя смотреть.',
    'Твоя показывать моя... что-то интересное. Моя краснеть.',
    'Моя не понимать, но моя нравиться смотреть.',
  ],
  boobs_young: [
    'Ого! Твоя красивый! Моя хотеть смотреть ещё!',
    'Моя нравиться то, что твоя показывать!',
    'Твоя дразнить моя! Моя не против!',
  ],
  boobs_adult: [
    'Моя знать точно, что это, и моя очень довольный!',
    'Твоя знать, как порадовать тролля! Моя обожать это!',
    'О да! Моя хотеть больше!',
  ],
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
    'Моя найти вкусный корешок под мостом и скушать сама!',
    'Моя сама находить еда — не всегда ждать, пока твоя покормить!',
    'Ням, моя перекусить немного, без посторонний помощь!',
  ],
  activity_awake: [
    'бродит под мостом',
    'ждёт, когда покормят',
    'греется на солнышке',
    'что-то мастерит из веточек',
  ],
};

// tease_harsh/tease_neutral/tease_adoring aren't part of PHRASE_SEED (seeded
// separately below, since they didn't exist at first-run time for
// already-deployed trolls) — added here too so /troll_phrase_add and
// /troll_phrases still recognize them.
const PHRASE_CATEGORIES = [...Object.keys(PHRASE_SEED), 'tease_harsh', 'tease_neutral', 'tease_adoring'];

const phraseCount = db.prepare('SELECT COUNT(*) AS n FROM troll_phrases').get().n;
if (phraseCount === 0) {
  const insertPhrase = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)');
  for (const [category, texts] of Object.entries(PHRASE_SEED)) {
    for (const text of texts) insertPhrase.run(category, text);
  }
}

// Extra comeback lines for /tease, added after the original 3-phrase seed
// above — checked by exact text match (not a first-run-only gate like the
// block above) so it tops up an already-deployed troll_phrases table
// without duplicating on every restart.
const TEASE_EXTRA_PHRASES = [
  'Твоя обзываться, а моя не обижаться — моя тролль, моя привыкший!',
  'Ха! Твоя слова как вода — моя даже не замечать!',
  'Моя видеть много глупый люди, твоя не самый худший.',
  'Твоя думать моя обидеться? Моя только смеяться!',
  'Ой-ой, кто-то сегодня злой! Твоя завтракать лягушка?',
  'Моя тролль под мостом — моя слышать похуже твоя слова.',
  'Твоя стараться обидеть моя? Твоя слабо стараться.',
  'Моя не обращать внимание на твоя писк.',
  'Твоя злой язык, а моя толстый кожа!',
  'Хех, твоя даже не знать, как по-настоящему обидеть моя.',
  'Моя тролль, моя питаться такой слова на завтрак.',
  'Твоя пытаться, а моя даже не почувствовать.',
  'Моя видеть твоя насквозь — твоя просто грустный внутри.',
  'Ого, какие громкие слова от такой маленький человек!',
  'Твоя обзываться — моя записывать в книга жалоб.',
  'Моя смеяться твоя попытка — попробуй ещё раз, а?',
  'Твоя слова отскакивать от моя, как камешек от мост.',
  'Моя тролль с толстый шкура — твоя слова только щекотать.',
  'Ай, как обидно... нет, не обидно, моя просто зевать.',
  'Твоя злиться — моя становиться только веселее!',
];

// Same tone as tease, but reserved for people the troll actively dislikes
// (see pickTeaseCategory below) — split into its own category so the admin
// panel's existing Фразы tab (which groups phrases by category with no
// hardcoded list) shows it as its own separate, manageable section.
const TEASE_HARSH_PHRASES = [
  'Твоя совсем дурак, да? Моя видеть таких каждый день под мост.',
  'Пошёл твоя отсюда, скотина неблагодарная!',
  'Твоя мозг совсем нет? Моя думать твоя просто идиот.',
  'Заткнись, урод, пока моя терпеть твоя чушь.',
  'Твоя мерзкий тип, моя тошнить от твоя слова.',
  'Отвали, паскуда, моя не хотеть слышать твоя вонь.',
  'Твоя жалкий козёл, моя даже плевать лень на твоя.',
  'Моя видеть много мразь, но твоя переплюнуть всех!',
  'Свали, гнида, пока моя терпение не кончаться совсем.',
  'Твоя тупица редкая, моя удивляться, как твоя жить вообще.',
  'Заткнуть твоя рот, сволочь, никто твоя не спрашивать!',
  'Твоя дно самое настоящее, моя даже брезговать.',
  'Пошёл твоя в болото, гад мерзкий!',
  'Твоя остолоп конченый, моя терять время на твоя.',
  'Убирайся, зараза, пока моя не разозлиться по-настоящему.',
  'Твоя моя раздражать до тошноты, кретин недоделанный.',
  'Твоя ничтожество, моя даже смотреть на твоя противно.',
  'Заглохни, паразит, твоя болтовня моя утомлять.',
  'Твоя позорище ходячее, моя стыдно за твоя рядом стоять.',
  'Проваливай, мразь, пока моя не показать, кто тут главный!',
];

// Attitude 0-70: plain, matter-of-fact acknowledgment — not hostile, not
// affectionate, just a neutral "yes, you're there" response.
const TEASE_NEUTRAL_PHRASES = [
  'Моя видеть твоя. Твоя тут, окей.',
  'Твоя звать моя? Моя слушать.',
  'Моя нормально относиться к твоя.',
  'Твоя тут — моя не против.',
  'Ну, привет, твоя. Моя занят, но ладно.',
  'Твоя обращаться к моя — моя отвечать, как обычно.',
  'Моя видеть твоя каждый день, твоя нормальный.',
  'Твоя не самый плохой, но и не самый хороший.',
  'Ладно, твоя, моя слушать, что твоя хотеть.',
  'Моя относиться к твоя спокойно, без претензий.',
  'Твоя тут снова. Моя заметить.',
  'Хорошо, твоя, моя дать ответ, раз твоя спрашивать.',
  'Моя не злиться и не радоваться — просто твоя тут.',
  'Твоя обычный человек для моя, ничего особенного.',
  'Моя отвечать твоя, потому что твоя вежливо спросить.',
  'Ну что, твоя, чего хотеть на этот раз?',
  'Моя знать твоя, твоя знать моя — норм так.',
  'Твоя не плохой сосед под мост, если честно.',
  'Моя кивать твоя — обычное дело.',
  'Твоя тут, моя тут — всё нормально.',
];

// Attitude 70-100: warm, respectful, openly adoring — the troll's favorite
// people get treated like it.
const TEASE_ADORING_PHRASES = [
  'Ах, твоя! Моя самый любимый человек говорить с моя!',
  'Твоя голос моя радовать сердце! Моя обожать твоя!',
  'Моя счастливый, когда твоя рядом! Твоя лучший!',
  'О, твоя! Моя специально ждать твоя слова!',
  'Твоя самый добрый друг моя во всём мире!',
  'Моя мурчать от радость — это же твоя пришёл!',
  'Твоя всегда моя радовать, моя обожать каждый твоя слово!',
  'Ах, как хорошо, что твоя снова тут! Моя скучать!',
  'Моя гордиться дружба с твоя, честное слово!',
  'Твоя самый прекрасный человек, моя знать!',
  'Моя слушать твоя с восхищение, твоя такой мудрый!',
  'Твоя приходить — и моя весь день становиться лучше!',
  'О, обожаемый твоя! Моя всегда рада твоя видеть!',
  'Моя доверять твоя больше всех под этот мост!',
  'Твоя просто чудо, моя не мочь на твоя нарадоваться!',
  'Моя благодарный судьба за твоя дружба!',
  'Твоя моя любимчик, моя это не скрывать!',
  'Ах, твоя тут! Моя аж подпрыгивать от счастье!',
  'Твоя заслуживать самый лучший в мире тролль-друг — это моя!',
  'Моя обожать твоя всем моя тролль-сердце!',
];

// Per-stage variants for the mild-tease and harsh-insult pools (see
// STAGE_SUFFIXES/pickPhraseForStage) — малыш keeps using the plain
// tease/tease_harsh pools above as its baseline, these three stages get
// their own escalating flavor: молодой is cockier, взрослый is sharper and
// more composed, старый is world-weary and dismissive.
const TEASE_YOUNG_PHRASES = [
  'Ха, серьёзно? Твоя дразнилка совсем слабый, дружок.',
  'Моя уже не малыш — такое моя не задевать.',
  'Твоя пытаться — плюс за старание, минус за результат.',
  'Опять твоя за старое? Моя уже привык к твоя выходкам.',
  'Твоя думать это обидно? Моя даже не поморщиться.',
  'Слабенько, друг. Моя видеть попытки и получше.',
  'Твоя язык острый, но моя кожа острее.',
  'Ну давай, ещё раз попробуй — моя подождать.',
  'Твоя смешить моя своя дразнилка, честно.',
  'Моя расти — и твоя шутки расти не успевать.',
];
const TEASE_ADULT_PHRASES = [
  'Серьёзно? Я думал, ты придумаешь что-то получше.',
  'Твои слова не долетают — я давно перерос такие уколы.',
  'Мило, что ты пытаешься. Продолжай тренироваться.',
  'Я взрослый тролль — меня такими мелочами не пробить.',
  'Твоя дерзость забавна, но безрезультатна.',
  'Ты явно недооценил, с кем связался.',
  'Спасибо за попытку. Правда, спасибо — было забавно.',
  'Я слышал оскорбления и получше от детей помладше тебя.',
  'Твой запал впечатляет больше, чем содержание.',
  'Возвращайся, когда придумаешь что-то стоящее.',
];
const TEASE_OLD_PHRASES = [
  'Эх, молодёжь... думаешь удивить старого тролля?',
  'Я такое слышал ещё до твоего рождения, дитя.',
  'Побереги силы, внучок, я видал дразнилки и пострашнее.',
  '*устало вздыхает* Опять двадцать пять...',
  'Твоя дерзость мила, как и всё в твоём возрасте.',
  'Я пережил века под этим мостом — твои слова не более чем ветер.',
  'Ну-ну, покажи характер. Я подожду, мне спешить некуда.',
  'В моё время дразнились как-то изощрённее, чесслово.',
  '*кряхтит* Ты хоть представляешь, сколько таких, как ты, я видал?',
  'Мудрость приходит с возрастом — жаль, не к тебе.',
];
const TEASE_HARSH_YOUNG_PHRASES = [
  'Заткнись, мелкий выскочка, пока моя не показал тебе, кто тут главный.',
  'Твоя мозг совсем отсутствовать? Даже не удивлён.',
  'Пшёл вон, неудачник, моя терпение не резиновое.',
  'Твоя жалок — даже дразнить скучно.',
  'Ещё слово — и моя перестать быть вежливым.',
  'Твоя реально думать это сработать? Смешно.',
  'Отвали, пока цел, дурень.',
  'Моя видеть больше таланта в камне под мостом, чем в твоя словах.',
  'Твоя тупость поражает даже моя.',
  'Свали, пока моя добрый.',
  // Added for the more grown-up, hormonal-teen personality — sharper,
  // more dismissive attitude on top of the original harsh-young set above.
  'Твоя вообще в курсе, с кем разговаривать? Моя не для слабаков.',
  'Ой, всё, началось нытьё. Твоя скучный до зевоты.',
  'Моя было бы стыдно говорить такое на людях.',
  'Твоя серьёзно думать, это смешно? Пффф.',
  'Моя видеть таких как твоя пачками, ничего особенного.',
  'Твоя достал уже, честно говоря.',
  'Ага, конечно, беги дальше со своими глупостями.',
  'Твоя явно не выспался, раз несёшь такую чушь.',
  'Моя даже спорить с твоя не буду, бессмысленно.',
  'Твоя такая мелочь, а туда же.',
  'Серьёзно? Это всё, что твоя могла придумать?',
  'Твоя раздражаешь моя одним своим видом.',
  'Моя даже не удостоит твоя нормальным ответом.',
  'Твоя вообще думаешь, прежде чем писать?',
  'Ладно, твоя выиграл титул самого скучного в чате.',
];
const TEASE_HARSH_ADULT_PHRASES = [
  'Ты действительно жалок. Даже оскорблять тебя скучно.',
  'Прекрати унижаться — это даже для меня слишком неловко смотреть.',
  'Твоё существование — уже достаточное наказание для окружающих.',
  'Я видел мусор интереснее тебя.',
  'Заткнись и не трать моё время впустую.',
  'Ты — живое доказательство того, что не всем стоило рождаться умными.',
  'Убирайся, пока я не решил, что ты того не стоишь даже для оскорблений.',
  'Твоя наглость не компенсирует полное отсутствие мозгов.',
  'Даже эхо под мостом умнее твоих слов.',
  'Проваливай — от тебя веет только позором.',
];
const TEASE_HARSH_OLD_PHRASES = [
  'Мальчишка, я топил таких, как ты, ещё столетие назад.',
  '*презрительно фыркает* Твоя дерзость — жалкая тень настоящей наглости.',
  'Даже гнилой пень под мостом уважительнее тебя.',
  'Ты не стоишь моего гнева — только моего презрения.',
  'Я видел тысячи таких глупцов — все они кончили одинаково жалко.',
  'Прочь с глаз, пока старость не сделала меня снисходительным к тебе.',
  'Твои слова — пыль на ветру времени, которое я пережил.',
  'Даже мхом на камне я дорожу больше, чем твоим мнением.',
  '*устало машет рукой* Иди отсюда, дитя, ты утомляешь старого тролля.',
  'Я похоронил под этим мостом наглецов посерьёзнее тебя.',
];

// Extra "moya remember this little person" flavor lines, added on top of
// each interaction's existing phrase pool (not replacing it — these just
// mix in alongside the originals via the normal random pick).
const PLAY_MEMORY_PHRASES = [
  'Моя запомнить твоя, людишка! Играть с твоя было весело!',
  'Твоя теперь в моя память, людишка — хороший игрок!',
  'Моя не забывать твоя лицо, людишка, твоя хорошо играть!',
];
const FEED_MEMORY_PHRASES = [
  'Моя запомнить твоя, людишка — вкусный корм давать!',
  'Твоя теперь в моя память как кормилец, людишка!',
  'Моя не забывать, кто моя кормить, людишка!',
];
const KICK_MEMORY_PHRASES = [
  'Моя запомнить твоя, людишка! Моя не забывать обида!',
  'Твоя теперь в чёрный список моя память, людишка!',
  'Моя запоминать твоя лицо — берегись, людишка!',
];
const TEASE_MEMORY_PHRASES = [
  'Моя запомнить твоя, дразнилка-людишка!',
  'Твоя теперь в моя память, людишка, как надоеда!',
  'Моя не забывать твоя приставание, людишка!',
];
const BOOBS_BABY_MEMORY_PHRASES = [
  'Моя запомнить эта еда-сиська, людишка!',
  'Твоя сиська теперь в моя память, людишка!',
];
const BOOBS_TEEN_MEMORY_PHRASES = [
  'Моя запомнить твоя сиська, людишка... неловко, но запомнить!',
  'Твоя сиська теперь в моя память, людишка.',
];
const BOOBS_YOUNG_MEMORY_PHRASES = [
  'Моя точно запомнить твоя сиська, людишка!',
  'Твоя сиська теперь навсегда в моя память, людишка!',
];
const BOOBS_ADULT_MEMORY_PHRASES = [
  'Моя запомнить твоя сиська во всех подробностях, людишка!',
  'Твоя сиська — теперь легенда в моя память, людишка!',
];

// Whoever earns the "mama" title (see checkMamaPromotion) gets these
// instead of the normal play/feed/tease/boobs pool — clingy, demanding,
// toddler-with-a-parent energy.
const MAMA_PHRASES = [
  'Мама! Мама! Взять моя на ручки!',
  'Мама, погулять с моя, а? Моя хотеть на улица!',
  'Мама, покормить моя, моя кушать хотеть!',
  'Мама, моя хотеть на ручки прямо сейчас!',
  'Мама, потрогать моя пузико, оно урчать!',
  'Мама, моя хотеть обнимашки!',
  'Мама, посмотри, какой моя хвостик — потрогать его!',
  'Мама, моя устал, взять моя на ручки!',
  'Мама, купить моя вкусняшка!',
  'Мама, поиграть с моя, а то моя скучать!',
  'Мама, почесать моя за ухом, пожалуйста!',
  'Мама, моя хотеть сидеть у твоя на коленках!',
  'Мама, посмотри на моя бородавка — потрогать её!',
  'Мама, спой моя колыбельная!',
  'Мама, моя боится темноты, побудь рядом!',
  'Мама, моя нарисовал тебе картинка из грязи!',
  'Мама, понеси моя, моя лапки устали!',
  'Мама, моя хотеть купаться в лужа с твоя!',
  'Мама, расскажи моя сказка про тролль!',
  'Мама, моя любить твоя больше всех на свете!',
];

// Extra nasty sneaky-revenge lines for an enemy (attitude -100) specifically
// — added to the existing targeted_action_mean pool since an enemy's
// attitude is already far below attitude_escalation_threshold, so mischief
// aimed at them always escalates to this top tier anyway. No new category
// or targeting logic needed, just richer content for the case that already
// fires reliably.
const TARGETED_ACTION_MEAN_ENEMY_PHRASES = [
  'исподтишка подложить тухлую рыба под дверь {user}',
  'заминировать порог {user} острой колючкой',
  'вылить помои прямо у дверь {user}',
  'спрятать заранее камни в ботинки {user}',
  'измазать ручка двери {user} грязью',
  'тайно связать шнурки на порог {user}',
  'оставить куча гнилых листьев у дверь {user}',
  'начертить нехорошие слова мелом на стена {user}',
  'выпустить лягушки в дом {user}',
  'стащить и спрятать носки {user}, пока тот спать',
];

// Gender-specific comebacks (see resolveTeaseCategory) — a flat 20-line
// pool per gender that takes priority over the normal attitude-tier tease
// system whenever the target's gender is known (see detectAndStoreGender),
// falling back to the harsh/neutral/adoring tiers otherwise.
const TEASE_MALE_PHRASES = [
  'Твоя такой глупый! Моя не бояться твоя!',
  'Ха! Твоя слабый совсем, а ещё дразнить моя!',
  'Твоя мужик, а вести себя как малыш!',
  'Твоя такой шумный, как трактор без глушитель!',
  'Ну и хвастун твоя! Моя видеть твоя насквозь!',
  'Твоя думать, твоя крутой? Моя смеяться!',
  'Твоя такой упрямый осёл!',
  'Фу, твоя такой вонючий, моя аж отвернуться!',
  'Твоя борода растрёпанный, как моя мост!',
  'Твоя грозный только на словах!',
  'Моя видеть, твоя дрожать от страх, а ещё выпендриваться!',
  'Твоя такой ленивый лежебока!',
  'Твоя орать горазд, а сам трусишка!',
  'Твоя пузатый и надутый, как жаба!',
  'Моя знать, твоя слабак под этой важностью!',
  'Твоя такой невоспитанный грубиян!',
  'Ой, твоя такой напыщенный, а внутри пустой!',
  'Твоя пыжиться, а моя всё равно не бояться твоя!',
  'Твоя такой неуклюжий, споткнёшься о собственный нога!',
  'Твоя думать твоя сильный? Моя видеть только хвастовство!',
];
const TEASE_FEMALE_PHRASES = [
  'Твоя такая глупая! Моя не бояться твоя!',
  'Ха! Твоя слабая совсем, а ещё дразнить моя!',
  'Твоя такая шумная, как трещотка!',
  'Твоя такая надутая, как шарик!',
  'Ну и хвастунья твоя! Моя видеть твоя насквозь!',
  'Твоя думать, твоя крутая? Моя смеяться!',
  'Твоя такая упрямая ослица!',
  'Фу, твоя такая вонючая, моя аж отвернуться!',
  'Твоя причёска растрёпанная, как моя мост!',
  'Твоя грозная только на словах!',
  'Моя видеть, твоя дрожать от страх, а ещё выпендриваться!',
  'Твоя такая ленивая лежебока!',
  'Твоя орать горазда, а сама трусишка!',
  'Твоя надутая и капризная, как жаба!',
  'Моя знать, твоя слабачка под этой важностью!',
  'Твоя такая невоспитанная грубиянка!',
  'Ой, твоя такая напыщенная, а внутри пустая!',
  'Твоя пыжиться, а моя всё равно не бояться твоя!',
  'Твоя такая неуклюжая, споткнёшься о собственный нога!',
  'Твоя думать твоя сильная? Моя видеть только хвастовство!',
];

// Gender-specific mischief actions (see resolveTargetedActionCategory) —
// same priority-pool idea as tease above, fed through rollTrollTry so each
// still gets the usual trial-roll treatment, just with gender-flavored
// content instead of the plain mild/medium/mean tiers.
const TARGETED_ACTION_MALE_PHRASES = [
  'спрятать любимый мяч {user} под мост',
  'подрисовать усы на фото {user}',
  'связать шнурки {user} между собой',
  'спрятать пульт от телевизора у {user}',
  'подложить жвачку под стул {user}',
  'украсть кепку у {user}',
  'спрятать бритва {user} под мост',
  'подкрутить будильник {user} на час раньше',
  'намазать руль велосипеда {user} мёдом',
  'спрятать носки {user} по одному',
  'подложить лягушка в рюкзак {user}',
  'стащить последняя котлета у {user}',
  'перепутать пульт от игровая приставка {user}',
  'спрятать зарядка от телефон {user}',
  'нарисовать рожица на кроссовке {user}',
  'подвязать шнурки на кроссовках {user}',
  'спрятать любимая кружка {user} под мост',
  'намочить подушка {user} водой из-под моста',
  'стащить чипсы у {user} и спрятать под мост',
  'перепутать носки {user} местами',
];
const TARGETED_ACTION_FEMALE_PHRASES = [
  'спрятать любимая помада {user} под мост',
  'перепутать флаконы шампуня у {user}',
  'завязать бантик на сумке {user}, пока та не видеть',
  'спрятать заколки {user} под мост',
  'подложить блёстки в косметичка {user}',
  'стащить последняя конфета у {user}',
  'спрятать любимые серёжки {user}',
  'намазать зеркало {user} водой из-под моста',
  'перепутать крем и зубную паста у {user}',
  'спрятать зарядка от телефон {user}',
  'подрисовать смайлик на зеркале {user}',
  'стащить резинка для волос у {user}',
  'спрятать любимый шарф {user} под мост',
  'намочить полотенце {user} водой из-под моста',
  'перепутать местами тапочки {user}',
  'спрятать зонтик {user} перед дождь',
  'подложить блёстки в сумка {user}',
  'стащить последнее печенье у {user}',
  'спрятать любимая кружка {user} под мост',
  'завязать шнурки {user} узлом',
];

// Stage-2 ("молодой") override of TARGETED_ACTION_FEMALE_PHRASES — picked up
// automatically by pickPhraseForStage's stage-suffix lookup (see
// resolveTargetedActionCategory, which returns the plain 'targeted_action_female'
// unconditionally; the '_young' variant only kicks in downstream, in
// pickPhraseForStage itself). Clumsy teenage flirting instead of innocent
// pranks — the older, more hormonal personality the user asked for.
const TARGETED_ACTION_FEMALE_YOUNG_PHRASES = [
  'подмигнуть {user} и покраснеть от смущения',
  'предложить {user} прогуляться под луной',
  'подойти к {user} познакомиться, но забыть все слова',
  'подарить {user} самый красивый камень с моста',
  'встать в эффектную позу перед {user}',
  'написать {user} любовную записку на мокром листике',
  'спеть серенаду для {user} под мостом',
  'угостить {user} самой большой рыбой с моста',
  'пригласить {user} на свидание при лунном свете',
  'сделать комплимент {user} и смутиться от своих слов',
  'предложить {user} потрогать свои мускулы',
  'засмотреться на {user} и врезаться в мост',
  'украдкой сфотографировать {user} на память',
  'пригласить {user} покормить голубей вместе',
  'подойти к {user} вразвалочку, изображая крутого парня',
];

// Stage-2 override of the untargeted mischief_mild/mischief_medium pools
// (see MISCHIEF_TIER_CATEGORIES + pickPhraseForStage in triggerMischief) —
// same plain-Russian, third-person, asterisk-wrapped style as the base
// pools, just with the hormonal-teen ambient behavior the user asked for
// (no specific chat participant named — that's what TARGETED_ACTION_FEMALE_YOUNG_PHRASES is for).
const MISCHIEF_MILD_YOUNG_PHRASES = [
  'украдкой поправил причёску, заметив кого-то симпатичного',
  'потрогал себя через штаны, задумавшись о своём',
  'разглядывал себя в луже, накачивая мускулы',
  'написал на мосту чьё-то имя в сердечке',
  'вздохнул тяжело, вспоминая кого-то',
  'почесал где-то ниже пояса и сделал вид, что ничего не было',
  'настроил отражение в луже под правильным углом',
  'опять переоделся три раза перед тем, как выйти из-под моста',
  'обрызгался чужими духами, найденными у моста',
  'практиковал в одиночестве, как будет знакомиться',
];
const MISCHIEF_MEDIUM_YOUNG_PHRASES = [
  'подглядывал за девушками у речки, притворяясь, что ловит рыбу',
  'полез трогать себя прямо во время шалости, не стесняясь никого',
  'написал похабный стишок на заборе и подписался чужим именем',
  'выпросил у прохожей номер телефона и получил по морде',
  'спрятался в кустах, чтобы получше рассмотреть проходящих мимо',
  'потратил час на укладку единственной пряди волос',
  'громко присвистнул вслед незнакомке и тут же спрятался от стыда',
  'полез обниматься без спроса и получил пощёчину',
  'сделал самому себе комплимент вслух, никого не стесняясь',
  'разложил перед мостом цветы для девушки, которая так и не пришла',
];

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

// /boobs turn-away for a known male caller (see performBoobs) — unknown
// gender still goes through normally, only an explicit male match rejects.
const BOOBS_MALE_REJECT_PHRASES = [
  'Твоя же не девушка! У твоя нет что показать!',
  'Ха, твоя мужик! Моя ждать сиська, а не эта!',
  'Твоя перепутал что-то, у твоя там не то!',
  'Моя не обманывать — иди зови девушка, если хочешь моя порадовать!',
  'Твоя думать моя не заметить? У твоя нет сиська!',
  'Тю, твоя мужик — моя это не интересно!',
];

// Tops up an already-deployed troll_phrases table with new seed phrases for
// a category, checked by exact text match rather than a first-run-only
// gate — so it's safe to call again on every restart without duplicating.
function seedPhrasesIfMissing(category, phrases) {
  const existing = new Set(
    db.prepare('SELECT text FROM troll_phrases WHERE category = ?').all(category).map((r) => r.text)
  );
  const insertPhrase = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)');
  for (const text of phrases) {
    if (!existing.has(text)) insertPhrase.run(category, text);
  }
}
seedPhrasesIfMissing('tease', TEASE_EXTRA_PHRASES);
seedPhrasesIfMissing('tease_harsh', TEASE_HARSH_PHRASES);
seedPhrasesIfMissing('tease_neutral', TEASE_NEUTRAL_PHRASES);
seedPhrasesIfMissing('tease_adoring', TEASE_ADORING_PHRASES);
seedPhrasesIfMissing('tease_young', TEASE_YOUNG_PHRASES);
seedPhrasesIfMissing('tease_adult', TEASE_ADULT_PHRASES);
seedPhrasesIfMissing('tease_old', TEASE_OLD_PHRASES);
seedPhrasesIfMissing('tease_harsh_young', TEASE_HARSH_YOUNG_PHRASES);
seedPhrasesIfMissing('tease_harsh_adult', TEASE_HARSH_ADULT_PHRASES);
seedPhrasesIfMissing('tease_harsh_old', TEASE_HARSH_OLD_PHRASES);
seedPhrasesIfMissing('play', PLAY_MEMORY_PHRASES);
seedPhrasesIfMissing('feed', FEED_MEMORY_PHRASES);
seedPhrasesIfMissing('kick', KICK_MEMORY_PHRASES);
seedPhrasesIfMissing('tease', TEASE_MEMORY_PHRASES);
seedPhrasesIfMissing('boobs_baby', BOOBS_BABY_MEMORY_PHRASES);
seedPhrasesIfMissing('boobs_teen', BOOBS_TEEN_MEMORY_PHRASES);
seedPhrasesIfMissing('boobs_young', BOOBS_YOUNG_MEMORY_PHRASES);
seedPhrasesIfMissing('boobs_adult', BOOBS_ADULT_MEMORY_PHRASES);
seedPhrasesIfMissing('mama', MAMA_PHRASES);
seedPhrasesIfMissing('targeted_action_mean', TARGETED_ACTION_MEAN_ENEMY_PHRASES);
seedPhrasesIfMissing('tease_male', TEASE_MALE_PHRASES);
seedPhrasesIfMissing('tease_female', TEASE_FEMALE_PHRASES);
seedPhrasesIfMissing('targeted_action_male', TARGETED_ACTION_MALE_PHRASES);
seedPhrasesIfMissing('targeted_action_female', TARGETED_ACTION_FEMALE_PHRASES);
seedPhrasesIfMissing('boobs_male_reject', BOOBS_MALE_REJECT_PHRASES);
seedPhrasesIfMissing('targeted_action_female_young', TARGETED_ACTION_FEMALE_YOUNG_PHRASES);
seedPhrasesIfMissing('mischief_mild_young', MISCHIEF_MILD_YOUNG_PHRASES);
seedPhrasesIfMissing('mischief_medium_young', MISCHIEF_MEDIUM_YOUNG_PHRASES);
seedPhrasesIfMissing('lust_action', LUST_ACTION_PHRASES);

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

function getPhrases(category) {
  return db.prepare('SELECT text FROM troll_phrases WHERE category = ?').all(category).map((r) => r.text);
}

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

// Returns the underlying send promise so ordering-sensitive callers (e.g.
// after a trial-roll message) can await it — callers that don't care can
// keep firing-and-forgetting exactly as before.
function sendCategoryReply(chatId, category, fallback, actorLabel, actorUserId) {
  const sticker = Math.random() < 0.5 ? pickSticker(category) : null;
  if (sticker) {
    const stickerPromise = bot.sendSticker(chatId, sticker.fileId).catch(() => {});
    if (sticker.hasOwnText) return stickerPromise;
  }
  const phrase = appendRelationshipEmoji(pickPhrase(category, fallback), actorUserId);
  return bot.sendMessage(chatId, actorLabel ? `${actorLabel} → ${phrase}` : phrase).catch(() => {});
}

// Per-stage content, layered on top of any category: <category>_baby /
// _young / _adult / _old, falling back to the plain <category> pool when
// nothing's been added for that stage yet. This means every interaction
// CAN have distinct per-stage phrases/stickers without requiring all four
// variants to exist up front — admin adds them via the panel's Фразы tab
// (which already groups by whatever category strings exist, no code
// changes needed there to recognize a new suffix). Not used by boobs_*,
// which predates this convention and keeps its own baby/teen/young/adult
// naming.
const STAGE_SUFFIXES = { 1: '_baby', 2: '_young', 3: '_adult', 4: '_old' };

function pickPhraseForStage(baseCategory, stage, fallback) {
  const staged = getPhrases(baseCategory + (STAGE_SUFFIXES[stage] || ''));
  if (staged.length > 0) return pick(staged);
  return pickPhrase(baseCategory, fallback);
}

function pickStickerForStage(baseCategory, stage) {
  return pickSticker(baseCategory + (STAGE_SUFFIXES[stage] || '')) || pickSticker(baseCategory);
}

function sendCategoryReplyForStage(chatId, baseCategory, stage, fallback, actorLabel, actorUserId) {
  const sticker = Math.random() < 0.5 ? pickStickerForStage(baseCategory, stage) : null;
  if (sticker) {
    const stickerPromise = bot.sendSticker(chatId, sticker.fileId).catch(() => {});
    if (sticker.hasOwnText) return stickerPromise;
  }
  const phrase = appendRelationshipEmoji(pickPhraseForStage(baseCategory, stage, fallback), actorUserId);
  return bot.sendMessage(chatId, actorLabel ? `${actorLabel} → ${phrase}` : phrase).catch(() => {});
}

function isSilenced(state) {
  return !!state.silenced_until && state.silenced_until * 1000 > Date.now();
}

// "Пьяный" debuff from "Бухать с тролем" (see performDrink) — forces the
// harshest available tease/mischief tier regardless of attitude/mood/
// naughtiness while active (see pickTeaseCategory/resolveTeaseCategory/
// getMischiefTier below).
function isDrunk(state) {
  return !!state.drunk_until && state.drunk_until * 1000 > Date.now();
}

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

// --- Relationships ---
// Called anywhere the troll "notices" someone — any ordinary message in its
// home chat, or /play, /feed, /fight (even from someone who only ever uses
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

// Guesses grammatical gender from a first-person self-description — the
// classic Russian trick: past-tense verbs and long adjectives directly
// after "я" carry an unambiguous masculine/feminine ending ("я устал" vs
// "я устала", "я пошёл" vs "я пошла", "я такой" vs "я такая"). Checks the
// word right after "я" and the one after that (to tolerate one adverb in
// between, e.g. "я вчера пошла"). Best-effort and occasionally wrong for a
// casual chat heuristic — that's fine, it's never overwritten once set (see
// detectAndStoreGender), same permanence pattern as mama/enemy.
function guessGenderFromWord(word) {
  if (word.endsWith('лась') || word.endsWith('ла')) return 'female';
  if (word.endsWith('лся') || word.endsWith('л')) return 'male';
  if (word.endsWith('ая') || word.endsWith('яя')) return 'female';
  if (word.endsWith('ый') || word.endsWith('ий') || word.endsWith('ой')) return 'male';
  return null;
}

function detectGenderFromText(text) {
  if (!text) return null;
  const words = text.toLowerCase().match(/[а-яё]+/gi) || [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'я') continue;
    for (let j = i + 1; j <= Math.min(i + 2, words.length - 1); j++) {
      const gender = guessGenderFromWord(words[j]);
      if (gender) return gender;
    }
  }
  return null;
}

// Sticky like mama/enemy — only ever sets gender from NULL, a later message
// (even a contradictory one) never overwrites an already-known guess.
function detectAndStoreGender(userId, text) {
  const row = db.prepare('SELECT gender FROM troll_relationships WHERE user_id = ?').get(userId);
  if (!row || row.gender) return;
  const gender = detectGenderFromText(text);
  if (gender) {
    db.prepare('UPDATE troll_relationships SET gender = ? WHERE user_id = ?').run(gender, userId);
  }
}

// Returns the attitude BEFORE this adjustment so callers can detect a
// just-now crossing into enemy territory (see checkEnemyDeclaration) —
// existing callers that ignore the return value are unaffected.
function adjustAttitude(userId, delta) {
  const before = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(userId);
  const oldAttitude = before ? before.attitude : 0;
  db.prepare('UPDATE troll_relationships SET attitude = MAX(-100, MIN(100, attitude + ?)) WHERE user_id = ?').run(delta, userId);
  return oldAttitude;
}

// Whoever is first to actually reach attitude 100 gets crowned — checked
// right after adjustAttitude wherever the delta can be positive (play,
// feed). Once someone holds the title it's never re-evaluated, even if
// their attitude drops later.
function checkMamaPromotion(chatId, userId) {
  const state = db.prepare('SELECT mama_user_id FROM troll_state WHERE id = 1').get();
  if (!state || state.mama_user_id) return;
  const rel = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(userId);
  if (!rel || rel.attitude < 100) return;
  db.prepare('UPDATE troll_state SET mama_user_id = ? WHERE id = 1').run(userId);
  bot.sendMessage(chatId, '👑 Моя обрести мама! Твоя теперь моя мама навсегда!').catch(() => {});
}

// Enemy status is permanent once earned, like mama — reaching attitude -100
// sets is_enemy for good, even if attitude later recovers (see isEnemy).
// oldAttitude <= -100 short-circuits so this only fires on the actual
// transition into it, not every further negative delta while already there.
function checkEnemyDeclaration(chatId, from, oldAttitude) {
  if (oldAttitude <= -100) return;
  // Mama can never be flagged an enemy, however far her attitude drops —
  // is_enemy would otherwise make findEnemyAmong guarantee-target her in
  // triggerMischief/triggerPee, bypassing the mama exemption in
  // pickMischiefTarget entirely, and getMentionName checks isEnemy before
  // isMama so she'd display as "мой враг" instead of "мама".
  if (isMama(from.id)) return;
  const row = db.prepare('SELECT attitude, is_enemy FROM troll_relationships WHERE user_id = ?').get(from.id);
  if (!row || row.attitude > -100 || row.is_enemy) return;
  db.prepare('UPDATE troll_relationships SET is_enemy = 1 WHERE user_id = ?').run(from.id);
  bot.sendMessage(chatId, `💀 ${actorName(from)}, твоя теперь мой враг! Моя не забывать это никогда! 🖕`).catch(() => {});
}

// Swaps in the 'mama' phrase pool for whoever holds that title, on the
// affectionate commands only (play/feed/tease/boobs) — kicking mama still
// gets the normal kick reaction, that one isn't overridden.
function mamaCategoryOverride(state, userId, fallbackCategory) {
  return state.mama_user_id && state.mama_user_id === userId ? 'mama' : fallbackCategory;
}

function isMama(userId) {
  const state = db.prepare('SELECT mama_user_id FROM troll_state WHERE id = 1').get();
  return !!state && state.mama_user_id === userId;
}

// Taught emoji: loving ones for mama, 🖕 for an enemy — appended to
// whatever dialogue line was about to be sent to/about that specific
// person. No-op (returns text unchanged) for anyone else.
function appendRelationshipEmoji(text, userId) {
  if (userId == null) return text;
  if (isEnemy(userId)) return `${text} 🖕`;
  if (isMama(userId)) return `${text} ❤️😍💕`;
  return text;
}

// Four tiers by relationship, used uniformly by /tease, the reply-to-troll
// comeback, and the addressed-by-name comeback: harsh (<= escalation
// threshold), regular tease (threshold..0), neutral (0..70), adoring
// (70-100) — even a /tease from someone the troll adores lands soft.
// While drunk (see isDrunk), this is always overridden to the harshest
// tier for EVERYONE — deliberately no mama exemption here, per the "злой
// на всех" (angry at everyone) design of the debuff.
function pickTeaseCategory(userId) {
  const drunkState = db.prepare('SELECT drunk_until FROM troll_state WHERE id = 1').get();
  if (drunkState && isDrunk(drunkState)) return 'tease_harsh';
  const row = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(userId);
  const attitude = row ? row.attitude : 0;
  if (attitude >= 70) return 'tease_adoring';
  if (attitude >= 0) return 'tease_neutral';
  if (attitude <= getSettingNumber('attitude_escalation_threshold')) return 'tease_harsh';
  return 'tease';
}

// Gender pool (see TEASE_MALE_PHRASES/TEASE_FEMALE_PHRASES) takes priority
// over the attitude-tier tease system above whenever the target's gender
// is known (see detectAndStoreGender) — falls back to the normal
// harsh/neutral/adoring tiers otherwise. Only for actual phrase-selection
// call sites — the plain attitude check gating "Тролль Фас" keeps calling
// pickTeaseCategory directly, unaffected by gender. Drunk is checked here
// too (not just inside pickTeaseCategory) since it must override gender's
// otherwise-higher priority as well.
function resolveTeaseCategory(userId) {
  const drunkState = db.prepare('SELECT drunk_until FROM troll_state WHERE id = 1').get();
  if (drunkState && isDrunk(drunkState)) return 'tease_harsh';
  const row = db.prepare('SELECT gender FROM troll_relationships WHERE user_id = ?').get(userId);
  return row && row.gender ? `tease_${row.gender}` : pickTeaseCategory(userId);
}

// Same idea for targeted mischief actions (see TARGETED_ACTION_MALE_PHRASES/
// TARGETED_ACTION_FEMALE_PHRASES) — falls back to whatever escalation tier
// the caller already computed (mild/medium/mean) when gender is unknown.
function resolveTargetedActionCategory(userId, tierCategory) {
  const row = db.prepare('SELECT gender FROM troll_relationships WHERE user_id = ?').get(userId);
  return row && row.gender ? `targeted_action_${row.gender}` : tierCategory;
}

// Daily cap on /fight attempts per person (fight_daily_limit, default 5) —
// a rolling 24h window, same idiom as frequent_arguer_window_hours, just a
// separate counter so tuning one doesn't affect the other.
function getFightAttemptsToday(userId) {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM troll_actions WHERE user_id = ? AND action = 'fight' AND created_at >= ?"
  ).get(userId, since);
  return row.n;
}

// A "frequent arguer" is purely about recent conflict frequency (fights
// within a rolling window) — deliberately independent of the attitude-based
// enemy system, since someone can fight a lot in a short burst without ever
// dropping attitude all the way to -100. Counted via 'fight' since /kick was
// retired in favor of the Драка mini-game; old historical 'kick' rows simply
// age out of the rolling window like any other.
function isFrequentArguer(userId) {
  const windowSeconds = getSettingNumber('frequent_arguer_window_hours') * 3600;
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM troll_actions WHERE user_id = ? AND action = 'fight' AND created_at >= ?"
  ).get(userId, since);
  return row.n >= getSettingNumber('frequent_arguer_kick_threshold');
}

// Rolled at every tease-comeback call site, before the normal reply — a
// frequent arguer sometimes gets just a bare 🖕 or a GIF from the curated
// troll_gifs pool (see the admin-chat animation listener below) instead of
// the usual tease phrase. Returns true when it fired, so callers know to
// skip their normal reply.
function maybeSendFuckReaction(chatId, userId) {
  if (!isFrequentArguer(userId)) return false;
  if (Math.random() * 100 >= getSettingNumber('frequent_arguer_fuck_chance')) return false;
  const gifs = db.prepare("SELECT file_id FROM troll_gifs WHERE category = 'fuck'").all();
  if (gifs.length > 0 && Math.random() < 0.5) {
    bot.sendAnimation(chatId, pick(gifs).file_id).catch(() => {});
  } else {
    bot.sendMessage(chatId, '🖕').catch(() => {});
  }
  return true;
}

// --- Learned phrases ("сказать") ---
// Deliberately unmoderated free text, taught by any user via /teach or by
// replying directly to something the troll said. Replayed verbatim later at
// random, addressed to whoever happens to be talking at the time.
function learnPhrase(text, from) {
  db.prepare(
    'INSERT INTO troll_learned_phrases (text, taught_by_user_id, taught_by_username) VALUES (?, ?, ?)'
  ).run(text, from.id, from.username || from.first_name);
  logAction(from.id, from.username || from.first_name, 'teach');
}

// --- Growth ---
const STAGE_NAMES = { 1: 'малыш', 2: 'молодой', 3: 'взрослый', 4: 'старый' };
const STAGE_HEALTH_REGEN_KEYS = {
  1: 'health_regen_baby',
  2: 'health_regen_young',
  3: 'health_regen_adult',
  4: 'health_regen_old',
};

function moodWord(mood) {
  if (mood >= 70) return 'весёлый';
  if (mood >= 40) return 'нормальный';
  if (mood >= 15) return 'грустный';
  return 'злой';
}

function satietyWord(satiety) {
  if (satiety >= 90) return 'объевшийся';
  if (satiety >= 50) return 'сытый';
  if (satiety >= 30) return 'голодный';
  return 'очень голодный';
}

function attitudeWord(attitude) {
  if (attitude >= 60) return 'обожает';
  if (attitude >= 20) return 'любит';
  if (attitude >= -19) return 'нейтрально';
  if (attitude >= -59) return 'недолюбливает';
  return 'ненавидит';
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

// Known-imperfect on purpose: pronoun substitution now correctly matches
// Cyrillic word boundaries via lookaround (see wordRegex above), but the verb
// heuristic will still occasionally mangle irregular verbs or unrelated words
// that share a common personal-verb ending. Accepted trade-off per design doc.
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

// Shared by triggerMischief's targeted-action branch and /troll_say's "/try"
// prefix — the troll rolls its own dice rather than relying on another bot
// to see and process a "/try" message (Telegram doesn't deliver messages
// authored by one bot to another bot's updates).
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

function rollTrollTry(action) {
  return rollTrollTryResult(action).text;
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

// Current-activity line for the /troll card: sulking (post-kick silence) beats
// regen sleep, which beats ordinary night sleep, which beats a random
// "awake" flavor line — same precedence order used everywhere else silence/
// sleep interact (silence = total override).
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
  if (isDrunk(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.drunk_until * 1000 - Date.now()) / 60000));
    return `пьяный в стельку, злой на всех (ещё ~${minutesLeft} мин)`;
  }
  return pickPhraseForStage('activity_awake', state.stage, 'бродит под мостом');
}

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
        { text: '🍻 Бухать', callback_data: 'troll_drink' },
      ],
    ],
  },
};

// All-time activity totals, shown as the /troll photo's caption only while
// cocooned (see backgroundTick's freeze and admin-server.js's /cocoon-enter/
// -exit) — same category set as admin-server.js's per-stage report, just
// scoped to the troll's whole life (since born_at, not stage_started_at)
// and without the per-person breakdown, since this is a quick glance during
// stasis, not an audit. Admin-server.js is a separate process and can't
// require this file (see admin-lib.js's file-level comment on why), so this
// is intentionally a standalone duplicate of that aggregation shape rather
// than a shared function.
// Fixed personality write-up derived from a real read of this troll's
// all-time stats (see docs/superpowers/specs/2026-07-30-troll-stage2-perevoploschenie-design.md) —
// a frozen character bio for "who he turned out to be" by this point in his
// life, not something recomputed live from the numbers each time.
const TROLL_CHARACTER_SUMMARY = [
  '🧬 Характер:',
  'Избалованный обжора — его перекармливают чаще, чем он ест сам.',
  'Острый на язык: огрызается на всех и каждого больше, чем делает что-либо ещё.',
  'Любит внимание — играют и дразнят его охотно, показов сиськи тоже хватает.',
  'Нахватался фраз от чата — попугайничает много и разнообразно.',
  'Спит крепко: будят его пораньше очень редко.',
].join('\n');

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
    `🚫 Отказано сытому: ${totalFor('feed_reject')}`,
    `👢 Пинков: ${totalFor('kick')}`,
    `😈 Дразнилок: ${totalFor('tease')}`,
    `🍈 Показов сиськи: ${totalFor('boobs')}`,
    `😏 Огрызнулся: ${totalFor('snapped_at')}`,
    `😴 Разбудили раньше времени: ${totalFor('woke_troll')}`,
    `🎯 Дотроллил: ${totalFor('mischief_targeted')}`,
    `💦 Описал: ${totalFor('pee_target')}`,
    `💩 В какашку попали: ${totalFor('poop_victim')}`,
    `📖 Выучено фраз: ${totalFor('teach')}`,
    `— — —`,
    `💩 Покакал: ${totalFor('poop')}`,
    `💦 Пописал: ${totalFor('pee')}`,
    `🍽️ Поел сам: ${totalFor('self_eat')}`,
    `😳 Не сдержался от похоти: ${totalFor('lust_action')}`,
    `💋 Похоть: ${state.char_lust}/100`,
    `🍻 Бухал: ${totalFor('drink')}`,
    `🏏 Дубинкой в запое: ${totalFor('drunk_attack')}`,
    `🐕 Атаковано по "Фас": ${totalFor('fas_attack')}`,
    `🍺 Трезвость: ${state.char_sobriety}/100`,
    '',
    TROLL_CHARACTER_SUMMARY,
  ].join('\n');
}

bot.onText(/\/troll\b/, async (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id && msg.chat.id !== ADMIN_CHAT_ID) return;
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

bot.onText(/\/troll_character\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id && msg.chat.id !== ADMIN_CHAT_ID) return;
  const lines = [
    '🎭 Характер тролля:',
    `🍽️ Аппетит: ${state.char_appetite}/100`,
    `🎈 Игривость: ${state.char_playfulness}/100`,
    `😡 Злость: ${state.char_anger}/100`,
    `💋 Похоть: ${state.char_lust}/100`,
    `😈 Вредность: ${state.char_naughtiness}/100`,
    `🍺 Трезвость: ${state.char_sobriety}/100`,
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// --- Public commands: play / fight / feed ---
// Extracted from the command handlers so the /troll card's inline buttons
// (and the callback_query handler below) can trigger the exact same logic
// as typing /play, /feed, /fight — only chatId/from are actually used by any
// of these, so a callback_query's message.chat/from line up just as well.
function actorName(from) {
  return from.username ? `@${from.username}` : from.first_name;
}

// Shared by every non-kick direct interaction while regen_sleep_started_at
// is set (see backgroundTick/handleRegenSleepTick) — the troll doesn't wake
// for anything except a landed kick, it just snores through it.
const REGEN_SLEEP_SNORE_REPLY = '*тихо похрапывает под мостом, восстанавливая силы*';

// Shared by every direct interaction while cocoon_started_at is set (see
// backgroundTick's freeze and admin-server.js's /cocoon-enter/-exit) — takes
// priority over every other guard (is_asleep, regen_sleep_started_at), since
// the cocoon is a total stasis, not just another sleep state.
const COCOON_REPLY = '🥚 Тролль сейчас в коконе, ему не до тебя...';

// Per-user, per-command anti-spam — in-memory only (a rate limiter doesn't
// need to survive a restart). Silently drops the repeat instead of
// replying "not so fast", since a bot reply to spam is itself more spam.
const commandCooldowns = new Map();

function checkCommandCooldown(userId, command) {
  const key = `${userId}:${command}`;
  const cooldownMs = getSettingNumber('command_cooldown_seconds') * 1000;
  const last = commandCooldowns.get(key);
  if (last && Date.now() - last < cooldownMs) return false;
  commandCooldowns.set(key, Date.now());
  return true;
}

// Note: isSilenced (previously a 1-hour window set after a landed /kick)
// intentionally does NOT gate these three — being "silenced" only suppresses
// autonomous mischief (checked separately in backgroundTick and the message
// handler), not direct interaction. The troll always reacts to /play, /feed,
// /fight regardless of how recently it was hit — moot in practice now, since
// performFight (which replaced performKick) never sets silenced_until, so
// this window no longer opens at all.
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.cocoon_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep && !isAdminTestChat) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10), char_playfulness = MIN(100, char_playfulness + 6), char_anger = MAX(0, char_anger - 4) WHERE id = 1').run();
  logAction(from.id, from.username || from.first_name, 'play');
  noticeUser(from.id, from.username, from.first_name);
  adjustAttitude(from.id, getSettingNumber('attitude_play_delta'));
  checkMamaPromotion(chatId, from.id);
  sendCategoryReplyForStage(chatId, mamaCategoryOverride(state, from.id, 'play'), state.stage, 'Моя рада играть с твоя!', actorName(from), from.id);
}

// async + awaited sends throughout: without awaiting, two fire-and-forget
// sendMessage calls issued back-to-back race over the network and can
// arrive at Telegram (and so appear in the chat) in either order — the
// roll message must visibly land before whatever response follows it.
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
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
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
  if (challengerHealth.energy === 0) {
    await bot.sendMessage(chatId, `${actorName(from)}, нет энергии на удар — отдохни (⚡ 1 за 20 мин).`).catch(() => {});
    return;
  }
  const fightLimit = getSettingNumber('fight_daily_limit');
  if (!isAdminTestChat && getFightAttemptsToday(from.id) >= fightLimit) {
    await bot.sendMessage(chatId, `${actorName(from)}, на сегодня хватит драк с троллем (лимит ${fightLimit}/день)!`).catch(() => {});
    return;
  }

  if (!checkCommandCooldown(from.id, 'fight')) return;

  if (state.cocoon_started_at && !isAdminTestChat) {
    await bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    await bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }

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

// Shared by performFeed's normal/overeating branches and the autonomous
// self-eat tick (triggerAutoEat) — same mood/satiety/weight effects
// regardless of whether the troll was fed or found food on its own.
function applyEatStats(overeating) {
  const satietyGain = getSettingNumber('satiety_feed_gain');
  const weightGain = getSettingNumber('weight_gain_per_feed');
  if (overeating) {
    db.prepare(
      'UPDATE troll_state SET mood = MIN(100, mood + 5), satiety = MIN(100, satiety + ?), weight = MIN(500, weight + ?), char_appetite = MIN(100, char_appetite + 6) WHERE id = 1'
    ).run(satietyGain, weightGain);
  } else {
    db.prepare(
      'UPDATE troll_state SET mood = MIN(100, mood + 5), satiety = MIN(100, satiety + ?), weight = MIN(500, weight + ?) WHERE id = 1'
    ).run(satietyGain, weightGain);
  }
}

function performFeed(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.cocoon_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep && !isAdminTestChat) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
  // Completely full (satiety 100): the only case rejected outright — the
  // troll throws the food back instead of eating it, and it costs the
  // feeder some attitude for not noticing. Nothing else changes.
  if (state.satiety >= 100) {
    logAction(from.id, from.username || from.first_name, 'feed_reject');
    noticeUser(from.id, from.username, from.first_name);
    const oldAttitude = adjustAttitude(from.id, getSettingNumber('attitude_feed_reject_delta'));
    checkEnemyDeclaration(chatId, from, oldAttitude);
    sendCategoryReplyForStage(chatId, 'feed_reject', state.stage, 'Моя сытый! *кидает еда в твоя*', actorName(from), from.id);
    return;
  }
  // Satiety 90-99: still eats, but it's overeating — same stat gains, plus
  // it grows the troll's appetite trait (a lasting personality effect, not
  // a momentary one like mood/health). Health is deliberately NOT bumped
  // here anymore — it's governed purely by the satiety<30 decay / per-stage
  // regen tick now (see backgroundTick), so eating keeps satiety up rather
  // than directly patching health.
  const overeating = state.satiety >= 90;
  const newFeedCount = state.feed_count + 1;
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE troll_state SET feed_count = ?, last_fed_at = ? WHERE id = 1').run(newFeedCount, now);
  applyEatStats(overeating);
  logAction(from.id, from.username || from.first_name, overeating ? 'feed_overeat' : 'feed');
  noticeUser(from.id, from.username, from.first_name);
  adjustAttitude(from.id, getSettingNumber('attitude_feed_delta'));
  checkMamaPromotion(chatId, from.id);
  if (overeating) {
    sendCategoryReplyForStage(chatId, mamaCategoryOverride(state, from.id, 'feed_overeat'), state.stage, 'Ммм, моя переедать, но моя не мочь остановиться...', actorName(from), from.id);
  } else {
    sendCategoryReplyForStage(chatId, mamaCategoryOverride(state, from.id, 'feed'), state.stage, 'Ням-ням, спасибо твоя!', actorName(from), from.id);
  }
}

function performTease(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.cocoon_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
  if (state.is_asleep && !isAdminTestChat) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10), char_anger = MIN(100, char_anger + 8) WHERE id = 1').run();
  logAction(from.id, from.username || from.first_name, 'tease');
  noticeUser(from.id, from.username, from.first_name);
  if (!maybeSendFuckReaction(chatId, from.id)) {
    sendCategoryReplyForStage(chatId, mamaCategoryOverride(state, from.id, resolveTeaseCategory(from.id)), state.stage, 'Твоя дразнить моя?! Моя злиться!', actorName(from), from.id);
  }
}

// малыш sees it as food (the joke the whole feature started from); the
// reaction "matures" alongside the troll's growth stage after that. Every
// stage raises lust the same amount — only the flavor text differs.
const BOOBS_CATEGORY_BY_STAGE = { 1: 'boobs_baby', 2: 'boobs_teen', 3: 'boobs_young', 4: 'boobs_adult' };

function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  if (state.cocoon_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }
  noticeUser(from.id, from.username, from.first_name);
  // Only a KNOWN male gets turned away — unknown gender (not yet detected,
  // see detectAndStoreGender) still goes through normally, so new users
  // aren't punished before the troll has had a chance to guess.
  const rel = db.prepare('SELECT gender FROM troll_relationships WHERE user_id = ?').get(from.id);
  if (rel && rel.gender === 'male') {
    sendCategoryReply(chatId, 'boobs_male_reject', 'Твоя же не девушка! У твоя нет что показать!', actorName(from), from.id);
    return;
  }
  const category = BOOBS_CATEGORY_BY_STAGE[state.stage] || 'boobs_baby';
  const lustGain = getSettingNumber('lust_gain_per_boobs');
  db.prepare('UPDATE troll_state SET char_lust = MIN(100, char_lust + ?) WHERE id = 1').run(lustGain);
  logAction(from.id, from.username || from.first_name, 'boobs');
  sendCategoryReply(chatId, mamaCategoryOverride(state, from.id, category), 'Моя видеть еда!', actorName(from), from.id);
}

// "Бухать с тролем" — 60% good session (mood+attitude up), 30% argument
// (mood down), 5% the troll beats you up (3 guaranteed hits, same weapon/
// body-part pools and crit-injury rule as Драка's counter-swing, just with
// no dodge roll — you're too drunk to avoid it), 5% befriend (a bigger
// mood+attitude boost than the plain good outcome). Every session also
// drains char_sobriety; crossing sobriety_drunk_threshold (and not already
// drunk) starts the 1h "пьяный" debuff and sobers back up to 100. Also: on
// exactly your 5th lifetime drink with the troll, if you're currently its
// enemy, that's forgiven outright (is_enemy cleared, attitude reset to 0) —
// separate from the random "befriend" outcome above.
async function performDrink(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const isAdminTestChat = chatId === ADMIN_CHAT_ID;
  if (!state || (chatId !== state.chat_id && !isAdminTestChat)) return;
  if (!tgBotDb) {
    await bot.sendMessage(chatId, 'Бухать сейчас не с кем.').catch(() => {});
    return;
  }
  const challengerHealth = getUserHealth(from.id);
  if (challengerHealth.health === 0) {
    await bot.sendMessage(chatId, `${actorName(from)}, твоя в отключке, какая выпивка!`).catch(() => {});
    return;
  }
  if (!checkCommandCooldown(from.id, 'drink')) return;
  if (state.cocoon_started_at && !isAdminTestChat) {
    await bot.sendMessage(chatId, COCOON_REPLY).catch(() => {});
    return;
  }
  if (state.regen_sleep_started_at && !isAdminTestChat) {
    await bot.sendMessage(chatId, REGEN_SLEEP_SNORE_REPLY).catch(() => {});
    return;
  }

  noticeUser(from.id, from.username, from.first_name);
  logAction(from.id, from.username || from.first_name, 'drink');

  const roll = Math.random() * 100;
  if (roll < 60) {
    db.prepare('UPDATE troll_state SET mood = MIN(100, mood + ?) WHERE id = 1').run(getSettingNumber('mood_drink_good_delta'));
    adjustAttitude(from.id, getSettingNumber('attitude_drink_good_delta'));
    await bot.sendMessage(chatId, `🍻 ${actorName(from)} с троллем хорошо посидели — настроение и отношение выросли!`).catch(() => {});
  } else if (roll < 90) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - ?) WHERE id = 1').run(getSettingNumber('mood_drink_bad_delta'));
    await bot.sendMessage(chatId, `🍻 ${actorName(from)} поссорился с троллем по пьяни — настроение упало.`).catch(() => {});
  } else if (roll < 95) {
    await bot.sendMessage(chatId, `🍻 ${actorName(from)} перебрал — тролль дал пиздюлей!`).catch(() => {});
    for (let i = 0; i < 3; i++) {
      const weapon = pick(FIGHT_WEAPONS);
      const bodyPart = pick(FIGHT_BODY_PARTS);
      const critRoll = Math.floor(Math.random() * 101);
      await bot.sendMessage(chatId, `Тролль — ударить ${actorName(from)} ${weapon} ${bodyPart} ✅ удачно: ${critRoll}/100`).catch(() => {});
      const dmg = Math.floor(Math.random() * 20) + 1;
      const before = getUserHealth(from.id);
      const after = damageHuman(from.id, chatId, from.username || from.first_name, dmg);
      await bot.sendMessage(chatId, `💥 Урон ${actorName(from)}: ${dmg} (${before.health} -> ${after})`).catch(() => {});
      if (critRoll >= 90) {
        const injuryType = INJURY_TYPES[Math.floor(Math.random() * INJURY_TYPES.length)];
        const healHours = applyInjury(from.id, injuryType);
        const injuryName = injuryType === 'arm' ? 'рука' : injuryType === 'leg' ? 'нога' : 'голова';
        await bot.sendMessage(chatId, `🤕 Критический удар! ${actorName(from)} получить травму: ${injuryName} (на ${healHours} ч).`).catch(() => {});
      }
      if (after === 0) break;
    }
  } else {
    db.prepare('UPDATE troll_state SET mood = MIN(100, mood + ?) WHERE id = 1').run(getSettingNumber('mood_drink_friend_delta'));
    adjustAttitude(from.id, getSettingNumber('attitude_drink_friend_delta'));
    await bot.sendMessage(chatId, `🍻 ${actorName(from)} и тролль спились в дым и стали лучшими друзьями!`).catch(() => {});
  }

  const drinkCount = db.prepare(
    "SELECT COUNT(*) AS n FROM troll_actions WHERE user_id = ? AND action = 'drink'"
  ).get(from.id).n;
  if (drinkCount === 5 && isEnemy(from.id)) {
    db.prepare('UPDATE troll_relationships SET is_enemy = 0, attitude = 0 WHERE user_id = ?').run(from.id);
    await bot.sendMessage(chatId, `🤝 ${actorName(from)} и тролль бухали вместе уже 5 раз — тролль больше не держит зла, вы снова никто друг другу.`).catch(() => {});
  }

  const sobrietyLoss = getSettingNumber('sobriety_loss_per_drink');
  const newSobriety = db.prepare(
    'UPDATE troll_state SET char_sobriety = MAX(0, char_sobriety - ?) WHERE id = 1 RETURNING char_sobriety'
  ).get(sobrietyLoss).char_sobriety;
  if (!isDrunk(state) && newSobriety <= getSettingNumber('sobriety_drunk_threshold')) {
    const durationMinutes = getSettingNumber('drunk_duration_minutes');
    const drunkUntil = Math.floor(Date.now() / 1000) + durationMinutes * 60;
    db.prepare('UPDATE troll_state SET drunk_until = ?, char_sobriety = 100 WHERE id = 1').run(drunkUntil);
    await bot.sendMessage(chatId, `🥴 Тролль совсем набрался! Теперь он злой на всех, пока не протрезвеет (~${durationMinutes} мин).`).catch(() => {});
  }
}

bot.onText(/\/play\b/, (msg) => {
  performPlay(msg.chat.id, msg.from);
});

bot.onText(/\/fight\b/, (msg) => {
  performFight(msg.chat.id, msg.from);
});

bot.onText(/\/feed\b/, (msg) => {
  performFeed(msg.chat.id, msg.from);
});

bot.onText(/\/tease\b/, (msg) => {
  performTease(msg.chat.id, msg.from);
});

bot.onText(/\/boobs\b/, (msg) => {
  performBoobs(msg.chat.id, msg.from);
});

bot.onText(/\/drink\b/, (msg) => {
  performDrink(msg.chat.id, msg.from);
});

// Explicit alternative to the passive "reply to the troll" teach path (see
// the message handler below) — either works the same way.
bot.onText(/\/teach ([\s\S]+)/, (msg, match) => {
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id) return;
  if (!checkCommandCooldown(msg.from.id, 'teach')) return;
  const text = match[1].trim();
  if (!text) return;
  learnPhrase(text, msg.from);
  bot.sendMessage(msg.chat.id, `${actorName(msg.from)} научил тролля фразе: "${text}"`).catch(() => {});
});

// "Тролль Фас <@цель>" / "тролль фас" as a reply — no slash needed, any
// case, tolerates both "троль" and "тролль". Only usable by people the
// troll adores (tease_adoring tier, attitude >= 70); everyone else gets a
// dismissive rhyme instead. On success, targeted mischief focuses on that
// one person for 30 minutes (see getFasTargetInfo/triggerMischief).
const TROLL_FAS_REGEX = /(?:^|\s)тролл?ь\s+фас(?:\s+@?(\S+))?/i;

bot.onText(TROLL_FAS_REGEX, async (msg, match) => {
  const state = db.prepare('SELECT chat_id, cocoon_started_at FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id) return;
  if (!checkCommandCooldown(msg.from.id, 'fas')) return;
  if (state.cocoon_started_at) {
    await bot.sendMessage(msg.chat.id, COCOON_REPLY).catch(() => {});
    return;
  }

  if (pickTeaseCategory(msg.from.id) !== 'tease_adoring') {
    bot.sendMessage(
      msg.chat.id,
      `${actorName(msg.from)}, твоя мне не указ, вали отсюда сейчас!`,
      { reply_to_message_id: msg.message_id }
    ).catch(() => {});
    return;
  }

  let target = null;
  if (msg.reply_to_message && msg.reply_to_message.from) {
    target = {
      userId: msg.reply_to_message.from.id,
      username: msg.reply_to_message.from.username,
      firstName: msg.reply_to_message.from.first_name,
    };
  } else if (match[1]) {
    const handle = match[1].replace(/^@/, '');
    const row = db.prepare(
      'SELECT user_id, username, first_name FROM troll_relationships WHERE LOWER(username) = LOWER(?)'
    ).get(handle);
    if (row) {
      target = { userId: row.user_id, username: row.username, firstName: row.first_name };
    } else {
      // Best-effort fallback for someone the troll has never seen — only
      // works if Telegram considers the username resolvable to this bot.
      try {
        const chat = await bot.getChat('@' + handle);
        target = { userId: chat.id, username: chat.username, firstName: chat.first_name };
      } catch {}
    }
  }

  if (!target) {
    bot.sendMessage(msg.chat.id, 'Моя не понимать, кого травить — укажи @юзернейм или ответь на его сообщение.').catch(() => {});
    return;
  }

  // Mama is off-limits even to an explicit "Фас" order from someone the
  // troll otherwise adores — this is the one deliberate way someone could
  // otherwise sic the troll on her.
  if (isMama(target.userId)) {
    bot.sendMessage(msg.chat.id, 'Не-не-не! Моя никогда не обижать мама, даже если твоя просить! 💕').catch(() => {});
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE troll_state SET troll_fas_until = ?, troll_fas_target_user_id = ? WHERE id = 1').run(now + 30 * 60, target.userId);
  // Using the troll like an attack dog costs a little of its fondness even
  // from someone it adores.
  adjustAttitude(msg.from.id, getSettingNumber('attitude_fas_delta'));
  const targetName = target.username ? `@${target.username}` : target.firstName;
  bot.sendMessage(msg.chat.id, `🐕 ${actorName(msg.from)} скомандовал троллю "Фас!" на ${targetName} — 30 минут не будет покоя, тролль будет бить раз в минуту, пока хватает энергии!`).catch(() => {});
});

// Buttons on the /troll status card (callback_data-type inline buttons work
// fine in groups, unlike web_app buttons — that restriction only applies to
// the Mini App admin panel's link, not these).
bot.on('callback_query', (query) => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  if (query.data === 'troll_play') performPlay(chatId, query.from);
  else if (query.data === 'troll_feed') performFeed(chatId, query.from);
  else if (query.data === 'troll_fight') performFight(chatId, query.from);
  else if (query.data === 'troll_tease') performTease(chatId, query.from);
  else if (query.data === 'troll_boobs') performBoobs(chatId, query.from);
  else if (query.data === 'troll_drink') performDrink(chatId, query.from);
  else return;
  bot.answerCallbackQuery(query.id).catch(() => {});
});

// --- Autonomous mischief ---
// Stage caps how serious mischief can get, regardless of mood/naughtiness:
// малыш (1) never goes past mild, подросток (2) never past medium, молодой/
// взрослый (3-4) can reach the full mean tier. Tiers: 0=mild, 1=medium, 2=mean.
const STAGE_MAX_MISCHIEF_TIER = { 1: 0, 2: 1, 3: 2, 4: 2 };
const MISCHIEF_TIER_CATEGORIES = ['mischief_mild', 'mischief_medium', 'mischief_mean'];

function getMischiefTier(mood, naughtiness, stage, drunk) {
  const maxTier = STAGE_MAX_MISCHIEF_TIER[stage] ?? 2;
  // Drunk forces the harshest tier the stage still allows — "злой на всех"
  // overrides mood/naughtiness, but not the age-appropriateness cap (a baby
  // -stage troll doesn't jump to full "mean" content just because it drank).
  if (drunk) return maxTier;
  const score = naughtiness - Math.floor(mood / 20);
  let tier = 0;
  if (score >= 7) tier = 2;
  else if (score >= 4) tier = 1;
  return Math.min(tier, maxTier);
}

function maybeRememberedUser() {
  const row = db.prepare('SELECT username FROM troll_actions ORDER BY RANDOM() LIMIT 1').get();
  return row ? row.username : null;
}

// --- Targeted mischief (recent chat participants) ---
// Tracks the last few ordinary (non-bot, non-command) senders in the troll's
// home chat, in memory only — not persisted, purely for picking a live
// "victim" for targeted mischief. Separate from troll_actions (which only
// logs /play, /fight, /feed) and from maybeRememberedUser above, which still
// draws from that older history for the existing detached-mischief aside.
const RECENT_MESSAGES_MAX = 10;
let recentMessages = [];

function pushRecentMessage(entry) {
  recentMessages.push(entry);
  if (recentMessages.length > RECENT_MESSAGES_MAX) recentMessages.shift();
}

// Enemy status is a stored flag, permanent once earned (see
// checkEnemyDeclaration) — attitude recovering later does NOT lift it.
function isEnemy(userId) {
  const row = db.prepare('SELECT is_enemy FROM troll_relationships WHERE user_id = ?').get(userId);
  return !!row && !!row.is_enemy;
}

function findEnemyAmong(entries) {
  return entries.find((entry) => isEnemy(entry.userId)) || null;
}

// Every mention anywhere (mischief, hungry grab, pee) routes through this,
// so an enemy is always called out as one, everywhere, automatically.
function getMentionName(entry) {
  const name = entry.username ? `@${entry.username}` : entry.firstName;
  if (isEnemy(entry.userId)) return `мой враг ${name} 🖕`;
  if (isMama(entry.userId)) return `❤️ мама ${name} 💕`;
  return name;
}

// Weighted pick from recentMessages: the more a person is disliked, the more
// likely they are to be chosen as a mischief target (weight = 100 - attitude),
// floored at 10 so even a beloved (+100) person can still occasionally be
// picked, never dropping to zero chance. Mama is the one exception — she's
// filtered out entirely before weighting, not just floored, since she's a
// singular permanent role rather than an ordinary beloved user. Returns null
// if that leaves nobody eligible; every caller must handle that (fall back
// to an untargeted flavor, don't assume a target always comes back).
function pickMischiefTarget() {
  const eligible = recentMessages.filter((entry) => !isMama(entry.userId));
  if (eligible.length === 0) return null;
  const candidates = eligible.map((entry) => {
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

// High-lust autonomous action target: any known female relationship who
// loves the troll back (attitude >= 70, same tier as pickTeaseCategory's
// 'tease_adoring' and "Тролль Фас" eligibility) — never mama, same
// exemption as pickMischiefTarget. Deliberately NOT limited to recentMessages
// (unlike pickMischiefTarget) — a strong relationship doesn't expire just
// because someone hasn't spoken in the last few messages. Returns null if
// nobody currently qualifies; the caller just skips this tick and tries
// again next time (see triggerLustAction).
function pickLustTarget() {
  const candidates = db.prepare(
    'SELECT user_id, username, first_name FROM troll_relationships WHERE gender = ? AND attitude >= 70'
  ).all('female').filter((row) => !isMama(row.user_id));
  if (candidates.length === 0) return null;
  const row = candidates[Math.floor(Math.random() * candidates.length)];
  return { userId: row.user_id, username: row.username, firstName: row.first_name };
}

// Fires once char_lust crosses lust_trigger_threshold (see backgroundTick) —
// unlike mischief/pee/poop this doesn't roll a dice, it just happens once a
// qualifying target is found. Resets char_lust to 0 and stamps
// last_lust_action_at only when it actually fires, so a threshold-crossed-
// but-nobody-around tick doesn't block the very next attempt.
function triggerLustAction(chatId, stage, now) {
  const target = pickLustTarget();
  if (!target) return;
  const name = getMentionName(target);
  const template = pickPhraseForStage('lust_action', stage, 'подсмотреть за {user} и не сдержаться');
  const sticker = Math.random() < 0.5 ? pickStickerForStage('lust_action', stage) : null;
  if (sticker) bot.sendSticker(chatId, sticker.fileId).catch(() => {});
  if (!sticker || !sticker.hasOwnText) {
    bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, name)}*`).catch(() => {});
  }
  db.prepare('UPDATE troll_state SET char_lust = 0, last_lust_action_at = ? WHERE id = 1').run(now);
  logAction(target.userId, target.username || target.firstName, 'lust_action');
}

// While drunk (see isDrunk/performDrink), the troll autonomously clubs a
// random known person every drunk_attack_interval_minutes — same roll/
// damage/crit-injury rules as Драка's counter-swing (rollTrollTryResult,
// 1-20 damage, roll>=90 injury), just a fixed "дубинка" instead of a random
// weapon, and no dodge attempt from the target (they didn't ask for this).
// Target picked the same weighted-random way as ordinary mischief (mama
// excluded); stamps last_drunk_attack_at even on a miss so a string of
// misses doesn't retry every tick.
function triggerDrunkAttack(chatId, now) {
  if (!tgBotDb) return;
  const targetInfo = pickMischiefTarget();
  if (!targetInfo) return;
  // No energy: skip this tick's club swing, same "quietly retry next tick"
  // idiom as a missing target (see triggerFasAttack).
  if (spendTrollEnergy() === null) return;
  const target = targetInfo.entry;
  const name = getMentionName(target);
  db.prepare('UPDATE troll_state SET last_drunk_attack_at = ? WHERE id = 1').run(now);
  logAction(target.userId, target.username || target.firstName, 'drunk_attack');
  bot.sendMessage(chatId, `🥴 Бухому троллю не понравилось, как на него посмотрел ${name}!`).catch(() => {});
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

// Tiered category names [mild, medium, mean] — indexed the same way as getMischiefTier.
const TARGETED_PHRASE_TIER_CATEGORIES = ['targeted_phrase_mild', 'targeted_phrase_medium', 'targeted_phrase_mean'];
const TARGETED_ACTION_TIER_CATEGORIES = ['targeted_action_mild', 'targeted_action_medium', 'targeted_action_mean'];

// "Тролль Фас" override (see the onText handler further down) — while
// active, targeted mischief always aims at this one person instead of the
// normal weighted-random pick. Same {entry, attitude} shape as
// pickMischiefTarget so it can be dropped in directly.
function getFasTargetInfo(state) {
  const now = Math.floor(Date.now() / 1000);
  if (!state.troll_fas_until || state.troll_fas_until < now || !state.troll_fas_target_user_id) return null;
  // Defense in depth: the onText handler already refuses to start a "Фас"
  // order against mama, but this also covers the rare case where the
  // target gets promoted to mama (via someone else's /play or /feed) while
  // an order against them is already running.
  if (isMama(state.troll_fas_target_user_id)) return null;
  const row = db.prepare(
    'SELECT user_id, username, first_name, attitude FROM troll_relationships WHERE user_id = ?'
  ).get(state.troll_fas_target_user_id);
  if (!row) return null;
  return { entry: { userId: row.user_id, username: row.username, firstName: row.first_name }, attitude: row.attitude };
}

// On top of getFasTargetInfo's mischief-prioritization above, "Тролль Фас"
// also throws an actual attack at the target every minute (fixed cadence,
// gated by spendTrollEnergy) for as long as the fas window is running —
// same roll/damage/crit-injury rules as Драка's counter-swing
// (rollTrollTryResult, 1-20 damage, roll>=90 injury), no dodge attempt from
// the target. Stamps last_fas_attack_at even on a miss so a string of
// misses doesn't retry every tick.
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

function triggerMischief(chatId) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const stage = state.stage;
  const tier = getMischiefTier(state.mood, getSettingNumber('naughtiness'), stage, isDrunk(state));
  // The admin's naughtiness slider still drives how mischievous the troll
  // acts (unchanged); this just lets the character trait of the same name
  // reflect how much mischief it's actually gotten up to, growing more per
  // meaner tier. Purely cosmetic/display for now — nothing reads it back.
  db.prepare('UPDATE troll_state SET char_naughtiness = MIN(100, char_naughtiness + ?) WHERE id = 1').run(tier + 1);

  // Priority: an explicit "Тролль Фас" order first, then an enemy present
  // in the chat gets picked with certainty (not just favored by weight) —
  // the whole point of having an enemy — falling back to the normal
  // weighted-random pick otherwise.
  const enemyEntry = findEnemyAmong(recentMessages);
  const fasTargetInfo = getFasTargetInfo(state);
  if (fasTargetInfo || enemyEntry || (recentMessages.length > 0 && Math.random() < 0.5)) {
    const targetInfo = fasTargetInfo || (enemyEntry ? { entry: enemyEntry, attitude: -100 } : pickMischiefTarget());
    // pickMischiefTarget can come back null (everyone recent is mama) —
    // falls through to the untargeted flavor below instead of crashing.
    if (targetInfo) {
      const target = getMentionName(targetInfo.entry);
      const escalationThreshold = getSettingNumber('attitude_escalation_threshold');
      const maxTier = STAGE_MAX_MISCHIEF_TIER[stage] ?? 2;
      const effectiveTier = targetInfo.attitude <= escalationThreshold ? Math.min(maxTier, tier + 1) : tier;
      logAction(targetInfo.entry.userId, targetInfo.entry.username || targetInfo.entry.firstName, 'mischief_targeted');
      if (Math.random() < 0.5) {
        const phraseCategory = TARGETED_PHRASE_TIER_CATEGORIES[effectiveTier];
        const sticker = Math.random() < 0.5 ? pickStickerForStage(phraseCategory, stage) : null;
        if (sticker) bot.sendSticker(chatId, sticker.fileId).catch(() => {});
        if (!sticker || !sticker.hasOwnText) {
          const template = pickPhraseForStage(phraseCategory, stage, 'подмигнул {user}');
          bot.sendMessage(chatId, `*${template.replace(/\{user\}/g, target)}*`).catch(() => {});
        }
      } else {
        const actionCategory = resolveTargetedActionCategory(targetInfo.entry.userId, TARGETED_ACTION_TIER_CATEGORIES[effectiveTier]);
        const template = pickPhraseForStage(actionCategory, stage, 'подшутить над {user}');
        const action = template.replace(/\{user\}/g, target);
        bot.sendMessage(chatId, rollTrollTry(action)).catch(() => {});
      }
      return;
    }
  }
  const mischiefCategory = MISCHIEF_TIER_CATEGORIES[tier];
  const sticker = Math.random() < 0.5 ? pickStickerForStage(mischiefCategory, stage) : null;
  if (sticker) bot.sendSticker(chatId, sticker.fileId).catch(() => {});
  if (!sticker || !sticker.hasOwnText) {
    const action = pickPhraseForStage(mischiefCategory, stage, 'шалит тихонько под мостом');
    let phrase = `*${action}*`;
    if (Math.random() < 0.3) {
      const rememberedUser = maybeRememberedUser();
      if (rememberedUser) phrase += ` (твоя как ${rememberedUser}, твоя тоже моя помнить!)`;
    }
    bot.sendMessage(chatId, phrase).catch(() => {});
  }
}

function triggerBegging(chatId, stage) {
  sendCategoryReplyForStage(chatId, 'hunger_beg', stage, 'Моя кушать хотеть! Кто-нибудь покормить моя?!', null);
}

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

// --- Digestion cycle: eat / poop / pee (all autonomous, independent ticks) ---
const WEIGHT_FLOOR = 30;

function triggerAutoEat(chatId, stage) {
  applyEatStats(false);
  logAction(0, 'тролль', 'self_eat');
  sendCategoryReplyForStage(chatId, 'self_eat', stage, 'Моя найти еда и скушать сама!', null);
}

// Candidate pool for the current poop mini-game, populated by the message
// handler while troll_state.poop_game_ends_at is in the future. In-memory
// only (like recentMessages) — a restart mid-game just quietly fizzles it,
// not worth persisting a whole participant list for.
const poopGameCandidates = new Map();

function triggerPoop(chatId) {
  const weightLoss = getSettingNumber('weight_loss_per_poop');
  const moodGain = getSettingNumber('poop_mood_gain');
  const gameEndsAt = Math.floor(Date.now() / 1000) + 3600;
  db.prepare(
    'UPDATE troll_state SET mood = MIN(100, mood + ?), weight = MAX(?, weight - ?), poop_game_ends_at = ? WHERE id = 1'
  ).run(moodGain, WEIGHT_FLOOR, weightLoss, gameEndsAt);
  poopGameCandidates.clear();
  logAction(0, 'тролль', 'poop');
  // Pure in-character flavor — deliberately doesn't mention the "whoever
  // writes next becomes a candidate" mechanic, so it reads as a surprise
  // later rather than a warning to stay quiet right now.
  bot.sendMessage(chatId, '💩 Моя покакать под мостом! Уф, стало легче...').catch(() => {});
}

// Called every backgroundTick regardless of paused/silenced — a running
// game clock shouldn't stall just because shalости are paused.
function resolvePoopGameIfDue(state, now) {
  if (!state.poop_game_ends_at || now < state.poop_game_ends_at) return;
  db.prepare('UPDATE troll_state SET poop_game_ends_at = NULL WHERE id = 1').run();
  const candidates = [...poopGameCandidates.values()];
  poopGameCandidates.clear();
  if (candidates.length === 0) return;
  // An enemy among the candidates loses with certainty — no dice needed,
  // the troll makes sure of it.
  const loser = findEnemyAmong(candidates) || candidates[Math.floor(Math.random() * candidates.length)];
  const name = getMentionName(loser);
  bot.sendMessage(state.chat_id, `💩 Ой-ой, ${name} вступить в моя какашка! Твоя теперь вонять целый час...`).catch(() => {});
  logAction(loser.userId, loser.username || loser.firstName, 'poop_victim');
  markSmelly(loser.userId, 3600, 'poop');
}

// Weighted random target (same pool/weighting as targeted mischief) half
// the time; ambient/untargeted the other half.
function triggerPee(chatId) {
  const weightLoss = getSettingNumber('weight_loss_per_pee');
  db.prepare('UPDATE troll_state SET weight = MAX(?, weight - ?) WHERE id = 1').run(WEIGHT_FLOOR, weightLoss);
  logAction(0, 'тролль', 'pee');
  const enemyEntry = findEnemyAmong(recentMessages);
  // pickMischiefTarget can return null (everyone recent is mama) — treated
  // the same as "didn't roll a target this time", not a crash.
  const targetInfo = enemyEntry
    ? { entry: enemyEntry }
    : (recentMessages.length > 0 && Math.random() < 0.5) ? pickMischiefTarget() : null;
  if (targetInfo) {
    const target = getMentionName(targetInfo.entry);
    bot.sendMessage(chatId, `💦 Моя метко пометить территория, заодно окатить ${target}!`).catch(() => {});
    logAction(targetInfo.entry.userId, targetInfo.entry.username || targetInfo.entry.firstName, 'pee_target');
    markSmelly(targetInfo.entry.userId, 3600, 'pee');
  } else {
    bot.sendMessage(chatId, '💦 Моя пометить территория под мостом.').catch(() => {});
  }
}

function isNightNow() {
  const hour = new Date().getHours();
  const start = getSettingNumber('sleep_start');
  const end = getSettingNumber('sleep_end');
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// Dropped from 5 minutes so "Тролль Фас" (see triggerFasAttack) can land a
// real attack every minute — every other timer below already gates itself
// with its own now-vs-lastAt check, so ticking more often just makes those
// more precise, it doesn't change their cadence.
const BACKGROUND_TICK_MS = 60 * 1000;

// Total regen-sleep ticks in a full nap, e.g. 60min/10min = 6.
function regenSleepTotalTicks() {
  return Math.floor(getSettingNumber('regen_sleep_duration_minutes') / getSettingNumber('regen_sleep_tick_minutes'));
}

// Advances (or finishes) an in-progress regen sleep. Runs on the same
// cadence as the rest of backgroundTick — floor(elapsed/tickLength)
// is resilient to that cadence not lining up exactly with the tick length,
// so ticks never get double-applied or skipped even if the two drift out of
// phase with each other.
function handleRegenSleepTick(state, now) {
  const tickSeconds = getSettingNumber('regen_sleep_tick_minutes') * 60;
  const totalTicks = regenSleepTotalTicks();
  const elapsedTicks = Math.min(Math.floor((now - state.regen_sleep_started_at) / tickSeconds), totalTicks);
  const healthPerTick = getSettingNumber('regen_sleep_health_per_tick');
  const weightLossPerTick = getSettingNumber('regen_sleep_weight_loss_per_tick');
  const newTicks = elapsedTicks - state.regen_sleep_ticks_applied;
  if (newTicks > 0) {
    db.prepare(
      'UPDATE troll_state SET health = MIN(max_health, health + ?), weight = MAX(?, weight - ?), regen_sleep_ticks_applied = ? WHERE id = 1'
    ).run(healthPerTick * newTicks, WEIGHT_FLOOR, weightLossPerTick * newTicks, elapsedTicks);
  }
  if (elapsedTicks >= totalTicks) {
    db.prepare('UPDATE troll_state SET regen_sleep_started_at = NULL, regen_sleep_ticks_applied = 0, last_regen_sleep_at = ? WHERE id = 1').run(now);
    bot.sendMessage(
      state.chat_id,
      `Моя выспаться под мостом! Похудеть на ${weightLossPerTick * totalTicks}кг, здоровье восстановить на ${healthPerTick * totalTicks}. Моя снова бодрый!`
    ).catch(() => {});
  }
}

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
  // (naturally) now — performFight (which replaced performKick) no longer
  // wakes the troll early — see the eligibility check further down for how
  // it starts.
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

  // A running poop-game clock resolves on schedule even while paused —
  // it's finishing something already started, not a new shalость.
  resolvePoopGameIfDue(state, now);

  if (getSetting('paused') !== '1' && !isSilenced(state)) {
    const intervalSeconds = getSettingNumber('mischief_interval_hours') * 3600;
    if (!state.last_mischief_at || now - state.last_mischief_at >= intervalSeconds) {
      triggerMischief(state.chat_id);
      db.prepare('UPDATE troll_state SET last_mischief_at = ? WHERE id = 1').run(now);
    }

    // Hunger-driven autonomous behavior: below 30 the troll gets aggressive
    // and tries to grab a random recent chat participant (rolled like any
    // other targeted mischief); between 30 and 49 it just begs the chat at
    // large. Both share one cooldown so they never fire back-to-back with
    // mischief spam — only the more severe branch runs when satiety is
    // low enough to qualify for both.
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

    // Autonomous eat/poop/pee — independent cooldowns, each fires on its
    // own schedule regardless of the others.
    const eatIntervalSeconds = getSettingNumber('eat_action_interval_minutes') * 60;
    if (state.satiety < 70 && (!state.last_eat_action_at || now - state.last_eat_action_at >= eatIntervalSeconds)) {
      triggerAutoEat(state.chat_id, state.stage);
      db.prepare('UPDATE troll_state SET last_eat_action_at = ? WHERE id = 1').run(now);
    }

    const poopIntervalSeconds = getSettingNumber('poop_action_interval_minutes') * 60;
    if (!state.poop_game_ends_at && (!state.last_poop_action_at || now - state.last_poop_action_at >= poopIntervalSeconds)) {
      triggerPoop(state.chat_id);
      db.prepare('UPDATE troll_state SET last_poop_action_at = ? WHERE id = 1').run(now);
    }

    const peeIntervalSeconds = getSettingNumber('pee_action_interval_minutes') * 60;
    if (!state.last_pee_action_at || now - state.last_pee_action_at >= peeIntervalSeconds) {
      triggerPee(state.chat_id);
      db.prepare('UPDATE troll_state SET last_pee_action_at = ? WHERE id = 1').run(now);
    }

    // High-lust action: no fixed roll like mischief above — it only fires
    // once char_lust crosses the threshold AND a qualifying target is found
    // (see pickLustTarget/triggerLustAction), so the cooldown is stamped
    // inside the trigger function itself, not here.
    const lustIntervalSeconds = getSettingNumber('lust_action_interval_minutes') * 60;
    if (
      state.char_lust > getSettingNumber('lust_trigger_threshold') &&
      (!state.last_lust_action_at || now - state.last_lust_action_at >= lustIntervalSeconds)
    ) {
      triggerLustAction(state.chat_id, state.stage, now);
    }

    // Drunk-only autonomous club attack (see triggerDrunkAttack) — separate
    // cooldown from every other autonomous action, only active while drunk.
    const drunkAttackIntervalSeconds = getSettingNumber('drunk_attack_interval_minutes') * 60;
    if (
      isDrunk(state) &&
      (!state.last_drunk_attack_at || now - state.last_drunk_attack_at >= drunkAttackIntervalSeconds)
    ) {
      triggerDrunkAttack(state.chat_id, now);
    }

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
  }
}

setInterval(backgroundTick, BACKGROUND_TICK_MS);

// --- Message-triggered mischief ---
bot.on('message', (msg) => {
  if (msg.from?.is_bot) return;
  if (msg.text && msg.text.startsWith('/')) return;
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id) return;
  // Cocoon is total stasis — skip everything below (recent-message
  // tracking, poop-game candidacy, the enemy-hide roll, passive teach-by-
  // reply, name-addressed comebacks, message-count mischief, learned-phrase
  // chatter). None of it should happen while frozen, and none of it needs
  // special-casing individually — one early return covers the whole handler.
  if (state.cocoon_started_at) return;
  pushRecentMessage({ userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  detectAndStoreGender(msg.from.id, msg.text);

  // Poop mini-game: while a game clock is running, anyone who writes
  // becomes a candidate to be randomly picked as the "loser" (see
  // resolvePoopGameIfDue in backgroundTick).
  const nowForGame = Math.floor(Date.now() / 1000);
  // Mama never enters the candidate pool at all — she can chat freely
  // during a running poop game without risk of becoming the "loser" (see
  // resolvePoopGameIfDue, which just fizzles if the pool ends up empty).
  if (state.poop_game_ends_at && nowForGame < state.poop_game_ends_at && !isMama(msg.from.id)) {
    poopGameCandidates.set(msg.from.id, { userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  }

  // Baby stage only: the troll is scared of a permanent enemy (see isEnemy)
  // — the moment they show up, it tries to hide, and on success
  // their kick button is blocked for an hour (same kick_blocked_until
  // column the kick-dodge mechanic already uses). Cooldown so a chatty
  // enemy doesn't trigger a hide-roll on every single message.
  if (state.stage === 1 && isEnemy(msg.from.id) && checkCommandCooldown(msg.from.id, 'enemy_fear')) {
    const hideRoll = rollTrollTryResult(`спрятаться от врага ${actorName(msg.from)}`);
    bot.sendMessage(msg.chat.id, hideRoll.text).catch(() => {});
    if (hideRoll.success) {
      db.prepare('UPDATE troll_relationships SET kick_blocked_until = ? WHERE user_id = ?').run(nowForGame + 3600, msg.from.id);
    }
  }

  // Passive alternative to /teach: replying directly to anything the troll
  // sent (a dialogue line or an autonomous mischief message) teaches it
  // that phrase — the troll immediately claps back with a tease/comeback
  // line instead of a dry confirmation. Runs regardless of paused/silenced/
  // night, since it's the user acting, not the troll.
  const repliedToTroll = !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === botUserId);
  if (repliedToTroll && msg.text && checkCommandCooldown(msg.from.id, 'teach')) {
    learnPhrase(msg.text, msg.from);
    logAction(msg.from.id, msg.from.username || msg.from.first_name, 'snapped_at');
    if (!maybeSendFuckReaction(msg.chat.id, msg.from.id)) {
      const comeback = appendRelationshipEmoji(
        pickPhraseForStage(resolveTeaseCategory(msg.from.id), state.stage, 'Твоя дразнить моя?! Моя не любить это!'),
        msg.from.id
      );
      bot.sendMessage(msg.chat.id, comeback, { reply_to_message_id: msg.message_id }).catch(() => {});
    }
  }

  // Directly named ("тролль") in an ordinary message — same comeback pool,
  // fresh regex instance every call since wordRegex's /g flag would
  // otherwise carry stale lastIndex state across .test() calls on a shared
  // one. Takes priority over the periodic mischief/learned-phrase chatter
  // below when both would fire on the same message.
  // Excludes "Тролль Фас" messages — that command sends its own dedicated
  // response (see the onText handler above), no need for a second reply.
  const addressedByName = !repliedToTroll && wordRegex('тролль').test(msg.text || '') && !TROLL_FAS_REGEX.test(msg.text || '');

  const newCount = state.message_count + 1;
  db.prepare('UPDATE troll_state SET message_count = ? WHERE id = 1').run(newCount);
  if (getSetting('paused') === '1' || isSilenced(state) || isNightNow()) return;

  if (addressedByName) {
    logAction(msg.from.id, msg.from.username || msg.from.first_name, 'snapped_at');
    if (!maybeSendFuckReaction(msg.chat.id, msg.from.id)) {
      const comeback = appendRelationshipEmoji(
        pickPhraseForStage(resolveTeaseCategory(msg.from.id), state.stage, 'Твоя звать моя? Моя тут!'),
        msg.from.id
      );
      bot.sendMessage(msg.chat.id, comeback, { reply_to_message_id: msg.message_id }).catch(() => {});
    }
    return;
  }

  const trigger = getSettingNumber('mischief_message_trigger');
  if (newCount % trigger === 0) {
    triggerMischief(state.chat_id);
  } else if (!repliedToTroll && Math.random() < getSettingNumber('learned_phrase_reply_chance') / 100) {
    const learned = db.prepare('SELECT text FROM troll_learned_phrases ORDER BY RANDOM() LIMIT 1').get();
    if (learned) bot.sendMessage(msg.chat.id, trollify(learned.text), { reply_to_message_id: msg.message_id }).catch(() => {});
  }
});

// Curated "fuck gif" pool (see maybeSendFuckReaction): there's no Telegram
// "GIF set" to bulk-import the way sticker packs work for troll_stickers,
// so an admin just forwards/sends an animation directly in the admin chat
// and it gets captured here — no caption or command needed.
bot.on('message', (msg) => {
  if (!isAdminChat(msg) || !msg.animation) return;
  const info = db.prepare('INSERT OR IGNORE INTO troll_gifs (file_id, category) VALUES (?, ?)').run(msg.animation.file_id, 'fuck');
  if (info.changes > 0) {
    bot.sendMessage(msg.chat.id, '🖕 Гифка добавлена в пул.').catch(() => {});
  } else {
    bot.sendMessage(msg.chat.id, 'Эта гифка уже есть в пуле.').catch(() => {});
  }
});

bot.onText(/\/troll_gifs\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const rows = db.prepare("SELECT id FROM troll_gifs WHERE category = 'fuck'").all();
  bot.sendMessage(msg.chat.id, `Гифок в пуле: ${rows.length}${rows.length > 0 ? ` (ID: ${rows.map((r) => r.id).join(', ')})` : ''}`);
});

bot.onText(/\/troll_gif_del (\d+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const info = db.prepare('DELETE FROM troll_gifs WHERE id = ?').run(Number(match[1]));
  bot.sendMessage(msg.chat.id, info.changes > 0 ? 'Гифка удалена.' : 'Не найдено.');
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

bot.onText(/\/troll_relationships\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT mama_user_id FROM troll_state WHERE id = 1').get();
  const rows = db.prepare('SELECT user_id, username, first_name, attitude, is_enemy, gender FROM troll_relationships ORDER BY attitude DESC').all();
  if (rows.length === 0) return bot.sendMessage(msg.chat.id, 'Троль пока никого не знает.');
  const lines = rows.map((r) => {
    const name = r.username ? `@${r.username}` : r.first_name;
    const tags = [];
    if (state && state.mama_user_id === r.user_id) tags.push('👑 мама');
    if (r.is_enemy) tags.push('💀 враг');
    if (r.gender === 'male') tags.push('♂');
    if (r.gender === 'female') tags.push('♀');
    const tagText = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    return `${name}: ${attitudeWord(r.attitude)} (${r.attitude > 0 ? '+' : ''}${r.attitude})${tagText}`;
  });
  bot.sendMessage(msg.chat.id, `🤝 Отношения тролля:\n${lines.join('\n')}`);
});

// Catch-up for anyone sitting at -100 who somehow isn't flagged yet (e.g. a
// manual DB edit to attitude bypassing adjustAttitude) — normally the
// migration backfill plus checkEnemyDeclaration's live check already cover
// everyone, so this is a rarely-needed safety net, not the primary path.
bot.onText(/\/troll_declare_enemies\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  const enemies = db.prepare("SELECT user_id, username, first_name FROM troll_relationships WHERE attitude <= -100 AND is_enemy = 0").all();
  if (enemies.length === 0) return bot.sendMessage(msg.chat.id, 'Новых врагов нет — все уже отмечены.');
  for (const enemy of enemies) {
    const name = enemy.username ? `@${enemy.username}` : enemy.first_name;
    db.prepare('UPDATE troll_relationships SET is_enemy = 1 WHERE user_id = ?').run(enemy.user_id);
    bot.sendMessage(state.chat_id, `💀 ${name}, твоя мой враг! Моя не забывать это никогда! 🖕`).catch(() => {});
  }
  bot.sendMessage(msg.chat.id, `Объявлено врагов: ${enemies.length}`);
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
  db.exec('DELETE FROM troll_learned_phrases');
  bot.sendMessage(msg.chat.id, 'Тролль сброшен, выученные фразы стёрты. Используй /troll_here в публичном чате, чтобы призвать нового.');
});

bot.onText(/\/troll_poop\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  triggerPoop(state.chat_id);
  db.prepare('UPDATE troll_state SET last_poop_action_at = ? WHERE id = 1').run(Math.floor(Date.now() / 1000));
});

bot.onText(/\/troll_pee\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  triggerPee(state.chat_id);
  db.prepare('UPDATE troll_state SET last_pee_action_at = ? WHERE id = 1').run(Math.floor(Date.now() / 1000));
});

bot.onText(/\/troll_say ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  const text = match[1];
  const tryMatch = text.match(/^\/try\s+([\s\S]+)/);
  if (tryMatch) {
    return bot.sendMessage(state.chat_id, rollTrollTry(tryMatch[1]));
  }
  const caption = trollify(text);
  const photoSizes = msg.reply_to_message?.photo;
  if (photoSizes && photoSizes.length > 0) {
    const fileId = photoSizes[photoSizes.length - 1].file_id;
    bot.sendPhoto(state.chat_id, fileId, { caption });
  } else {
    bot.sendMessage(state.chat_id, caption);
  }
});

bot.onText(/\/troll_panel\b/, async (msg) => {
  if (!isAdminChat(msg)) return;
  // Telegram only allows web_app inline buttons in private chats with the
  // bot (BUTTON_TYPE_INVALID otherwise) — the admin chat here is a group, so
  // the button has to go to the admin's DM with the bot instead. That only
  // works if they've already messaged the bot privately at least once
  // (Telegram bots can't initiate a DM with someone who never has); if not,
  // point them at /start there first.
  try {
    await bot.sendMessage(msg.from.id, 'Панель управления троллем:', {
      reply_markup: {
        inline_keyboard: [[{ text: '🧌 Открыть панель', web_app: { url: 'https://nordheimunion.ru/troll-admin' } }]],
      },
    });
    bot.sendMessage(msg.chat.id, 'Кнопка отправлена в личные сообщения с ботом.');
  } catch (err) {
    bot.sendMessage(msg.chat.id, 'Не получилось написать в личку — сначала напиши боту /start в личных сообщениях, потом повтори /troll_panel.');
  }
});

// --- Admin commands: phrase management ---
bot.onText(/\/troll_phrases\b(?:\s+(\S+))?/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const category = match[1];
  if (category) {
    if (!PHRASE_CATEGORIES.includes(category)) {
      return bot.sendMessage(msg.chat.id, `Неизвестная категория: ${category}`);
    }
    const rows = db.prepare('SELECT id, text FROM troll_phrases WHERE category = ? ORDER BY id').all(category);
    if (rows.length === 0) return bot.sendMessage(msg.chat.id, `В категории "${category}" пока пусто.`);
    return bot.sendMessage(msg.chat.id, rows.map((r) => `#${r.id}: ${r.text}`).join('\n'));
  }
  const blocks = PHRASE_CATEGORIES.map((cat) => {
    const rows = db.prepare('SELECT id, text FROM troll_phrases WHERE category = ? ORDER BY id').all(cat);
    const lines = rows.length > 0 ? rows.map((r) => `#${r.id}: ${r.text}`) : ['(пусто)'];
    return [`— ${cat} —`, ...lines].join('\n');
  });
  bot.sendMessage(msg.chat.id, blocks.join('\n\n'));
});

bot.onText(/\/troll_phrase_add (\S+) ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const category = match[1];
  const text = match[2];
  if (!PHRASE_CATEGORIES.includes(category)) {
    return bot.sendMessage(msg.chat.id, `Неизвестная категория: ${category}`);
  }
  const info = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)').run(category, text);
  bot.sendMessage(msg.chat.id, `Добавлено #${info.lastInsertRowid} в "${category}".`);
});

bot.onText(/\/troll_phrase_del (\d+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const id = Number(match[1]);
  const info = db.prepare('DELETE FROM troll_phrases WHERE id = ?').run(id);
  bot.sendMessage(msg.chat.id, info.changes > 0 ? `Удалено #${id}.` : `Не найдено #${id}.`);
});

bot.onText(/\/troll_phrase_edit (\d+) ([\s\S]+)/, (msg, match) => {
  if (!isAdminChat(msg)) return;
  const id = Number(match[1]);
  const text = match[2];
  const info = db.prepare('UPDATE troll_phrases SET text = ? WHERE id = ?').run(text, id);
  bot.sendMessage(msg.chat.id, info.changes > 0 ? `Обновлено #${id}.` : `Не найдено #${id}.`);
});

// --- Help ---
const TROLL_HELP_PUBLIC = [
  '🧌 Тролль под мостом:',
  '/troll — статус тролля (здоровье, сытость, вес, настроение, стадия)',
  '/troll_character — характер тролля (аппетит, игривость, злость, похоть, вредность)',
  '/play — поиграть с тролем (+настроение, +игривость, -злость)',
  '/feed — покормить тролля (+здоровье, +сытость, +настроение; от 90 до 99 сытости — переедает и это растит аппетит; при 100 — кинет еду обратно)',
  '/fight — подраться с тролем (⚔️ один обмен ударами за раз: сначала бьёшь ты — тролль может увернуться или потерять здоровье; затем отвечает тролль — если попадёт, теряешь здоровье, а критический удар может дать травму на 2-24 часа (рука/нога/голова — блокирует драки, пока не пройдёт); при 0 здоровья тебя вырубает и мутит на 30 минут; лимит попыток в день на человека настраивается админом; тратит 1 энергию из 10, восстановление — 1 за 20 мин, смотри /me)',
  '/tease — подразнить тролля (-настроение, +злость)',
  '/boobs — показать тролю сиську (+похоть, реакция зависит от стадии роста)',
  '/drink — бухать с тролем (🍻 60% — хорошо посидели, +настроение +отношение; 30% — поссорились, -настроение; 5% — тролль дал пиздюлей, 3 удара подряд; 5% — подружились, большой плюс к настроению и отношению); частое бухалово роняет трезвость тролля и рано или поздно вгоняет его в запой на час — весь этот час он максимально злой на всех и раз в ~20 минут лупит дубинкой случайного участника чата; если побухать с тролем 5 раз, будучи его врагом — вражда прощается, отношение сбрасывается в 0',
  '/teach <фраза> — научить тролля фразе; он потом будет иногда повторять её случайным людям (можно и просто ответить на любое сообщение тролля)',
].join('\n');

const TROLL_HELP_ADMIN = [
  '',
  '⚙️ Админские команды (только в этом чате):',
  '/troll_here — призвать тролля (одноразово)',
  '/troll_settings — текущие настройки',
  '/troll_relationships — отношение тролля ко всем известным людям (👑 мама / 💀 враг отмечены)',
  '/troll_declare_enemies — объявить задним числом всех, кто уже на -100, врагами тролля (для тех, кто набрал это до появления фичи)',
  '/troll_set <ключ> <значение> — изменить настройку',
  '/troll_pause / /troll_resume — выключить/включить шалости',
  '/troll_reset — полный сброс тролля (включая выученные фразы)',
  '/troll_poop — заставить тролля покакать прямо сейчас (мини-игра)',
  '/troll_pee — заставить тролля пописать прямо сейчас',
  '/troll_say <текст> — сказать текст от лица тролля тролльским акцентом',
  '/troll_phrases [категория] — все реплики тролля по категориям (с ID), или только одна категория',
  '/troll_phrase_add <категория> <текст> — добавить фразу',
  '/troll_phrase_edit <ID> <текст> — изменить фразу',
  '/troll_phrase_del <ID> — удалить фразу',
  '/troll_panel — открыть веб-панель управления (кнопкой)',
  '/troll_gifs — список гифок в пуле "фак" (для частых спорщиков); пул пополняется, просто скинув гифку в этот чат',
  '/troll_gif_del <ID> — удалить гифку из пула',
].join('\n');

bot.onText(/\/troll_help\b/, (msg) => {
  const text = isAdminChat(msg) ? TROLL_HELP_PUBLIC + TROLL_HELP_ADMIN : TROLL_HELP_PUBLIC;
  bot.sendMessage(msg.chat.id, text);
});

// Quick way to find a chat's numeric ID (e.g. to relocate the troll via
// UPDATE troll_state SET chat_id = ... — there's no move command yet).
bot.onText(/\/chatid\b/, (msg) => {
  bot.sendMessage(msg.chat.id, `ID этого чата: ${msg.chat.id}`);
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
