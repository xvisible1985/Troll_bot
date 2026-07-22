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
  activity_awake: [
    'бродит под мостом',
    'ждёт, когда покормят',
    'греется на солнышке',
    'что-то мастерит из веточек',
  ],
};

const PHRASE_CATEGORIES = Object.keys(PHRASE_SEED);

const phraseCount = db.prepare('SELECT COUNT(*) AS n FROM troll_phrases').get().n;
if (phraseCount === 0) {
  const insertPhrase = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)');
  for (const [category, texts] of Object.entries(PHRASE_SEED)) {
    for (const text of texts) insertPhrase.run(category, text);
  }
}

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

function adjustAttitude(userId, delta) {
  db.prepare('UPDATE troll_relationships SET attitude = MAX(-100, MIN(100, attitude + ?)) WHERE user_id = ?').run(delta, userId);
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
  return pickPhrase('activity_awake', 'бродит под мостом');
}

bot.onText(/\/troll\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return bot.sendMessage(msg.chat.id, 'Тролля ещё нет. Позови его через /troll_here.');
  if (msg.chat.id !== state.chat_id) return;
  const displayWeight = Math.round(getWeight(state.feed_count) + (Math.random() * 6 - 3));
  const lines = [
    `Здоровье: ${state.health}/100`,
    `Вес: ${displayWeight} кг`,
    `Настроение: ${moodWord(state.mood)}`,
    `Стадия: ${STAGE_NAMES[getStage(state.feed_count)]}`,
    `Занятие: ${getActivityLine(state)}`,
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

// --- Public commands: play / kick / feed ---
bot.onText(/\/play\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id || isSilenced(state)) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    return bot.sendMessage(msg.chat.id, pickPhrase('woken_angry', 'Твоя разбудить моя! Моя злой!'));
  }
  db.prepare('UPDATE troll_state SET mood = MIN(100, mood + 10) WHERE id = 1').run();
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'play');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_play_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('play', 'Моя рада играть с твоя!'));
});

bot.onText(/\/kick\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id || isSilenced(state)) return;
  const silencedUntil = Math.floor(Date.now() / 1000) + 60 * 60;
  db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 20), silenced_until = ? WHERE id = 1').run(silencedUntil);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'kick');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_kick_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('kick', 'Твоя злой! Моя обижаться!'));
});

bot.onText(/\/feed\b/, (msg) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state || msg.chat.id !== state.chat_id || isSilenced(state)) return;
  if (state.is_asleep) {
    db.prepare('UPDATE troll_state SET mood = MAX(0, mood - 10) WHERE id = 1').run();
    return bot.sendMessage(msg.chat.id, pickPhrase('woken_angry', 'Твоя разбудить моя! Моя злой!'));
  }
  const newFeedCount = state.feed_count + 1;
  const oldStage = getStage(state.feed_count);
  const newStage = getStage(newFeedCount);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE troll_state SET feed_count = ?, health = MIN(100, health + 30), mood = MIN(100, mood + 5), last_fed_at = ? WHERE id = 1'
  ).run(newFeedCount, now);
  logAction(msg.from.id, msg.from.username || msg.from.first_name, 'feed');
  noticeUser(msg.from.id, msg.from.username, msg.from.first_name);
  adjustAttitude(msg.from.id, getSettingNumber('attitude_feed_delta'));
  bot.sendMessage(msg.chat.id, pickPhrase('feed', 'Ням-ням, спасибо твоя!'));
  if (newStage > oldStage) {
    bot.sendMessage(msg.chat.id, `Тролль подрос! Теперь твоя видеть: ${STAGE_NAMES[newStage]}!`);
  }
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

function getMentionName(entry) {
  return entry.username ? `@${entry.username}` : entry.firstName;
}

// Tiered category names [mild, medium, mean] — indexed the same way as getMischiefTier.
const TARGETED_PHRASE_TIER_CATEGORIES = ['targeted_phrase_mild', 'targeted_phrase_medium', 'targeted_phrase_mean'];
const TARGETED_ACTION_TIER_CATEGORIES = ['targeted_action_mild', 'targeted_action_medium', 'targeted_action_mean'];

function triggerMischief(chatId) {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  const stage = getStage(state.feed_count);
  const tier = getMischiefTier(state.mood, getSettingNumber('naughtiness'), stage);

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
  const action = pickPhrase(MISCHIEF_TIER_CATEGORIES[tier], 'шалит тихонько под мостом');
  let phrase = `*${action}*`;
  if (Math.random() < 0.3) {
    const rememberedUser = maybeRememberedUser();
    if (rememberedUser) phrase += ` (твоя как ${rememberedUser}, твоя тоже моя помнить!)`;
  }
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
      db.prepare('UPDATE troll_state SET last_mischief_at = ? WHERE id = 1').run(now);
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
  const newCount = state.message_count + 1;
  db.prepare('UPDATE troll_state SET message_count = ? WHERE id = 1').run(newCount);
  if (getSetting('paused') === '1' || isSilenced(state) || isNightNow()) return;
  const trigger = getSettingNumber('mischief_message_trigger');
  if (newCount % trigger === 0) {
    triggerMischief(state.chat_id);
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
  '/troll — статус тролля (здоровье, вес, настроение, стадия)',
  '/play — поиграть с тролем (+настроение)',
  '/feed — покормить тролля (+здоровье, +настроение, растёт)',
  '/kick — пнуть тролля (-настроение, замолкает на час)',
].join('\n');

const TROLL_HELP_ADMIN = [
  '',
  '⚙️ Админские команды (только в этом чате):',
  '/troll_here — призвать тролля (одноразово)',
  '/troll_settings — текущие настройки',
  '/troll_set <ключ> <значение> — изменить настройку',
  '/troll_pause / /troll_resume — выключить/включить шалости',
  '/troll_reset — полный сброс тролля',
  '/troll_say <текст> — сказать текст от лица тролля тролльским акцентом',
  '/troll_phrases [категория] — все реплики тролля по категориям (с ID), или только одна категория',
  '/troll_phrase_add <категория> <текст> — добавить фразу',
  '/troll_phrase_edit <ID> <текст> — изменить фразу',
  '/troll_phrase_del <ID> — удалить фразу',
].join('\n');

bot.onText(/\/troll_help\b/, (msg) => {
  const text = isAdminChat(msg) ? TROLL_HELP_PUBLIC + TROLL_HELP_ADMIN : TROLL_HELP_PUBLIC;
  bot.sendMessage(msg.chat.id, text);
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
