const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'NotoSans-Regular.ttf'), 'Noto Sans');
GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'NotoSans-Bold.ttf'), 'Noto Sans Bold');

const PORTRAIT_PATH = path.join(__dirname, 'uploads', 'troll-portrait.png');

// Top section: portrait + stage/weight/activity beside it (unchanged from
// before). Bottom section: the 4 bars, now spanning the FULL width instead
// of being squeezed into the narrow column beside the portrait — that's
// what let long label+value combos (e.g. "Отношение к тебе" / "-45
// (недолюбливает)") collide in the old layout.
const WIDTH = 800;
const PAD = 24;
const TITLE_H = 54;
const TOP_H = 400;
const SECTION_GAP = 28;
const BAR_ROW_H = 100;
const PORTRAIT_W = 300;
const HEIGHT = PAD * 2 + TITLE_H + SECTION_GAP + TOP_H + SECTION_GAP + BAR_ROW_H * 4;

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

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  ctx.font = '38px "Noto Sans Bold"';
  ctx.fillText('Тролль под мостом', PAD, PAD + 34);

  const topY = PAD + TITLE_H + SECTION_GAP;

  roundRectPath(ctx, PAD, topY, PORTRAIT_W, TOP_H, 18);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();

  if (fs.existsSync(PORTRAIT_PATH)) {
    try {
      const img = await loadImage(PORTRAIT_PATH);
      const inset = 16;
      const boxW = PORTRAIT_W - inset * 2;
      const boxH = TOP_H - inset * 2;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = PAD + inset + (boxW - dw) / 2;
      const dy = topY + inset + (boxH - dh) / 2;
      ctx.save();
      roundRectPath(ctx, PAD, topY, PORTRAIT_W, TOP_H, 18);
      ctx.clip();
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();
    } catch {}
  } else {
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '20px "Noto Sans"';
    ctx.textAlign = 'center';
    ctx.fillText('портрет не загружен', PAD + PORTRAIT_W / 2, topY + TOP_H / 2);
  }

  // Top-right column: stage / weight / activity, beside the portrait.
  const infoX = PAD + PORTRAIT_W + 28;
  const infoW = WIDTH - infoX - PAD;
  let y = topY + 6;

  // Same type scale as the bottom bar rows now (label 29/bold, value 24) —
  // was noticeably smaller than the bars before, looked inconsistent.
  function infoRow(icon, color, label, valueText) {
    drawIcon(ctx, icon, infoX + 22, y + 19, 42, color);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '29px "Noto Sans Bold"';
    ctx.fillText(label, infoX + 54, y + 29);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '24px "Noto Sans"';
    ctx.fillText(valueText, infoX + infoW, y + 29);
    y += 58;
  }

  infoRow('sprout', COLORS.mood, 'Стадия', data.stageName);
  infoRow('weight', COLORS.satiety, 'Вес', `${data.weight} кг`);

  drawIcon(ctx, 'paw', infoX + 22, y + 19, 42, COLORS.text);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.text;
  ctx.font = '29px "Noto Sans Bold"';
  ctx.fillText('Занятие', infoX + 54, y + 29);
  y += 46;
  ctx.font = '24px "Noto Sans"';
  ctx.fillStyle = COLORS.textMuted;
  const activityBottom = topY + TOP_H - 6;
  for (const line of wrapText(ctx, data.activity, infoW - 54)) {
    y += 33;
    if (y <= activityBottom) ctx.fillText(line, infoX + 54, y);
  }

  // Bottom section: full-width bars — plenty of room now for label and
  // value to share one line even for the longest combo ("Отношение к тебе"
  // / "-45 (недолюбливает)"), unlike the old narrow side-column layout.
  let barY = topY + TOP_H + SECTION_GAP;
  const barsW = WIDTH - PAD * 2;

  function barRow(icon, color, label, valueText, value, max, centered) {
    drawIcon(ctx, icon, PAD + 24, barY + 20, 46, color);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = '29px "Noto Sans Bold"';
    ctx.fillText(label, PAD + 58, barY + 29);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '24px "Noto Sans"';
    ctx.fillText(valueText, PAD + barsW, barY + 29);
    drawBar(ctx, PAD, barY + 48, barsW, 20, value, max, color, centered);
    barY += BAR_ROW_H;
  }

  barRow('heart', COLORS.health, 'Здоровье', `${data.health}/100`, data.health, 100, false);
  barRow('drumstick', COLORS.satiety, 'Сытость', `${data.satiety}/100 (${data.satietyWord})`, data.satiety, 100, false);
  barRow('smiley', COLORS.mood, 'Настроение', `${data.mood}/100 (${data.moodWord})`, data.mood, 100, false);
  barRow('handshake', COLORS.attitudePos, 'Отношение к тебе', `${data.attitude > 0 ? '+' : ''}${data.attitude} (${data.attitudeWord})`, data.attitude, 100, true);

  return canvas.encode('png');
}

module.exports = { renderTrollCard, PORTRAIT_PATH };
