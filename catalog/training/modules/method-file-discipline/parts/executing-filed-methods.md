# Executing a Filed Method

Executing a filed method is a discipline of its own: the point of filing the
method was to spend the reasoning once, so the executing session follows the
steps as written, in order, running each step's check before moving on. A
session that re-derives the method mid-run has thrown away the saving and,
worse, produced an unverifiable hybrid — neither the filed method nor a new
one.

Deviations are handled, not hidden. When reality disagrees with a step — the
expected result does not appear — the executor stops at that step, records
the deviation with its evidence, and decides under the governing module
whether the method is stale or the situation is different from the trigger.
Either answer is valuable and both are written back: a stale method gets
corrected the same day, and a mismatched trigger gets its boundary sharpened.
What never happens is a silent workaround that lets the run "succeed" while
the file stays wrong for the next executor.

The run closes with the method's own proof step, graded in the fleet's
words, and the report cites the method file by name and version. Over many
runs those citations are the method's track record — the evidence a session
uses when it decides how much of its context budget a filed method deserves.
