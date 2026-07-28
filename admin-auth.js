const crypto = require('crypto');
const https = require('https');
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

// getChatMember has no built-in timeout, and this proxy is known to drop
// roughly half of fresh handshakes under concurrency (see the agent setup
// comment above) — troll-bot's own bot stays fast because its connection to
// Telegram is kept warm by continuous long-polling, but this call is a cold
// one-off every cache miss. Without a timeout+retry here, a dropped
// handshake just hangs until nginx's proxy_read_timeout gives up and the
// admin panel shows a 504 with empty tabs.
const CHAT_MEMBER_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function getChatMemberResilient(chatId, userId) {
  try {
    return await withTimeout(bot.getChatMember(chatId, userId), CHAT_MEMBER_TIMEOUT_MS);
  } catch {
    return await withTimeout(bot.getChatMember(chatId, userId), CHAT_MEMBER_TIMEOUT_MS);
  }
}

async function isAdmin(userId) {
  const cached = adminCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < ADMIN_CACHE_TTL_MS) {
    return cached.isAdmin;
  }
  let result = false;
  try {
    const member = await getChatMemberResilient(ADMIN_CHAT_ID, userId);
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

// Streams a Telegram-hosted file (a sticker's image bytes) back to whoever
// calls this, through the SAME proxy agent used for every other Bot API
// call — needed since api.telegram.org is blocked from Russia. Never expose
// the raw getFileLink URL to a browser: it embeds the bot token.
//
// The proxy agent caps concurrent connections (maxSockets: 5). Without a
// timeout here, a dropped/stalled handshake never errors and never
// releases its socket — and the stickers tab fires ~30 of these in
// parallel on load, so a couple of stuck ones back up the whole queue and
// the admin panel ends up with a 504 and empty tabs.
const FILE_FETCH_TIMEOUT_MS = 10000;

function fetchTelegramFile(fileId) {
  return bot.getFileLink(fileId).then((fileLink) => new Promise((resolve, reject) => {
    const req = https.get(fileLink, { agent }, (fileRes) => {
      if (fileRes.statusCode !== 200) {
        reject(new Error(`Telegram file server responded ${fileRes.statusCode} for ${fileLink}`));
        fileRes.resume();
        return;
      }
      resolve({ contentType: fileRes.headers['content-type'] || 'application/octet-stream', stream: fileRes });
    }).on('error', reject);
    req.setTimeout(FILE_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`timed out fetching ${fileLink}`));
    });
  }));
}

module.exports = { bot, verifyInitData, isAdmin, requireAdmin, fetchTelegramFile };
