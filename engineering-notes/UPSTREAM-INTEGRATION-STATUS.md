# Pinned upstream integration checkpoint

Release source: ronininc/kingmaker b44cea4132ba4a569b724969152134bf80cee470. Integrated branch candidate/integrated-451, checkpoint8d6d173. Exact engine source: ronininc/TSS47482a2e59de0bc49a1ad7938a5464710ca401bd; isolated classifier fix2f60433. User source checkouts and installed signed app unchanged.

`node --test --test-force-exit --test-concurrency=1 test/*.test.mjs` on integrated release:1480tests,1386pass,47fail,47skip. Pristine exact upstream baseline:1299tests,1202pass,50fail,47skip. No new failing test remains after consumer reconciliation. Three baseline failures resolved. Reports outside repo: release-integrated-final-tests.txt, release-baseline-test-results.txt, final-regression-comparison.json. This is not a fully green release suite and excludes addon suites.

Real code reconciliation preserves incomplete declarations: draft validation distinguishes a safe awaiting-owner proposal from executed capability; translation retains incomplete status with genuine structural evidence; iteration positive tests conduct actual writes rather than fabricate completion. Hunter download pause remains explicit/reversible. Tool fixtures no longer depend on this Mac lacking Blender.

`node scripts/build-payload.mjs --out ../payload-candidate` produced and verified a57MB2016-file payload and ran unpacked Kingmaker4.5.1. Later staging correction normalizes executable bits only in private output. Focused raw installer layout and actual compiled Swift wrapper/fixture-engine handshake tests pass. Native presentation patch compiles and validates links; this is not a deployed production GUI or successful full engine rebuild.

Standalone engine checkout lacks its development dependencies; whole engine rebuild has not run. Public release includes signing tool source and public certificate pin, but no private key was read/exported and no production signing/install was attempted. Build-app.sh would fetch absent ffmpeg/uv payloads, so it was not blindly executed. Any final production build must satisfy current dependency, identity, compatibility and remaining test requirements rather than relabel fixture results.
