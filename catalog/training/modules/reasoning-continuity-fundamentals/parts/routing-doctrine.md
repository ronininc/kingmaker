# Routing Doctrine: One Owner Per Pipeline

Work is routed, never self-assigned and never shared by default. The owner's
orders flow to Kingmaker, and Kingmaker — or, when Kingmaker is unavailable,
the CRM fallback — dispatches each job to the best-fit owner for that job.
Bots are routed; they never self-coordinate, and two engines never hold the
same line at once.

The standing shape is one daemon per pipeline: one owner per line, accountable
for it end to end. When a pipeline genuinely needs several engines, they do
not share control — they feed each other reports. Each stage concludes, writes
its report, and the next stage consumes the report. Operational data stays
local to the stage that produced it; conclusions are what travel. Report-fed
cooperation is the only cooperation.

Routing decisions follow the owner's lanes, not convenience: the owner of a
repo or pipeline does the work in it, a second bot verifies what the first one
built, and nothing is self-approved. When a job arrives that fits no lane,
that is a routing question to escalate, not an invitation for whichever engine
is idle to absorb it. A lane change is the owner's act, announced — a daemon
that quietly takes over another daemon's pipeline has broken the doctrine even
if its work is good.
