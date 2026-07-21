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
  result = result.split(/(\s+)/).map((token) => (/^[а-яё]+$/i.test(token) ? trollifyWord(token) : token)).join('');
  return result;
}
