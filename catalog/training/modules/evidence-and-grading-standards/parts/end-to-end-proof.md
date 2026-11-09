# End-to-End Proof on the Real Thing

Wherever a runnable path exists, the proof is a run of the whole thing on the
real thing. Unit suites, fixture harnesses, and static reads are how you get
to the run; they are not the run.

The order matters as much as the run itself: assemble the whole system first,
freeze it, then test the assembled unit once. Proof rounds on loose pieces —
or on a tree still being edited — prove nothing transferable, because the
thing that ships is the assembled unit, seams and all. A flaky result during
that test is reported as a result: flaky counts as red for any gate that
matters, and it is never chased with re-runs until a clean pass happens to
appear. A pass obtained by re-rolling is a flaky system wearing a green
badge.

Effort scales to the stakes. Releases, production merges, money and
authentication paths get the full proof. Inventories, lookups, and drafts get
a light touch — one check, honestly graded. What never scales down is the
grade word: light work is still labelled with the grade its evidence actually
earns, so cheap checks are never mistaken for deep ones downstream.
