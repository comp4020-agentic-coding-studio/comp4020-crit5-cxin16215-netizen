# Crit 5 reflection

**What was the breakthrough that moved the work forward?**

Learning that "measure, don't guess" has a second half I had been skipping:
check you measured the right thing. The motion felt janky, so I profiled it,
found the renderer fill-rate bound, and cached the static geometry into an
offscreen layer. It got slower. The profile was honest but the *machine* was
wrong --- headless Chromium rasterizes on the CPU, where that trade pays,
while a real GPU turns the same idea into a pessimization. No number could
have told me, because every number was internally consistent. What broke it
open was building a comparison I could be wrong against: serving the last
committed version on a second port and running the identical profile at both.
The baseline beat me, and that was the finding. The same instinct later made
me disable my own fix to confirm the new regression test could fail --- a test
that has never failed is a claim, not evidence.

**What did this work change about who I want to be as a software developer?**

I want to build the thing that can prove me wrong, rather than accumulate
evidence that I am right. Both of this week's real mistakes were invisible
from inside my own setup: a plausible profile from the wrong renderer, and a
green test never shown to fail. Neither would have yielded to more care or
more reading. Both fell to a deliberately constructed control --- a baseline,
a disabled fix --- whose only job was to disagree with me.
