# Troll Relationships & Attitude System — design

## Purpose

Give the troll a persistent, per-person "attitude" toward every chat member it has
noticed, which automatically shifts from how that person treats it (`/play`,
`/feed`, `/kick`), and which in turn skews targeted mischief — disliked people
get targeted more often and more harshly. This is a prerequisite for the planned
Mini App admin panel's "Relationships" tab (a separate, later sub-project),
which will let admins view and hand-adjust these values, plus edit the
attitude-tuning numbers below as sliders.

## Data model

```sql
CREATE TABLE IF NOT EXISTS troll_relationships (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  attitude INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER DEFAULT (strftime('%s','now')),
  last_seen_at INTEGER
)
```

- `attitude` ranges from **-100** (hates) to **+100** (loves), clamped on every
  write. Defaults to **0** (neutral) the moment someone is first noticed.
- `username`/`first_name` are refreshed on every notice (people rename
  themselves) — not just set once at insert.

## New settings (added to `troll_settings` / `DEFAULT_SETTINGS`)

Per explicit request, the tuning numbers below are admin-configurable settings
(via `/troll_set`, and later sliders in the Mini App), not hardcoded constants:

| key | default | meaning |
|---|---|---|
| `attitude_play_delta` | `5` | attitude change for the actor on `/play` |
| `attitude_feed_delta` | `8` | attitude change for the actor on `/feed` |
| `attitude_kick_delta` | `-15` | attitude change for the actor on `/kick` |
| `attitude_escalation_threshold` | `-30` | attitude at/below which a targeted-mischief victim gets bumped one tier harsher |

The weighted-target-selection formula's shape (see below) stays fixed in code —
only the four numbers above are exposed as tunable settings.

## Getting noticed

Whenever the troll would already register someone's presence, it also
upserts `troll_relationships`:

- Any ordinary (non-bot, non-command) message in the troll's home chat — same
  place `pushRecentMessage` already runs.
- `/play`, `/feed`, `/kick` — even for someone who only ever uses commands and
  never sends plain messages, so they still can't be missed.

A no-op interaction (troll asleep-and-angered, or silenced) does **not** notice
or adjust attitude, consistent with "the action didn't happen."

## Attitude changes

Only the three direct interactions above move the actor's own attitude number:
`/play` → `+attitude_play_delta`, `/feed` → `+attitude_feed_delta`, `/kick` →
`+attitude_kick_delta` (negative by default). Always clamped to [-100, 100].
Ordinary messages notice (refresh `last_seen_at`/name) but don't move the
number by themselves.

## Effect on targeted mischief

Today, `triggerMischief`'s targeted branch picks a victim uniformly at random
from the last 10 chat messages. This changes to:

1. **Weighted selection** — each candidate's weight is
   `max(10, 100 - attitude)`, so a hated person (attitude -100) has 10x the
   weight of a beloved one (attitude +100), while nobody ever drops to zero
   chance.
2. **Tier escalation** — once a victim is chosen, if their attitude is at or
   below `attitude_escalation_threshold`, the mischief tier for that message
   is bumped up by one (mild→medium, medium→mean), still capped by the
   troll's growth-stage ceiling (`STAGE_MAX_MISCHIEF_TIER`) — a малыш never
   exceeds mild no matter how disliked the target is.

This only affects the targeted branch (recent-participant mischief); the
detached/generic mischief branch and the timer-vs-message-count trigger split
are unchanged.

## Out of scope (this sub-project)

- The Mini App "Relationships" tab itself (viewing/editing attitude and the
  four settings above as sliders) — separate, later sub-project, built once
  this data model exists.
- Any admin command to view relationships directly from chat — not requested;
  the data is there for the future panel to read, no `/troll_*` command is
  being added for it in this pass.
