# Process overview

A reading-guide to how the work came together --- a map to your process, not an
essay about it. Markers read this file and follow its citations; they don't
trawl the repo for evidence you didn't point at, so if a moment mattered, cite
it.

This file is the shape; the course site's
[assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#what-you-submit)
is the requirement, and its
[word counts](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#word-counts)
cover every deliverable.

## What I built

**Swell**: grow by eating, get crushed by anything still bigger than you. A
canvas game with a stateful predator (patrol/chase/search, foiled by hiding in
grass), scattered rock clusters you route around or thread the gaps of, two
timed power-ups, and a hard 60-second clock --- losable by hazard, by predator,
or by the timer running out, winnable by growing past `WIN_RADIUS`.

## The moments that mattered

1. **Two independent review passes converged on the same two bugs.** I ran
   several review agents over the finished game from different angles, and
   two of them --- reading the code from unrelated directions --- both flagged
   that `placeAvoiding` only checked new food/power-up spawns against other
   entities, never against `state.walls`, so a mid-round respawn could land
   permanently inside a rock cluster; and that `resize()` updated
   `state.width`/`state.height` but never reclamped `target`, so shrinking the
   window left the delta-based pointer control pinned to the old edge.
   Agreement across independent passes is what made these worth fixing over
   the dozen smaller, non-corroborated findings the same agents raised ---
   those I logged and deliberately left alone rather than churning on
   marginal issues. Verified with `pnpm check` staying green (33/33) after
   each fix, not just a visual spot-check.
   [`ac6c666`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/ac6c666),
   [`636a962`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/636a962)

2. **I rejected fabricating a "found by playtesting" balance tweak.** The spec
   wants one change that came from playing the game rather than reading its
   code. My first instinct was to retune `CRUSH_RATIO` and call it
   playtesting-derived, but the existing constant was already accompanied by
   a comment saying to tune it by playing, and I hadn't actually found it
   wanting in play --- changing it just to have a story would have been
   inventing evidence. The real, honest instance was smaller and already sitting
   in a console log: running the game in a live browser tab showed a 404 for
   `/favicon.ico` on every load, which no amount of reading `index.html`
   would have surfaced, since the file simply doesn't reference one.
   [`9cf0d8b`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/9cf0d8b)

3. **Scoped the accessibility fix instead of over-building it.** The template's
   plain HTML page became a canvas-only game, which quietly dropped every
   accessibility affordance the template had for free. Full screen-reader
   support for a real-time canvas game is out of scope for a week's
   prototype, so I drew the line at what's both honest and cheap: a real
   keyboard control path (arrow/WASD plus Enter/Space to restart, so the game
   doesn't structurally require a mouse), an `aria-label` on the only content
   on the page, a focus-visible style so the hidden nav link doesn't disappear
   for a keyboard user tabbing to it, and a `noscript` fallback.
   [`97dfb47`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/97dfb47)

4. **The link-preview card was still the starter placeholder.** `CLAUDE.md`
   itself says to replace `public/card.png`, and it was still the template's
   1200x630 image despite the page having become a completely different
   game --- an easy thing to miss because nothing in `pnpm check` catches it.
   Replaced it with a screenshot driven from an actual running round rather
   than staged art.
   [`b4476cf`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/b4476cf)

## Before you ship

`pnpm check:evidence` verifies your citations resolve to real commits, that a
reflection entry the marker reads is in `reflections/`, and that your
`CLAUDE.md` is there --- before a marker ever opens the file. It checks that
your map is traceable, not that it is good: the marker judges whether your
small, deliberately chosen set of moments shows real judgement and reflection. A
green check is not a substitute for that curation.

Images aren't checked: unlike a citation whose SHA doesn't resolve, a broken
image is visible the moment this file is rendered on GitHub.
