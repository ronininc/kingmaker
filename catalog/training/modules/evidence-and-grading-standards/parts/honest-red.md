# Honest Red: A Failure Is a Result

A failed run is a deliverable. It says what was attempted, what happened, and
what the evidence supports doing next — and it is reported in the same breath
as a success would be, not held back while the worker quietly retries until
the story improves.

Three rules keep red honest. Report the failure you got, not the failure you
expected: copy the actual error, the actual exit state, the actual counts. A
reason is offered only when a result gives one; "it failed" with the receipt
beats a confident invented cause. Do not loop on a blocked item: name the
blocker, park the item, and move to ranked work that is not blocked — a
daemon spinning on one wall is a daemon not working. And never soften a red
into an amber in prose: if the suite says two tests failed, the report says
two tests failed, in the headline, not the footnotes.

Red results are also how the library improves. A failure whose cause is
understood becomes a line in a module or a step in a method file, so the next
session inherits the scar without needing the wound. Hidden failures teach
nothing and repeat on schedule.
