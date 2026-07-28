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
} catch (err) {
  console.error('Could not open tg-bot\'s mutes.db — the "smell" feature is disabled. Set TG_BOT_DB_PATH in .env if the path is wrong:', err.message);
}

function markSmelly(userId, durationSeconds) {
  if (!tgBotDb) return;
  const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
  tgBotDb.prepare(
    'INSERT INTO troll_smell (user_id, marked_at, expires_at) VALUES (?, strftime(\'%s\',\'now\'), ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET marked_at = strftime(\'%s\',\'now\'), expires_at = excluded.expires_at'
  ).run(userId, expiresAt);
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
  { command: 'kick', description: 'Пнуть тролля' },
  { command: 'tease', description: 'Подразнить тролля' },
  { command: 'boobs', description: 'Показать тролю сиську' },
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
// Global kick lockout — set when the troll successfully hides after being
// kicked twice within an hour; while in the future, /kick does nothing for
// anyone (see performKick).
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
    kick_blocked_until INTEGER
  )
`);
try {
  db.exec('ALTER TABLE troll_relationships ADD COLUMN kick_blocked_until INTEGER');
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
  health_decay_per_hour: '2',
  health_regen_baby: '1',
  health_regen_young: '2',
  health_regen_adult: '5',
  health_regen_old: '3',
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

// Unlike mama, "enemy" isn't sticky — it's a live check (see isEnemy) — so
// this only fires the announcement on the actual transition into it
// (oldAttitude wasn't already -100), not every time a further negative
// delta lands while already there.
function checkEnemyDeclaration(chatId, from, oldAttitude) {
  if (oldAttitude <= -100) return;
  if (!isEnemy(from.id)) return;
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
function pickTeaseCategory(userId) {
  const row = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(userId);
  const attitude = row ? row.attitude : 0;
  if (attitude >= 70) return 'tease_adoring';
  if (attitude >= 0) return 'tease_neutral';
  if (attitude <= getSettingNumber('attitude_escalation_threshold')) return 'tease_harsh';
  return 'tease';
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
  return { success, text: `Тролль — ${action} ${outcome}: ${roll}/100` };
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
// asleep, which beats a random "awake" flavor line — same precedence order
// used everywhere else silence/sleep interact (silence = total override).
function getActivityLine(state) {
  if (isSilenced(state)) {
    const minutesLeft = Math.max(1, Math.ceil((state.silenced_until * 1000 - Date.now()) / 60000));
    return `дуется после пинка (ещё ~${minutesLeft} мин)`;
  }
  if (state.is_asleep) {
    return 'спит под мостом, тихо похрапывает';
  }
  return pickPhraseForStage('activity_awake', state.stage, 'бродит под мостом');
}

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

bot.onText(/\/troll_character\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id) return;
  const lines = [
    '🎭 Характер тролля:',
    `🍽️ Аппетит: ${state.char_appetite}/100`,
    `🎈 Игривость: ${state.char_playfulness}/100`,
    `😡 Злость: ${state.char_anger}/100`,
    `💋 Похоть: ${state.char_lust}/100`,
    `😈 Вредность: ${state.char_naughtiness}/100`,
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// --- Public commands: play / kick / feed ---
// Extracted from the command handlers so the /troll card's inline buttons
// (and the callback_query handler below) can trigger the exact same logic
// as typing /play, /feed, /kick — only chatId/from are actually used by any
// of these, so a callback_query's message.chat/from line up just as well.
function actorName(from) {
  return from.username ? `@${from.username}` : from.first_name;
}

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

// Note: isSilenced (the 1-hour window after /kick) intentionally does NOT
// gate these three — being "silenced" only suppresses autonomous mischief
// (checked separately in backgroundTick and the message handler), not direct
// interaction. The troll always reacts to /play, /feed, /kick regardless of
// how recently it was kicked.
function performPlay(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'play')) return;
  if (state.is_asleep) {
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
async function performKick(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'kick')) return;
  const now = Math.floor(Date.now() / 1000);
  noticeUser(from.id, from.username, from.first_name);

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
    await sendCategoryReplyForStage(chatId, pickTeaseCategory(from.id), state.stage, 'Твоя не попасть в моя!', actorName(from), from.id);
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
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'feed')) return;
  if (state.is_asleep) {
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
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'tease')) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    sendCategoryReplyForStage(chatId, 'woken_angry', state.stage, 'Твоя разбудить моя! Моя злой!', actorName(from), from.id);
    return;
  }
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10), char_anger = MIN(100, char_anger + 8) WHERE id = 1').run();
  logAction(from.id, from.username || from.first_name, 'tease');
  noticeUser(from.id, from.username, from.first_name);
  sendCategoryReplyForStage(chatId, mamaCategoryOverride(state, from.id, pickTeaseCategory(from.id)), state.stage, 'Твоя дразнить моя?! Моя злиться!', actorName(from), from.id);
}

// малыш sees it as food (the joke the whole feature started from); the
// reaction "matures" alongside the troll's growth stage after that. Every
// stage raises lust the same amount — only the flavor text differs.
const BOOBS_CATEGORY_BY_STAGE = { 1: 'boobs_baby', 2: 'boobs_teen', 3: 'boobs_young', 4: 'boobs_adult' };

function performBoobs(chatId, from) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || chatId !== state.chat_id) return;
  if (!checkCommandCooldown(from.id, 'boobs')) return;
  const category = BOOBS_CATEGORY_BY_STAGE[state.stage] || 'boobs_baby';
  db.prepare('UPDATE troll_state SET char_lust = MIN(100, char_lust + 8) WHERE id = 1').run();
  logAction(from.id, from.username || from.first_name, 'boobs');
  noticeUser(from.id, from.username, from.first_name);
  sendCategoryReply(chatId, mamaCategoryOverride(state, from.id, category), 'Моя видеть еда!', actorName(from), from.id);
}

bot.onText(/\/play\b/, (msg) => {
  performPlay(msg.chat.id, msg.from);
});

bot.onText(/\/kick\b/, (msg) => {
  performKick(msg.chat.id, msg.from);
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
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id) return;
  if (!checkCommandCooldown(msg.from.id, 'fas')) return;

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

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE troll_state SET troll_fas_until = ?, troll_fas_target_user_id = ? WHERE id = 1').run(now + 30 * 60, target.userId);
  // Using the troll like an attack dog costs a little of its fondness even
  // from someone it adores.
  adjustAttitude(msg.from.id, getSettingNumber('attitude_fas_delta'));
  const targetName = target.username ? `@${target.username}` : target.firstName;
  bot.sendMessage(msg.chat.id, `🐕 ${actorName(msg.from)} скомандовал троллю "Фас!" на ${targetName} — 30 минут не будет покоя!`).catch(() => {});
});

// Buttons on the /troll status card (callback_data-type inline buttons work
// fine in groups, unlike web_app buttons — that restriction only applies to
// the Mini App admin panel's link, not these).
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

// --- Autonomous mischief ---
// Stage caps how serious mischief can get, regardless of mood/naughtiness:
// малыш (1) never goes past mild, подросток (2) never past medium, молодой/
// взрослый (3-4) can reach the full mean tier. Tiers: 0=mild, 1=medium, 2=mean.
const STAGE_MAX_MISCHIEF_TIER = { 1: 0, 2: 1, 3: 2, 4: 2 };
const MISCHIEF_TIER_CATEGORIES = ['mischief_mild', 'mischief_medium', 'mischief_mean'];

function getMischiefTier(mood, naughtiness, stage) {
  const score = naughtiness - Math.floor(mood / 20);
  let tier = 0;
  if (score >= 7) tier = 2;
  else if (score >= 4) tier = 1;
  const maxTier = STAGE_MAX_MISCHIEF_TIER[stage] ?? 2;
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
// logs /play, /kick, /feed) and from maybeRememberedUser above, which still
// draws from that older history for the existing detached-mischief aside.
const RECENT_MESSAGES_MAX = 10;
let recentMessages = [];

function pushRecentMessage(entry) {
  recentMessages.push(entry);
  if (recentMessages.length > RECENT_MESSAGES_MAX) recentMessages.shift();
}

// "Enemy" isn't a stored flag — it's just attitude bottomed out at -100,
// checked live. If it later improves, they stop being treated as one.
function isEnemy(userId) {
  const row = db.prepare('SELECT attitude FROM troll_relationships WHERE user_id = ?').get(userId);
  return !!row && row.attitude <= -100;
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
  const row = db.prepare(
    'SELECT user_id, username, first_name, attitude FROM troll_relationships WHERE user_id = ?'
  ).get(state.troll_fas_target_user_id);
  if (!row) return null;
  return { entry: { userId: row.user_id, username: row.username, firstName: row.first_name }, attitude: row.attitude };
}

function triggerMischief(chatId) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const stage = state.stage;
  const tier = getMischiefTier(state.mood, getSettingNumber('naughtiness'), stage);
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
      const template = pickPhraseForStage(TARGETED_ACTION_TIER_CATEGORIES[effectiveTier], stage, 'подшутить над {user}');
      const action = template.replace(/\{user\}/g, target);
      bot.sendMessage(chatId, rollTrollTry(action)).catch(() => {});
    }
    return;
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
  markSmelly(loser.userId, 3600);
}

// Weighted random target (same pool/weighting as targeted mischief) half
// the time; ambient/untargeted the other half.
function triggerPee(chatId) {
  const weightLoss = getSettingNumber('weight_loss_per_pee');
  db.prepare('UPDATE troll_state SET weight = MAX(?, weight - ?) WHERE id = 1').run(WEIGHT_FLOOR, weightLoss);
  logAction(0, 'тролль', 'pee');
  const enemyEntry = findEnemyAmong(recentMessages);
  if (enemyEntry || (recentMessages.length > 0 && Math.random() < 0.5)) {
    const targetInfo = enemyEntry ? { entry: enemyEntry } : pickMischiefTarget();
    const target = getMentionName(targetInfo.entry);
    bot.sendMessage(chatId, `💦 Моя метко пометить территория, заодно окатить ${target}!`).catch(() => {});
    logAction(targetInfo.entry.userId, targetInfo.entry.username || targetInfo.entry.firstName, 'pee_target');
    markSmelly(targetInfo.entry.userId, 3600);
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
  }
}

setInterval(backgroundTick, BACKGROUND_TICK_MS);

// --- Message-triggered mischief ---
bot.on('message', (msg) => {
  if (msg.from?.is_bot) return;
  if (msg.text && msg.text.startsWith('/')) return;
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id) return;
  pushRecentMessage({ userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);

  // Poop mini-game: while a game clock is running, anyone who writes
  // becomes a candidate to be randomly picked as the "loser" (see
  // resolvePoopGameIfDue in backgroundTick).
  const nowForGame = Math.floor(Date.now() / 1000);
  if (state.poop_game_ends_at && nowForGame < state.poop_game_ends_at) {
    poopGameCandidates.set(msg.from.id, { userId: msg.from.id, username: msg.from.username, firstName: msg.from.first_name });
  }

  // Baby stage only: the troll is scared of an enemy (attitude bottomed out
  // at -100) — the moment they show up, it tries to hide, and on success
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
    const comeback = appendRelationshipEmoji(
      pickPhraseForStage(pickTeaseCategory(msg.from.id), state.stage, 'Твоя дразнить моя?! Моя не любить это!'),
      msg.from.id
    );
    bot.sendMessage(msg.chat.id, comeback, { reply_to_message_id: msg.message_id }).catch(() => {});
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
    const comeback = appendRelationshipEmoji(
      pickPhraseForStage(pickTeaseCategory(msg.from.id), state.stage, 'Твоя звать моя? Моя тут!'),
      msg.from.id
    );
    bot.sendMessage(msg.chat.id, comeback, { reply_to_message_id: msg.message_id }).catch(() => {});
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
  const rows = db.prepare('SELECT user_id, username, first_name, attitude FROM troll_relationships ORDER BY attitude DESC').all();
  if (rows.length === 0) return bot.sendMessage(msg.chat.id, 'Троль пока никого не знает.');
  const lines = rows.map((r) => {
    const name = r.username ? `@${r.username}` : r.first_name;
    const tags = [];
    if (state && state.mama_user_id === r.user_id) tags.push('👑 мама');
    if (r.attitude <= -100) tags.push('💀 враг');
    const tagText = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    return `${name}: ${attitudeWord(r.attitude)} (${r.attitude > 0 ? '+' : ''}${r.attitude})${tagText}`;
  });
  bot.sendMessage(msg.chat.id, `🤝 Отношения тролля:\n${lines.join('\n')}`);
});

// One-off catch-up for anyone who was already sitting at -100 before this
// feature existed — the live announcement in checkEnemyDeclaration only
// fires on an actual transition, so a pre-existing rock-bottom relationship
// would otherwise never get declared.
bot.onText(/\/troll_declare_enemies\b/, (msg) => {
  if (!isAdminChat(msg)) return;
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет.');
  const enemies = db.prepare('SELECT user_id, username, first_name FROM troll_relationships WHERE attitude <= -100').all();
  if (enemies.length === 0) return bot.sendMessage(msg.chat.id, 'Врагов пока нет.');
  for (const enemy of enemies) {
    const name = enemy.username ? `@${enemy.username}` : enemy.first_name;
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
  '/kick — пнуть тролля (тролль может увернуться — тогда огрызнётся в ответ и заблокирует тебе кнопку "Пнуть" на час; если попал — -настроение, -здоровье, замолкает на час; после 2 удачных пинков за час тролль может спрятаться и заблокировать пинки для всех)',
  '/tease — подразнить тролля (-настроение, +злость)',
  '/boobs — показать тролю сиську (+похоть, реакция зависит от стадии роста)',
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
