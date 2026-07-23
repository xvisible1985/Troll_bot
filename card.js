const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'NotoSans-Regular.ttf'), 'Noto Sans');
GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'NotoSans-Bold.ttf'), 'Noto Sans Bold');

const PORTRAIT_PATH = path.join(__dirname, 'uploads', 'troll-portrait.png');

// Portrait-ish aspect ratio (not the earlier wide landscape one) so
// Telegram's chat bubble renders it full-width and tall — a wide/short
// image gets shown small, leaving blank space beside it where the client's
// quick-forward icon ends up sitting.
const WIDTH = 760;
const HEIGHT = 920;
const PAD = 24;
const PORTRAIT_W = 300;

const COLORS = {
  bg: '#181c16',
  panel: '#232920',
  track: '#343a2c',
  text: '#e9e6d8',
  textMuted: '#9aa08e',
  health: '#d97a7a',
  satiety: '#e0a05c',
  mood: '#8bab7a',
  attitudePos: '#8bab7a',
  attitudeNeg: '#d97a7a',
};

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Hand-drawn icons instead of Unicode emoji glyphs — headless Linux servers
// usually have no color-emoji font installed, so emoji text renders as
// blank boxes; simple vector shapes render identically everywhere.
function drawIcon(ctx, kind, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  switch (kind) {
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(cx, cy + size * 0.32);
      ctx.bezierCurveTo(cx - size * 0.6, cy - size * 0.05, cx - size * 0.22, cy - size * 0.55, cx, cy - size * 0.12);
      ctx.bezierCurveTo(cx + size * 0.22, cy - size * 0.55, cx + size * 0.6, cy - size * 0.05, cx, cy + size * 0.32);
      ctx.closePath();
      ctx.fill();
      break;
    case 'drumstick':
      ctx.beginPath();
      ctx.arc(cx - size * 0.06, cy - size * 0.14, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = size * 0.15;
      ctx.beginPath();
      ctx.moveTo(cx + size * 0.1, cy + size * 0.06);
      ctx.lineTo(cx + size * 0.36, cy + size * 0.4);
      ctx.stroke();
      break;
    case 'smiley':
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.panel;
      ctx.beginPath(); ctx.arc(cx - size * 0.15, cy - size * 0.08, size * 0.055, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + size * 0.15, cy - size * 0.08, size * 0.055, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COLORS.panel;
      ctx.lineWidth = size * 0.06;
      ctx.beginPath();
      ctx.arc(cx, cy + size * 0.02, size * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      break;
    case 'handshake':
      ctx.beginPath(); ctx.arc(cx - size * 0.17, cy, size * 0.23, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + size * 0.17, cy, size * 0.23, 0, Math.PI * 2); ctx.fill();
      break;
    case 'sprout':
      ctx.beginPath();
      ctx.moveTo(cx, cy + size * 0.38);
      ctx.lineTo(cx, cy - size * 0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx - size * 0.18, cy - size * 0.12, size * 0.2, size * 0.13, Math.PI * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + size * 0.18, cy - size * 0.2, size * 0.2, size * 0.13, -Math.PI * 0.28, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'weight':
      ctx.beginPath(); ctx.arc(cx - size * 0.28, cy, size * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + size * 0.28, cy, size * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(cx - size * 0.18, cy - size * 0.05, size * 0.36, size * 0.1);
      break;
    case 'paw':
      ctx.beginPath();
      ctx.ellipse(cx, cy + size * 0.14, size * 0.24, size * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const dx of [-0.24, 0, 0.24]) {
        ctx.beginPath();
        ctx.arc(cx + dx * size, cy - size * 0.22, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
  }
  ctx.restore();
}

function drawBar(ctx, x, y, w, h, value, max, color, centered) {
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = COLORS.track;
  ctx.fill();
  if (centered) {
    const half = w / 2;
    const fillW = half * Math.max(-1, Math.min(1, value / max));
    ctx.fillStyle = fillW >= 0 ? COLORS.attitudePos : COLORS.attitudeNeg;
    roundRectPath(ctx, x + half + Math.min(0, fillW), y, Math.abs(fillW), h, h / 2);
    ctx.fill();
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(x + half - 1, y - 2, 2, h + 4);
  } else {
    const fillW = w * Math.max(0, Math.min(1, value / max));
    if (fillW > 0) {
      ctx.fillStyle = color;
      roundRectPath(ctx, x, y, fillW, h, h / 2);
      ctx.fill();
    }
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function renderTrollCard(data) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const portraitH = HEIGHT - PAD * 2;
  roundRectPath(ctx, PAD, PAD, PORTRAIT_W, portraitH, 18);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();

  if (fs.existsSync(PORTRAIT_PATH)) {
    try {
      const img = await loadImage(PORTRAIT_PATH);
      const inset = 16;
      const boxW = PORTRAIT_W - inset * 2;
      const boxH = portraitH - inset * 2;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = PAD + inset + (boxW - dw) / 2;
      const dy = PAD + inset + (boxH - dh) / 2;
      ctx.save();
      roundRectPath(ctx, PAD, PAD, PORTRAIT_W, portraitH, 18);
      ctx.clip();
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();
    } catch {}
  } else {
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '20px "Noto Sans"';
    ctx.textAlign = 'center';
    ctx.fillText('портрет не загружен', PAD + PORTRAIT_W / 2, PAD + portraitH / 2);
  }

  const rowsX = PAD + PORTRAIT_W + 30;
  const rowsW = WIDTH - rowsX - PAD;
  let y = PAD + 10;

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  ctx.font = '34px "Noto Sans Bold"';
  ctx.fillText('Тролль под мостом', rowsX, y + 26);
  y += 62;

  // The right column is narrower than the earlier landscape layout, so a
  // long label ("Отношение к тебе") and a long value ("-45 (недолюбливает)")
  // no longer fit side by side on one line — label sits on the icon's line,
  // value sits on its own line directly above the bar instead.
  function barRow(icon, color, label, valueText, value, max, centered) {
    const rowTop = y;
    drawIcon(ctx, icon, rowsX + 20, rowTop + 16, 36, color);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '22px "Noto Sans Bold"';
    ctx.fillText(label, rowsX + 48, rowTop + 22);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '17px "Noto Sans"';
    ctx.fillText(valueText, rowsX + rowsW, rowTop + 54);
    drawBar(ctx, rowsX, rowTop + 62, rowsW, 16, value, max, color, centered);
    y = rowTop + 100;
  }

  function textRow(icon, color, label, valueText) {
    drawIcon(ctx, icon, rowsX + 20, y + 15, 36, color);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '22px "Noto Sans Bold"';
    ctx.fillText(label, rowsX + 48, y + 22);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '20px "Noto Sans"';
    ctx.fillText(valueText, rowsX + rowsW, y + 22);
    y += 48;
  }

  barRow('heart', COLORS.health, 'Здоровье', `${data.health}/100`, data.health, 100, false);
  barRow('drumstick', COLORS.satiety, 'Сытость', `${data.satiety}/100 (${data.satietyWord})`, data.satiety, 100, false);
  barRow('smiley', COLORS.mood, 'Настроение', `${data.mood}/100 (${data.moodWord})`, data.mood, 100, false);
  barRow('handshake', COLORS.attitudePos, 'Отношение к тебе', `${data.attitude > 0 ? '+' : ''}${data.attitude} (${data.attitudeWord})`, data.attitude, 100, true);

  y += 12;
  textRow('sprout', COLORS.mood, 'Стадия', data.stageName);
  textRow('weight', COLORS.satiety, 'Вес', `${data.weight} кг`);

  // Activity flavor text can be a full sentence — wraps onto its own lines
  // below the icon+label row instead of squeezing into a single right-
  // aligned value like the other rows.
  drawIcon(ctx, 'paw', rowsX + 20, y + 15, 36, COLORS.text);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  ctx.font = '22px "Noto Sans Bold"';
  ctx.fillText('Занятие', rowsX + 48, y + 22);
  y += 36;
  ctx.font = '20px "Noto Sans"';
  ctx.fillStyle = COLORS.textMuted;
  ctx.textAlign = 'left';
  for (const line of wrapText(ctx, data.activity, rowsW - 48)) {
    y += 28;
    ctx.fillText(line, rowsX + 48, y);
  }

  return canvas.encode('png');
}

module.exports = { renderTrollCard, PORTRAIT_PATH };
