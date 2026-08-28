# Process overview

## What I built

**Swell**: grow by eating, get crushed by anything still bigger than you. Two
stateful predators, rock clusters, a safe zone that closes in from 20s, and a
decaying combo that pays for chaining bites --- so a streak means crossing
ground you would otherwise route around. Lose to a hazard, a predator, the
zone, or the clock; win by outgrowing `WIN_RADIUS`.

## The moments that mattered

1. **The opening could kill you before you had done anything.** Playing it, not
   reading it, showed rounds ending at about a second: a predator's band sits
   ~130px from spawn, `placeAvoiding` demanded only 100px, and detection
   reaches 220 --- so a round could begin already locked on. Fixed with spawn
   clearance plus a 4s grace. Writing the test exposed a second hole:
   `placeAvoiding` falls back to an *unconstrained* point after 40 tries,
   quietly putting the bug back. [`ef88d92`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/ef88d92)

2. **I measured the wrong machine and made it slower.** It felt janky, so I
   profiled headless and cached the static boulders into an offscreen layer.
   Trading many small fills for one cached blit pays on the CPU that headless
   Chromium rasterizes with; on a real GPU that blit costs 44x the pixels of
   the fills it replaced. Only serving the last committed version on a second
   port and profiling both caught it. Reverted, reasoning kept in the comment.
   [`dce5047`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/dce5047)

3. **A lurch I felt in play had an exact mechanism.** The blob lagged, then
   yanked. The follow target was accumulating pointer travel the player ---
   once clamped and pushed out of walls --- could never spend, discharging as
   one lurch. I leashed it, then disabled the fix to prove the test could
   fail: 50px in a frame against a bounded 18. [`c6d54b9`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-cxin16215-netizen/commit/c6d54b9)
