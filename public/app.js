const initData = window.Telegram?.WebApp?.initData || '';
if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ 'X-Telegram-Init-Data': initData }, options.headers || {});
  const res = await fetch('/troll-admin/api' + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = [body.error, body.detail].filter(Boolean).join(': ');
    throw new Error(message || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const STAGE_OPTIONS = [
  { value: 1, label: 'малыш' },
  { value: 2, label: 'молодой' },
  { value: 3, label: 'взрослый' },
  { value: 4, label: 'старый' },
];

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

const SETTING_LABELS = {
  naughtiness: 'Вредность',
  mischief_message_trigger: 'Шалость раз в N сообщений',
  mischief_interval_hours: 'Интервал шалости, ч',
  sleep_start: 'Засыпает в (час)',
  sleep_end: 'Просыпается в (час)',
  health_decay_per_hour: 'Упадок здоровья/ч (при голоде < 30)',
  health_regen_baby: 'Восстановление здоровья/ч: малыш',
  health_regen_young: 'Восстановление здоровья/ч: молодой',
  health_regen_adult: 'Восстановление здоровья/ч: взрослый',
  health_regen_old: 'Восстановление здоровья/ч: старый',
  attitude_play_delta: 'Отношение: /play',
  attitude_feed_delta: 'Отношение: /feed',
  attitude_kick_delta: 'Отношение: /kick',
  attitude_escalation_threshold: 'Порог озлобления',
  satiety_decay_per_hour: 'Упадок сытости/ч',
  satiety_feed_gain: 'Сытость от кормления',
  satiety_suckle_gain: 'Сытость от сосания молока',
  hunger_action_interval_minutes: 'Интервал голодного действия, мин',
  attitude_feed_reject_delta: 'Отношение: кормление сытого',
  weight_gain_per_feed: 'Вес от кормления',
  weight_loss_per_poop: 'Потеря веса от какашки',
  weight_loss_per_pee: 'Потеря веса от пописа',
  eat_action_interval_minutes: 'Интервал самостоятельной еды, мин',
  poop_action_interval_minutes: 'Интервал какашки, мин',
  pee_action_interval_minutes: 'Интервал пописа, мин',
  poop_mood_gain: 'Настроение от какашки',
  command_cooldown_seconds: 'Антиспам-кулдаун команд, сек (1 мин – 1 час)',
  attitude_fas_delta: 'Отношение: команда "Фас"',
  regen_sleep_health_threshold: 'Регенерационный сон: порог здоровья',
  regen_sleep_duration_minutes: 'Регенерационный сон: длительность, мин',
  regen_sleep_tick_minutes: 'Регенерационный сон: интервал тика, мин',
  regen_sleep_health_per_tick: 'Регенерационный сон: здоровье за тик',
  regen_sleep_weight_loss_per_tick: 'Регенерационный сон: потеря веса за тик',
  regen_sleep_cooldown_hours: 'Регенерационный сон: кулдаун, ч',
  frequent_arguer_kick_threshold: 'Частый спорщик: кол-во пинков для статуса',
  frequent_arguer_window_hours: 'Частый спорщик: окно подсчёта, ч',
  frequent_arguer_fuck_chance: 'Частый спорщик: шанс 🖕 вместо огрызания, %',
  lust_gain_per_boobs: 'Похотливость (прирост похоти за 🍈)',
};
const SETTING_RANGES = {
  naughtiness: [1, 10, 1],
  mischief_message_trigger: [10, 200, 10],
  mischief_interval_hours: [1, 12, 1],
  sleep_start: [0, 23, 1],
  sleep_end: [0, 23, 1],
  health_decay_per_hour: [0, 20, 1],
  health_regen_baby: [0, 20, 1],
  health_regen_young: [0, 20, 1],
  health_regen_adult: [0, 20, 1],
  health_regen_old: [0, 20, 1],
  attitude_play_delta: [0, 20, 1],
  attitude_feed_delta: [0, 20, 1],
  attitude_kick_delta: [-40, 0, 1],
  attitude_escalation_threshold: [-100, 0, 5],
  satiety_decay_per_hour: [0, 15, 1],
  satiety_feed_gain: [5, 50, 5],
  satiety_suckle_gain: [5, 50, 5],
  hunger_action_interval_minutes: [5, 120, 5],
  attitude_feed_reject_delta: [-40, 0, 1],
  weight_gain_per_feed: [1, 20, 1],
  weight_loss_per_poop: [1, 30, 1],
  weight_loss_per_pee: [0, 10, 1],
  eat_action_interval_minutes: [10, 180, 10],
  poop_action_interval_minutes: [15, 240, 15],
  pee_action_interval_minutes: [15, 240, 15],
  poop_mood_gain: [0, 20, 1],
  command_cooldown_seconds: [60, 3600, 60],
  attitude_fas_delta: [-20, 0, 1],
  regen_sleep_health_threshold: [0, 100, 5],
  regen_sleep_duration_minutes: [10, 180, 10],
  regen_sleep_tick_minutes: [5, 30, 5],
  regen_sleep_health_per_tick: [1, 20, 1],
  regen_sleep_weight_loss_per_tick: [0, 5, 1],
  regen_sleep_cooldown_hours: [1, 12, 1],
  frequent_arguer_kick_threshold: [1, 20, 1],
  frequent_arguer_window_hours: [1, 72, 1],
  frequent_arguer_fuck_chance: [0, 100, 5],
  lust_gain_per_boobs: [0, 20, 1],
};

async function loadStatus() {
  const data = await apiFetch('/status');
  const sub = document.getElementById('troll-sub');
  const chips = document.getElementById('status-chips');
  const panel = document.getElementById('panel-status');
  if (!data.exists) {
    sub.textContent = 'тролля ещё нет';
    chips.innerHTML = '';
    panel.innerHTML = '<div class="card">Тролля ещё нет — призови его командой /troll_here в публичном чате.</div>';
    return;
  }
  sub.textContent = data.stageName;
  chips.innerHTML = `
    <div class="chip"><span class="dot"></span>здоровье <b class="mono">${data.health}/${data.maxHealth}</b></div>
    <div class="chip${data.satiety < 50 ? ' warn' : ''}"><span class="dot"></span>сытость <b class="mono">${data.satiety}</b></div>
    <div class="chip"><span class="dot"></span>настроение <b>${data.moodWord}</b></div>
    ${data.paused ? '<div class="chip warn"><span class="dot"></span>шалости на паузе</div>' : ''}
    ${data.cocoon ? '<div class="chip warn"><span class="dot"></span>тролль в коконе</div>' : ''}
  `;
  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Сейчас</p>
      <div class="stat-grid">
        <div class="stat"><div class="label">❤️ Здоровье</div><div class="value mono">${data.health}/${data.maxHealth}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * data.health / data.maxHealth)}%"></div></div></div>
        <div class="stat"><div class="label">🍖 Сытость</div><div class="value mono">${data.satiety}/100</div>
          <div class="bar-track"><div class="bar-fill" style="width:${data.satiety}%"></div></div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${data.satietyWord}</div></div>
        <div class="stat"><div class="label">⚖️ Вес</div><div class="value mono">${data.weight} кг</div></div>
        <div class="stat"><div class="label">😊 Настроение</div><div class="value">${data.moodWord}</div></div>
        <div class="stat">
          <div class="label">🌱 Стадия (управляется вручную)</div>
          <select id="stage-select" style="margin-top:4px; width:100%; padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--bg-sunken); color:var(--text); font-size:13px;">
            ${STAGE_OPTIONS.map((opt) => `<option value="${opt.value}" ${opt.value === data.stage ? 'selected' : ''}>${opt.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="activity-line"><span>🎭</span><span>${data.activity}</span></div>
    </div>
    <div class="card">
      <p class="eyebrow">Быстрые действия</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" id="btn-pause">${data.paused ? '▶ Возобновить' : '⏸ Пауза шалостей'}</button>
        <button class="btn ghost" id="btn-cocoon">${data.cocoon ? '🦋 Вывести из кокона' : '🥚 Кокон'}</button>
        <button class="btn ghost" id="btn-reset">↺ Полный сброс</button>
      </div>
    </div>
    <div class="card">
      <p class="eyebrow">Портрет тролля (для картинки /troll)</p>
      <div style="display:flex; gap:12px; align-items:center;">
        <img id="portrait-preview" style="width:88px; height:88px; object-fit:cover; border-radius:10px; background:var(--bg-sunken); flex-shrink:0;" alt="">
        <div style="flex:1; min-width:0;">
          <input type="file" id="portrait-file" accept="image/png" style="width:100%; font-size:12px;">
          <button class="btn" id="portrait-upload-btn" style="margin-top:8px;">Загрузить</button>
        </div>
      </div>
      <div id="portrait-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  document.getElementById('btn-pause').addEventListener('click', async () => {
    await apiFetch(data.paused ? '/resume' : '/pause', { method: 'POST' });
    loadStatus();
  });
  document.getElementById('btn-cocoon').addEventListener('click', async () => {
    await apiFetch(data.cocoon ? '/cocoon-exit' : '/cocoon-enter', { method: 'POST' });
    loadStatus();
  });
  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Точно сбросить тролля полностью?')) return;
    await apiFetch('/reset', { method: 'POST' });
    loadStatus();
  });
  document.getElementById('stage-select').addEventListener('change', async (e) => {
    await apiFetch('/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: Number(e.target.value) }),
    });
    loadStatus();
  });

  // Plain <img src> can't carry the auth header (same issue as sticker
  // previews) — fetch with the header and hand the browser a blob: URL.
  (async () => {
    const img = document.getElementById('portrait-preview');
    try {
      const res = await fetch('/troll-admin/api/troll-portrait/image', {
        headers: { 'X-Telegram-Init-Data': initData },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      img.src = URL.createObjectURL(blob);
    } catch {
      img.removeAttribute('src');
    }
  })();

  document.getElementById('portrait-upload-btn').addEventListener('click', async () => {
    const fileInput = document.getElementById('portrait-file');
    const status = document.getElementById('portrait-status');
    if (!fileInput.files[0]) return;
    const formData = new FormData();
    formData.append('portrait', fileInput.files[0]);
    status.textContent = 'Загружаю…';
    try {
      const res = await fetch('/troll-admin/api/troll-portrait', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': initData },
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error([body.error, body.detail].filter(Boolean).join(': ') || `HTTP ${res.status}`);
      }
      status.textContent = 'Портрет обновлён.';
      loadStatus();
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });
}

async function loadSettings() {
  const settings = await apiFetch('/settings');
  const panel = document.getElementById('panel-settings');
  const rows = Object.keys(SETTING_LABELS).map((key) => {
    const [min, max, step] = SETTING_RANGES[key];
    const value = Number(settings[key]);
    return `
      <div class="setting-row">
        <div class="setting-head">
          <span class="setting-name">${SETTING_LABELS[key]}</span>
          <span class="setting-value mono" data-out="${key}">${value}</span>
        </div>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-key="${key}">
      </div>
    `;
  }).join('');
  panel.innerHTML = `<div class="card">${rows}</div>`;
  panel.querySelectorAll('input[type=range]').forEach((input) => {
    input.addEventListener('input', () => {
      panel.querySelector(`[data-out="${input.dataset.key}"]`).textContent = input.value;
    });
    input.addEventListener('change', async () => {
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [input.dataset.key]: input.value }),
      });
    });
  });
}

// Runs after loadSettings() and prepends its own card into #panel-settings,
// rather than replacing the panel's innerHTML the way loadSettings does —
// so it must always be called after loadSettings, never before.
async function loadBotProfile() {
  const profile = await apiFetch('/bot-profile');
  const panel = document.getElementById('panel-settings');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <p class="eyebrow">Профиль бота в Telegram</p>
    <p style="font-size:12px; color:var(--text-muted); margin:-4px 0 12px;">Аватарку можно сменить только вручную через @BotFather (/setuserpic) — в Bot API такого метода нет.</p>
    <div class="setting-row">
      <div class="setting-head"><span class="setting-name">Имя</span></div>
      <input type="text" id="profile-name" value="${profile.name || ''}" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-sunken); color:var(--text); font-size:13.5px;">
    </div>
    <div class="setting-row">
      <div class="setting-head"><span class="setting-name">Краткое описание</span></div>
      <textarea id="profile-short-desc" style="min-height:50px;">${profile.shortDescription || ''}</textarea>
    </div>
    <div class="setting-row">
      <div class="setting-head"><span class="setting-name">Полное описание</span></div>
      <textarea id="profile-desc">${profile.description || ''}</textarea>
    </div>
    <div class="say-actions"><button class="btn" id="profile-save">Сохранить</button></div>
    <div id="profile-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
  `;
  panel.insertBefore(card, panel.firstChild);
  document.getElementById('profile-save').addEventListener('click', async () => {
    const status = document.getElementById('profile-status');
    status.textContent = 'Сохранение…';
    try {
      await apiFetch('/bot-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('profile-name').value,
          shortDescription: document.getElementById('profile-short-desc').value,
          description: document.getElementById('profile-desc').value,
        }),
      });
      status.textContent = 'Сохранено.';
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });
}

