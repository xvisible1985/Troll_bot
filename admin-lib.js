const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'troll.db'));

// --- Settings ---
const DEFAULT_SETTINGS_KEYS = [
  'sleep_start', 'sleep_end', 'naughtiness', 'mischief_interval_hours',
  'mischief_message_trigger', 'health_decay_per_hour', 'health_regen_per_hour',
  'neglect_threshold_hours', 'paused', 'attitude_play_delta', 'attitude_feed_delta',
  'attitude_kick_delta', 'attitude_escalation_threshold',
  'satiety_decay_per_hour', 'satiety_feed_gain', 'satiety_suckle_gain', 'hunger_action_interval_minutes',
  'attitude_feed_reject_delta', 'learned_phrase_reply_chance',
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

function satietyWord(satiety) {
  if (satiety >= 90) return 'объевшийся';
  if (satiety >= 50) return 'сытый';
  if (satiety >= 30) return 'голодный';
  return 'очень голодный';
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

// Duplicated from bot.js for the same reason as everything else in this
// file — kept in sync by hand, not shared, since admin-server.js can't
// require('./bot.js') (see the file-level comment near the top).
function rollTrollTry(action) {
  const roll = Math.floor(Math.random() * 101);
  const outcome = roll < 50 ? '❌ неудачно' : '✅ удачно';
  return `Тролль — ${action} ${outcome}: ${roll}/100`;
}

module.exports = {
  db,
  DEFAULT_SETTINGS_KEYS,
  getSetting,
  setSetting,
  getAllSettings,
  STAGE_NAMES,
  getWeight,
  moodWord,
  satietyWord,
  isSilenced,
  getActivityLine,
  trollify,
  rollTrollTry,
};
