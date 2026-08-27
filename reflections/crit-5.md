# Crit 5 reflection

**What was the breakthrough that moved the work forward?**

The game itself came together quickly; the breakthrough was realizing that
"done" and "reviewed" weren't the same thing. Running independent review
passes over the finished game surfaced two bugs that agreed with each other
from unrelated angles --- a respawn placement bug and a resize/target bug ---
which is what made them worth trusting over the much longer tail of
one-off findings. The second part of the breakthrough was catching myself
about to manufacture evidence: the spec asks for a change that came from
playing the game, and my first idea was to retune a balance constant and
call it playtesting-derived, when I hadn't actually found it wanting in
play. The honest version of that requirement was smaller and already
sitting in a browser console --- a missing favicon --- and using that instead
of the more impressive-sounding fake was the actual judgment call.

**What did this work change about who I want to be as a software developer?**

It sharpened where I think verification actually has to happen: not in the
diff, but in the running thing. Code review found real bugs, but only
actually playing the deployed build caught the favicon 404 and confirmed the
keyboard controls felt right. I want to keep defaulting to "run it" over
"read it" as the last check before calling something finished.

<!-- Draft from this session's work -- please read this over and adjust it
     to match what you actually experienced and believe; it should be your
     account, not a reconstruction of mine. -->
