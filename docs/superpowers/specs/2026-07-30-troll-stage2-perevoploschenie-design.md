# Тролль — Стадия 2 перевоплощения

## Purpose

A snapshot personality write-up derived from this troll's real all-time
stats, baked into the cocoon stasis caption alongside the numbers it came
from; a new admin-tunable "похотливость" setting controlling how fast the
existing `char_lust` trait rises; and a live retuning of three settings to
match the observed playstyle. Named "Стадия 2 перевоплощения" per the user's
request — a discrete milestone on top of the cocoon/transformation and
stage-2 content work already shipped.

## Background data (from the live troll, all-time totals)

Игр 97, кормлений 26 (18 переедено, 13 отказано сытому), пинков 27,
дразнилок 53, показов сиськи 60, огрызнулся 103, разбудили раньше времени 1,
дотроллил 10, описал 9, в какашку попали 8, выучено фраз 91, покакал 9,
пописал 15, поел сам 1.

Read as: spoiled/overfed (self_eat only 1, most feeds are overeats), sharp-
tongued (snapped_at is the single highest count of any logged action),
attention-loving (plays+teases+boobs far outweigh kicks), a big taught-
phrase vocabulary, and rarely disturbed during sleep.

## Character summary (fixed text, not recomputed live)

Added as `TROLL_CHARACTER_SUMMARY` in `bot.js`, appended to
`buildAllTimeStatsCaption`'s output (shown only while cocooned, same as
before) along with the troll's current `char_lust` value:

```
🧬 Характер:
Избалованный обжора — его перекармливают чаще, чем он ест сам.
Острый на язык: огрызается на всех и каждого больше, чем делает что-либо ещё.
Любит внимание — играют и дразнят его охотно, показов сиськи тоже хватает.
Нахватался фраз от чата — попугайничает много и разнообразно.
Спит крепко: будят его пораньше очень редко.
```

This is a frozen bio ("who he turned out to be by this point"), not a
formula that reruns against future stats — re-deriving it later, if wanted,
is a separate future edit, not something this change tries to automate.

## New setting: "Похотливость"

`char_lust` (an existing character trait, schema since before this change,
shown via `/troll_character`) only ever increases in one place —
`performBoobs`, previously a hardcoded `+ 8`. That literal is replaced with
a new admin-tunable setting `lust_gain_per_boobs` (default `8`, so behavior
is unchanged until an admin moves the slider), added to `bot.js`'s
`DEFAULT_SETTINGS`, `admin-lib.js`'s `DEFAULT_SETTINGS_KEYS`, and
`public/app.js`'s `SETTING_LABELS`/`SETTING_RANGES` (range `[0, 20, 1]`,
label "Похотливость (прирост похоти за 🍈)").

## Live settings retune (applied directly to the running troll, not a
## code-level default change)

Based on the stats above:

- `satiety_decay_per_hour`: 4 → 6 (feeds are overwhelmingly overeats and
  self-directed eating is nearly absent — hunger isn't biting fast enough
  between feeds)
- `mischief_message_trigger`: 50 → 30 (autonomous mischief is dwarfed by
  reactive engagement given how chatty this room is — lower the trigger so
  the troll acts on its own more often)
- `learned_phrase_reply_chance`: 8 → 13 (91 taught phrases is a rich, live
  pool — worth surfacing more often)

Applied via a direct SQL update on the server, not a `DEFAULT_SETTINGS`
change (this is tuning THIS troll's already-seeded settings, not changing
what a brand-new install starts with).

## Testing

No automated test suite. Verify: `/boobs` a few times and confirm
`char_lust` increases by the configured `lust_gain_per_boobs` amount (check
`/troll_character`); toggle the cocoon and confirm the caption now ends with
the lust line and the character-summary paragraph; confirm the three
retuned settings show their new values via `/api/settings` or the panel.
