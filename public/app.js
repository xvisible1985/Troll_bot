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
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

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
  neglect_threshold_hours: 'Забвение до упадка, ч',
  health_decay_per_hour: 'Упадок здоровья/ч',
  health_regen_per_hour: 'Восстановление здоровья/ч',
  attitude_play_delta: 'Отношение: /play',
  attitude_feed_delta: 'Отношение: /feed',
  attitude_kick_delta: 'Отношение: /kick',
  attitude_escalation_threshold: 'Порог озлобления',
};
const SETTING_RANGES = {
  naughtiness: [1, 10, 1],
  mischief_message_trigger: [10, 200, 10],
  mischief_interval_hours: [1, 12, 1],
  sleep_start: [0, 23, 1],
  sleep_end: [0, 23, 1],
  neglect_threshold_hours: [1, 24, 1],
  health_decay_per_hour: [0, 10, 1],
  health_regen_per_hour: [0, 10, 1],
  attitude_play_delta: [0, 20, 1],
  attitude_feed_delta: [0, 20, 1],
  attitude_kick_delta: [-40, 0, 1],
  attitude_escalation_threshold: [-100, 0, 5],
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
    <div class="chip"><span class="dot"></span>здоровье <b class="mono">${data.health}</b></div>
    <div class="chip"><span class="dot"></span>настроение <b>${data.moodWord}</b></div>
    ${data.paused ? '<div class="chip warn"><span class="dot"></span>шалости на паузе</div>' : ''}
  `;
  panel.innerHTML = `
    <div class="card">
      <p class="eyebrow">Сейчас</p>
      <div class="stat-grid">
        <div class="stat"><div class="label">Здоровье</div><div class="value mono">${data.health}/100</div>
          <div class="bar-track"><div class="bar-fill" style="width:${data.health}%"></div></div></div>
        <div class="stat"><div class="label">Вес</div><div class="value mono">${data.weight} кг</div></div>
        <div class="stat"><div class="label">Настроение</div><div class="value">${data.moodWord}</div></div>
        <div class="stat"><div class="label">Стадия</div><div class="value">${data.stageName}</div></div>
      </div>
      <div class="activity-line"><span>💤</span><span>${data.activity}</span></div>
    </div>
    <div class="card">
      <p class="eyebrow">Быстрые действия</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" id="btn-pause">${data.paused ? '▶ Возобновить' : '⏸ Пауза шалостей'}</button>
        <button class="btn ghost" id="btn-reset">↺ Полный сброс</button>
      </div>
    </div>
  `;
  document.getElementById('btn-pause').addEventListener('click', async () => {
    await apiFetch(data.paused ? '/resume' : '/pause', { method: 'POST' });
    loadStatus();
  });
  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Точно сбросить тролля полностью?')) return;
    await apiFetch('/reset', { method: 'POST' });
    loadStatus();
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

async function loadPhrases() {
  const phrases = await apiFetch('/phrases');
  const byCategory = {};
  for (const row of phrases) {
    (byCategory[row.category] = byCategory[row.category] || []).push(row);
  }
  const panel = document.getElementById('panel-phrases');
  const categoryBlocks = Object.keys(byCategory).sort().map((category) => {
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
  panel.innerHTML = `<div class="card">${categoryBlocks}</div>`;

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
    return `
      <div class="person-row" data-user-id="${p.user_id}">
        <div class="avatar">${initial}</div>
        <div class="person-main">
          <div class="person-name">${name}</div>
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
      <div class="say-actions"><button class="btn" id="say-send">Отправить в чат</button></div>
      <div id="say-status" style="margin-top:8px; font-size:12.5px; color:var(--text-muted);"></div>
    </div>
  `;
  document.getElementById('say-send').addEventListener('click', async () => {
    const text = document.getElementById('say-input').value.trim();
    const photoInput = document.getElementById('say-photo');
    const status = document.getElementById('say-status');
    if (!text) return;
    const formData = new FormData();
    formData.append('text', text);
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

async function init() {
  try {
    await loadStatus();
    await loadSettings();
    await loadPhrases();
    await loadRelationships();
    renderSay();
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card">Ошибка доступа: ${err.message}</div>`;
  }
}
init();
