require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  db, getSetting, setSetting, getAllSettings, DEFAULT_SETTINGS_KEYS,
  STAGE_NAMES, getWeight, moodWord, getActivityLine, trollify, rollTrollTry,
} = require('./admin-lib');
const { bot, requireAdmin, fetchTelegramFile } = require('./admin-auth');

const PORT = 4100;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
// Mounted at /troll-admin, not root — nginx's proxy_pass here has no path
// component, so it forwards the original request URI unchanged (including
// the /troll-admin prefix) rather than stripping it. Matching that prefix
// here, and in every absolute path the frontend uses, is simpler and more
// robust than trying to strip it in nginx (which would break as soon as any
// asset/API path assumed root-relative resolution).
// no-cache: this panel's static files change often during active
// development — without this, browsers/Telegram's WebView can keep serving
// a stale cached app.js indefinitely, causing confusing "it's not doing
// what I just changed" reports that are actually just an old cached copy.
app.use('/troll-admin', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

const api = express.Router();
api.use(requireAdmin);

api.get('/status', (req, res) => {
  const state = db.prepare('SELECT * FROM troll_state WHERE id = 1').get();
  if (!state) return res.json({ exists: false });
  res.json({
    exists: true,
    health: state.health,
    mood: state.mood,
    moodWord: moodWord(state.mood),
    weight: getWeight(state.feed_count),
    stage: state.stage,
    stageName: STAGE_NAMES[state.stage],
    activity: getActivityLine(state),
    paused: getSetting('paused') === '1',
  });
});

// Stage is admin-controlled (set via this endpoint), not derived from
// feed_count — see the migration note in bot.js's schema section.
api.put('/stage', (req, res) => {
  const stageNum = Number(req.body && req.body.stage);
  if (![1, 2, 3, 4].includes(stageNum)) return res.status(400).json({ error: 'stage must be 1-4' });
  const info = db.prepare('UPDATE troll_state SET stage = ? WHERE id = 1').run(stageNum);
  if (info.changes === 0) return res.status(404).json({ error: 'no troll yet' });
  res.json({ ok: true, stage: stageNum, stageName: STAGE_NAMES[stageNum] });
});

api.get('/settings', (req, res) => {
  res.json(getAllSettings());
});

api.put('/settings', (req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    if (!DEFAULT_SETTINGS_KEYS.includes(key)) continue;
    setSetting(key, value);
  }
  res.json(getAllSettings());
});

api.get('/phrases', (req, res) => {
  const rows = db.prepare('SELECT id, category, text FROM troll_phrases ORDER BY category, id').all();
  res.json(rows);
});

api.post('/phrases', (req, res) => {
  const { category, text } = req.body || {};
  if (!category || !text) return res.status(400).json({ error: 'category and text required' });
  const info = db.prepare('INSERT INTO troll_phrases (category, text) VALUES (?, ?)').run(category, text);
  res.json({ id: info.lastInsertRowid, category, text });
});

api.put('/phrases/:id', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const info = db.prepare('UPDATE troll_phrases SET text = ? WHERE id = ?').run(text, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ id: Number(req.params.id), text });
});

