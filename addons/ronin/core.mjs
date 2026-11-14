// addons/ronin/core.mjs — the only way this add-on reaches Kingmaker's core. An installed add-on never imports core by
// path (ronin.addon/1: the app's layout changes between versions); Kingmaker hands it these through register(host), as
// host.services.lib, and bind() puts them here. Every module of the add-on imports them from this file, so they are
// live bindings: filled once register() runs, before anything of the add-on is called.
// The constants are known before binding (the add-on's module-level code reads them); bind() confirms them.

// client.mjs
export let ownerCall;
// voice.mjs
export let SAMPLE_RATE = 16_000;
export let createSegmenter, isNonSpeech, synthesizeKokoroWav, transcribe;
// keychain-seal.mjs
export let runSecurity;
// the brains (claude-brain.mjs, chatgpt-brain.mjs, grok-brain.mjs)
export let createClaudeBrain, findClaude, createChatgptBrain, findCodex, createGrokBrain, findGrok;
// phone.mjs, phone-ring.mjs, background.mjs, kingmaker-facts.mjs
export let textOwner, createPhoneRunners, runBackgroundCommand, factsFor;
// iphone-dnc.mjs
export let TOKEN_SERVICE = 'Kingmaker iPhone Bridge';
export let TOKEN_ACCOUNT = 'crm-dnc-token';
// kill-switch.mjs
export let STOP_APPROVING = /$^/;
export let isStopApproving = () => false;

/** The core modules this add-on needs, by file name (lib/addon-core.mjs builds the map Kingmaker passes). */
export const NEEDS = Object.freeze(['client', 'voice', 'keychain-seal', 'claude-brain', 'chatgpt-brain', 'grok-brain', 'phone', 'phone-ring', 'background', 'kingmaker-facts', 'iphone-dnc', 'kill-switch']);

/** Fill the bindings from Kingmaker's core (host.services.lib: { '<name>': module namespace }). Throws on a missing piece. */
export function bind(lib) {
  const need = (name) => { const m = lib?.[name]; if (!m) throw new Error(`Kingmaker did not hand this add-on its ${name} module`); return m; };
  ({ ownerCall } = need('client'));
  ({ SAMPLE_RATE, createSegmenter, isNonSpeech, synthesizeKokoroWav, transcribe } = need('voice'));
  ({ runSecurity } = need('keychain-seal'));
  ({ createClaudeBrain, findClaude } = need('claude-brain'));
  ({ createChatgptBrain, findCodex } = need('chatgpt-brain'));
  ({ createGrokBrain, findGrok } = need('grok-brain'));
  ({ textOwner } = need('phone'));
  ({ createPhoneRunners } = need('phone-ring'));
  ({ runBackgroundCommand } = need('background'));
  ({ factsFor } = need('kingmaker-facts'));
  ({ TOKEN_SERVICE, TOKEN_ACCOUNT } = need('iphone-dnc'));
  ({ STOP_APPROVING, isStopApproving } = need('kill-switch'));
}
