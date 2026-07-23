# Troll Stickers — design

## Purpose

Let the troll send stickers from the admin's own troll-themed sticker packs
alongside/instead of its text phrases, managed entirely through the Mini App
admin panel (import a whole pack by name, then categorize each sticker).

## Data model

```sql
CREATE TABLE IF NOT EXISTS troll_stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL UNIQUE,
  category TEXT,
  has_own_text INTEGER NOT NULL DEFAULT 0,
  emoji TEXT,
  added_at INTEGER DEFAULT (strftime('%s','now'))
)
```

- `category` uses the same 12 category names `troll_phrases` already has (a
  sticker and a text phrase for `mischief_mean`, say, are peers — either can
  get picked when that category's turn comes up). `NULL` until an admin
  assigns one via the panel.
- `has_own_text` (admin-set toggle): true for stickers whose artwork already
  contains the joke/phrase — those get sent alone, never paired with a text
  message that would restate/clash with what's already on the sticker.
- `emoji`: the single emoji Telegram associates with the sticker in its set,
  stored only as a categorizing hint shown in the panel — not used in logic.

## Import: whole pack by name, from the panel

`POST /api/stickers/import` — body `{ setName }` (the short name from a
`t.me/addstickers/<setName>` link). Calls `bot.getStickerSet(setName)` and
inserts every sticker in the result (`INSERT OR IGNORE` keyed on `file_id`,
so re-importing the same pack is harmless) with `category = NULL`,
`has_own_text = 0`, `emoji` from Telegram's own per-sticker emoji field.
Returns how many were newly added vs. already known.

No chat-based capture flow (no forwarding stickers to the bot one at a time)
— this is the only import path, matching the explicit preference for
managing this entirely from the web panel.

## Panel: sticker management

A new section (own tab or folded into an existing one — implementation can
decide the exact placement) with:
- An "import pack" field (set name + button) hitting the endpoint above.
- Every sticker, grouped by category plus an "unassigned" bucket, each shown
  with:
  - A preview image, served via `GET /api/stickers/:id/image` — the backend
    fetches the file from Telegram itself (through the same proxy agent
    already used for other Bot API calls) and streams the bytes back with
    the right content-type. The raw `getFileLink` URL is never sent to the
    browser, since it embeds the bot token.
  - A category dropdown (the same 12 names) and a "has its own text" toggle,
    saved via `PUT /api/stickers/:id`.
  - A delete button (`DELETE /api/stickers/:id`).

**Known v1 limitation:** static (`.webp`) stickers preview correctly as a
plain image; animated (`.tgs`, gzipped Lottie JSON) or video (`.webm`)
stickers will not render via a plain `<img>` tag — the preview may show a
broken-image icon for those. Rendering Lottie/video previews is a real chunk
of extra frontend work with no functional payoff (the sticker still sends
and displays correctly in Telegram itself either way) — deferred, not
silently dropped.

## Sending: where and how often

Applies to exactly the categories that already send a phrase as a live chat
reaction: `play`, `kick`, `feed`, `mischief_mild`/`mischief_medium`/
`mischief_mean`, `targeted_phrase_mild`/`medium`/`mean`, `woken_angry`.

Does **not** apply to `targeted_action_*` (those drive the `/try`-style dice
roll, a structured result message, not a mood reaction) or `activity_awake`
(a status-line word inside `/troll`'s card, never its own sent message).

At each of those call sites: if the category has at least one registered
sticker, 50% chance to pick one (uniformly at random among that category's
stickers) instead of going straight to the existing text-only path:
- If the chosen sticker has `has_own_text`, send only the sticker.
- Otherwise, send the sticker, then send the normal text phrase right after
  (for `play`/`kick`/`feed`, keeping the existing `{actor} → {phrase}`
  attribution on that text message, same as today).

If a category has zero registered stickers, behavior is byte-for-byte
identical to today (plain text, no roll, no chance of skipping it) — this
feature is purely additive until an admin actually imports and categorizes
something.

## Out of scope

- Animated/video sticker preview rendering in the panel (see limitation
  above).
- Any change to `targeted_action_*`/`/try` rolling or `activity_awake`.
- Per-sticker weighting/rate limits beyond "uniform pick among registered
  stickers in the category" — same simplicity as `troll_phrases`.