api.delete('/phrases/:id', (req, res) => {
  const info = db.prepare('DELETE FROM troll_phrases WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

api.post('/pause', (req, res) => {
  setSetting('paused', '1');
  res.json({ paused: true });
});

api.post('/resume', (req, res) => {
  setSetting('paused', '0');
  res.json({ paused: false });
});

api.post('/reset', (req, res) => {
  db.exec('DELETE FROM troll_state');
  db.exec('DELETE FROM troll_actions');
  res.json({ ok: true });
});

// Bot self-profile (name/description shown in Telegram) — note there is no
// Bot API method to change the bot's avatar; that stays BotFather-only
// (/setuserpic), a hard platform limitation, not something skipped here.
api.get('/bot-profile', async (req, res) => {
  try {
    const [nameResult, descResult, shortDescResult] = await Promise.all([
      bot.getMyName(),
      bot.getMyDescription(),
      bot.getMyShortDescription(),
    ]);
    res.json({
      name: nameResult.name,
      description: descResult.description,
      shortDescription: shortDescResult.short_description,
    });
  } catch (err) {
    res.status(502).json({ error: 'telegram request failed', detail: err.message });
  }
});

api.put('/bot-profile', async (req, res) => {
  const { name, description, shortDescription } = req.body || {};
  try {
    const calls = [];
    if (typeof name === 'string') calls.push(bot.setMyName({ name }));
    if (typeof description === 'string') calls.push(bot.setMyDescription({ description }));
    if (typeof shortDescription === 'string') calls.push(bot.setMyShortDescription({ short_description: shortDescription }));
    await Promise.all(calls);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'telegram request failed', detail: err.message });
  }
});

api.get('/stickers', (req, res) => {
  const rows = db.prepare('SELECT id, category, has_own_text, emoji FROM troll_stickers ORDER BY category, id').all();
  res.json(rows);
});

api.post('/stickers/import', async (req, res) => {
  const { setName } = req.body || {};
  if (!setName) return res.status(400).json({ error: 'setName required' });
  try {
    const set = await bot.getStickerSet(setName);
    const insert = db.prepare('INSERT OR IGNORE INTO troll_stickers (file_id, emoji) VALUES (?, ?)');
    let added = 0;
    for (const sticker of set.stickers) {
      const info = insert.run(sticker.file_id, sticker.emoji || null);
      if (info.changes > 0) added += 1;
    }
    res.json({ total: set.stickers.length, added });
  } catch (err) {
    res.status(502).json({ error: 'telegram request failed', detail: err.message });
  }
});

api.put('/stickers/:id', (req, res) => {
  const current = db.prepare('SELECT category, has_own_text FROM troll_stickers WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'not found' });
  const { category, hasOwnText } = req.body || {};
  const newCategory = category !== undefined ? category : current.category;
  const newHasOwnText = hasOwnText !== undefined ? (hasOwnText ? 1 : 0) : current.has_own_text;
  db.prepare('UPDATE troll_stickers SET category = ?, has_own_text = ? WHERE id = ?').run(newCategory, newHasOwnText, req.params.id);
  res.json({ ok: true, category: newCategory, hasOwnText: !!newHasOwnText });
});

api.delete('/stickers/:id', (req, res) => {
  const info = db.prepare('DELETE FROM troll_stickers WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

api.get('/stickers/:id/image', async (req, res) => {
  const row = db.prepare('SELECT file_id FROM troll_stickers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  try {
    const { contentType, stream } = await fetchTelegramFile(row.file_id);
    res.set('Content-Type', contentType);
    stream.pipe(res);
  } catch (err) {
    res.status(502).end();
  }
});

api.get('/relationships', (req, res) => {
  const rows = db.prepare('SELECT * FROM troll_relationships ORDER BY last_seen_at DESC').all();
  res.json(rows);
});

api.put('/relationships/:userId', (req, res) => {
  const { attitude } = req.body || {};
  if (typeof attitude !== 'number') return res.status(400).json({ error: 'attitude must be a number' });
  const clamped = Math.max(-100, Math.min(100, Math.round(attitude)));
  const info = db.prepare('UPDATE troll_relationships SET attitude = ? WHERE user_id = ?').run(clamped, req.params.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ userId: Number(req.params.userId), attitude: clamped });
});

api.post('/say', upload.single('photo'), async (req, res) => {
  const state = db.prepare('SELECT chat_id FROM troll_state WHERE id = 1').get();
  if (!state) return res.status(404).json({ error: 'no troll yet' });
  const text = (req.body && req.body.text) || '';
  if (!text) return res.status(400).json({ error: 'text required' });
  const tryMatch = text.match(/^\/try\s+([\s\S]+)/);
  const applyTrollify = req.body && (req.body.applyTrollify === '1' || req.body.applyTrollify === true);
  try {
    if (tryMatch) {
      const sent = rollTrollTry(tryMatch[1]);
      await bot.sendMessage(state.chat_id, sent);
      return res.json({ ok: true, sent });
    }
    const caption = applyTrollify ? trollify(text) : text;
    if (req.file) {
      await bot.sendPhoto(state.chat_id, req.file.buffer, { caption });
    } else {
      await bot.sendMessage(state.chat_id, caption);
    }
    res.json({ ok: true, sent: caption });
  } catch (err) {
    res.status(502).json({ error: 'telegram send failed', detail: err.message });
  }
});

app.use('/troll-admin/api', api);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Админ-панель слушает на 127.0.0.1:${PORT}`);
});