// Categories ending in one of these suffixes belong to that specific
// growth stage (see bot.js's STAGE_SUFFIXES/pickPhraseForStage); anything
// without a suffix is a universal category used as the fallback for every
// stage that has no override yet — so it stays visible under every filter.
const STAGE_CATEGORY_SUFFIXES = { _baby: 'малыш', _young: 'молодой', _adult: 'взрослый', _old: 'старый' };
const PHRASE_STAGE_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: '_baby', label: 'Малыш' },
  { value: '_young', label: 'Молодой' },
  { value: '_adult', label: 'Взрослый' },
  { value: '_old', label: 'Старый' },
];
let phrasesStageFilter = 'all';

function categoryStageSuffix(category) {
  // boobs_* predates this suffix convention and maps stages differently
  // (boobs_young is stage 3, not stage 2) — tagging it here would show the
  // wrong stage, so it's excluded and just always shown instead.
  if (category.startsWith('boobs_')) return null;
  return Object.keys(STAGE_CATEGORY_SUFFIXES).find((s) => category.endsWith(s)) || null;
}

async function loadPhrases() {
  const phrases = await apiFetch('/phrases');
  const byCategory = {};
  for (const row of phrases) {
    (byCategory[row.category] = byCategory[row.category] || []).push(row);
  }
  const panel = document.getElementById('panel-phrases');
  const visibleCategories = Object.keys(byCategory).filter((category) => {
    if (phrasesStageFilter === 'all') return true;
    const suffix = categoryStageSuffix(category);
    return suffix === null || suffix === phrasesStageFilter;
  });
  const categoryBlocks = visibleCategories.sort().map((category) => {
    const suffix = categoryStageSuffix(category);
    const stageTag = suffix ? `<span class="count" style="background:var(--accent); color:var(--accent-contrast);">${STAGE_CATEGORY_SUFFIXES[suffix]}</span>` : '';
    const items = byCategory[category].map((row) => `
      <div class="phrase-item" data-id="${row.id}">
        <span class="text">${row.text}</span>
        <button class="icon-btn btn-edit">✎</button>
        <button class="icon-btn btn-del">✕</button>
      </div>
    `).join('');
    return `
      <div class="category">
        <div class="category-head">
          <span class="name">${category}</span>
          <span style="display:flex; align-items:center; gap:8px;">
            ${stageTag}
            <span class="count">${byCategory[category].length}</span>
            <span class="chevron">›</span>
          </span>
        </div>
        <div class="category-body">
          ${items}
          <div class="add-phrase-row">
            <input type="text" placeholder="Новая фраза для ${category}…" class="new-phrase-input">
            <button class="btn btn-add">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  const filterRow = `
    <div class="card">
      <p class="eyebrow">Показать категории для стадии</p>
      <select id="phrases-stage-filter" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg-sunken); color:var(--text); font-size:13px;">
        ${PHRASE_STAGE_FILTERS.map((f) => `<option value="${f.value}" ${f.value === phrasesStageFilter ? 'selected' : ''}>${f.label}</option>`).join('')}
      </select>
      <p style="font-size:11.5px; color:var(--text-muted); margin:8px 0 0;">Категории без метки стадии — общие, используются как запасной вариант для любой стадии, у которой ещё нет своих фраз.</p>
    </div>
  `;
  panel.innerHTML = filterRow + `<div class="card">${categoryBlocks}</div>`;

  document.getElementById('phrases-stage-filter').addEventListener('change', (e) => {
    phrasesStageFilter = e.target.value;
    loadPhrases();
  });

  panel.querySelectorAll('.category-head').forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  });
  panel.querySelectorAll('.category').forEach((categoryEl) => {
    const category = categoryEl.querySelector('.name').textContent;
    categoryEl.querySelector('.btn-add').addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = categoryEl.querySelector('.new-phrase-input');
      if (!input.value.trim()) return;
      await apiFetch('/phrases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text: input.value.trim() }),
      });
      loadPhrases();
    });
    categoryEl.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = e.target.closest('.phrase-item').dataset.id;
        await apiFetch('/phrases/' + id, { method: 'DELETE' });
        loadPhrases();
      });
    });
    categoryEl.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = e.target.closest('.phrase-item');
        const id = item.dataset.id;
        const current = item.querySelector('.text').textContent;
        const next = prompt('Новый текст фразы:', current);
        if (next === null || next.trim() === '') return;
        await apiFetch('/phrases/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: next.trim() }),
        });
        loadPhrases();
      });
    });
  });
}

async function loadLearnedPhrases() {
  const [settings, phrases] = await Promise.all([
    apiFetch('/settings'),
    apiFetch('/learned-phrases'),
  ]);
  const panel = document.getElementById('panel-learned');
  const chance = Number(settings.learned_phrase_reply_chance);

  const items = phrases.map((p) => `
    <div class="phrase-item" data-id="${p.id}">
      <span class="text">${p.text}${p.taughtByUsername ? ` <span style="color:var(--text-muted); font-size:11px;">— ${p.taughtByUsername}</span>` : ' <span style="color:var(--text-muted); font-size:11px;">— добавлено админом</span>'}</span>
      <button class="icon-btn btn-del">✕</button>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Частота использования</p>
      <div class="setting-row">
        <div class="setting-head">
          <span class="setting-name">Шанс ответить выученной фразой, %</span>
          <span class="setting-value mono" id="learned-chance-out">${chance}</span>
        </div>
        <input type="range" min="0" max="100" step="1" value="${chance}" id="learned-chance-input">
      </div>
    </div>
    <div class="card">
      <p class="eyebrow">Добавить фразу вручную</p>
      <div class="add-phrase-row">
        <input type="text" id="learned-add-text" placeholder="Новая фраза">
        <button class="btn" id="learned-add-btn">+</button>
      </div>
    </div>
    <div class="card">
      <p class="eyebrow">Запомненные фразы (${phrases.length})</p>
      ${items || '<p style="color:var(--text-muted); font-size:13px; margin:0;">Тролль пока ничего не запомнил.</p>'}
    </div>
  `;

  const chanceInput = document.getElementById('learned-chance-input');
  chanceInput.addEventListener('input', () => {
    document.getElementById('learned-chance-out').textContent = chanceInput.value;
  });
  chanceInput.addEventListener('change', async () => {
    await apiFetch('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learned_phrase_reply_chance: chanceInput.value }),
    });
  });

  document.getElementById('learned-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('learned-add-text');
    const text = input.value.trim();
    if (!text) return;
    await apiFetch('/learned-phrases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    loadLearnedPhrases();
  });

  panel.querySelectorAll('.btn-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.phrase-item').dataset.id;
      await apiFetch('/learned-phrases/' + id, { method: 'DELETE' });
      loadLearnedPhrases();
    });
  });
}

async function loadRelationships() {
  const people = await apiFetch('/relationships');
  const panel = document.getElementById('panel-relationships');
  if (people.length === 0) {
    panel.innerHTML = '<div class="card">Тролль пока никого не заметил.</div>';
    return;
  }
  const rows = people.map((p) => {
    const name = p.username ? '@' + p.username : p.first_name;
    const initial = (p.first_name || p.username || '?')[0].toUpperCase();
    const positive = p.attitude >= 0;
    const barWidth = Math.abs(p.attitude) / 2;
    const barStyle = positive
      ? `left:50%; width:${barWidth}%; background:var(--positive);`
      : `right:50%; width:${barWidth}%; background:var(--warning);`;
    const seenDate = p.last_seen_at ? new Date(p.last_seen_at * 1000).toLocaleDateString('ru-RU') : '—';
    const genderLabel = p.gender === 'male' ? '♂' : p.gender === 'female' ? '♀' : '❔';
    const genderTitle = p.gender === 'male' ? 'мужской — клик, чтобы сменить' : p.gender === 'female' ? 'женский — клик, чтобы сменить' : 'не определён — клик, чтобы задать';
    return `
      <div class="person-row" data-user-id="${p.user_id}">
        <div class="avatar">${initial}</div>
        <div class="person-main">
          <div class="person-name">${name} <span class="count gender-badge" data-gender="${p.gender || ''}" title="${genderTitle}" style="cursor:pointer;">${genderLabel}</span></div>
          <div class="person-meta">видели: ${seenDate}</div>
        </div>
        <div class="attitude-wrap">
          <div class="attitude-bar"><div class="mid-tick"></div><div class="fill" style="${barStyle}"></div></div>
          <div class="attitude-num" style="color:${positive ? 'var(--positive)' : 'var(--warning-deep)'}">${p.attitude > 0 ? '+' : ''}${p.attitude}</div>
        </div>
      </div>
    `;
  }).join('');
  panel.innerHTML = `<div class="card">${rows}</div>`;
  panel.querySelectorAll('.person-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const userId = row.dataset.userId;
      const next = prompt('Новое отношение (-100..100):');
      if (next === null || Number.isNaN(Number(next))) return;
      await apiFetch('/relationships/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attitude: Number(next) }),
      });
      loadRelationships();
    });
  });
  // Cycles male -> female -> unknown -> male on click, separate from the
  // row's own click (attitude prompt) via stopPropagation.
  panel.querySelectorAll('.gender-badge').forEach((badge) => {
    badge.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = badge.closest('.person-row').dataset.userId;
      const current = badge.dataset.gender;
      const next = current === 'male' ? 'female' : current === 'female' ? null : 'male';
      await apiFetch('/relationships/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gender: next }),
      });
      loadRelationships();
    });
  });
}

function renderSay() {
  const panel = document.getElementById('panel-say');
  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Сказать от лица тролля</p>
      <textarea id="say-input" placeholder="Напиши обычным языком…"></textarea>
      <div class="attach-row">
        <span>📎</span>
        <input type="file" id="say-photo" accept="image/*">
      </div>
      <label style="font-size:12.5px; display:flex; align-items:center; gap:6px; margin-top:10px;">
        <input type="checkbox" id="say-trollify"> перевести на трольский акцент
      </label>
      <div class="say-actions"><button class="btn" id="say-send">Отправить в чат</button></div>
      <div id="say-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  document.getElementById('say-send').addEventListener('click', async () => {
    const text = document.getElementById('say-input').value.trim();
    const photoInput = document.getElementById('say-photo');
    const applyTrollify = document.getElementById('say-trollify').checked;
    const status = document.getElementById('say-status');
    if (!text) return;
    const formData = new FormData();
    formData.append('text', text);
    formData.append('applyTrollify', applyTrollify ? '1' : '0');
    if (photoInput.files[0]) formData.append('photo', photoInput.files[0]);
    status.textContent = 'Отправка…';
    try {
      const res = await fetch('/troll-admin/api/say', { method: 'POST', headers: { 'X-Telegram-Init-Data': initData }, body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ошибка');
      status.textContent = 'Отправлено: ' + data.sent;
      document.getElementById('say-input').value = '';
      photoInput.value = '';
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });
}

const STICKER_CATEGORIES = [
  'play', 'kick', 'feed',
  'mischief_mild', 'mischief_medium', 'mischief_mean',
  'targeted_phrase_mild', 'targeted_phrase_medium', 'targeted_phrase_mean',
  'woken_angry',
];

async function loadStickers() {
  const stickers = await apiFetch('/stickers');
  const panel = document.getElementById('panel-stickers');
  const byCategory = { '(без категории)': [] };
  for (const s of stickers) {
    const key = s.category || '(без категории)';
    (byCategory[key] = byCategory[key] || []).push(s);
  }
  const importCard = `
    <div class="card">
      <p class="eyebrow">Импорт пака</p>
      <p style="font-size:12px; color:var(--text-muted); margin:-4px 0 12px;">Короткое имя из ссылки вида t.me/addstickers/&lt;имя&gt;</p>
      <div class="add-phrase-row">
        <input type="text" id="sticker-set-name" placeholder="Имя пака">
        <button class="btn" id="sticker-import-btn">Импорт</button>
      </div>
      <div id="sticker-import-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  const categoryBlocks = Object.keys(byCategory).map((category) => {
    const items = byCategory[category].map((s) => `
      <div class="sticker-item" data-id="${s.id}">
        <img data-sticker-id="${s.id}" class="sticker-preview" alt="${s.emoji || ''}">
        <div class="sticker-controls">
          <select class="sticker-category">
            <option value="">— без категории —</option>
            ${STICKER_CATEGORIES.map((c) => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <div class="sticker-own-text-row">
            <label><input type="checkbox" class="sticker-own-text" ${s.has_own_text ? 'checked' : ''}> есть свой текст</label>
            <button class="icon-btn sticker-del">✕ удалить</button>
          </div>
        </div>
      </div>
    `).join('');
    return `
      <div class="category open">
        <div class="category-head"><span class="name">${category}</span><span class="count">${byCategory[category].length}</span></div>
        <div class="category-body">${items}</div>
      </div>
    `;
  }).join('');
  panel.innerHTML = importCard + `<div class="card">${categoryBlocks}</div>`;

  document.getElementById('sticker-import-btn').addEventListener('click', async () => {
    const setName = document.getElementById('sticker-set-name').value.trim();
    const status = document.getElementById('sticker-import-status');
    if (!setName) return;
    status.textContent = 'Импортирую…';
    try {
      const result = await apiFetch('/stickers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setName }),
      });
      status.textContent = `Добавлено ${result.added} из ${result.total}.`;
      loadStickers();
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });

  panel.querySelectorAll('.sticker-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('.sticker-category').addEventListener('change', async (e) => {
      await apiFetch('/stickers/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: e.target.value || null }),
      });
      loadStickers();
    });
    item.querySelector('.sticker-own-text').addEventListener('change', async (e) => {
      await apiFetch('/stickers/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hasOwnText: e.target.checked }),
      });
    });
    item.querySelector('.sticker-del').addEventListener('click', async () => {
      await apiFetch('/stickers/' + id, { method: 'DELETE' });
      loadStickers();
    });
  });

  // Plain <img src> can't carry the X-Telegram-Init-Data header the API
  // requires, so every preview would 401 before ever reaching the proxy
  // route. Fetch each image with the header instead and hand the browser
  // a blob: URL.
  panel.querySelectorAll('.sticker-preview').forEach(async (img) => {
    const id = img.dataset.stickerId;
    try {
      const res = await fetch(`/troll-admin/api/stickers/${id}/image`, {
        headers: { 'X-Telegram-Init-Data': initData },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      img.src = URL.createObjectURL(blob);
    } catch (err) {
      console.error(`sticker preview failed for id=${id}:`, err);
    }
  });
}

// Uploads go out through the bot itself (to the admin chat, the same place
// the pool is normally filled from) — that's the only way to get Telegram's
// file_id back for a raw file, there's no "store without sending" endpoint.
async function loadGifs() {
  const gifs = await apiFetch('/gifs');
  const panel = document.getElementById('panel-gifs');
  const uploadCard = `
    <div class="card">
      <p class="eyebrow">Добавить гифку</p>
      <div class="add-phrase-row">
        <input type="file" id="gif-upload-input" accept="video/mp4,image/gif,video/webm">
        <button class="btn" id="gif-upload-btn">Загрузить</button>
      </div>
      <div id="gif-upload-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  if (gifs.length === 0) {
    panel.innerHTML = uploadCard + '<div class="card">Пул пуст.</div>';
    bindGifUpload();
    return;
  }
  const items = gifs.map((g) => `
    <div class="sticker-item" data-id="${g.id}">
      <video class="gif-preview" data-gif-id="${g.id}" muted loop autoplay playsinline></video>
      <div class="sticker-controls">
        <div class="sticker-own-text-row">
          <span style="font-size:11.5px; color:var(--text-muted);">добавлена: ${new Date(g.added_at * 1000).toLocaleDateString('ru-RU')}</span>
          <button class="icon-btn gif-del">✕ удалить</button>
        </div>
      </div>
    </div>
  `).join('');
  panel.innerHTML = uploadCard + `<div class="card">${items}</div>`;
  bindGifUpload();

  panel.querySelectorAll('.sticker-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('.gif-del').addEventListener('click', async () => {
      await apiFetch('/gifs/' + id, { method: 'DELETE' });
      loadGifs();
    });
  });

  // Same X-Telegram-Init-Data-via-fetch-then-blob trick as sticker previews
  // — a plain <video src> can't carry the auth header the API route needs.
  panel.querySelectorAll('.gif-preview').forEach(async (video) => {
    const id = video.dataset.gifId;
    try {
      const res = await fetch(`/troll-admin/api/gifs/${id}/video`, {
        headers: { 'X-Telegram-Init-Data': initData },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      video.src = URL.createObjectURL(blob);
    } catch (err) {
      console.error(`gif preview failed for id=${id}:`, err);
    }
  });
}

function bindGifUpload() {
  document.getElementById('gif-upload-btn').addEventListener('click', async () => {
    const input = document.getElementById('gif-upload-input');
    const status = document.getElementById('gif-upload-status');
    if (!input.files[0]) return;
    status.textContent = 'Загружаю…';
    const formData = new FormData();
    formData.append('gif', input.files[0]);
    try {
      const res = await fetch('/troll-admin/api/gifs', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': initData },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ошибка');
      status.textContent = data.added ? 'Добавлено!' : 'Такая гифка уже есть в пуле.';
      input.value = '';
      loadGifs();
    } catch (err) {
      status.textContent = 'Ошибка: ' + err.message;
    }
  });
}

async function init() {
  // The very first call also acts as the auth probe (requireAdmin gates
  // every /api/* route) — if it fails, treat it as "you don't have access"
  // and stop entirely. Every tab after that loads independently: one tab's
  // failure shows an error only in that tab's own panel, instead of the
  // old behavior where any single failing tab (stickers, being last, was
  // the common victim) wiped out every already-loaded tab's content.
  try {
    await loadStatus();
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">Ошибка доступа: ${err.message}</div>`;
    return;
  }
  const tasks = [
    { name: 'settings', panelId: 'panel-settings', fn: loadSettings },
    { name: 'botProfile', panelId: 'panel-settings', fn: loadBotProfile },
    { name: 'phrases', panelId: 'panel-phrases', fn: loadPhrases },
    { name: 'learnedPhrases', panelId: 'panel-learned', fn: loadLearnedPhrases },
    { name: 'relationships', panelId: 'panel-relationships', fn: loadRelationships },
    { name: 'say', panelId: 'panel-say', fn: async () => renderSay() },
    { name: 'stickers', panelId: 'panel-stickers', fn: loadStickers },
    { name: 'gifs', panelId: 'panel-gifs', fn: loadGifs },
  ];
  for (const task of tasks) {
    try {
      await task.fn();
    } catch (err) {
      console.error(`Ошибка загрузки (${task.name}):`, err);
      const panel = document.getElementById(task.panelId);
      if (panel) panel.innerHTML = `<div class="card">Ошибка загрузки: ${err.message}</div>`;
    }
  }
}
init();
