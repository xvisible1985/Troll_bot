require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  db, getSetting, setSetting, getAllSettings, DEFAULT_SETTINGS_KEYS,
  STAGE_NAMES, getStage, getWeight, moodWord, getActivityLine, trollify,
} = require('./admin-lib');
const { bot, requireAdmin } = require('./admin-auth');

const PORT = 4100;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    stage: getStage(state.feed_count),
    stageName: STAGE_NAMES[getStage(state.feed_count)],
    activity: getActivityLine(state),
    paused: getSetting('paused') === '1',
  });
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
  const caption = trollify(text);
  try {
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

app.use('/api', api);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Админ-панель слушает на 127.0.0.1:${PORT}`);
});
