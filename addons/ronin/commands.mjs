// addons/ronin/commands.mjs — what the Ronin add-on adds to the bar's command library.

/** The add-on's entries in the bar's command library (lib/command-list.mjs withAddons), by the core group they join. */
export const COMMAND_ITEMS = Object.freeze({
  'Typed commands (console, or the bar)': [
      { say: ':nightly on | off | status', icon: 'moon.stars', fill: ':nightly status', does: 'The overnight loop: drafts data entry and health fixes between 1 and 5 am' },
      { say: ':nightly show', icon: 'list.bullet.rectangle', fill: ':nightly show', does: 'Last night\'s list' },
      { say: ':nightly approve <code> [skip 2,3]', icon: 'checkmark.seal', fill: ':nightly approve ', does: 'Approve the list by the code it shows (the card\'s Approve all does the same)' },
      { say: ':nightly edit <n> <value>', fill: ':nightly edit ', does: 'Change one drafted item first (the card is shown again)' },
      { say: ':nightly answer <n> <text>', fill: ':nightly answer ', does: 'Answer one of its questions' },
      { say: ':nightly run', fill: ':nightly run', does: 'A draft run now (nothing is changed)' },
      { say: ':nightly brain claude | chatgpt', fill: ':nightly brain claude', does: 'Which cloud brain drafts at night' },
      { say: ':approvals on | off', icon: 'checkmark.shield', does: 'Delegated approvals (console only; Ronin CRM owners)' },
      { say: ':dms on | off', does: 'Inbound DM forwarding (console only)' },
  ],
  'Say or type to turn a tool on': [
      { say: 'stop forwarding', icon: 'hand.raised', fill: 'stop forwarding', does: 'Pause DM forwarding, at once' },
      { say: 'Mia, wrap it up', icon: 'person.wave.2', does: 'In a meeting: Mia writes the notes and tasks and leaves' },
      { say: 'retire stale memories', icon: 'clock.arrow.circlepath', fill: 'retire stale memories', does: 'Fix memories that are no longer true' },
  ],
});

/** Names whisper should expect on an owner's install (lib/voice.mjs extendVocabulary). */
export const VOCABULARY = Object.freeze(['Ronin', 'Orosolu', 'Mia', 'Robbie', 'Seeker']);
