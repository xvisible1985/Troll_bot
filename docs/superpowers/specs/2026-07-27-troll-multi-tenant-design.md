# Multi-Tenant Troll Support — Design

> Status: **design captured, not yet planned/implemented.** Phase 1 (bot-only) is the agreed starting scope; phase 2 (web admin panel) is intentionally deferred and only sketched below.

**Goal:** Let one running troll-bot process (one Telegram bot token) serve multiple independent trolls, each bound to its own (admin chat, public chat) pair, with fully separate state/settings/relationships/character and phrases that layer personal additions on top of a shared base pool.

**Why:** Today the bot is hard-wired to a single troll — `troll_state` has `CHECK (id = 1)`, a single `ADMIN_CHAT_ID` env var gates every admin command, and literally every query in `bot.js`/`admin-lib.js`/`admin-server.js` assumes that one global row. Someone wants to add the troll to a second community without standing up a second bot deployment.

---

## Architecture

### Linking a new troll (two explicit steps, mirroring how `/troll_here` already works)

1. **`/troll_link`** — run in a *new* admin chat the bot has just been added to. The bot replies asking the admin to forward any message from the public chat they want to pair it with. The admin forwards one; the bot reads `forward_from_chat.id` and inserts a row into a new mapping table:

   ```sql
   CREATE TABLE troll_admin_links (
     admin_chat_id INTEGER PRIMARY KEY,
     public_chat_id INTEGER NOT NULL UNIQUE,
     linked_at INTEGER DEFAULT (strftime('%s','now'))
   )
   ```

   One admin chat governs exactly one public chat (and vice versa — `UNIQUE` both ways).

2. **`/troll_here`** — unchanged in spirit, still run *in the public chat* by a Telegram chat-admin of that chat. It now first checks whether `msg.chat.id` appears as a `public_chat_id` in `troll_admin_links`. If not linked yet, it tells the admin to run `/troll_link` first. If linked, it creates the actual `troll_state` row (the moment the troll narratively "appears") stamped with `admin_chat_id` copied from the link row.

`troll_state.id`'s `CHECK (id = 1)` constraint is dropped — `id` becomes a normal auto-increment "troll ID," and a new `admin_chat_id INTEGER NOT NULL` column is added (the public chat is already `chat_id`, which already exists).

### Data scoping

Every other currently-global table gets a `troll_id` column and all queries against it get filtered by it:

- **`troll_settings`**: primary key becomes composite `(troll_id, key)`. Every one of the ~40 `getSetting(Number)('key')` call sites in `bot.js` becomes `getSetting(Number)(trollId, 'key')`.
- **`troll_phrases`**: `troll_id` is **nullable** — `NULL` means "shared base seed" (the existing `PHRASE_SEED` + all the categories added this project, e.g. `tease_harsh_old`), a real value means "this troll's own addition, only it uses this line." Phrase lookup becomes `WHERE category = ? AND (troll_id IS NULL OR troll_id = ?)`. This was an explicit decision: new trolls start with the full existing phrase library, and admins can add troll-specific lines on top without needing to re-seed hundreds of lines per troll or affecting anyone else's troll.
- **`troll_relationships`, `troll_stickers`, `troll_learned_phrases`, `troll_actions`**: `troll_id` required (not nullable) — these are inherently per-community, no shared-base concept applies.
- **In-memory state** (`recentMessages`, `poopGameCandidates`, `commandCooldowns`, `seenUpdateIds`) is currently a flat global structure sized for one chat. Each becomes keyed by `troll_id` (e.g. `Map<trollId, recentMessagesArray>`) so participants of different chats never leak into each other's mischief targeting, poop-game candidate pool, or cooldowns.
- **`backgroundTick`**: currently ticks the one troll every 5 minutes. Becomes a loop over every row in `troll_state`, running the same per-troll logic for each. DB read/write volume scales linearly with the number of trolls — fine at the scale this is meant for (a handful of communities, not thousands).
- **Admin commands** (`isAdminChat`): instead of comparing `msg.chat.id` to the single `ADMIN_CHAT_ID` constant, look up whether a troll exists with `admin_chat_id = msg.chat.id` and resolve that instance's `troll_id` for everything downstream in the handler.

### Deliberately out of scope for phase 1

The **web admin panel** (`admin-server.js`, `admin-auth.js`, `public/app.js`) stays pointed at a single troll (today's `ADMIN_CHAT_ID` from `.env`) for now. Multi-troll web access needs its own design pass later:

- `requireAdmin` needs to resolve *which* troll(s) the calling Telegram user actually administers (by checking chat-admin status against each registered `admin_chat_id`, not one hardcoded value), and if more than one, the panel needs an instance picker before showing any data.
- Every API route needs to authorize the caller against the **specific** `troll_id` being requested, not just "is an admin of *some* troll" — otherwise an admin of troll A could pass troll B's ID and read/write troll B's data.

This was discussed and the recommended shape captured (chat-admin-driven instance list + picker, scoped per-request authorization) but the implementation is explicitly deferred until after phase 1 (bot-only) ships and is validated.

---

## Phasing (agreed)

**Phase 1 — bot only.** Everything above except the web panel: schema changes, `/troll_link` + updated `/troll_here`, and threading `troll_id` through every function in `bot.js` (commands, mischief, phrases, settings, relationships, character, digestion cycle, kick mechanics, Тролль Фас, learned phrases, in-memory per-chat state). Existing single troll gets migrated into this schema as the first row (its `chat_id`/`admin_chat_id` backfilled from the current `.env` values) so nothing breaks for the already-running instance.

**Phase 2 — web panel** (separate future design + plan): instance-aware `requireAdmin`, picker UI, per-request instance authorization.

## Scale note

This is a large, mostly-mechanical refactor (dozens of functions, most of `bot.js`'s ~1700 lines touched in some way) rather than a new isolated feature — realistically its own multi-task implementation plan, not a same-session add-on like the rest of this project's features so far.
