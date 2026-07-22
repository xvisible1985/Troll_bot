# Troll Admin Mini App — design

## Purpose

A Telegram Mini App (Web App) that gives admins a clickable panel over
everything currently only reachable via `/troll_*` chat commands: troll
status, settings (as sliders), phrase management, the relationships/attitude
system, and `/troll_say` broadcasting — plus pause/resume/reset. Opened from
inside Telegram via a button, no separate browser tab, with Telegram's own
signed `initData` providing built-in per-user authentication.

## Architecture

**A second, independent process** (`admin-server.js`, its own PM2 entry:
`troll-admin`) alongside the existing `troll-bot` process, both reading and
writing the **same** `troll.db` file directly via `better-sqlite3` — no
inter-process API between them. `better-sqlite3` handles two processes on one
SQLite file safely at this traffic level (a handful of admins occasionally
clicking, versus one bot polling Telegram); no locking scheme beyond SQLite's
own is needed.

`admin-server.js` is a small Express app: serves the static Mini App frontend
(vanilla HTML/CSS/JS, no build step — Vue is vendored as a local static file
rather than pulled from a live CDN at runtime, so the page never depends on a
CDN being reachable from inside Russia at load time) and exposes a small JSON
API under `/api/*` that the frontend calls.

It needs the bot's token and the admin chat ID (same values as `troll-bot`'s
`.env`) to do two things: verify `initData` signatures, and call
`getChatMember` to confirm the requesting user is currently in the admin
chat. It does **not** run a polling loop — `new TelegramBot(token, { polling:
false })` gives just the REST method wrappers, so there is zero risk of a
second `getUpdates` conflict with the real `troll-bot` process (the polling
conflict from earlier this project was specifically about two processes
racing on `getUpdates`; every other Bot API method, including `getChatMember`
and `sendMessage`/`sendPhoto`, is safe to call concurrently from any number of
processes sharing one token).

## Hosting

Same VPS (`91.224.86.8`), path-based on the existing site
(`nordheimunion.ru`), which already has nginx + a valid Let's Encrypt cert.
Add one new `location /troll-admin { proxy_pass http://127.0.0.1:4100; ... }`
block (mirroring the existing `/umami` block's proxy headers) to
`/etc/nginx/sites-enabled/nordheimunion.ru` — port `4100` is free (`3100` is
umami, `4000` is the main site). `admin-server.js` listens on `4100`,
loopback-only.

## Opening the panel

`troll-bot`'s `bot.js` gets one new admin-chat-only command, `/troll_panel`,
that replies with an inline keyboard containing a single button of type
`web_app: { url: 'https://nordheimunion.ru/troll-admin' }`. Tapping it opens
the Mini App inside Telegram. (Small addition to the existing bot, not part
of `admin-server.js` itself.)

## Auth

1. The frontend reads `window.Telegram.WebApp.initData` (a signed
   query-string Telegram injects into the page) and sends it as a header
   (`X-Telegram-Init-Data`) on every `/api/*` call.
2. The backend verifies the signature per Telegram's documented algorithm
   (HMAC-SHA256 over the data-check-string, keyed by
   `HMAC-SHA256("WebAppData", bot_token)`), extracting `user.id` from the
   verified payload. An invalid/missing signature → `401`.
3. The backend then checks `getChatMember(ADMIN_CHAT_ID, user.id)` — status
   must be `creator` or `administrator`, same rule `troll-bot` already uses
   elsewhere. Not a member/not an admin → `403`.
4. Step 3's result is cached in memory per `user_id` for 5 minutes, so
   routine clicking around the panel doesn't hammer the Bot API (and doesn't
   add proxy round-trip latency) on every single request.

## API surface

All under `/api/*`, all requiring the auth above, all operating directly on
`troll.db`:

| Method & path | Does |
|---|---|
| `GET /api/status` | troll_state + derived stage/weight/mood-word/activity-line (same data `/troll` shows) |
| `GET /api/settings` | all `troll_settings` key/values |
| `PUT /api/settings` | update one or more settings (body: `{key: value, ...}`) |
| `GET /api/phrases` | all categories with their phrases (id + text) |
| `POST /api/phrases` | add `{category, text}` |
| `PUT /api/phrases/:id` | edit `{text}` |
| `DELETE /api/phrases/:id` | delete |
| `POST /api/pause` / `POST /api/resume` | toggle the `paused` setting |
| `POST /api/reset` | wipe `troll_state` + `troll_actions` (same as `/troll_reset`) |
| `GET /api/relationships` | all `troll_relationships` rows |
| `PUT /api/relationships/:user_id` | admin override of `attitude` |
| `POST /api/say` | `{text, photo?}` (multipart if a photo file is attached) — trollifies `text` and sends to the troll's home chat, with the photo attached directly as a file upload (not a reply-to-message file_id lookup, since there's no "replying" concept in a Mini App — simpler than the chat-command version) |

## Frontend

Five tabs matching the approved mockup: **Статус**, **Настройки** (sliders,
grouped: character, sleep, health, attitude-sensitivity), **Фразы**
(collapsible categories, inline add/edit/delete), **Отношения** (list with a
−100..+100 bar per person), **Сказать** (textarea + optional photo attach +
live troll-speak preview via the same transform logic, reimplemented in the
frontend for the preview — the actual send always re-runs `trollify()`
server-side as the source of truth).

## Out of scope

- Any change to how `troll-bot` itself behaves — this sub-project only adds
  a read/write surface over the same data, plus the one `/troll_panel`
  command.
- Multi-admin conflict handling (two admins editing the same setting at the
  same moment) — last write wins, no locking; acceptable for a small friend
  group.
- Historical charts/analytics over relationship or settings changes — only
  current-state view/edit.
