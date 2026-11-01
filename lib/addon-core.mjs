// lib/addon-core.mjs — the core modules Kingmaker hands an add-on as host.services.lib, by name. An add-on never imports
// core by path (ronin.addon/1); it gets exactly these, and only the Ronin office add-on asks for them (its core.mjs).
import * as background from './background.mjs';
import * as chatgptBrain from './chatgpt-brain.mjs';
import * as claudeBrain from './claude-brain.mjs';
import * as client from './client.mjs';
import * as grokBrain from './grok-brain.mjs';
import * as iphoneDnc from './iphone-dnc.mjs';
import * as keychainSeal from './keychain-seal.mjs';
import * as killSwitch from './kill-switch.mjs';
import * as kingmakerFacts from './kingmaker-facts.mjs';
import * as phone from './phone.mjs';
import * as phoneRing from './phone-ring.mjs';
import * as voice from './voice.mjs';

export const ADDON_CORE = Object.freeze({
  background, 'chatgpt-brain': chatgptBrain, 'claude-brain': claudeBrain, client, 'grok-brain': grokBrain, 'iphone-dnc': iphoneDnc,
  'keychain-seal': keychainSeal, 'kill-switch': killSwitch, 'kingmaker-facts': kingmakerFacts, phone, 'phone-ring': phoneRing, voice,
});
