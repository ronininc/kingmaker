# What a Method File Is

A method file is a solved problem, filed. When a session works out how to do
something non-trivial — a build, a proof, a multi-step investigation — the
method is written down as an executable procedure: named inputs, ordered
steps, the checks that prove each stage, and the known failure modes with
their tells. Later sessions execute the filed method instead of re-deriving
it, which is where the fleet's speed actually comes from: reasoning is
expensive, execution is cheap, and a method file converts the first into the
second exactly once.

A method file is not documentation in the essay sense. It does not explain
the field; it performs the task. Every step is an action with an expected
observable result, and a step whose result cannot be observed does not belong
in the file — it belongs in a training module, where doctrine lives. The
reader of item 15's work should note the division: modules teach how to
reason; method files script what to do. A session loads the few module parts
that govern its judgement, then executes the method file that governs its
hands.

Method files live under version control like code, because they are code in
prose: reviewed, diffed, and corrected when reality disagrees with them.
