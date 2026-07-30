# Troll "teen" (stage 2) content expansion — design

## Purpose

The troll's stage 2 ("молодой") should read as an older, more hormonal
teenager: peeps/hits on a specific female participant, touches himself more
as ambient behavior, and snaps back harsher when provoked. ~50 new lines of
content, unrelated to the cocoon/transformation mechanic (confirmed with the
user — this applies right now, to the existing stage system, not gated
behind anything).

## Why this needs zero behavior changes

Two existing mechanisms already do exactly what's needed:

- `pickPhraseForStage(category, stage, fallback)` (bot.js:1083-1087) always
  tries `category + STAGE_SUFFIXES[stage]` first (stage 2 → `_young`),
  falling back to the plain category only if the staged one is empty. This
  already runs for both untargeted mischief (bot.js:2096-2100:
  `pickPhraseForStage(mischiefCategory, stage, ...)`) and gender-targeted
  mischief (bot.js:2088-2089: `resolveTargetedActionCategory(...)` returns
  `targeted_action_female`/`targeted_action_male`, which is then passed
  straight into `pickPhraseForStage(actionCategory, stage, ...)` — so a
  `_young` variant of a gendered category is picked up automatically the
  same way, no changes to `resolveTargetedActionCategory` needed).
- `seedPhrasesIfMissing(category, phrases)` (bot.js:980-988) tops up an
  already-deployed `troll_phrases` table by exact-text diff — safe to call
  on every restart, safe to add new lines to an existing seed array (only
  the genuinely-new lines get inserted).

So this whole feature is: new content arrays, three new `seedPhrasesIfMissing`
calls for brand-new categories, and more lines appended to one already-seeded
array. No new columns, no new trigger logic, no new call sites.

## Content plan (~50 lines across 3 categories)

- **`mischief_mild_young` / `mischief_medium_young`** (new categories, ~20
  lines total) — ambient, untargeted shalости in the same plain-Russian,
  third-person, asterisk-wrapped style as the existing `mischief_mild`/
  `mischief_medium` pools (e.g. `'пошутил над соседской курицей'`). Covers
  general hormonal-teen ambient behavior, including touching himself, without
  naming a specific chat participant.
- **`targeted_action_female_young`** (new category, ~15 lines) — same
  `{user}`-templated, third-person action style as `TARGETED_ACTION_FEMALE_PHRASES`,
  but leaning into clumsily hitting on / staring at the specific targeted
  female participant, instead of that pool's current innocent-prank tone.
- **`TEASE_HARSH_YOUNG_PHRASES`** (existing array/category, ~15 more lines
  appended) — sharper, more dismissive teen-attitude comebacks, same
  troll-speak dialogue style as the existing entries in that array.

No new category for male-targeted or mixed/mean-tier content — the user
only asked for the three behaviors above; extending further is out of scope
(YAGNI).

## Explicitly out of scope

- Any change to `resolveTargetedActionCategory`, `pickPhraseForStage`,
  `MISCHIEF_TIER_CATEGORIES`, `TARGETED_ACTION_TIER_CATEGORIES`, or any other
  existing function.
- Any tie-in to the cocoon/transformation mechanic — this content is live
  immediately for stage 2, independent of `has_transformed`/`cocoon_started_at`.
- Male-targeted or "mean tier" versions of this content.

## Testing

No automated test suite (same as the rest of this bot). Verification: after
deploying, set the troll's stage to 2 in the admin panel, trigger enough
messages/mischief cycles to observe `mischief_mild`/`medium` and gender-
targeted mischief firing, and confirm the new stage-2-flavored lines show up
instead of the generic ones; provoke a harsh tease response and confirm new
`tease_harsh_young` lines appear in rotation.
