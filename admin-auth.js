const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const proxy = process.env.PROXY_URL;

let agent;
if (proxy) {
  const agentOpts = { keepAlive: true, keepAliveMsecs: 60000, maxSockets: 5, maxFreeSockets: 3 };
  agent = proxy.startsWith('socks') ? new SocksProxyAgent(proxy, agentOpts) : new HttpsProxyAgent(proxy, agentOpts);
}

// polling: false — this process only ever calls one-off REST methods
// (getChatMember), never getUpdates, so there is no risk of racing the real
// troll-bot process's poll loop the way two concurrent getUpdates callers
// would (the 409 conflict this project hit earlier was specifically that).
const bot = new TelegramBot(BOT_TOKEN, { polling: false, request: { agent } });

// Telegram's documented Mini App initData verification algorithm.
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

const adminCache = new Map();
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function isAdmin(userId) {
  const cached = adminCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < ADMIN_CACHE_TTL_MS) {
    return cached.isAdmin;
  }
  let result = false;
  try {
    const member = await bot.getChatMember(ADMIN_CHAT_ID, userId);
    result = ['creator', 'administrator'].includes(member.status);
  } catch {
    result = false;
  }
  adminCache.set(userId, { isAdmin: result, checkedAt: Date.now() });
  return result;
}

async function requireAdmin(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data');
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const allowed = await isAdmin(user.id);
  if (!allowed) return res.status(403).json({ error: 'not an admin' });
  req.telegramUser = user;
  next();
}

module.exports = { bot, verifyInitData, isAdmin, requireAdmin };
